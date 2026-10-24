"""渲染层测试（FOR-57，FOR-56 §5 口径）：断言落在浏览器渲染后的 DOM 上。

为什么要单独有这条文件：FOR-41 和 FOR-57 两轮都出现同一件事——
「pytest 全绿」与「真实浏览器里页面不可读」同时成立。tests/test_web.py 只看
HTTP 响应体（JSON / BOM / 状态码），看不见 fmtNum 把原值覆盖成数字（昵称 /
信号 / 粉丝比全变 NaN），也看不见徽章 class 属性未闭合把整行吞进属性。
所以这里起真服务 + headless chromium --dump-dom，对渲染出来的 <tbody> 断言。

本地没有 chromium 时跳过；CI 的 web-render job 带 BILI_REQUIRE_BROWSER=1，
那时「找不到浏览器」直接算失败，不让门禁悄悄变成空跑。
"""
import os
import sys
from pathlib import Path

import pytest

from bili import web

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
