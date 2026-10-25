"""Build a contact sheet from the per-second frames so a reviewer can eyeball a whole
film in ONE png, without a video player.

The scene table is parsed from the film source itself (promo.tsx / walkthrough.tsx),
so the labels cannot drift away from what actually renders. Same discipline as
tools/shot_webui.py: the tool refuses rather than guessing.

usage:
  python tools/contact_sheet.py out/frames/v013-promo out/contact-promo.png src/promo.tsx
  python tools/contact_sheet.py out/frames/v013-walk  out/contact-walk.png  src/walkthrough.tsx
"""
from PIL import Image, ImageDraw, ImageFont
import json
import re
import sys
import glob
import os

CELL_W, CELL_H, LABEL_H = 384, 216, 26
COLS = 6
FPS = 30


def scene_table(tsx_path):
    src = open(tsx_path, encoding="utf-8").read()
    m = re.search(r"const frames = \[([\d,\s]+)\];", src)
    c = re.search(r"const comps = \[([^\]]+)\];", src)
    if not m or not c:
        sys.exit("[FAIL] cannot find `const frames = [...]` / `const comps = [...]` in " + tsx_path)
    starts = [int(x) for x in re.findall(r"\d+", m.group(1))]
    names = [x.strip() for x in c.group(1).split(",") if x.strip()]
    if len(starts) != len(names):
        sys.exit("[FAIL] frames(%d) and comps(%d) length mismatch" % (len(starts), len(names)))
    spans = []
    for i, name in enumerate(names):
        lo = starts[i]
        hi = starts[i + 1] if i + 1 < len(starts) else None
        spans.append({"name": name, "from": lo, "to": hi})
    return spans


def label_for(spans, frame):
    for s in spans:
        if frame >= s["from"] and (s["to"] is None or frame < s["to"]):
            return s["name"]
    return "?"


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    frames_dir, out_png, tsx = sys.argv[1:4]
    spans = scene_table(tsx)
    paths = sorted(glob.glob(os.path.join(frames_dir, "*.png")))
    if not paths:
        sys.exit("[FAIL] no frames in " + frames_dir)
    font_path = r"C:\Windows\Fonts\arial.ttf"
    font = ImageFont.truetype(font_path, 15) if os.path.exists(font_path) else ImageFont.load_default()

    rows = (len(paths) + COLS - 1) // COLS
    sheet_w = COLS * CELL_W
    sheet_h = rows * (CELL_H + LABEL_H)
    sheet = Image.new("RGB", (sheet_w, sheet_h), (11, 13, 18))
    draw = ImageDraw.Draw(sheet)

    rows = []
    for idx, p in enumerate(paths):
        step = 1  # frames.mjs default: one sample per second
        second = idx * step
        scene = label_for(spans, second * FPS + 15)  # frames.mjs samples at t=i+0.5s
        cell_x, cell_y = (idx % COLS) * CELL_W, (idx // COLS) * (CELL_H + LABEL_H)
        im = Image.open(p).convert("RGB")
        im.thumbnail((CELL_W, CELL_H))
        sheet.paste(im, (cell_x + (CELL_W - im.width) // 2, cell_y))
        draw.text((cell_x + 6, cell_y + CELL_H + 4), "%02ds %s" % (second, scene), fill=(200, 210, 230), font=font)
        rows.append((second, scene))

    os.makedirs(os.path.dirname(out_png) or ".", exist_ok=True)
    sheet.save(out_png, optimize=True)
    print("[OK] %s -> %s (%d frames, %dx%d px)" % (frames_dir, out_png, len(paths), sheet_w, sheet_h))
    counts = {}
    for _, s in rows:
        counts[s] = counts.get(s, 0) + 1
    print(json.dumps({"per_scene_seconds": counts, "scene_order": [s["name"] for s in spans]}))
    print(json.dumps([{"sec": a, "scene": b} for a, b in rows], ensure_ascii=False))


main()
