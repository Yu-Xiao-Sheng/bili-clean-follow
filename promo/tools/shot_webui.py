#!/usr/bin/env python3
"""用当前版本的真实 Web 报告界面重截 promo/public/webui.png。

片子里那张「本地报告」截图必须是当前版本渲染出来的，而且必须是**真的能看**的。
v0.1.2（tag = 4a229ce）的 web.py 在真实浏览器里把昵称 / 信号 / 粉丝比三列渲染成字面量
NaN，分类徽章的 span 又缺一个属性闭合引号，整行塌成转义文本（FOR-56 取证、FOR-57 修）。
那种页面照样能截出一张图，但放进片子里就是替产品演示一个坏掉的界面。
所以这里先抓一次真实浏览器渲染后的 DOM 做断言：不合格就不出图，退出码 3。
"""
from __future__ import annotations

import argparse
import csv
import os
import random
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # promo/
REPO_ROOT = ROOT.parent
sys.path.insert(0, str(REPO_ROOT / "src"))            # 钉住当前工作树的 src/bili
from bili import web as bili_web                     # noqa: E402

import bili as _bili                                     # noqa: E402
from bili import __version__ as BILI_VERSION             # noqa: E402
_BILI_PATH = Path(_bili.__file__).resolve()
if _BILI_PATH.parent.parent != (REPO_ROOT / "src").resolve():
    sys.exit(
        f"bili 来源不在当前工作树: {_BILI_PATH}"
        f"（期望 {REPO_ROOT / 'src'}）—— venv 里的 editable install 指向别的 checkout 时，"
        "截出来的界面不是当前分支的界面"
    )
REPO = ROOT.parent                                   # 仓库根
PUBLIC = ROOT / "public"
OUT = PUBLIC / "webui.png"

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def find_browser(override: str | None) -> str:
    if override:
        if not Path(override).exists():
            sys.exit(f"指定的浏览器不存在: {override}")
        return override
    for cand in BROWSER_CANDIDATES:
        if Path(cand).exists():
            return cand
    sys.exit("找不到 Chrome / Edge，用 --browser 指定可执行文件路径")


def free_port(preferred: int) -> int:
    for port in (preferred, preferred + 7, preferred + 23):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    sys.exit("端口都占着，换个 --port")


def build_demo_input(tmp: Path) -> Path:
    """真实接口形状 + 补信号：界面上三类都有，截图才有信息量。"""
    src = REPO / "tests" / "fixture-bili-real-list.json"
    raw = tmp / "follows.json"
    shutil.copyfile(src, raw)

    env = dict(os.environ, PYTHONPATH=str(REPO / "src"), PYTHONIOENCODING="utf-8")
    tpl = tmp / "signals.csv"
    subprocess.run([sys.executable, "-m", "bili.merge_cli", str(raw), "--template", str(tpl)],
                   env=env, check=True, capture_output=True)

    rows = list(csv.DictReader(tpl.open(encoding="utf-8-sig")))
    rng = random.Random(11)
    for row in rows:
        seen = rng.choice(["4", "12", "35", "120", "310", "540", "760", ""])
        row["last_seen_days"] = seen
        if seen:
            row["last_video_days"] = rng.choice(["2", "9", "45", "150", "400", ""])
        row["follower_count"] = rng.choice(["1200", "15000", "1804220", "43000", ""])
        row["following_count"] = rng.choice(["38", "210", "1500", ""])
    filled = tmp / "signals-filled.csv"
    with filled.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    merged = tmp / "follows.merged.json"
    subprocess.run([sys.executable, "-m", "bili.merge_cli", str(raw), "--signals", str(filled),
                    "--out", str(merged)], env=env, check=True, capture_output=True)
    return merged


def fetch_dom(browser: str, port: int) -> str:
    """抓真实浏览器渲染后的 DOM（不是响应体）：前端 JS 跑过才算数。"""
    res = subprocess.run([browser, "--headless=new", "--disable-gpu", "--dump-dom",
                          "--virtual-time-budget=4000", f"http://127.0.0.1:{port}/"],
                         capture_output=True)
    if res.returncode != 0:
        sys.exit(f"浏览器 --dump-dom 失败 exit={res.returncode}: "
                 f"{res.stderr.decode('utf-8', 'replace')[:300]}")
    return res.stdout.decode("utf-8", "replace")


def tbody_of(dom: str) -> str:
    start, end = dom.find("<tbody"), dom.find("</tbody>")
    if start < 0 or end < 0:
        return ""
    return dom[start:end]


def check_dom(dom: str, results: list) -> list:
    """对渲染层下断言。返回问题清单，空清单 = 这张图有资格进片子。

    失效模式来自 FOR-56 取证 / FOR-57 修复：昵称列被 fmtNum 覆盖成字面量 NaN，
    分类徽章的 span 缺属性闭合引号，导致后面所有列塌成转义文本。
    两种坏法都还能截出一张「像样」的图，所以只能靠 DOM 断言拦，肉眼抽查拦不住。
    """
    body = tbody_of(dom)
    if not body:
        return ["页面没有渲染出 <tbody>：前端 JS 没跑起来，截图会是空表"]

    problems = []
    rows = body.count("<tr")
    if rows != len(results):
        problems.append(f"表格渲染 {rows} 行 != 数据 {len(results)} 行（行被吞或塌成文本）")
    if "NaN" in body:
        problems.append("tbody 出现字面量 NaN：某一列把原值覆盖成了转换值")
    for frag in ("&lt;td", "&lt;/td", "&lt;span", "&gt;"):
        if frag in body:
            problems.append(f"tbody 出现被转义的标签 {frag}：属性缺闭合引号，后面的列被吞进 class")
            break

    badges = sum(body.count(f'class="b-{cls}') for cls in ("keep", "review", "remove"))
    if badges != rows:
        problems.append(f"分类徽章 {badges} 个 != {rows} 行：徽章 span 未闭合，颜色与文案都不会生效")

    counts = bili_web.summarize(results)["counts"]
    for cls in ("keep", "review", "remove"):
        shown = body.count(f'class="{cls}"')
        if shown != counts[cls]:
            problems.append(f"{cls} 行 {shown} != Summary {counts[cls]}：分类行渲染不完整")
    return problems


def wait_until_up(port: int, timeout: float = 12.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.4)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.3)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="截取当前版本的 Web 报告界面，供 promo 使用")
    ap.add_argument("input", nargs="?", help="报告输入 JSON（默认自动生成：真实形状 + 补信号）")
    ap.add_argument("--browser")
    ap.add_argument("--port", type=int, default=8795)
    ap.add_argument("--size", default="1180,700", help="截图尺寸 W,H，贴合页面 max-width 1100")
    args = ap.parse_args()

    browser = find_browser(args.browser)
    env = dict(os.environ, PYTHONPATH=str(REPO / "src"), PYTHONIOENCODING="utf-8")

    tmp = ROOT / "out"
    tmp.mkdir(exist_ok=True)
    payload = Path(args.input).resolve() if args.input else build_demo_input(tmp)

    port = free_port(args.port)
    server = subprocess.Popen([sys.executable, "-m", "bili.web", "--input", str(payload),
                               "--port", str(port)], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_until_up(port):
            sys.exit("bili.web 没起来，检查 --input 是否是可加载的导出")
        dom = fetch_dom(browser, port)
        try:
            results = bili_web.load_report(str(payload))
        except Exception as exc:                       # noqa: BLE001
            sys.exit(f"报告数据加载失败: {exc}")
        problems = check_dom(dom, results)
        if problems:
            print("[FAIL] 当前 src/bili 的 Web 界面在真实浏览器里不可读，不出图")
            for item in problems:
                print("  - " + item)
            print("先确认 FOR-57 / FOR-58 的渲染层修复已合进当前分支，"
                  "再重截这张 Web 界面镜头。")
            raise SystemExit(3)
        print(f"[OK] DOM 门禁通过：{len(results)} 行渲染完整，无 NaN、无塌行（bili {BILI_VERSION}）")
        subprocess.run([browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--force-device-scale-factor=1", f"--window-size={args.size}",
                        "--virtual-time-budget=4000", f"--screenshot={OUT}",
                        f"http://127.0.0.1:{port}/"], check=True)
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print(f"已写出 {OUT.relative_to(REPO)}（来源 {payload.name}，界面版本以当前 src/bili 为准）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

