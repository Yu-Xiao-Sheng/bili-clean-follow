"""GitHub Pages 落地页发布器（FOR-66）。

为什么要有这个文件：GitHub README 里 mp4 只会渲染成下载链接，<video> 会被 sanitizer
清成空 <p>，YouTube 链接也不会内嵌播放器（取证见 docs/video-hosting.md）。README 首屏
只能靠 GIF 自动播；完整 1080p 影片需要一个能真正播放的落地页，这就是 pages/index.html。

关键约束：mp4 绝不进 main 的 git 历史（repo size 只有几百 KB）。所以影片只作为
Pages 产物存在——由本脚本从 promo/out/ 或 Release 资源组装，落到 dist/（已 gitignore）。

Windows 中文控制台（GBK/cp936）下也能直接读：入口与 check_url 都走
bili.streams.harden_stdio()（与 CLI / Web / 取证脚本同一份兜底，FOR-38 口径）。
实测 PYTHONIOENCODING=gbk 跑这条取证，中文提示会输出成 cp936 字节，管道按 UTF-8 读
就是一片花屏（FOR-66 复核时踩过），CI 只跑 ubuntu 抓不到这个环境。

用法：
    python tools/publish_pages.py                          # 组装 dist/pages（影片取 promo/out/）
    python tools/publish_pages.py --from-release v0.1.2     # 没有本地影片时从 Release 下载
    python tools/publish_pages.py --serve                   # 本地起一个支持 Range 的预览服务
    python tools/publish_pages.py --check-url https://yu-xiao-sheng.github.io/bili-clean-follow/
                                                            # 断言线上页在流式播放（206 + Accept-Ranges）
    python tools/publish_pages.py --push-branch gh-pages    # 兜底：把产物推成 gh-pages 分支
                                                            #（Pages 设为 Deploy from a branch: gh-pages）
"""
from __future__ import annotations

import argparse
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from bili.streams import harden_stdio  # noqa: E402  # 与 CLI/Web 同一份 stdout 兜底（FOR-38）

# slug -> Pages 产物里的影片文件名（与 pages/index.html 里的 src 一致）。
FILMS = [
    ("promo", "bili-clean-promo.mp4"),
    ("walkthrough", "bili-clean-walkthrough.mp4"),
]
PAGES_SOURCE = REPO_ROOT / "pages" / "index.html"
ASSETS = REPO_ROOT / "assets"


def release_url(tag: str, name: str) -> str:
    return ("https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/%s/%s"
            % (tag, name))


def download(url: str, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "bili-clean-follow-pages"})
    with urllib.request.urlopen(req) as resp, open(dst, "wb") as fh:
        shutil.copyfileobj(resp, fh)


def gather_videos(video_dir: Path, tag: str | None) -> dict:
    """本地 promo/out/ 优先；缺了就按 tag 从 Release 资源下载。"""
    found = {}
    for slug, name in FILMS:
        local = video_dir / name
        if local.exists():
            found[slug] = local
            continue
        if not tag:
            raise SystemExit(
                "缺影片 %s。先渲染 promo（promo/out/%s），或加 --from-release <tag> 从 Release 下载。"
                % (name, name))
        cached = Path(tempfile.gettempdir()) / "bili-clean-pages" / tag / name
        if not cached.exists():
            print("下载 %s" % release_url(tag, name))
            download(release_url(tag, name), cached)
        found[slug] = cached
    return found


def build(out_dir: Path, video_dir: Path, tag: str | None) -> list:
    if not PAGES_SOURCE.exists():
        raise SystemExit("找不到落地页源文件 %s" % PAGES_SOURCE)
    videos = gather_videos(video_dir, tag)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    shutil.copyfile(str(PAGES_SOURCE), str(out_dir / "index.html"))
    written.append(out_dir / "index.html")
    # Jekyll 会无视下划线开头的文件并把目录当站点构建；Pages 要的是纯静态产物。
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")
    written.append(out_dir / ".nojekyll")
    for slug, name in FILMS:
        poster = ASSETS / ("poster-%s.jpg" % slug)
        if not poster.exists():
            raise SystemExit("缺封面 %s（先跑 tools/build_readme_preview.py）" % poster)
        shutil.copyfile(str(poster), str(out_dir / poster.name))
        written.append(out_dir / poster.name)
        shutil.copyfile(str(videos[slug]), str(out_dir / name))
        written.append(out_dir / name)
    for path in written:
        print("  %-28s %8.2f MB" % (path.name, path.stat().st_size / 1048576.0))
    return written


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """浏览器 <video> 要 Range/206；stdlib 的 SimpleHTTPRequestHandler 不给，
    所以本地预览必须自己补一段——否则"本地能播"是假证据。"""

    extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        mp4="video/mp4", jpg="image/jpeg", gif="image/gif", html="text/html")

    def do_GET(self):  # noqa: N802
        fspath = self.translate_path(self.path)
        start, end = None, None
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes=") and os.path.isfile(fspath):
            total = os.path.getsize(fspath)
            spec = rng[6:].split(",")[0].split("-")
            start = int(spec[0]) if spec[0] else 0
            end = int(spec[1]) if len(spec) > 1 and spec[1] else total - 1
            end = min(end, total - 1)
            if start > end or start >= total:
                self.send_error(416, "Requested Range Not Satisfiable")
                return None
            f = open(fspath, "rb")
            f.seek(start)
            self.send_response(206)
            ctype = self.guess_type(fspath)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            try:
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                f.close()
            return None
        return super().do_GET()

    def do_HEAD(self):  # noqa: N802
        fspath = self.translate_path(self.path)
        if not os.path.isfile(fspath):
            self.send_error(404, "File not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(fspath))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(os.path.getsize(fspath)))
        self.end_headers()

    def log_message(self, fmt, *args):
        return


def start_server(out_dir: Path, port: int):
    def handler(*args):
        return RangeHandler(*args, directory=str(out_dir))
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)


def serve(out_dir: Path, port: int) -> None:
    httpd = start_server(out_dir, port)
    print("落地页预览：http://127.0.0.1:%d/  （Ctrl+C 停）" % port)
    httpd.serve_forever()


def check_url(base: str) -> int:
    # FOR-66：取证输出走 UTF-8，GBK 控制台下也不花屏（被直接 import 调用时同样要兜）。
    harden_stdio()
    """线上取证：页面在、影片可流式（Accept-Ranges + 206 + Content-Range）。"""
    base = base.rstrip("/") + "/"
    problems = []
    with urllib.request.urlopen(base, timeout=30) as resp:
        html = resp.read().decode("utf-8", "replace")
        if resp.status != 200:
            problems.append("index.html HTTP %s" % resp.status)
        for needle in ("<video", "controls", "poster=", ".mp4"):
            if needle not in html:
                problems.append("落地页 HTML 里缺 %r" % needle)
    for _, name in FILMS:
        url = base + name
        req = urllib.request.Request(url, method="HEAD",
                                     headers={"User-Agent": "bili-clean-follow-pages"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.headers.get("Accept-Ranges", "").lower() != "bytes":
                problems.append("%s 没有 Accept-Ranges: bytes（浏览器无法边下边播/拖动）" % name)
        req = urllib.request.Request(url, headers={"Range": "bytes=0-1023",
                                                  "User-Agent": "bili-clean-follow-pages"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.status != 206:
                problems.append("%s 分段请求返回 %s，不是 206" % (name, resp.status))
            crange = resp.headers.get("Content-Range", "")
            if not crange.startswith("bytes 0-1023/"):
                problems.append("%s 的 Content-Range 不对：%r" % (name, crange))
            if len(resp.read()) != 1024:
                problems.append("%s 分段响应长度不是 1024" % name)
    for p in problems:
        print("FAIL  %s" % p)
    print("OK    落地页与两支影片可流式播放" if not problems else "落地页取证未通过")
    return 1 if problems else 0


def push_branch(out_dir: Path, remote: str, branch: str) -> int:
    """兜底发布：在临时仓库里把产物做成一个孤立提交，强推到 <branch>。
    只允许 refs/heads/gh-pages，绝不碰 main；主仓库工作区不受影响。"""
    if branch != "gh-pages":
        raise SystemExit("这个兜底只用于 gh-pages 分支（收到 %r），其它分支请走 CI。" % branch)
    tmp = Path(tempfile.mkdtemp(prefix="bili-pages-"))
    def git(*args, **kw):
        env = dict(os.environ, GIT_LFS_SKIP_SMUDGE="1")
        proc = subprocess.run(["git"] + list(args), cwd=str(tmp), env=env,
                              capture_output=True, text=True, check=False, **kw)
        if proc.returncode != 0:
            raise SystemExit("git %s 失败：%s" % (" ".join(args), (proc.stderr or proc.stdout).strip()))
        return proc.stdout.strip()
    git("init", "-q")
    git("remote", "add", "origin", remote)
    shutil.copytree(str(out_dir), str(tmp), dirs_exist_ok=True)
    git("add", "-A")
    name = ""
    email = ""
    try:
        name = subprocess.run(["git", "config", "user.name"], cwd=str(REPO_ROOT),
                              capture_output=True, text=True).stdout.strip()
        email = subprocess.run(["git", "config", "user.email"], cwd=str(REPO_ROOT),
                               capture_output=True, text=True).stdout.strip()
    except OSError:
        pass
    git("-c", "user.name=%s" % (name or "bili-clean-follow-bot"),
        "-c", "user.email=%s" % (email or "bot@bili-clean-follow.local"),
        "commit", "-q", "-m", "pages: FOR-66 落地页（<video controls poster> 直接播两支 1080p 影片）")
    git("push", "-f", "origin", "HEAD:refs/heads/%s" % branch)
    print("已推送 %s -> %s（Pages 需设为 Deploy from a branch: gh-pages / (root)）" % (remote, branch))
    return 0


def main(argv: list) -> int:
    harden_stdio()
    ap = argparse.ArgumentParser(description="组装 / 发布 / 验证 Pages 落地页")
    ap.add_argument("--out", default=str(REPO_ROOT / "dist" / "pages"))
    ap.add_argument("--video-dir", default=str(REPO_ROOT / "promo" / "out"))
    ap.add_argument("--from-release", default=None, help="本地没有影片时按 tag 从 Release 下载")
    ap.add_argument("--serve", action="store_true", help="起本地预览（支持 Range）")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--check-url", default=None, help="线上取证：断言页面与影片可流式播放")
    ap.add_argument("--self-check", action="store_true",
                    help="把刚组装的产物起成本地服务，再对自己做一次线上取证")
    ap.add_argument("--push-branch", default=None, help="兜底发布到 gh-pages 分支")
    ap.add_argument("--remote", default=None, help="配合 --push-branch 使用的远端 URL")
    args = ap.parse_args(argv)

    if args.check_url:
        return check_url(args.check_url)

    out_dir = Path(args.out)
    build(out_dir, Path(args.video_dir), args.from_release)

    if args.self_check:
        httpd = start_server(out_dir, args.port)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            return check_url("http://127.0.0.1:%d/" % args.port)
        finally:
            httpd.shutdown()

    if args.push_branch:
        if not args.remote:
            raise SystemExit("--push-branch 需要 --remote <远端 URL>")
        return push_branch(out_dir, args.remote, args.push_branch)
    if args.serve:
        serve(out_dir, args.port)
        return 0
    print("\n产物目录：%s（gitignore 内，绝不进 main 历史）" % out_dir)
    print("CI 里用 actions/upload-pages-artifact 上传它；本地验证：--serve")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))