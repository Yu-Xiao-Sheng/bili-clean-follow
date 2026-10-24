"""FOR-41：真实接口形状的端到端验收（跑 CLI 子进程，不是单元测试）。

为什么要有这个文件：tests/ 里两百多项单元测试全绿，用的却是自定义形状
（follower_id / nickname / bio，且信号齐全）。真实用户喂进来的是浏览器 Network
里原样存盘的响应（code / message / data.follower + mid / name / sign / official），
以及只有 identity + bio 的最小导出。FOR-34 的实测（main=1d2629a）里同一份代码给出的是
「20/20 昵称全空 + 13/13 全 remove + GBK 控制台崩栈」。本文件把用户视角的结果钉死，
防止再退回「单元测试绿但产品不可用」。

三层 fixture（与 FOR-36 / FOR-37 的验收口径一一对应）：
(a) tests/fixture-bili-real.json      真实接口原始响应（data.follower 嵌套、中文与 emoji 昵称、official）
(b) tests/fixture-minimal.json        只有 identity + bio 的最小导出（13 条）
(c) tests/fixture-full-signals.json   补全 last_seen_days / follower_count 的导出

期望 Summary（本文件逐条断言，改代码前先在这里改期望）：
(a) keep=0 review=20 remove=0，且 CSV 20 行昵称全部非空
(b) keep=0 review=13 remove=0，且 stderr 出现缺信号警告
(c) 允许 keep 与 remove 同时出现（证明取关判定本身没被削弱）
"""

import csv
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"
FIXTURES = REPO_ROOT / "tests"

REAL = "fixture-bili-real.json"
REAL_LIST = "fixture-bili-real-list.json"
MINIMAL = "fixture-minimal.json"
FULL = "fixture-full-signals.json"
ALL_FIXTURES = [REAL, REAL_LIST, MINIMAL, FULL]

SUMMARY_RE = re.compile(r"Summary: keep=(\d+) review=(\d+) remove=(\d+)")
CSV_BOM = b"\xef\xbb\xbf"

sys.path.insert(0, str(SRC))

from bili import web  # noqa: E402
from bili.export import recency_remove_violations, run  # noqa: E402
from bili.loaders import load_from_file  # noqa: E402


def _fixture(name):
    return FIXTURES / name


def _run_cli(args, cwd, env=None):
    """Run the CLI the way docs/getting-started.md tells users to run it."""
    full = dict(os.environ)
    full["PYTHONPATH"] = str(SRC)
    full["PYTHONIOENCODING"] = "utf-8"
    if env:
        full.update(env)
    return subprocess.run(
        [sys.executable, "-m", "bili"] + [str(a) for a in args],
        cwd=str(cwd), env=full, capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=False)


def _summary(proc):
    m = SUMMARY_RE.search(proc.stderr or "")
    assert m, "stderr 缺少 Summary 行，stdout=%r stderr=%r" % (proc.stdout, proc.stderr)
    return dict(zip(("keep", "review", "remove"), (int(x) for x in m.groups())))


def _csv_rows(path):
    # Excel 口径：带 BOM 的 utf-8（utf-8-sig）。不带 BOM 时 Excel 按 GBK 猜，中文全乱。
    with io.open(str(path), "r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _record_count(name):
    data = json.loads(io.open(str(_fixture(name)), encoding="utf-8-sig").read())
    if isinstance(data, list):
        return len(data)
    for key in ("follower", "list", "items", "follow"):
        if isinstance(data.get("data"), dict) and key in data["data"]:
            return len(data["data"][key])
    raise AssertionError("fixture %s 不是预期的真实形状" % name)


def _markdown_name_cells(md_text):
    cells = []
    for line in md_text.splitlines():
        if not line.startswith("|"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 4 or not parts[1].isdigit():
            continue
        cells.append(parts[2])
    return cells


# --- (a) 真实接口原始响应：FOR-37 的用户视角断言 ------------------------------

def test_real_api_response_runs_and_every_row_has_a_name(tmp_path):
    total = _record_count(REAL)
    proc = _run_cli([_fixture(REAL), "--md", tmp_path / "report.md",
                      "--csv", tmp_path / "report.csv",
                      "--unfollow-list", tmp_path / "unfollow.txt"], cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert "Traceback" not in proc.stderr
    counts = _summary(proc)
    assert counts["keep"] + counts["review"] + counts["remove"] == total
    assert counts["remove"] == 0, "真实导出只带 identity+bio，不该有任何取关建议：%s" % counts

    raw = (tmp_path / "report.csv").read_bytes()
    assert raw.startswith(CSV_BOM), "CSV 缺 BOM，Excel 双击打开中文会乱码（FOR-38）"
    rows = _csv_rows(tmp_path / "report.csv")
    assert len(rows) == total
    blank = [r for r in rows if not (r.get("nickname") or "").strip()]
    assert not blank, "报告里昵称全空 = 用户不知道该取关谁（FOR-37 根因）"

    name_cells = _markdown_name_cells((tmp_path / "report.md").read_text(encoding="utf-8"))
    assert len(name_cells) == total
    assert all(name_cells), "Markdown 的 Name 列出现空单元格"
    assert "\U0001f600" in (tmp_path / "report.md").read_text(encoding="utf-8")
    candidates = [ln for ln in (tmp_path / "unfollow.txt")
                .read_text(encoding="utf-8-sig").splitlines()
                if ln and not ln.startswith("#")]
    assert not candidates, "remove=0 时取关清单里不该有候选行：%s" % candidates
    assert proc.stdout or proc.stderr  # 至少要有输出，别静默成功


# --- (b) 只有 identity + bio 的最小导出：FOR-36 的用户视角断言 ----------------

def test_minimal_export_is_never_a_removal_basis(tmp_path):
    total = _record_count(MINIMAL)
    proc = _run_cli([_fixture(MINIMAL), "--md", tmp_path / "report.md",
                      "--csv", tmp_path / "report.csv"], cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr
    counts = _summary(proc)
    assert counts["remove"] == 0, (
        "缺信号被当成取关证据（FOR-36 根因）：%s" % counts)
    assert counts["review"] == total
    assert "缺信号警告" in proc.stderr, "缺信号时必须在 stderr 说话"
    assert "bili-merge" in proc.stderr, "警告里必须给出下一步动作（补信号用哪条命令）"
    md = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "缺信号警告" in md, "报告正文也要自带警告，别只写在终端"


# --- (c) 补全信号的导出：取关判定本身没有被削弱 ------------------------------

def test_full_signal_export_can_still_say_remove(tmp_path):
    proc = _run_cli([_fixture(FULL), "--csv", tmp_path / "report.csv",
                      "--unfollow-list", tmp_path / "unfollow.txt"], cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr
    counts = _summary(proc)
    assert counts["keep"] >= 1, "信号齐全却一个 keep 都没有，说明归一化把分数压平了"
    assert counts["remove"] >= 1, "信号齐全还不敢给 remove，取关判定被削弱了"
    assert all((r.get("nickname") or "").strip() for r in _csv_rows(tmp_path / "report.csv"))

    lines = [ln for ln in (tmp_path / "unfollow.txt").read_text(encoding="utf-8-sig").splitlines()
             if ln and not ln.startswith("#")]
    assert len(lines) == counts["remove"]
    for line in lines:
        mid, _, nickname = line.partition("\t")
        assert mid.strip() and nickname.strip(), "取关清单必须是 mid <TAB> 昵称（FOR-38）"


# --- 跨单不变量：缺 recency 的行不得是 remove（ADR r2 闸门 A 的导出层镜像）----

@pytest.mark.parametrize("name", ALL_FIXTURES)
def test_rows_missing_recency_are_never_remove(name, tmp_path):
    proc = _run_cli([_fixture(name), "--csv", tmp_path / "out.csv"], cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr
    offenders = [r for r in _csv_rows(tmp_path / "out.csv")
                 if "recency" in (r.get("missing_signals") or "")
                 and r.get("class") == "remove"]
    assert not offenders, "CSV 里出现「缺 recency 却判 remove」：%s" % offenders
    in_proc = run(load_from_file(str(_fixture(name))))
    assert recency_remove_violations(in_proc) == []


# --- 平台维度：Windows 中文控制台（GBK）+ Excel 可读的 CSV -------------------

def test_cli_survives_a_gbk_console_end_to_end(tmp_path):
    """不写 --md，报告直接打到 GBK 控制台：FOR-38 那条崩栈路径。

    CI 里另有一个 windows-latest 的 smoke-gbk job（.github/workflows/ci.yml），
    真 Windows 控制台由那个 job 兜；这里在任何平台上用 PYTHONIOENCODING=gbk
    跑同一条路径，防止本地回归。PYTHONUTF8=0 必须显式给，否则 UTF-8 mode
    会盖掉 PYTHONIOENCODING，job 永远绿但真机照样崩。
    """
    proc = _run_cli([_fixture(REAL), "--csv", tmp_path / "out.csv"], cwd=tmp_path,
                     env={"PYTHONIOENCODING": "gbk", "PYTHONUTF8": "0"})
    assert proc.returncode == 0, proc.stderr
    assert "UnicodeEncodeError" not in proc.stderr
    assert "Traceback" not in proc.stderr
    counts = _summary(proc)
    assert counts["keep"] + counts["review"] + counts["remove"] == _record_count(REAL)
    assert all((r.get("nickname") or "").strip() for r in _csv_rows(tmp_path / "out.csv"))


# --- Web 展示层：同一份真实导出，页面上也必须能看到名字 --------------------

def test_web_page_shows_names_for_the_real_api_shape():
    results = web.load_report(str(_fixture(REAL)))
    assert len(results) == _record_count(REAL)
    html = web.build_page_html(results, web.summarize(results))
    html.encode("utf-8")
    empty = [r for r in results if not (r.get("nickname") or "").strip()]
    assert not empty, "Web 页面会出现无名行：%s" % empty
    assert "\U0001f600" in html


# --- fixture 自身的防呆：别再退回「方便但假」的形状 --------------------------

@pytest.mark.parametrize("name,keys", [
    (REAL, {"mid", "name"}),
    (REAL_LIST, {"mid", "name"}),
])
def test_real_shape_fixtures_keep_bilibili_envelope_and_fields(name, keys):
    data = json.loads(io.open(str(_fixture(name)), encoding="utf-8-sig").read())
    assert isinstance(data, dict) and isinstance(data.get("data"), dict), (
        "本单根因就是 fixture 被改成自定义形状：真实响应必须带 code/message/data 信封")
    block = data["data"]
    recs = block.get("follower") or block.get("list")
    assert recs, "真实 fixture 必须是 data.follower / data.list 嵌套"
    assert keys <= set(recs[0]), "真实 fixture 必须用 B 站字段名 mid / name"
    assert not any("nickname" in r for r in recs)


def test_minimal_fixture_really_lacks_every_signal():
    data = json.loads(io.open(str(_fixture(MINIMAL)), encoding="utf-8-sig").read())
    recs = data["data"]["follower"] if "follower" in data.get("data", {}) else data["data"]["list"]
    for rec in recs:
        for key in ("last_seen_days", "last_video_days", "follower_count", "following_count"):
            assert key not in rec, "最小导出夹具被补上信号，FOR-36 的断言就失去意义"
