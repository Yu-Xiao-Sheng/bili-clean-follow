"""Score each follow into keep / review / remove with a human-readable reason."""

from typing import List, Tuple

from .model import Class, FollowRecord

# Tunable weights. Weights are per-signal; missing signals are simply skipped
# (contribute 0), so a follow with fewer known signals tends toward review/remove.
WEIGHTS = {
    "recency": 0.45,     # how recently you saw them / they posted
    "authority": 0.30,   # follower/following ratio -> niche/quality proxy
    "relevance": 0.25,   # bio signals (official/verified keywords, length)
}

REVIEW_MIN = 0.40
KEEP_MIN = 0.70

OFFICIAL_BIOS = ("官方", "认证", "verified", "official", "媒体", "传媒", "工作室")


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


def classify(record: FollowRecord) -> Tuple[Class, float, List[str]]:
    """Return (class, score, [reasons]). Unknown signals are skipped (neutral)."""
    parts = {}
    for k in WEIGHTS:
        if _provided(record, k):
            if k == "recency":
                d = record.last_seen_days if record.last_seen_days is not None else record.last_video_days
                parts[k] = _recency_signal(d)
            elif k == "authority":
                parts[k] = _authority_signal(record)
            elif k == "relevance":
                parts[k] = _relevance_signal(record)
        else:
            parts[k] = 0.0

    score = sum(WEIGHTS[k] * parts[k] for k in WEIGHTS)
    score = _clamp01(score)

    if score >= KEEP_MIN:
        cls = Class.KEEP
    elif score >= REVIEW_MIN:
        cls = Class.REVIEW
    else:
        cls = Class.REMOVE

    reasons = []
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

    top = " - ".join(r for r in reasons[:3])
    reasons.append("class=%s score=%.2f for %s" % (cls.value, score, record.nickname))
    return cls, score, reasons
