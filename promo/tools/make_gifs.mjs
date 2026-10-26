// README 内联预览 GIF（FOR-70 产出 2；规格见 promo/v2-script.md 第 3 节）
//
//   12-16s 精选段 · 480x270 · 8fps · 循环 · <=8MB
//   promo:  Install -> OpenPanel -> Classify -> CommandBar -> Diff
//   walk :  抓全 -> AI 分类 -> 分类卡片 -> 自然语言 -> 武装取关
//
// 不用 ffmpeg：本机那份是 Playwright 的精简构建（连 mp4 demux 与 palette 滤镜都没有）。
// 这里直接用 @remotion/renderer 把选段帧渲成 PNG，再 4x 盒式降采样到 480x270，gifenc 编码。
//
// 门禁：capture manifest 是自检素材（占位昵称）就不产出；镜头与报告数字对不上也不产出；
// 产物 >8MB 先降帧率、再降宽度，还不行退出码 1。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { decodePng } from "./png_decode.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "..");
const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.slice(n.length + 3) : d;
};
const fail = (m) => {
  console.error("[make_gifs] " + m);
  process.exit(1);
};

const MANIFEST = path.join(ROOT, "public", "v2", "manifest.json");
if (!fs.existsSync(MANIFEST)) fail("先跑 capture_ui（" + MANIFEST + " 不存在）：没有真实界面取证就不产 GIF");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const ALLOW_FIXTURE = process.argv.includes("--allow-fixture");
if ((manifest.syntheticNames || manifest.allowFixture) && !ALLOW_FIXTURE) {
  fail("这批截图是管线自检素材（占位昵称），不能进 README：等 FOR-67 的抓取快照与真实报告落地再重跑");
}
const unusable = (manifest.shots || []).filter((s) => !s.usable);
if (unusable.length) fail("有镜头与报告数字对不上：" + unusable.map((u) => u.name).join(", "));

const require_ = createRequire(path.join(ROOT, "package.json"));
let GIFEncoder;
let quantize;
let applyPalette;
try {
  ({ GIFEncoder, quantize, applyPalette } = require_("gifenc"));
} catch {
  fail("缺 gifenc：在 promo/ 里跑 npm install");
}

const FPS = 30;
const SPECS = [
  { comp: "BiliCleanV2Promo", name: "preview-v2-promo", clips: [[6, 9], [12, 15], [22, 25], [30, 33], [37, 40]] },
  { comp: "WalkthroughV2", name: "preview-v2-walkthrough", clips: [[15, 18], [24, 27], [34, 37], [44, 47], [56, 59]] },
];
const OUT_DIR = path.join(REPO, "assets");
const MAX_BYTES = 8 * 1024 * 1024;

// 4x 盒式降采样（1920x1080 -> 480x270），够用且不需要图像库
const downscale = (img, factor) => {
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const o = ((y * factor + dy) * img.width + (x * factor + dx)) * 4;
          r += img.rgba[o];
          g += img.rgba[o + 1];
          b += img.rgba[o + 2];
        }
      }
      const n = factor * factor;
      const p = (y * w + x) * 4;
      out[p] = Math.round(r / n);
      out[p + 1] = Math.round(g / n);
      out[p + 2] = Math.round(b / n);
      out[p + 3] = 255;
    }
  }
  return { width: w, height: h, rgba: out };
};

const serveUrl = await bundle({
  entryPoint: path.join(ROOT, "src", "index.ts"),
  publicDir: path.join(ROOT, "public"),
  chromiumOptions: { gl: "angle-egl" },
});
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const spec of SPECS) {
  const composition = await selectComposition({ serveUrl, id: spec.comp, browserExecutable });
  const secs = spec.clips.reduce((a, c) => a + (c[1] - c[0]), 0);
  let done = false;
  for (const [gifFps, factor] of [[8, 4], [6, 4], [6, 5]]) {
    const step = Math.max(1, Math.round(FPS / gifFps));
    const frames = [];
    for (const [a, b] of spec.clips) {
      for (let f = Math.round(a * FPS); f < Math.round(b * FPS); f += step) frames.push(f);
    }
    const kept = [];
    let w = 0;
    let h = 0;
    for (const [i, frame] of frames.entries()) {
      const { buffer: pngBuf } = await renderStill({ composition, serveUrl, frame, imageFormat: "png", browserExecutable });
      const img = downscale(decodePng(Buffer.from(pngBuf)), factor);
      w = img.width;
      h = img.height;
      kept.push(img.rgba);
      if (i % 20 === 0) console.log("[make_gifs] " + spec.name + " 渲帧 " + (i + 1) + "/" + frames.length);
    }
    const sampleIdx = [0, Math.floor(kept.length / 3), Math.floor((2 * kept.length) / 3)].slice(0, Math.min(3, kept.length));
    const merged = new Uint8Array(sampleIdx.reduce((a, i) => a + kept[i].length, 0));
    let off = 0;
    for (const i of sampleIdx) {
      merged.set(kept[i], off);
      off += kept[i].length;
    }
    const palette = quantize(merged, 256);
    const gif = GIFEncoder();
    for (const rgba of kept) gif.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: Math.round(1000 / gifFps), repeat: 0 });
    gif.finish();
    const bytes = gif.bytes();
    const out = path.join(OUT_DIR, spec.name + ".gif");
    fs.writeFileSync(out, bytes);
    console.log("[make_gifs] " + spec.name + " " + kept.length + " 帧 / " + secs + "s @" + gifFps + "fps/" + w + "x" + h +
      " -> " + (bytes.length / 1048576).toFixed(2) + "MB");
    if (bytes.length <= MAX_BYTES) {
      done = true;
      break;
    }
    fs.rmSync(out, { force: true });
    if (gifFps === 6 && factor === 5) fail(spec.name + " 压到 6fps/384px 还超 8MB，减少选段");
  }
  if (!done) fail(spec.name + " 没产出");
}
console.log("[make_gifs] 全部 <=8MB；README 内联门禁（tools/build_readme_preview.py + FOR-66 CI）可以接上");
if (ALLOW_FIXTURE) console.log("[make_gifs] 注意：这次是 --allow-fixture 的管线自检产物，不进 README、不进仓库");