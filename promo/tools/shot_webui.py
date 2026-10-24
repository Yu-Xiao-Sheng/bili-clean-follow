#!/usr/bin/env python3
"""用当前版本的真实 Web 报告界面重截 promo/public/webui.png。

片子里那张「本地报告」截图必须是当前版本渲染出来的，否则视频讲的就是过时界面。
纯本地：起 bili.web（只监听 127.0.0.1），用本机 Chrome / Edge headless 截图，截完停服务。

用法：
    python tools/shot_webui.py [输入JSON] [--browser 路径] [--port 8795]

不传输入时用 tests/fixture-bili-real-list.json 经 bili-merge 补信号后的结果，
这样界面上 keep / review / remove 三类都有内容，镜头里不至于空一半。
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
