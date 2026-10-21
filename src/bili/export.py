"""Human-readable exports of the cleaning report (Markdown + CSV)."""

import csv
from typing import List, Tuple

from .model import FollowRecord
from .score import classify


def run(records: List[FollowRecord]) -> List[dict]:
    """Classify all records, returning a list of result dicts ready to export."""
    out = []
    for rec in records:
        cls, score, reasons = classify(rec)
        out.append({
            "follower_id": rec.follower_id,
            "nickname": rec.nickname,
            "bio": rec.bio,
            "class": cls.value,
            "score": round(score, 3),
            "reason": reasons,
            "last_seen_days": rec.last_seen_days,
            "last_video_days": rec.last_video_days,
            "follower_count": rec.follower_count,
            "following_count": rec.following_count,
        })
    return out


def to_markdown(results: List[dict]) -> str:
    lines = ["# Bili Clean Follow Report", "",
             "Total follows: %d" % len(results), ""]
    by_class = {}
    for r in results:
        by_class.setdefault(r["class"], []).append(r)
    for cls in ("keep", "review", "remove"):
        group = by_class.get(cls, [])
        lines.append("## %s (%d)" % (cls.upper(), len(group)))
        lines.append("")
        lines.append("| # | Name | Score | Last seen (d) | Last video (d) | Reason |")
        lines.append("|---|:---|---:|---:|---:|:---|")
        for i, r in enumerate(group, 1):
            lines.append("| %d | %s | %.2f | %s | %s | %s |" % (
                i, r["nickname"], r["score"],
                _fmt(r["last_seen_days"]), _fmt(r["last_video_days"]),
                _clean_pipe(str(r["reason"][:120]))))
        lines.append("")
    return "\n".join(lines)


def to_csv(results: List[dict]) -> str:
    import io
    fields = ["follower_id", "nickname", "class", "score",
              "last_seen_days", "last_video_days", "follower_count", "following_count"]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(results)
    return buf.getvalue()


def _fmt(v):
    if v is None:
        return "-"
    if isinstance(v, float) and v == int(v):
        return "%d" % int(v)
    return "%s" % v


def _clean_pipe(s):
    return s.replace("|", "\\|")
