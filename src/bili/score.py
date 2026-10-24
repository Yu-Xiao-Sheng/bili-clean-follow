"""Score each follow into keep / review / remove with a human-readable reason.

FOR-36 口径（CTO ADR r2：缺失信号按「未知」处理，绝不按「最差」处理）：

1. **归一化**：只对已提供的信号求加权平均，
   ``score = sum(w_k * p_k) / sum(w_k)``，分母只含已提供信号的权重。
   一个信号都没有时 score = 0.0。未知不等于最差。
2. **闸门 A（取关方向）**：recency 未知 -> 不得判 remove，最多 review，
   并追加原因行 ``downgraded to review: no recency signal``。
3. **闸门 B（保留方向）**：keep 至少要提供 recency 或 authority 之一；
   只有 relevance（简介 / 官方认证字段）时不得 keep，最多 review。
4. **可观测性**：``signals_used`` 与 ``missing_signals`` 是一对互补的信号名列表
   （值域 recency / authority / relevance，分号连接、顺序固定，全缺时为空串），
   随结果一起导出到 CSV / Markdown / Web 报告。ADR r2 §3.4：数据层不存 0-3 整数，
   要计数由消费方自己数列表元素，避免导出层与 score 层各存一份、彼此漂移。

ADR 明确禁止的绕法：不许靠调低 REVIEW_MIN / KEEP_MIN 把信号缺失糊过去。
"""

import math
from typing import Dict, List, Tuple

from .model import Class, FollowRecord

# Tunable weights. Weights are per-signal; only the *provided* signals take part
# in the average (FOR-36): the denominator is the weight sum of provided signals,
# so a missing signal is unknown, not a zero score.
WEIGHTS = {
    "recency": 0.45,     # how recently you saw them / they posted
    "authority": 0.30,   # follower/following ratio -> niche/quality proxy
    "relevance": 0.25,   # bio + official certification signals
}

# Fixed signal order (used for signals_used / missing_signals and stable reasons).
SIGNALS = ("recency", "authority", "relevance")

REVIEW_MIN = 0.40
KEEP_MIN = 0.70

# 简介关键词兜底（FOR-37：官方认证优先认 official / official_verify 字段，
# 只有拿不到认证块时才退回简介文案关键词，换个 bio 就不会掉认证）。
OFFICIAL_BIOS = ("官方", "认证", "verified", "official", "媒体", "传媒", "工作室")

# extra 里由 model 落下来的官方认证字段（FOR-37 口径）。
OFFICIAL_EXTRA_KEYS = ("official_title", "official_role", "official_department")

# 闸门 A 的固定原因行（CTO 验收按这个字符串找）。
GATE_A_REASON = "downgraded to review: no recency signal"
# 闸门 B 的原因行。
GATE_B_REASON = "downgraded to review: keep needs recency or authority"

# 原因行里 signals_used 的显示值（全缺时不写空串，避免读起来像截断）。
NO_SIGNAL_LABEL = "none"


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
    return _clamp01(math.log10(ratio + 1.0) / 3.0)


def official_evidence(record: FollowRecord) -> str:
    """官方/认证证据文本（FOR-37）：先认 official / official_verify 字段。

    model.FollowRecord.from_dict 已把 B站 真实响应里的 official.role/title/department
    （以及 official_verify.type）落到 extra.official_*。没有认证块时才退回简介关键词，
    返回值用于原因行显示（有块就显示块里的文案）。
    """
    extra = record.extra or {}
    for key in OFFICIAL_EXTRA_KEYS:
        value = str(extra.get(key) or "").strip()
        if value:
            return value
    if extra.get("official_verified"):
        return "verified"
    return ""


def _official_by_bio(record: FollowRecord) -> bool:
    bio = (record.bio or "").strip().lower()
    if not bio:
        return False
    return any(k.lower() in bio for k in OFFICIAL_BIOS)


def _relevance_signal(record: FollowRecord) -> float:
    bio = (record.bio or "").strip()
    official = bool(official_evidence(record)) or _official_by_bio(record)
    official_score = 1.0 if official else 0.0
    if not bio:
        # 没有简介但有官方认证块：认证本身仍是相关性证据，只是简介质量记 0。
        return 0.6 * 0.0 + 0.4 * official_score
    s = len(bio)
    bio_quality = 1.0 if s >= 12 else _clamp01(s / 12.0)
    return 0.6 * bio_quality + 0.4 * official_score


def _provided(record: FollowRecord, name: str) -> bool:
    if name == "recency":
        return record.last_seen_days is not None or record.last_video_days is not None
    if name == "authority":
        return record.follower_count is not None and record.following_count is not None
    if name == "relevance":
        # 简介为空但有 official / official_verify 认证块，也算提供了相关性信号。
        return bool((record.bio or "").strip()) or bool(official_evidence(record))
    return False


def provided_signals(record: FollowRecord) -> List[str]:
    """The signal names this record actually carries (stable order)."""
    return [name for name in SIGNALS if _provided(record, name)]


def signals_used(record: FollowRecord) -> List[str]:
    """已提供信号名列表（ADR r2 §3.4 唯一形态：recency;authority;relevance）。"""
    return provided_signals(record)


def missing_signals(record: FollowRecord) -> List[str]:
    """未提供信号名列表 - signals_used 的补集，两者互补且互不相交。"""
    used = set(provided_signals(record))
    return [name for name in SIGNALS if name not in used]


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


def _official_note(record: FollowRecord) -> str:
    evidence = official_evidence(record)
    if evidence:
        return "yes (%s)" % evidence[:40]
    return "yes" if _official_by_bio(record) else "no"


def _relevance_note(record: FollowRecord, parts: Dict[str, float]) -> str:
    if "relevance" not in parts:
        return "relevance: no bio and no official block (unknown)"
    bio = (record.bio or "").strip()
    return "relevance: %d-char bio (official=%s)" % (len(bio), _official_note(record))


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
    # 闸门 B：只有简介 / 认证块（relevance）不足以支撑 keep。
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
    reasons.append(_relevance_note(record, parts))
    reasons.extend(notes)
    used = signals_used(record)
    reasons.append("class=%s score=%.2f signals_used=%s for %s" % (
        cls.value, score, ";".join(used) if used else NO_SIGNAL_LABEL, record.nickname))
    return cls, score, reasons