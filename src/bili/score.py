"""Score each follow into keep / review / remove with a human-readable reason.

FOR-36 口径（CTO ADR：缺失信号按"未知"处理，绝不按"最差"处理）：

1. **归一化**：只对已提供的信号求加权平均，
   ``score = sum(w_k * p_k) / sum(w_k)``，分母只含已提供信号的权重。
   一个信号都没有时 score = 0.0。未知不等于最差。
2. **闸门 A（取关方向）**：recency 未知 -> 不得判 remove，最多 review，
   并追加原因行 ``downgraded to review: no recency signal``。
3. **闸门 B（保留方向）**：keep 至少要提供 recency 或 authority 之一；
   只有 relevance（简介）时不得 keep，最多 review。
4. **可观测性**：``signals_used``（已提供信号数 0-3）随结果一起导出到
   CSV / Markdown / Web 报告。

ADR 明确禁止的绕法：不许靠调低 REVIEW_MIN / KEEP_MIN 把信号缺失糊过去。
"""

from typing import Dict, List, Tuple

from .model import Class, FollowRecord

# Tunable weights. Weights are per-signal; only the *provided* signals take part
# in the average (FOR-36): the denominator is the weight sum of provided signals,
# so a missing signal is unknown, not a zero score.
WEIGHTS = {
    "recency": 0.45,     # how recently you saw them / they posted
    "authority": 0.30,   # follower/following ratio -> niche/quality proxy
    "relevance": 0.25,   # bio signals (official/verified keywords, length)
}

# Fixed signal order (used for signals_used reporting and stable reason lines).
SIGNALS = ("recency", "authority", "relevance")

REVIEW_MIN = 0.40
KEEP_MIN = 0.70

OFFICIAL_BIOS = ("官方", "认证", "verified", "official", "媒体", "传媒", "工作室")

# 闸门 A 的固定原因行（CTO 验收按这个字符串找）。
GATE_A_REASON = "downgraded to review: no recency signal"
# 闸门 B 的原因行。
GATE_B_REASON = "downgraded to review: keep needs recency or authority"


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _recency_signal(days) -> float:
    """Map days-since-last-seen (or last video) to 0..1. 0 days -> 1.0."""
    if days is None:
        return 0.0
    return _clamp01(1.0 - (float(days) / 365.0) * 0.9)


def _authority_signal(record: FollowRecord) -> float:
    if record.follower_count is None or record.following_count is None:
        return 0.0
    fl = record.following_count
    if fl <= 0:
        return 1.0
    ratio = float(record.follower_count) / float(fl)
    import math
    return _clamp01(math.log10(ratio + 1.0) / 3.0)


def _relevance_signal(record: FollowRecord) -> float:
    bio = (record.bio or "").strip()
    if not bio:
        return 0.3
    s = len(bio)
    bio_quality = 1.0 if s >= 12 else _clamp01(s / 12.0)
    lowered = bio.lower()
    official = any(k in lowered for k in OFFICIAL_BIOS if k.lower() in lowered)
    official_score = 1.0 if official else 0.0
    return 0.6 * bio_quality + 0.4 * official_score


def _provided(record: FollowRecord, name: str) -> bool:
    if name == "recency":
        return record.last_seen_days is not None or record.last_video_days is not None
    if name == "authority":
        return record.follower_count is not None and record.following_count is not None
    if name == "relevance":
        return bool((record.bio or "").strip())
    return False


def provided_signals(record: FollowRecord) -> List[str]:
    """The signal names this record actually carries (stable order)."""
    return [name for name in SIGNALS if _provided(record, name)]


def signals_used(record: FollowRecord) -> int:
    """How many of the three signals are known (0-3) - exported per row (FOR-36)."""
    return len(provided_signals(record))


def signal_scores(record: FollowRecord) -> Dict[str, float]:
    """Sub-scores for the *provided* signals only; missing signals are absent."""
    out: Dict[str, float] = {}
    for name in SIGNALS:
        if not _provided(record, name):
            continue
        if name == "recency":
            days = (record.last_seen_days if record.last_seen_days is not None
                    else record.last_video_days)
            out[name] = _recency_signal(days)
        elif name == "authority":
            out[name] = _authority_signal(record)
        else:
            out[name] = _relevance_signal(record)
    return out


def weighted_score(record: FollowRecord) -> float:
    """Normalized weighted average over provided signals (0.0 when none known)."""
    parts = signal_scores(record)
    denom = sum(WEIGHTS[k] for k in parts)
    if not denom:
        return 0.0
    return _clamp01(sum(WEIGHTS[k] * parts[k] for k in parts) / denom)


def classify(record: FollowRecord) -> Tuple[Class, float, List[str]]:
    """Return (class, score, [reasons]).

    Unknown signals are skipped, not penalized: they drop out of the denominator
    (FOR-36 rule 1) and the two gates below keep them from producing an
    unfollow recommendation or an unearned keep.
    """
    parts = signal_scores(record)
    score = weighted_score(record)

    if score >= KEEP_MIN:
        cls = Class.KEEP
    elif score >= REVIEW_MIN:
        cls = Class.REVIEW
    else:
        cls = Class.REMOVE

    notes: List[str] = []
    # 闸门 A：没有 recency 就没有取关依据（未知不是证据）。
    if "recency" not in parts and cls == Class.REMOVE:
        cls = Class.REVIEW
        notes.append(GATE_A_REASON)
    # 闸门 B：只有简介（relevance）不足以支撑 keep。
    if cls == Class.KEEP and not ("recency" in parts or "authority" in parts):
        cls = Class.REVIEW
        notes.append(GATE_B_REASON)

    reasons: List[str] = []
    if record.last_seen_days is not None:
        reasons.append("recency: seen %.0f days ago" % record.last_seen_days)
    elif record.last_video_days is not None:
        reasons.append("recency: last post %.0f days ago" % record.last_video_days)
    else:
        reasons.append("recency: unknown")
    if record.follower_count is not None and record.following_count is not None:
        reasons.append("authority: %d followers vs %d following" % (
            record.follower_count, record.following_count))
    else:
        reasons.append("authority: unknown")
    if (record.bio or "").strip():
        reasons.append("relevance: %d-char bio (official=%s)" % (
            len(record.bio.strip()), "yes" if _relevance_signal(record) > 0.6 else "no"))
    else:
        reasons.append("relevance: empty bio")
    reasons.extend(notes)
    reasons.append("class=%s score=%.2f signals_used=%d for %s" % (
        cls.value, score, len(parts), record.nickname))
    return cls, score, reasons
