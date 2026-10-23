"""FOR-40：bili-merge 补信号工具（bili.signals 数据层 + bili.merge_cli 入口）。

真实导出只有 identity + bio + avatar，打分要 recency / authority。这组测试覆盖：
模板预填 mid + 昵称、CSV 宽容解析、合并只填空缺、合并后重跑能出 keep/remove、
以及入口的录屏友好分步提示。全程本地，不联网。
"""

import csv
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"

sys.path.insert(0, str(SRC))

import pytest

from bili import signals
from bili.export import CSV_ENCODING
from bili.loaders import load_from_file

UTF8_ENV = dict(os.environ, PYTHONIOENCODING="utf-8")
NAMES = ["头条小哥🔥", "阿花的花园", "山河旅人", "小鹿daily", "青灯古佛", "木子Muzi",
         "风铃草", "热点速递", "拾光映像", "云归处", "晚舟夜航", "老周不写代码",
         "草木有本心", "南野拓实", "青禾记", "北海虽可追", "半盏茶", "江上清风",
         "山间明月", "松间照"]


def _run(module, args, env=None, cwd=None):
    run_env = dict(UTF8_ENV)
    run_env["PYTHONPATH"] = str(SRC)
    if env:
        run_env.update(env)
    return subprocess.run(
        [sys.executable, "-m", module, *[str(a) for a in args]],
        cwd=str(cwd or REPO_ROOT), env=run_env, capture_output=True,
        text=True, encoding="utf-8", errors="replace", check=False)


def run_merge(*args, **kw):
    return _run("bili.merge_cli", args, **kw)


def run_clean(*args, **kw):
    return _run("bili.cli", args, **kw)


def minimal_export(count=20):
    """真实导出形状：identity + bio(sign) + avatar(face)，完全没有信号列。"""
    items = []
    for i in range(count):
        items.append({
            "mid": str(22965610 + i * 7),
            "uname": NAMES[i % len(NAMES)] + str(i),
            "nickname": NAMES[i % len(NAMES)] + str(i),
            "sign": "每日更新 · 现场直击" if i % 2 == 0 else "",
            "face": "https://static.hdslb.com/images/face.png",
        })
    return items


def write_export(path, items):
    Path(path).write_text(json.dumps(items, ensure_ascii=False, indent=2),
                          encoding="utf-8")
    return path


def fill_signals(path, items, plan, extra_rows=()):
    """把模板填成用户填好的样子（plan 里 None 表示这一行留空）。"""
    with open(str(path), "w", encoding=CSV_ENCODING, newline="") as fh:
        writer = csv.writer(fh, lineterminator="\r\n")
        writer.writerow(list(signals.TEMPLATE_COLUMNS))
        for item, values in zip(items, plan):
            cells = [item["mid"], item["nickname"]]
            if values is None:
                cells += [""] * len(signals.SIGNAL_FIELDS)
            else:
                cells += ["" if v is None else v for v in values]
            writer.writerow(cells)
        for row in extra_rows:
            writer.writerow(row)
    return path


def read_csv_rows(path):
    with open(str(path), "r", encoding=CSV_ENCODING, newline="") as fh:
        return list(csv.DictReader(fh))


class TestTemplate:
    def test_template_prefills_mid_and_nickname_only(self, tmp_path):
        items = minimal_export(20)
        tpl = tmp_path / "signals.csv"
        assert signals.write_template(str(tpl), items) == 20
        rows = read_csv_rows(tpl)
        assert len(rows) == 20
        assert [r["mid"] for r in rows] == [i["mid"] for i in items]
        assert all(r["nickname"] for r in rows)
        assert "头条小哥🔥0" == rows[0]["nickname"]
        for field in signals.SIGNAL_FIELDS:
            assert all(r[field] == "" for r in rows), field

    def test_template_is_excel_friendly_utf8_sig(self, tmp_path):
        tpl = tmp_path / "signals.csv"
        signals.write_template(str(tpl), minimal_export(3))
        assert tpl.read_bytes().startswith(b"\xef\xbb\xbf")

    def test_template_carries_existing_signals(self, tmp_path):
        items = [{"mid": "1", "nickname": "已有信号", "last_seen_days": 12.0,
                  "follower_count": 900}]
        tpl = tmp_path / "signals.csv"
        signals.write_template(str(tpl), items)
        rows = read_csv_rows(tpl)
        assert rows[0]["last_seen_days"] == "12"
        assert rows[0]["follower_count"] == "900"
        assert rows[0]["last_video_days"] == ""


class TestReadSignals:
    def _tpl(self, tmp_path, text):
        path = tmp_path / "signals.csv"
        path.write_bytes(text.encode("utf-8-sig"))
        return path

    def test_accepts_alias_headers_and_blank_cells(self, tmp_path):
        path = self._tpl(tmp_path, "UID,昵称,last_seen,followers,following\n"
                                   "123,阿花,30,,120\n")
        table = signals.read_signals(str(path))
        assert table.rows["123"] == {"last_seen_days": 30.0, "following_count": 120}
        assert table.errors == []
        assert table.data_rows == 1

    def test_bad_numbers_are_reported_not_fatal(self, tmp_path):
        path = self._tpl(tmp_path, "mid,nickname,last_seen_days,follower_count\n"
                                   "1,阿花,最近吧,500\n2,木子,60,abc\n")
        table = signals.read_signals(str(path))
        assert table.rows["1"] == {"follower_count": 500}
        assert table.rows["2"] == {"last_seen_days": 60.0}
        assert any("不是数字" in e for e in table.errors)
        assert len(table.errors) == 2

    def test_thousands_separators_are_tolerated(self, tmp_path):
        path = self._tpl(tmp_path, "mid,follower_count,following_count\n1,\"1,234\",\"3,000\"\n")
        table = signals.read_signals(str(path))
        assert table.rows["1"]["follower_count"] == 1234
        assert table.rows["1"]["following_count"] == 3000

    def test_missing_mid_column_says_what_to_do(self, tmp_path):
        path = self._tpl(tmp_path, "nickname,last_seen_days\n阿花,10\n")
        with pytest.raises(signals.SignalError) as exc:
            signals.read_signals(str(path))
        assert "mid" in str(exc.value)
        assert "--template" in str(exc.value)

    def test_header_only_is_actionable(self, tmp_path):
        path = self._tpl(tmp_path, "mid,nickname,last_seen_days\n")
        with pytest.raises(signals.SignalError) as exc:
            signals.read_signals(str(path))
        assert "--template" in str(exc.value)

    def test_duplicate_mid_and_missing_mid_are_flagged(self, tmp_path):
        path = self._tpl(tmp_path, "mid,last_seen_days\n1,10\n,20\n1,30\n")
        table = signals.read_signals(str(path))
        assert table.rows["1"]["last_seen_days"] == 30.0
        assert any("重复" in e for e in table.errors)
        assert any("mid 是空的" in e for e in table.errors)


class TestMerge:
    def test_fills_gaps_without_overwriting_by_default(self):
        items = [{"mid": "1", "nickname": "a", "last_seen_days": 5.0},
                 {"mid": "2", "nickname": "b"}]
        table = signals.SignalTable({"1": {"last_seen_days": 90.0, "follower_count": 700},
                                     "2": {"last_seen_days": 40.0}}, [], 2, 0)
        merged, stats = signals.merge(items, table)
        assert merged[0]["last_seen_days"] == 5.0        # 已有值不动
        assert merged[0]["follower_count"] == 700
        assert merged[1]["last_seen_days"] == 40.0
        assert stats["added"] == 2 and stats["overwritten"] == 0

    def test_overwrite_flag_replaces_existing_values(self):
        items = [{"mid": "1", "nickname": "a", "last_seen_days": 5.0}]
        table = signals.SignalTable({"1": {"last_seen_days": 90.0}}, [], 1, 0)
        merged, stats = signals.merge(items, table, overwrite=True)
        assert merged[0]["last_seen_days"] == 90.0
        assert stats["overwritten"] == 1

    def test_unknown_mid_is_reported_and_nothing_invented(self):
        items = [{"mid": "1", "nickname": "a"}]
        table = signals.SignalTable({"99999999": {"last_seen_days": 1.0}}, [], 1, 0)
        merged, stats = signals.merge(items, table)
        assert stats["unknown_mid"] == ["99999999"]
        assert "last_seen_days" not in merged[0]

    def test_blank_rows_stay_unknown_in_the_merged_file(self, tmp_path):
        items = minimal_export(4)
        table = signals.SignalTable({"22965610": {"last_seen_days": 5.0}}, [], 4, 3)
        merged, stats = signals.merge(items, table)
        assert stats["untouched"] == 3
        assert all("last_seen_days" not in m for m in merged[1:])

    def test_merged_output_keeps_original_fields(self, tmp_path):
        items = minimal_export(3)
        table = signals.SignalTable({"22965624": {"follower_count": 10}}, [], 1, 0)
        merged, _ = signals.merge(items, table)
        out = tmp_path / "follows.merged.json"
        signals.dump_merged(merged, str(out))
        recs = load_from_file(str(out))
        assert len(recs) == 3
        assert recs[0].nickname and recs[2].bio            # uname/sign 没被吃掉
        assert out.read_text(encoding="utf-8").count("static.hdslb.com") == 3


class TestMergeCli:
    def test_usage_without_template_or_signals_exit_2(self, tmp_path):
        src = write_export(tmp_path / "follows.json", minimal_export(3))
        out = run_merge(src, cwd=tmp_path)
        assert out.returncode == 2
        assert "第 1 步" in out.stdout
        assert "--template" in out.stdout

    def test_template_and_merge_round_trip_is_screen_friendly(self, tmp_path):
        items = minimal_export(20)
        src = write_export(tmp_path / "follows.json", items)
        tpl = tmp_path / "signals.csv"
        step1 = run_merge(src, "--template", tpl, cwd=tmp_path)
        assert step1.returncode == 0, step1.stderr
        assert "第 1 步" in step1.stdout and "utf-8 BOM" in step1.stdout
        assert "last_seen_days" in step1.stdout and "个人主页" in step1.stdout
        rows = read_csv_rows(tpl)
        assert len(rows) == 20 and rows[0]["nickname"]

        plan = ([(5, 3, 120000, 40)] * 8) + ([(600, 700, 60, 5000)] * 6) \
            + ([(150, 170, 2000, 300)] * 6)
        fill_signals(tpl, items, plan)
        step2 = run_merge(src, "--signals", tpl, cwd=tmp_path)
        assert step2.returncode == 0, step2.stderr
        assert "第 2 步" in step2.stdout and "第 3 步" in step2.stdout
        assert "Summary: merged_rows=20" in step2.stdout
        assert "不构成取关建议" in step2.stdout
        merged = tmp_path / "follows.merged.json"
        assert merged.is_file(), step2.stdout

    def test_merged_export_reproduces_keep_and_evidenced_remove(self, tmp_path):
        items = minimal_export(20)
        src = write_export(tmp_path / "follows.json", items)
        tpl = tmp_path / "signals.csv"
        assert run_merge(src, "--template", tpl, cwd=tmp_path).returncode == 0
        plan = ([(5, 3, 120000, 40)] * 8) + ([(600, 700, 60, 5000)] * 6) \
            + ([(150, 170, 2000, 300)] * 6)
        fill_signals(tpl, items, plan)
        merged = tmp_path / "follows.merged.json"
        assert run_merge(src, "--signals", tpl, "--out", merged,
                         cwd=tmp_path).returncode == 0
        recs = load_from_file(str(merged))
        assert len(recs) == 20
        assert all(r.last_seen_days is not None for r in recs)

        run = run_clean(merged, "--csv", tmp_path / "report.csv", "--md",
                        tmp_path / "report.md", cwd=tmp_path)
        assert run.returncode == 0, run.stderr
        rows = read_csv_rows(tmp_path / "report.csv")
        counts = {}
        for row in rows:
            counts[row["class"]] = counts.get(row["class"], 0) + 1
        assert counts.get("keep", 0) > 0, counts
        assert counts.get("remove", 0) > 0, counts
        # FOR-36 口径：判 remove 必须带真实 recency 依据，不能拿「未知」当证据。
        for row in rows:
            if row["class"] == "remove":
                assert row["last_seen_days"] or row["last_video_days"], row
        md = (tmp_path / "report.md").read_text(encoding="utf-8")
        assert "recency: seen" in md

    def test_refuses_to_overwrite_the_original_export(self, tmp_path):
        src = write_export(tmp_path / "follows.json", minimal_export(2))
        tpl = tmp_path / "signals.csv"
        run_merge(src, "--template", tpl, cwd=tmp_path)
        fill_signals(tpl, minimal_export(2), [(1, 1, 10, 5), (2, 2, 20, 6)])
        out = run_merge(src, "--signals", tpl, "--out", src, cwd=tmp_path)
        assert out.returncode == 2
        assert "不想覆盖" in out.stderr or "不想覆盖" in out.stdout

    def test_unknown_mid_and_dirty_cells_produce_hints_not_tracebacks(self, tmp_path):
        items = minimal_export(2)
        src = write_export(tmp_path / "follows.json", items)
        tpl = tmp_path / "signals.csv"
        run_merge(src, "--template", tpl, cwd=tmp_path)
        fill_signals(tpl, items, [("x", 1, 10, 5), (None, None, None, None)],
                     extra_rows=[["99999999", "抄错了", 7, 7, 7, 7]])
        out = run_merge(src, "--signals", tpl, cwd=tmp_path)
        assert out.returncode == 0, out.stderr
        assert "Traceback" not in out.stderr
        assert "不在你的关注列表里" in out.stdout
        assert "不是数字" in out.stdout
        assert "unknown_mid=1" in out.stdout

    def test_gbk_console_with_emoji_nickname_still_works(self, tmp_path):
        src = write_export(tmp_path / "follows.json", minimal_export(3))
        tpl = tmp_path / "signals.csv"
        out = run_merge(src, "--template", tpl, cwd=tmp_path,
                        env={"PYTHONIOENCODING": "gbk"})
        assert out.returncode == 0, out.stderr
        assert "Traceback" not in out.stderr
        rows = read_csv_rows(tpl)
        assert rows[0]["nickname"].startswith("头条小哥")

    def test_cookie_content_input_is_refused(self, tmp_path):
        path = tmp_path / "export.json"
        path.write_text(json.dumps({"mid": "1", "cookies": {"SESSDATA": "x"}}),
                        encoding="utf-8")
        out = run_merge(path, "--template", tmp_path / "s.csv", cwd=tmp_path)
        assert out.returncode == 2
        assert "SESSDATA" in out.stderr
        assert "Traceback" not in out.stderr

    def test_signals_file_that_does_not_exist_says_so(self, tmp_path):
        src = write_export(tmp_path / "follows.json", minimal_export(2))
        out = run_merge(src, "--signals", tmp_path / "nope.csv", cwd=tmp_path)
        assert out.returncode == 2
        assert "Traceback" not in out.stderr
        assert "--template" in out.stderr


def test_console_script_is_declared_for_bili_merge():
    """FOR-40 的坑就是「文档里有个命令但装不出来」——必须真的进 [project.scripts]。"""
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'bili-merge = "bili.merge_cli:main"' in text