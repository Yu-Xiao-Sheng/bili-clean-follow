#!/usr/bin/env python3
"""渲染层取证脚本（FOR-57 / FOR-56 §5 口径）：断言落在浏览器渲染后的 DOM 上。

为什么要有这条脚本：tests/test_web.py 只看 HTTP 响应体（JSON / BOM / 状态码），
它全绿的同时，页面在真实浏览器里可以是完全不可读的（FOR-41 的同构失效模式）：
  * web.py 的 fmtNum() 把原值覆盖成 Number(v)，isNaN 分支再 esc(String(v))，
    于是昵称 / 信号 / 粉丝比三列在页面上显示成字面量 "NaN"；
  * web.py 的 badge() 缺属性闭合引号，浏览器把 '>' 之后一路吞进 class 属性，
    后面的单元格塌成一坨转义文本（&lt;/td&gt;&lt;td&gt;...）。
这两种坏法在 HTTP 响应体里都看不见，只有 --dump-dom 才看得见。

用法：
    python tools/probe_web_render.py                      # 默认 tests/fixture-bili-real.json
    python tools/probe_web_render.py --input <导出JSON>   # 换一份数据
    BILI_CHROME=<chromium 可执行文件> python tools/probe_web_render.py

浏览器查找顺序：环境变量 BILI_CHROME -> PATH 里的 chrome-headless-shell / chromium /
chrome -> Playwright 缓存目录里的 chromium / chrome-headless-shell。

退出码：0 = 渲染层断言全过；1 = 有断言失败；2 = 环境起不来（缺浏览器 / 服务起不来）。
"""

from __future__ import annotations

import argparse
import contextlib
import html
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
PY = sys.executable
DEFAULT_INPUT = REPO_ROOT / "tests" / "fixture-bili-real.json"
DATA_RE = re.compile(r'<script type="application/json" id="bili-data">(.*?)</script>', re.S)
HEAD_RE = re.compile(r'<tbody id="tbody">(.*?)</tbody>', re.S)
TR_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S)
TD_RE = re.compile(r"<td\b[^>]*>(.*?)</td>", re.S)
BADGE_RE = re.compile(r'<span class="b-(keep|review|remove)"')

# 单元格下标（与 web.py 的 COLS 顺序一致）。
NICK, CLS, SCORE, SIGNALS, SEEN, VIDEO, RATIO, REASON = range(8)
NCOLS = 8

# 对抗性夹具：昵称长得像数字 / 含 HTML / 为空，数字列要保留精度。
ADVERSARIAL_NICKS = ["3.14", "1e3", "<img src=x onerror=alert(1)>", ""]
ADVERSARIAL_SEEN = [3.14, 100, None, None]
ADVERSARIAL_RATIO = [(1000, 10), (50, 10), (900, 10), (None, None)]


def find_browser() -> str:
    """Locate a chromium build we can run with --dump-dom ("" when none found)."""
    env = os.environ.get("BILI_CHROME")
    if env and os.path.exists(env):
        return env
    for name in ("chrome-headless-shell", "chromium", "chromium-browser",
                 "google-chrome", "google-chrome-stable", "chrome"):
        hit = shutil.which(name)
        if hit:
            return hit
    roots = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH"),
             os.path.expanduser("~/.cache/ms-playwright"),
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "ms-playwright"),
             os.path.expanduser("~/Library/Caches/ms-playwright")]
    wanted = ("chrome-headless-shell", "chrome-headless-shell.exe",
              "headless_shell", "chrome", "chrome.exe")
    found = []
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            if "chrom" not in dirpath.lower():
                continue
            for fn in filenames:
                if fn.lower() in wanted:
                    found.append(os.path.join(dirpath, fn))
    if not found:
        return ""
    found.sort(key=lambda p: (0 if "headless" in p.lower() else 1, p))
    return found[0]


def adversarial_fixture(path) -> list:
    """写一份「昵称像数字 / 含 HTML / 为空」的导出，用来钉文本列与数字列的显示。"""
    follower = []
    for i, nick in enumerate(ADVERSARIAL_NICKS):
        rec = {"mid": 40000 + i, "name": nick, "sign": "对抗性夹具 %d" % i,
               "last_seen_days": ADVERSARIAL_SEEN[i]}
        fans, follows = ADVERSARIAL_RATIO[i]
        if fans is not None:
            rec["follower_count"] = fans
            rec["following_count"] = follows
        follower.append(rec)
    payload = {"code": 0, "data": {"follower": follower, "total": len(follower)}}
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return follower


def start_server(input_path, port: int) -> subprocess.Popen:
    env = dict(os.environ, PYTHONPATH=str(REPO_ROOT / "src"), PYTHONUTF8="1")
    return subprocess.Popen(
        [PY, "-m", "bili.web", "--input", str(input_path), "--port", str(port)],
        cwd=str(REPO_ROOT), env=env, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")


def wait_health(port: int, timeout: float = 20.0) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with opener.open("http://127.0.0.1:%d/api/health" % port, timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def api_rows(port: int) -> list:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:%d/api/results" % port, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))["rows"]


def dump_dom(browser: str, url: str, profile: str) -> str:
    out = subprocess.run(
        [browser, "--headless", "--disable-gpu", "--no-sandbox",
         "--user-data-dir=" + profile, "--virtual-time-budget=8000",
         "--dump-dom", url],
        capture_output=True, timeout=180, env=dict(os.environ, PYTHONUTF8="1"))
    return out.stdout.decode("utf-8", "replace")


def embedded_rows(dom: str) -> list:
    """页面内嵌的那份行数据就是 JS 渲染表格的输入，拿它当预期最贴切。"""
    match = DATA_RE.search(dom)
    if not match:
        return []
    return json.loads(match.group(1))


def tbody_of(dom: str) -> str:
    match = HEAD_RE.search(dom)
    return match.group(1) if match else ""


def cells_of(tbody: str) -> list:
    """渲染后的每一行 -> 单元格纯文本列表（标签剥掉、实体还原）。"""
    rows = []
    for tr in TR_RE.findall(tbody):
        rows.append([html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                     for c in TD_RE.findall(tr)])
    return rows

def _cell(cells: list, idx: int) -> str:
    return cells[idx] if len(cells) > idx else "<missing>"


def _column_mismatch(label: str, col: str, idx: int, rendered: list, expected: list) -> list:
    """按「多重集」比对某一列：与排序无关，只问渲染出来的值对不对。"""
    got = sorted(_cell(cells, idx) for cells in rendered)
    want = sorted(expected)
    if got == want:
        return []
    detail = []
    for a, b in zip(want, got):
        if a != b:
            detail.append("期望 %r 渲染成 %r" % (a, b))
            break
    return ["%s: %s 列渲染不符（%s；渲染全集 %s）"
            % (label, col, "; ".join(detail) or "条数不符", got)]


def check_render(tbody: str, rows: list, label: str) -> list:
    """渲染层断言（FOR-57 验收 1）。返回失败描述列表，空表 = 全过。"""
    fails = []
    if not tbody:
        return ["%s: 渲染后的 DOM 里找不到 <tbody id=tbody>" % label]
    if "NaN" in tbody:
        fails.append("%s: tbody 里出现字面量 NaN（昵称/信号/粉丝比被 fmtNum 覆盖成 Number）" % label)
    if "&lt;/td" in tbody or "&lt;td" in tbody:
        fails.append("%s: tbody 里出现被转义的 td 标签（徽章 class 属性未闭合，整行被吞进属性）" % label)
    if "<img" in tbody or "<script" in tbody:
        fails.append("%s: tbody 里出现活的 img/script 标签（昵称未转义）" % label)
    dom_rows = cells_of(tbody)
    if len(dom_rows) != len(rows):
        fails.append("%s: 渲染行数 %d != 数据行数 %d" % (label, len(dom_rows), len(rows)))
    for idx, cells in enumerate(dom_rows):
        if len(cells) != NCOLS:
            fails.append("%s: 第 %d 行有 %d 个单元格（应为 %d 个）"
                         % (label, idx + 1, len(cells), NCOLS))
    badges = len(BADGE_RE.findall(tbody))
    if badges != len(dom_rows):
        fails.append("%s: 分类徽章 <span class=b-xxx> 数量 %d != 行数 %d"
                     % (label, badges, len(dom_rows)))
    blank = "\u2014"
    fails += _column_mismatch(label, "昵称", NICK, dom_rows,
                              [(r["nickname"] or blank) for r in rows])
    fails += _column_mismatch(label, "信号", SIGNALS, dom_rows,
                              [(r["signals_used"] or blank) for r in rows])
    fails += _column_mismatch(label, "粉丝比", RATIO, dom_rows,
                              [(r["ratio"] or blank) for r in rows])
    return fails


def check_text_and_number_columns(tbody: str, label: str) -> list:
    """文本列不再进 fmtNum，数字列保留精度，空值走占位符（FOR-57 验收 2）。"""
    fails = []
    blank = "\u2014"
    by_nick = {}
    for cells in cells_of(tbody):
        if cells:
            by_nick[_cell(cells, NICK)] = cells
    if "3.14" not in by_nick:
        fails.append("%s: 昵称 3.14 没有原样出现在昵称列（被数字格式化）" % label)
    else:
        if _cell(by_nick["3.14"], SEEN) != "3.14":
            fails.append("%s: 数值列 3.14 渲染成 %r（不得截成 3.1）"
                         % (label, _cell(by_nick["3.14"], SEEN)))
        if _cell(by_nick["3.14"], RATIO) != "1000 / 10":
            fails.append("%s: 粉丝比列渲染成 %r（应为 1000 / 10，不得进 fmtNum）"
                         % (label, _cell(by_nick["3.14"], RATIO)))
        if _cell(by_nick["3.14"], SIGNALS).lower() == "nan":
            fails.append("%s: 信号列渲染成 NaN" % label)
    if "1e3" not in by_nick:
        fails.append("%s: 昵称 1e3 没有原样出现在昵称列（被当成科学计数法变成 1000）" % label)
    elif _cell(by_nick["1e3"], SEEN) != "100":
        fails.append("%s: 数值列 100 渲染成 %r" % (label, _cell(by_nick["1e3"], SEEN)))
    if "<img src=x onerror=alert(1)>" not in by_nick:
        fails.append("%s: 含 HTML 的昵称没有原样转义成文本" % label)
    blank_row = by_nick.get(blank)
    if not blank_row:
        fails.append("%s: 空昵称没有走占位符" % label)
    elif _cell(blank_row, SEEN) != blank or _cell(blank_row, RATIO) != blank:
        fails.append("%s: 空数值列没有走占位符（last_seen=%r ratio=%r）"
                     % (label, _cell(blank_row, SEEN), _cell(blank_row, RATIO)))
    return fails

def free_port() -> int:
    """找一个空闲端口，避免和并行的测试撞车。"""
    with contextlib.closing(socket.socket(socket.AF_INET)) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def collect(input_path, port: int, browser: str, dump_out: str = "") -> dict:
    """起 bili.web -> headless chromium --dump-dom -> 收集渲染层断言所需材料。"""
    proc = start_server(input_path, port)
    tmp = tempfile.mkdtemp(prefix="bili-render-")
    try:
        if not wait_health(port):
            log = ""
            if proc.poll() is not None and proc.stdout:
                log = proc.stdout.read()[:800]
            return {"ok": False, "why": "server", "log": log, "label": pathlib.Path(input_path).name}
        api_count = len(api_rows(port))
        dom = dump_dom(browser, "http://127.0.0.1:%d/" % port, os.path.join(tmp, "profile"))
        if dump_out:
            pathlib.Path(dump_out).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(dump_out).write_text(dom, encoding="utf-8")
        tbody = tbody_of(dom)
        return {"ok": True, "label": pathlib.Path(input_path).name, "dom": dom,
                "tbody": tbody, "rows": embedded_rows(dom), "api_count": api_count,
                "dom_rows": cells_of(tbody)}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


def assertions(result: dict, check_numbers: bool = False) -> list:
    """把 collect() 的材料过一遍断言，返回失败描述列表（空表 = 全过）。"""
    if not result.get("ok"):
        return ["%s: bili.web 起不来（port 未就绪）%s"
                % (result.get("label"), result.get("log", ""))]
    label = result["label"]
    if not result["rows"]:
        return ["%s: 页面里嵌进去的 bili-data JSON 解析不出行" % label]
    if len(result["rows"]) != result["api_count"]:
        return ["%s: 页面内嵌数据 %d 行 != /api/results %d 行"
                % (label, len(result["rows"]), result["api_count"])]
    fails = check_render(result["tbody"], result["rows"], label)
    if check_numbers:
        fails += check_text_and_number_columns(result["tbody"], label)
    return fails


def print_report(result: dict, check_numbers: bool = False, dom_chars: int = 1500) -> None:
    if not result.get("ok"):
        print("[probe] %s: bili.web 起不来\n%s" % (result.get("label"), result.get("log", "")))
        return
    tbody = result["tbody"]
    dom_rows = result["dom_rows"]
    print("[probe] %s：api 行 %d，内嵌行 %d，渲染行 %d"
          % (result["label"], result["api_count"], len(result["rows"]), len(dom_rows)))
    print("[probe] 含字面量 NaN: %s | 含被转义 td: %s | 含活的 img: %s"
          % ("NaN" in tbody, "&lt;/td" in tbody, "<img" in tbody))
    for row in result["rows"]:
        if any(ord(ch) > 0xFFFF for ch in row["nickname"]):
            print("[probe] emoji 昵称 %r 原样渲染: %s" % (row["nickname"], row["nickname"] in tbody))
    print("[probe] tbody 首行第一列: %r"
          % (_cell(dom_rows[0], NICK) if dom_rows else "<no row>"))
    print("[probe] 渲染后 tbody 原文（前 %d 字）:" % dom_chars)
    print(tbody[:dom_chars] if tbody else "<找不到 tbody；dom_len=%d>" % len(result["dom"]))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", default=str(DEFAULT_INPUT))
    ap.add_argument("--port", type=int, default=0, help="0 = 自动挑空闲端口")
    ap.add_argument("--dump-out", default="", help="整页 dump-dom 存这个文件，便于贴证据")
    args = ap.parse_args(argv)

    browser = find_browser()
    if not browser:
        print("[probe] 找不到 chromium：装一个 Playwright chromium，或设 BILI_CHROME=<可执行文件>")
        return 2
    print("[probe] browser = %s" % browser)

    port = args.port or free_port()
    result = collect(args.input, port, browser, args.dump_out)
    print_report(result)
    rc = 0
    fails = assertions(result)
    if fails:
        print("[probe] 失败 %d 项:" % len(fails))
        for item in fails:
            print("  FAIL  %s" % item)
        rc = 1
    else:
        print("[probe] 渲染层断言全部通过")

    adversarial = REPO_ROOT / "tmp" / "fixture-adversarial.json"
    adversarial_fixture(adversarial)
    adv = collect(adversarial, port + 1 if args.port else free_port(), browser)
    print_report(adv)
    adv_fails = assertions(adv, check_numbers=True)
    if adv_fails:
        print("[probe] 失败 %d 项:" % len(adv_fails))
        for item in adv_fails:
            print("  FAIL  %s" % item)
        rc = 1
    else:
        print("[probe] 渲染层断言全部通过")
    return rc


if __name__ == "__main__":
    sys.exit(main())
