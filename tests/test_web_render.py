"""渲染层测试（FOR-57，FOR-56 §5 口径）：断言落在浏览器渲染后的 DOM 上。

为什么要单独有这条文件：FOR-41 和 FOR-57 两轮都出现同一件事——
「pytest 全绿」与「真实浏览器里页面不可读」同时成立。tests/test_web.py 只看
HTTP 响应体（JSON / BOM / 状态码），看不见 fmtNum 把原值覆盖成数字（昵称 /
信号 / 粉丝比全变 NaN），也看不见徽章 class 属性未闭合把整行吞进属性。
所以这里起真服务 + headless chromium --dump-dom，对渲染出来的 <tbody> 断言。

本地没有 chromium 时跳过；CI 的 web-render job 带 BILI_REQUIRE_BROWSER=1，
那时「找不到浏览器」直接算失败，不让门禁悄悄变成空跑。
"""
import json
import os
import sys
from pathlib import Path

import pytest

from bili import export, model, web

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import probe_web_render as probe  # noqa: E402

REAL_FIXTURE = REPO_ROOT / "tests" / "fixture-bili-real.json"


def _browser_or_skip():
    path = probe.find_browser()
    if path:
        return path
    if os.environ.get("BILI_REQUIRE_BROWSER"):
        pytest.fail("BILI_REQUIRE_BROWSER=1 但找不到 chromium：CI 里的浏览器装失败了")
    pytest.skip("本机没有 chromium（设 BILI_CHROME 或装一个 chromium 后再跑）")


def _render(input_path, browser):
    result = probe.collect(input_path, probe.free_port(), browser)
    assert result.get("ok"), "bili.web 起不来：%s" % result.get("log", "")
    return result


def _render_sorted(input_path, browser, sort_checks=None):
    """带排序预置的渲染：--dump-dom 不会点表头，排序列/方向从 URL 走（web.py seedSort）。"""
    if sort_checks is None:
        sort_checks = (("last_seen_days", 1), ("last_seen_days", -1),
                       ("last_video_days", 1))
    result = probe.collect(input_path, probe.free_port(), browser,
                           sort_checks=sort_checks)
    assert result.get("ok"), "bili.web 起不来：%s" % result.get("log", "")
    return result


def _assert_clean(result, check_numbers=False):
    fails = probe.assertions(result, check_numbers=check_numbers)
    if fails:
        pytest.fail("渲染层断言失败：\n  %s\n渲染后的 tbody：\n%s"
                    % ("\n  ".join(fails), result["tbody"][:2000]))


def test_real_export_renders_readable_rows():
    """FOR-57 验收 1：真实导出在浏览器里可读——昵称列是真实昵称，无 NaN、无被转义的 td。"""
    result = _render(REAL_FIXTURE, _browser_or_skip())
    _assert_clean(result)
    # 首行第一列必须是真实昵称，不是 NaN / 占位符。
    first = probe._cell(result["dom_rows"][0], probe.NICK)
    assert first and first != "NaN", "tbody 首行第一列渲染成 %r" % first
    assert first in [r["nickname"] for r in result["rows"]], \
        "tbody 首行第一列 %r 不是真实昵称" % first
    emoji = [r["nickname"] for r in result["rows"]
             if any(ord(ch) > 0xFFFF for ch in r["nickname"])]
    assert emoji, "夹具里没有含 emoji 的昵称，测试前提变了"
    for nick in emoji:
        assert nick in result["tbody"], "含 emoji 的昵称 %r 没有原样渲染" % nick


def test_number_like_nicknames_and_blank_cells_render_right(tmp_path):
    """FOR-57 验收 2：昵称列不进 fmtNum；数字列保留精度；空值走占位符。"""
    fixture = tmp_path / "adversarial.json"
    probe.adversarial_fixture(fixture)
    result = _render(fixture, _browser_or_skip())
    _assert_clean(result, check_numbers=True)


def test_source_pins_the_two_p0_snippets():
    """没有浏览器的 job 也要拦住这两次回归（真门禁是上面两条浏览器断言）。"""
    tail = web.PAGE_TAIL
    assert "v = Number(v)" not in tail, \
        "fmtNum 又把原值覆盖成数字了（FOR-57 W-1：非数字列会渲染成 NaN）"
    assert "'+'" not in tail and ("+" + chr(39) + ">" + chr(39)) not in tail, \
        "徽章 span 的 class 属性又缺闭合引号（FOR-57 W-2：整行会被吞进属性）"
    assert "fmtText" in tail, "文本列的格式化函数没了（FOR-57）"
    assert tail.count("text:1") >= 3, "昵称 / 信号 / 粉丝比三列要显式标记为文本列（FOR-57）"


def test_numeric_columns_sort_numerically(tmp_path):
    """FOR-58 验收 3：数值列按数值排 - 20 必须排在 100 前（字典序会反过来）。"""
    fixture = tmp_path / "sort-shape.json"
    probe.sort_fixture(fixture)
    result = _render_sorted(fixture, _browser_or_skip())
    _assert_clean(result)
    def nicks(page):
        return [probe._cell(cells, probe.NICK) for cells in probe.cells_of(page["tbody"])]

    asc, desc, video = result["sorts"][0], result["sorts"][1], result["sorts"][2]
    # 3.14 < 20 < 100：字典序会把 100 排到 20 前面（旧代码 state.sort 永远 undefined）。
    assert nicks(asc) == ["seen-3", "seen-20", "seen-100", "seen-none"], nicks(asc)
    assert nicks(desc) == ["seen-100", "seen-20", "seen-3", "seen-none"], nicks(desc)
    # 换一列排，行序必须跟着那一列走（5 < 30 < 200），空值永远垫到最后。
    assert nicks(video) == ["seen-3", "seen-100", "seen-20", "seen-none"], nicks(video)


def test_default_view_sorts_the_score_column_numerically(tmp_path):
    """默认视图是「得分 降序」：这一条钉住渲染顺序与得分单调（兜底回归网）。

    真正能区分数值序 / 字典序的是上面那条 last_seen_days 断言：得分都在 0..1
    且渲染成两位小数，字典序和数值序刚好同序，所以别把这条当主力。
    """
    fixture = tmp_path / "sort-shape.json"
    probe.sort_fixture(fixture)
    result = _render(fixture, _browser_or_skip())
    _assert_clean(result)
    scores = [probe._cell(cells, probe.SCORE) for cells in probe.cells_of(result["tbody"])]
    as_num = [float(s) for s in scores if s != "\\u2014"]
    assert as_num == sorted(as_num, reverse=True), "得分列按字典序排了：%s" % scores


def test_source_pins_sort_kind_from_cols():
    """没有浏览器的 job 也要拦住「数值列按字典序」（FOR-58 W-5）。"""
    tail = web.PAGE_TAIL
    assert "state.sort" not in tail, \
        "state 只有 {cls,key,dir}，读 state.sort 永远 undefined，数值列只能按字典序"
    assert "sortKind(state.key)" in tail, "排序类型必须从 COLS 查（唯一真相）"
    cols = tail.split("var COLS = [")[1].split("];")[0]
    assert cols.count("sort:'num'") == 3, "得分 / 最近活跃 / 最新视频三列要标成数值列"
    assert cols.count("sort:'str'") == 5, "其余五列按文本排"


def test_embedded_json_never_leaves_a_raw_angle_bracket():
    """昵称里的 </SCRIPT> 会提前关掉内嵌 JSON 的 script 元素（FOR-58，整页塌）。"""
    results = export.run([model.FollowRecord(follower_id="1", mid="1",
                                            nickname="x</SCRIPT><!--", bio="注入")])
    page = web.build_page_html(results, web.summarize(results))
    blob = page.split('id="bili-data">')[1].split("</script>")[0]
    assert "<" not in blob, "内嵌 JSON 里还有裸的 '<'：%r" % blob[:200]
    assert "\\u003c/script>" in blob.lower(), "闭合标签没有被转义：%r" % blob[:200]
    assert probe.DATA_RE.search(page) and json.loads(
        probe.DATA_RE.search(page).group(1))[0]["nickname"] == "x</SCRIPT><!--", \
        "内嵌数据被破坏后 JSON 解析不回来"
