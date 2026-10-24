"""FOR-36 端到端口径验收：真实导出（只有 identity+bio）不再一边倒 remove。

夹具就是发布门脚本 growth/verify-v012-gates.ps1 用的那几份，所以这里的数字与发布门
G3 / G5 / G6 / G13 / G14 / G15 同一批数据（CTO 会 clean-room 复跑前两条，ADR §4）：
  * fixture-minimal.json         13 条，只有 mid / uname / sign（code + data.follower 信封）
  * fixture-full-signals.json     6 条，last_seen / last_video / follower / following 齐全
  * fixture-bili-real.json       20 条，浏览器复制的真实响应（data.follower + official 块）
  * fixture-bili-real-list.json  同上，但包装是 data.list
"""
import csv
import io
import os
import subprocess
import sys
from pathlib import Path

import pytest

from bili.export import (UNKNOWN_SIGNAL_LABEL, missing_recency_count,
                         recency_remove_violations, run, signal_display,
                         signal_warning, to_csv, to_markdown, to_unfollow_list)
from bili.loaders import load_from_file
from bili.web import _display_rows

SIGNALS = ("recency", "authority", "relevance")

TESTS = Path(__file__).resolve().parent
REPO_ROOT = TESTS.parent
MINIMAL = TESTS / "fixture-minimal.json"
FULL = TESTS / "fixture-full-signals.json"
REAL = TESTS / "fixture-bili-real.json"
REAL_LIST = TESTS / "fixture-bili-real-list.json"

FIXTURES = (MINIMAL, FULL, REAL, REAL_LIST)

UTF8_ENV = dict(os.environ, PYTHONIOENCODING="utf-8",
                PYTHONPATH=str(REPO_ROOT / "src"))


def results_for(path):
    return run(load_from_file(str(path)))


def counts(results):
    return {k: sum(1 for r in results if r["class"] == k)
            for k in ("keep", "review", "remove")}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "bili.cli", *[str(a) for a in args]],
        cwd=str(REPO_ROOT), env=UTF8_ENV, capture_output=True,
        text=True, encoding="utf-8", errors="replace", check=False)


def summary_line(text):
    for line in text.splitlines():
        if line.startswith("Summary:"):
            return line.strip()
    return ""


class TestMinimalIdentityBioExport:
    """硬验收 1 / 发布门 G3：13 条 identity+bio -> keep=0 review=13 remove=0。"""

    def test_no_wall_of_remove(self):
        assert counts(results_for(MINIMAL)) == {"keep": 0, "review": 13, "remove": 0}

    def test_official_bio_row_is_not_kept(self):
        # 闸门 B：那条「官方认证的媒体账号」分数最高也只能进 review。
        rows = [r for r in results_for(MINIMAL) if str(r["mid"]) == "300548"]
        assert len(rows) == 1
        assert rows[0]["class"] == "review"
        assert any("keep needs recency or authority" in str(x)
                   for x in rows[0]["reason"])

    def test_rows_report_their_own_signals(self):
        assert {r["signals_used"] for r in results_for(MINIMAL)} <= {"", "relevance"}

    def test_report_carries_the_missing_signal_warning(self):
        md = to_markdown(results_for(MINIMAL))
        assert "13/13 (100%) 的记录没有 recency 信号" in md
        assert "不可作为取关依据" in md

    def test_unfollow_list_is_empty_for_a_thin_export(self):
        text = to_unfollow_list(results_for(MINIMAL))
        assert [ln for ln in text.splitlines() if ln and not ln.startswith("#")] == []


class TestFullSignalExport:
    """硬验收 2 / 发布门 G5 + G6：补全信号后 keep 与 remove 都还要能出现。"""

    def test_keep_and_remove_are_both_reachable(self):
        c = counts(results_for(FULL))
        assert c["keep"] >= 1 and c["remove"] >= 1
        assert c == {"keep": 1, "review": 1, "remove": 4}

    def test_the_stale_rows_are_the_removed_ones(self):
        res = {str(r["mid"]): r for r in results_for(FULL)}
        assert res["400001"]["class"] == "keep"
        assert res["400003"]["class"] == "remove"
        assert res["400004"]["class"] == "remove"

    def test_no_warning_when_recency_is_known(self):
        assert missing_recency_count(results_for(FULL)) == 0
        assert signal_warning(results_for(FULL)) == ""

    def test_signals_column_is_full(self):
        assert all(r["signals_used"] in ("recency;authority",
                                         "recency;authority;relevance")
                   for r in results_for(FULL))
        assert all(r["missing_signals"] in ("", "relevance")
                   for r in results_for(FULL))


class TestRealBilibiliExport:
    """FOR-37 / 发布门 G13-G15：真实形状（含 official 块）跑通且昵称不空。"""

    @pytest.mark.parametrize("path", [REAL, REAL_LIST])
    def test_wrapper_shapes_load_and_are_all_review(self, path):
        results = results_for(path)
        assert len(results) == 20
        assert counts(results) == {"keep": 0, "review": 20, "remove": 0}
        assert all(str(r["nickname"]).strip() for r in results)

    def test_certified_accounts_get_the_relevance_signal(self):
        res = {int(r["mid"]): r for r in results_for(REAL)}
        # official.role/title 认出来了，所以简介为空也算 relevance 已提供。
        for mid in (22000, 22001, 22017):
            assert "relevance" in res[mid]["signals_used"]

    def test_uncertified_rows_declare_everything_missing(self):
        res = {int(r["mid"]): r for r in results_for(REAL)}
        assert res[22002]["signals_used"] == ""
        assert res[22002]["missing_signals"] == "recency;authority;relevance"


class TestExportLayerInvariants:
    """ADR r2 §3.4 + §4：四份夹具都要满足的导出层不变量。"""

    @pytest.mark.parametrize("path", FIXTURES)
    def test_signals_used_and_missing_are_complementary(self, path):
        for r in results_for(path):
            used = set(x for x in r["signals_used"].split(";") if x)
            missing = set(x for x in r["missing_signals"].split(";") if x)
            assert used & missing == set()
            assert used | missing == set(SIGNALS)

    @pytest.mark.parametrize("path", FIXTURES)
    def test_no_remove_row_lacks_recency(self, path):
        # 导出层再断一次闸门 A：缺 recency 的行不能是 remove。
        assert recency_remove_violations(results_for(path)) == []

    @pytest.mark.parametrize("path", FIXTURES)
    def test_csv_carries_both_signal_columns(self, path):
        text = to_csv(results_for(path))
        header = text.splitlines()[0]
        assert "signals_used" in header and "missing_signals" in header
        assert "class" in header

    @pytest.mark.parametrize("path", FIXTURES)
    def test_markdown_and_web_show_the_same_string(self, path):
        # ADR r2 §3.4：显示层措辞只有一份（MD 与 Web 完全相等）。
        results = results_for(path)
        md = to_markdown(results)
        shown = set(r["signals_used"] for r in _display_rows(results))
        assert shown == set(signal_display(r) for r in results)
        for value in shown:
            assert value in md

    def test_minimal_rows_declare_recency_missing(self):
        for r in results_for(MINIMAL):
            assert "recency" in r["missing_signals"]

    def test_signal_names_are_not_translated_in_the_csv(self):
        # ADR r2 §3.4：CSV 数据层存信号名（不翻译）；「未知」只属于显示层。
        text = to_csv(results_for(MINIMAL))
        assert UNKNOWN_SIGNAL_LABEL not in text
        allowed = set(SIGNALS)
        for r in csv.DictReader(io.StringIO(text)):
            for cell in (r["signals_used"], r["missing_signals"]):
                assert set(x for x in cell.split(";") if x) <= allowed


class TestThroughTheCli:
    """CTO clean-room 的命令形状：python -m bili <文件> --md ... --csv ..."""

    def test_summary_line_for_a_thin_export(self, tmp_path):
        out = run_cli(MINIMAL, "--md", tmp_path / "r.md", "--csv", tmp_path / "r.csv")
        assert out.returncode == 0, out.stderr
        assert summary_line(out.stderr) == "Summary: keep=0 review=13 remove=0"
        assert "缺信号警告" in out.stderr

    def test_summary_line_for_full_signals(self, tmp_path):
        out = run_cli(FULL, "--md", tmp_path / "f.md")
        assert out.returncode == 0, out.stderr
        assert summary_line(out.stderr) == "Summary: keep=1 review=1 remove=4"
        assert "缺信号警告" not in out.stderr

    @pytest.mark.parametrize("path", [REAL, REAL_LIST])
    def test_summary_line_for_real_shapes(self, path, tmp_path):
        out = run_cli(path, "--md", tmp_path / "r.md", "--csv", tmp_path / "r.csv")
        assert out.returncode == 0, out.stderr
        assert summary_line(out.stderr) == "Summary: keep=0 review=20 remove=0"
        text = (tmp_path / "r.csv").read_bytes().decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(text)))
        assert len(rows) == 20
        assert all(r["nickname"].strip() for r in rows)
