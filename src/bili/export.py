"""Human-readable exports of the cleaning report (Markdown + CSV)."""

import csv
import io
from typing import List

from .model import FollowRecord
from .score import classify, missing_signals, signals_used

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


# --- FOR-36 可观测性：缺 recency 的行数与报告顶部警告 -------------------------
# 真实导出（docs/getting-started.md 3 节）只有 identity + bio，recency 与 authority
# 全靠用户补。当 >=50% 的记录连 recency 都没有时，这份报告只能排序，不能作为
# 取关依据 - 必须在 md / Web 报告顶部显式说出来，别让用户拿着它去取关。
MISSING_RECENCY_WARN_RATIO = 0.5

# 显示层：MD 与 Web 在中文下把「一个信号都没有」统一显示成「未知」（ADR r2 §3.4）。
# CSV 数据层不翻译：signals_used 存信号名（全缺时是空串），missing_signals 存补集。
UNKNOWN_SIGNAL_LABEL = "未知"

SIGNAL_FILL_HINT = (
    "先补 last_seen_days / last_video_days / follower_count / following_count"
    "（bili-merge 会生成已预填 mid + 昵称的待填模板），否则结果不可作为取关依据。"
    " Fill those signals (bili-merge writes the fill-in template) before using this"
    " report as an unfollow basis."
)


def _signal_names(row: dict, key: str) -> List[str]:
    """Split a semicolon-joined signal-name cell back into a list."""
    return [x for x in str(row.get(key, "") or "").split(";") if x]


def signal_display(row: dict) -> str:
    """缺信号显示串（MD 与 Web 共用同一份，ADR r2 §3.4：两处必须完全相等）。

    CSV 数据层不用它 - CSV 存 signals_used / missing_signals 两个原始字段。
    """
    used = _signal_names(row, "signals_used")
    return ";".join(used) if used else UNKNOWN_SIGNAL_LABEL


def recency_missing(result: dict) -> bool:
    """True when a result row carries no recency signal at all."""
    missing = _signal_names(result, "missing_signals")
    if missing:
        return "recency" in missing
    used = _signal_names(result, "signals_used")
    if used:
        return "recency" not in used
    return (result.get("last_seen_days") is None
            and result.get("last_video_days") is None)


def missing_recency_count(results: List[dict]) -> int:
    return sum(1 for r in results if recency_missing(r))


def recency_remove_violations(results: List[dict]) -> List[dict]:
    """导出层不变量（ADR r2 §4）：缺 recency 的行不得是 remove。

    闸门 A 已在 score 层实现，这里把同一条规则抬到导出层做自检，
    FOR-41 的端到端套件直接断言这个函数返回空列表。
    """
    bad = []
    for r in results:
        if r.get("class") == "remove" and recency_missing(r):
            bad.append(r)
    return bad


def signal_warning(results: List[dict]) -> str:
    """One-line warning when most rows lack recency ("" = nothing to warn)."""
    total = len(results)
    if not total:
        return ""
    missing = missing_recency_count(results)
    if (missing / float(total)) < MISSING_RECENCY_WARN_RATIO:
        return ""
    return ("缺信号警告 missing-signal warning: %d/%d (%d%%) 的记录没有 recency 信号。%s"
            % (missing, total, int(round(100.0 * missing / total)), SIGNAL_FILL_HINT))


def run(records: List[FollowRecord]) -> List[dict]:
    """Classify all records, returning a list of result dicts ready to export."""
    out = []
    for rec in records:
        cls, score, reasons = classify(rec)
        # FOR-36 / ADR r2 §3.4：两个互补的信号名列表（顺序固定 recency;authority;relevance），
        # 数据层不落整数，计数由消费方数列表元素。
        used = signals_used(rec)
        missing = missing_signals(rec)
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
            "signals_used": ";".join(used),
            "missing_signals": ";".join(missing),
        })
    return out


def to_markdown(results: List[dict]) -> str:
    lines = ["# Bili Clean Follow Report", "",
             "Total follows: %d" % len(results), ""]
    warning = signal_warning(results)
    if warning:
        lines.append("> %s" % warning)
        lines.append("")
    by_class = {}
    for r in results:
        by_class.setdefault(r["class"], []).append(r)
    for cls in ("keep", "review", "remove"):
        group = by_class.get(cls, [])
        lines.append("## %s (%d)" % (cls.upper(), len(group)))
        lines.append("")
        lines.append("| # | Name | Score | Signals | Last seen (d) | Last video (d) | Reason |")
        lines.append("|---|:---|---:|---:|---:|---:|:---|")
        for i, r in enumerate(group, 1):
            lines.append("| %d | %s | %.2f | %s | %s | %s | %s |" % (
                i, r["nickname"], r["score"], signal_display(r),
                _fmt(r["last_seen_days"]), _fmt(r["last_video_days"]),
                _clean_pipe(str(r["reason"][:120]))))
        lines.append("")
    return "\n".join(lines)


def to_csv(results: List[dict]) -> str:
    fields = ["follower_id", "nickname", "class", "score",
              "last_seen_days", "last_video_days", "follower_count", "following_count",
              "signals_used", "missing_signals"]
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