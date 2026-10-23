"""Human-readable exports of the cleaning report (Markdown + CSV)."""

import csv
import io
from typing import List

from .model import FollowRecord
from .score import classify

# CSV 一律带 BOM（FOR-38）：Windows 记事本/Excel/WPS 双击打开没有 BOM 的 UTF-8
# 会按 GBK 猜，中文昵称全部乱码。Markdown 不需要 BOM，保持 utf-8。
CSV_ENCODING = "utf-8-sig"
TEXT_ENCODING = "utf-8"

# 取关清单抬头（CLI 与 Web 共用同一份，FOR-38：清单必须能人工对上号）。
UNFOLLOW_NOTICE = (
    "# bili-clean-follow · 取关候选清单 (unfollow candidates)\n"
    "# 这份清单只用于人工核对，工具不会自动取关。"
    "Report-only: this tool never unfollows anything by itself.\n"
    "# 每行格式 format: mid <TAB> 昵称 nickname\n"
)


def run(records: List[FollowRecord]) -> List[dict]:
    """Classify all records, returning a list of result dicts ready to export."""
    out = []
    for rec in records:
        cls, score, reasons = classify(rec)
        out.append({
            "follower_id": rec.follower_id,
            "mid": rec.mid if rec.mid is not None else rec.follower_id,
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
    fields = ["follower_id", "nickname", "class", "score",
              "last_seen_days", "last_video_days", "follower_count", "following_count"]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(results)
    return buf.getvalue()


def to_unfollow_list(results: List[dict]) -> str:
    """The REMOVE candidates as `mid <TAB> nickname` lines (FOR-38).

    只有 mid 的清单对用户没用：没人记得 22965610 是谁。带上昵称后可以直接
    在 B 站关注页搜索核对。抬头明确这是人工核对清单，不是执行清单。
    """
    lines = [UNFOLLOW_NOTICE.rstrip("\n")]
    for r in results:
        if r.get("class") != "remove":
            continue
        mid = r.get("mid") or r.get("follower_id") or ""
        nickname = str(r.get("nickname") or "").replace("\t", " ").replace("\n", " ")
        lines.append("%s\t%s" % (mid, nickname))
    return "\n".join(lines) + "\n"


def unfollow_rows(results: List[dict]) -> List[dict]:
    """The REMOVE candidates as {mid, nickname} rows (for web/UI use)."""
    return [{"mid": r.get("mid") or r.get("follower_id") or "",
             "nickname": str(r.get("nickname") or "")}
            for r in results if r.get("class") == "remove"]


def _fmt(v):
    if v is None:
        return "-"
    if isinstance(v, float) and v == int(v):
        return "%d" % int(v)
    return "%s" % v


def _clean_pipe(s):
    return s.replace("|", "\\|")
