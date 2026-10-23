"""FOR-40：离线「补信号」伴生工具的数据层。

真实导出只有 identity + bio + avatar（docs/getting-started.md §3），而打分需要
recency / authority。v0.1.1 把「手工补信号」写进文档却没有任何工具，用户跑完只
能拿到一边倒的结果。这个模块不联网、不调 API，只做两件事：

  1) 由关注列表导出生成 signals.csv 待填模板（mid + 昵称已经预填，用户只填数字）；
  2) 把用户填好的 signals.csv 合并成新的 follows.json，供 bili-clean 重跑。

口径与 FOR-36 一致：CSV 里留空 = 未知，未知不是差评依据，合并时不会写入任何值。
"""

from __future__ import annotations

import csv
import json
from typing import Dict, List, Optional, Tuple

from .export import CSV_ENCODING

# 用户要填的四列（顺序即模板列序）。
SIGNAL_FIELDS = ("last_seen_days", "last_video_days", "follower_count", "following_count")
FLOAT_FIELDS = ("last_seen_days", "last_video_days")
TEMPLATE_COLUMNS = ("mid", "nickname") + SIGNAL_FIELDS

# 表头宽容匹配：用户手改过列名、或从别处粘过来的列名，都尽量认。
_ALIASES = {
    "mid": "mid", "uid": "mid", "follower_id": "mid", "b站uid": "mid",
    "nickname": "nickname", "nick": "nickname", "name": "nickname",
    "uname": "nickname", "昵称": "nickname", "名字": "nickname",
    "last_seen_days": "last_seen_days", "last_seen": "last_seen_days",
    "last_video_days": "last_video_days", "last_video": "last_video_days",
    "follower_count": "follower_count", "followers": "follower_count",
    "follower": "follower_count", "粉丝数": "follower_count",
    "following_count": "following_count", "following": "following_count",
    "关注数": "following_count",
}


class SignalError(Exception):
    """User-fixable signals.csv / follows export problem (never a traceback)."""


def _norm_key(cell: str) -> str:
    key = str(cell or "").strip().lstrip("\ufeff").strip().lower()
    return _ALIASES.get(key, key)


def _cell(value) -> str:
    """Render an existing signal value for the template (blank = unknown)."""
    if value is None or value == "":
        return ""
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


def id_of(item: dict) -> str:
    """The Bilibili UID for a raw export item (mid first, follower_id fallback)."""
    for key in ("mid", "uid", "follower_id", "fid"):
        v = item.get(key)
        if v not in (None, ""):
            return str(v).strip()
    return ""


def nickname_of(item: dict) -> str:
    for key in ("nickname", "uname", "follower_name", "name", "title"):
        v = item.get(key)
        if v not in (None, ""):
            return str(v).strip()
    return ""


class SignalTable:
    """Parsed signals.csv: rows keyed by mid, plus what went wrong."""

    def __init__(self, rows: Dict[str, Dict[str, Optional[float]]],
                 errors: List[str], data_rows: int, blank_rows: int):
        self.rows = rows
        self.errors = errors
        self.data_rows = data_rows
        self.blank_rows = blank_rows

    def __len__(self) -> int:
        return len(self.rows)


def template_rows(items: List[dict]) -> List[dict]:
    """Template rows for *items*: mid + nickname prefilled, signals carried over."""
    rows = []
    for item in items:
        row = {"mid": id_of(item), "nickname": nickname_of(item)}
        for field in SIGNAL_FIELDS:
            row[field] = _cell(item.get(field))
        rows.append(row)
    return rows


def write_template(path: str, items: List[dict]) -> int:
    """Write an Excel-friendly (utf-8-sig BOM) signals template. Row count back."""
    rows = template_rows(items)
    with open(str(path), "w", encoding=CSV_ENCODING, newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(TEMPLATE_COLUMNS),
                               extrasaction="ignore", lineterminator="\r\n")
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def read_signals(path: str) -> SignalTable:
    """Parse a user-filled signals.csv into {mid: {field: number}} + errors.

    宽容但要说清楚：列名大小写/别名都认；空单元格按未知跳过；非数字不炸栈，
    只记一条「第 N 行 X 不是数字，已按未知处理」。
    """
    try:
        with open(str(path), "r", encoding="utf-8-sig", newline="") as fh:
            raw_rows = [r for r in csv.reader(fh) if any(str(c).strip() for c in r)]
    except OSError as exc:
        raise SignalError("读不到 signals.csv %s：%s。先用模板命令生成：\n"
                          "  bili-merge follows.json --template signals.csv"
                          % (path, exc))
    rows = [r for r in raw_rows if not str(r[0]).strip().startswith("#")]
    if len(rows) < 2:
        raise SignalError("signals.csv 只有表头或为空：请先用 "
                          "bili-merge follows.json --template signals.csv 生成模板，"
                          "再填数字。")
    header = [_norm_key(c) for c in rows[0]]
    if "mid" not in header:
        raise SignalError(
            "signals.csv 缺少 mid 列（第一列表头必须是 mid，它是 B站 用户 UID，"
            "模板里已经预填好了，别删这一列）。重新生成：\n"
            "  bili-merge follows.json --template signals.csv")
    if not any(f in header for f in SIGNAL_FIELDS):
        raise SignalError("signals.csv 里没有任何信号列。需要的列名：%s。"
                          % "、".join(SIGNAL_FIELDS))
    unknown_cols = [c for c in header if c and c not in _ALIASES.values()]
    errors: List[str] = []
    for col in unknown_cols:
        errors.append("signals.csv 第 1 行：列「%s」不认识，已忽略（可用列：%s）"
                      % (col, "、".join(["mid", "nickname"] + list(SIGNAL_FIELDS))))
    parsed: Dict[str, Dict[str, Optional[float]]] = {}
    blank = 0
    for n, row in enumerate(rows[1:], start=2):
        cells = {}
        for i, name in enumerate(header):
            if name:
                cells[name] = str(row[i]).strip() if i < len(row) else ""
        mid = cells.get("mid", "")
        if not mid:
            errors.append("signals.csv 第 %d 行：mid 是空的，已跳过" % n)
            continue
        values: Dict[str, Optional[float]] = {}
        for field in SIGNAL_FIELDS:
            raw = cells.get(field, "")
            if raw == "":
                continue
            text = raw.replace(",", "").replace("，", "").strip()
            try:
                number = float(text)
            except ValueError:
                errors.append("signals.csv 第 %d 行 %s：「%s」不是数字，已按未知处理"
                              % (n, field, raw))
                continue
            if number < 0:
                errors.append("signals.csv 第 %d 行 %s：负数（%s）没有意义，已按未知处理"
                              % (n, field, raw))
                continue
            if field in FLOAT_FIELDS:
                values[field] = float(number)
            else:
                if number != int(number):
                    errors.append("signals.csv 第 %d 行 %s：「%s」取整为 %d 使用"
                                  % (n, field, raw, int(number)))
                values[field] = int(number)
        if not values:
            blank += 1
            continue
        if mid in parsed:
            errors.append("signals.csv 第 %d 行：mid %s 重复，后一行覆盖前一行" % (n, mid))
        parsed[mid] = values
    return SignalTable(parsed, errors, len(rows) - 1, blank)


def build_index(items: List[dict]) -> Dict[str, int]:
    """mid -> item position, so a CSV row can find its record."""
    index: Dict[str, int] = {}
    for i, item in enumerate(items):
        for key in ("mid", "uid", "follower_id", "fid"):
            v = item.get(key)
            if v not in (None, ""):
                index.setdefault(str(v).strip(), i)
    return index


def merge(items: List[dict], table: SignalTable, overwrite: bool = False):
    """Apply *table* onto raw export *items* (no network, no new records).

    默认只填空缺（导出里已有的值不动）；overwrite=True 时才覆盖。返回
    (merged_items, stats)：stats 给终端 Summary 用。
    """
    index = build_index(items)
    merged = [dict(item) for item in items]
    stats = {"records": len(merged), "rows": len(table.rows), "updated": 0,
             "added": 0, "overwritten": 0, "unknown_mid": [], "untouched": 0}
    for mid, values in table.rows.items():
        pos = index.get(mid)
        if pos is None:
            stats["unknown_mid"].append(mid)
            continue
        item = merged[pos]
        touched = 0
        for field, value in values.items():
            if item.get(field) not in (None, "") and not overwrite:
                stats["overwritten"] += 0
                continue
            if item.get(field) in (None, ""):
                stats["added"] += 1
            else:
                stats["overwritten"] += 1
            item[field] = value
            touched += 1
        if touched:
            stats["updated"] += 1
    stats["untouched"] = sum(
        1 for item in merged
        if not any(item.get(f) not in (None, "") for f in SIGNAL_FIELDS))
    return merged, stats


def dump_merged(items: List[dict], path: str) -> None:
    """Write the merged export as a flat JSON array (bili-clean reads it as-is)."""
    with open(str(path), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(items, ensure_ascii=False, indent=2))


def next_step_command(merged_path: str) -> str:
    return ("bili-clean %s --md report.md --csv report.csv "
            "--unfollow-list to-unfollow.txt" % merged_path)