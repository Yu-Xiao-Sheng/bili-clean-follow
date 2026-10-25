"""README 内联预览资产生成器（FOR-66）。

背景：GitHub README 无法内嵌 mp4 播放器（取证见 FOR-62 v2-spec 1.1 节），
README 首屏唯一能"自动播起来"的是动画图像。所以每支影片必须同时产出：

  1. assets/preview-<slug>.gif   —— README 首屏内联，单文件 <= 8 MB（GitHub 单图上限 10 MB）
  2. assets/poster-<slug>.jpg    —— Pages 落地页 <video poster> 与 README 封面
  3. 完整 1080p mp4 只走 Release / Pages 分支，绝不进 main 历史

mp4 源文件在 promo/out/（.gitignore 已排除），由 promo/ 里的 Remotion 工程渲染。
换 T8 的新影片时只需要重跑本脚本，README 引用路径不变，CI 门禁立刻生效。

用法：
    python tools/build_readme_preview.py                 # 默认 promo/out/*.mp4 -> assets/
    python tools/build_readme_preview.py --width 560 --fps 8
    python tools/build_readme_preview.py --source-dir out --mapping out/film.mp4=promo

ffmpeg 解析顺序：--ffmpeg 参数 > $BILI_FFMPEG > PATH 上的 ffmpeg >
promo/node_modules 里 Remotion 自带的 ffmpeg（无需额外安装）。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# slug -> 默认源文件名与封面取样时刻（秒）。取样时刻挑在"已经出现产品画面"之后，
# 不要拿片头的纯文字当封面。
DEFAULT_FILMS = [
    ("promo", "bili-clean-promo.mp4", 12.0),
    ("walkthrough", "bili-clean-walkthrough.mp4", 18.0),
]

# 逐级降质，直到 GIF 落进预算；README 内联图太大会把首屏加载拖死。
QUALITY_LADDER = [(720, 10), (640, 10), (560, 8), (480, 8), (480, 6)]

GIF_BUDGET_MB = 8.0


def find_ffmpeg(explicit: str | None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("BILI_FFMPEG")
    if env:
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    bundled = sorted(REPO_ROOT.glob(
        "promo/node_modules/@remotion/compositor-*/ffmpeg.exe"))
    if bundled:
        return str(bundled[0])
    raise SystemExit(
        "找不到 ffmpeg：装一个（winget install ffmpeg / brew install ffmpeg），"
        "或者 --ffmpeg <path> / 设 BILI_FFMPEG 环境变量。")


def probe_duration(ffmpeg: str, src: Path) -> float:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-i", str(src)],
                          capture_output=True, text=True, check=False)
    for line in (proc.stderr or "").splitlines():
        if "Duration:" in line:
            hms = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = hms.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    raise SystemExit("读不到 %s 的时长" % src)


def run(ffmpeg: str, args: list) -> None:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y"] + args,
                          capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise SystemExit("ffmpeg 失败: %s\n%s" % (" ".join(args), proc.stderr.strip()))


def build_gif(ffmpeg: str, src: Path, dst: Path, width: int, fps: int) -> int:
    pal = dst.with_name(dst.stem + "_palette.png")
    run(ffmpeg, ["-i", str(src), "-an", "-r", str(fps),
                 "-vf", "scale=%d:-1:flags=lanczos,palettegen=stats_mode=diff" % width,
                 str(pal)])
    run(ffmpeg, ["-i", str(src), "-an", "-i", str(pal), "-r", str(fps),
                 "-lavfi", "scale=%d:-1:flags=lanczos [x]; [x][1:v] "
                 "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" % width,
                 str(dst)])
    pal.unlink(missing_ok=True)
    return dst.stat().st_size


def build_poster(ffmpeg: str, src: Path, dst: Path, at_seconds: float, width: int = 1280) -> int:
    run(ffmpeg, ["-ss", "%.1f" % at_seconds, "-i", str(src), "-an", "-frames:v", "1",
                 "-vf", "scale=%d:-1:flags=lanczos" % width, "-q:v", "3", str(dst)])
    return dst.stat().st_size


def parse_mapping(items: list) -> list:
    films = []
    for item in items:
        if "=" not in item:
            raise SystemExit("--mapping 要写成 <mp4 路径>=<slug>，收到 %r" % item)
        path, slug = item.split("=", 1)
        films.append((slug.strip(), path.strip(), None))
    return films


def main(argv: list) -> int:
    ap = argparse.ArgumentParser(description="生成 README 内联 GIF 与封面")
    ap.add_argument("--ffmpeg", default=None)
    ap.add_argument("--source-dir", default=str(REPO_ROOT / "promo" / "out"))
    ap.add_argument("--out-dir", default=str(REPO_ROOT / "assets"))
    ap.add_argument("--budget-mb", type=float, default=GIF_BUDGET_MB)
    ap.add_argument("--width", type=int, default=None, help="锁死宽度，不自动降质")
    ap.add_argument("--fps", type=int, default=None, help="锁死帧率")
    ap.add_argument("--mapping", action="append", default=[],
                    help="自定义 <mp4>=<slug>，给了就覆盖默认两支影片")
    ap.add_argument("--poster-at", type=float, default=None,
                    help="封面取样秒数；默认取时长的一半")
    args = ap.parse_args(argv)

    ffmpeg = find_ffmpeg(args.ffmpeg)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    budget = int(args.budget_mb * 1024 * 1024)

    films = parse_mapping(args.mapping) if args.mapping else [
        (slug, str(Path(args.source_dir) / name), None) for slug, name, _ in DEFAULT_FILMS]

    rc = 0
    for slug, src_name, _ in films:
        src = Path(src_name)
        if not src.is_absolute():
            src = REPO_ROOT / src
        if not src.exists():
            print("!! 缺源文件 %s（先跑 promo 的 Remotion 渲染，或用 --mapping 指路径）" % src)
            rc = 1
            continue
        gif = out_dir / ("preview-%s.gif" % slug)
        poster = out_dir / ("poster-%s.jpg" % slug)
        duration = probe_duration(ffmpeg, src)
        poster_at = args.poster_at if args.poster_at is not None else round(duration / 2.0, 1)

        if args.width and args.fps:
            ladder = [(args.width, args.fps)]
        else:
            ladder = QUALITY_LADDER if not (args.width or args.fps) else [
                (args.width or QUALITY_LADDER[0][0], args.fps or QUALITY_LADDER[0][1])]
        used = None
        for width, fps in ladder:
            size = build_gif(ffmpeg, src, gif, width, fps)
            print("  %-24s %dx%d @ %dfps  %.2f MB" % (gif.name, width, fps, fps, size / 1048576.0))
            if size <= budget:
                used = (width, fps, size)
                break
        if used is None:
            print("!! %s 降到 %s 仍超 %.1f MB 预算，请剪短影片或改用 animated WebP"
                  % (gif.name, ladder[-1], args.budget_mb))
            rc = 1
            continue
        psize = build_poster(ffmpeg, src, poster, poster_at)
        print("  %-28s @%.1fs -> %.2f MB" % (poster.name, poster_at, psize / 1048576.0))

    print("完成：%s" % out_dir)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
