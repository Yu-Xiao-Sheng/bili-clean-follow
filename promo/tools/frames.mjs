// 从成片里按固定间隔抽帧，交给 qa.py 做质检。
//
// 为什么要有这个脚本：`remotion still` 实测不可靠。同一支片子（BiliCleanPromo，1730 帧）
// 用 --frame=800 / --frame=230 / 不带 frame 抽出来的 PNG 字节完全相同，内容只剩页脚一条
// （ink=174，qa.py 判 BLANK）——它在画面挂载前就抓帧了。拿它当「单帧校对」等于没校对。
// 成片本身没问题：从 mp4 里按秒抽帧，118 个抽样帧全部有内容。
// 这里刻意不用 -vf fps=...（Remotion 自带的 ffmpeg 解析该滤镜报错），改成逐秒 -ss 定位。
//
// 用法：
//   node tools/frames.mjs out/bili-clean-promo.mp4 out/frames/promo          # 每秒 1 帧
//   node tools/frames.mjs out/bili-clean-walkthrough.mp4 out/frames/walk 2   # 每 2 秒 1 帧
//   python ../qa.py out/frames/promo                                         # qa.py 收目录
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CANDIDATES = [
  process.env.BILI_FFMPEG,
  "node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe",
  "node_modules/@remotion/compositor-darwin-arm64/ffmpeg",
  "node_modules/@remotion/compositor-darwin-x64/ffmpeg",
  "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg",
  "node_modules/@remotion/compositor-linux-arm64-gnu/ffmpeg",
].filter(Boolean);

const findFfmpeg = () => {
  for (const cand of CANDIDATES) {
    if (fs.existsSync(cand)) return path.resolve(cand);
  }
  if (spawnSync("ffmpeg", ["-version"]).status === 0) return "ffmpeg";
  console.error("[FAIL] 找不到 ffmpeg。先 npm install（Remotion 自带），或设 BILI_FFMPEG=<路径>。");
  process.exit(2);
};

const [mp4, outDir, stepRaw = "1"] = process.argv.slice(2);
if (!mp4 || !fs.existsSync(mp4)) {
  console.error("用法: node tools/frames.mjs <成片.mp4> [输出目录] [每N秒1帧=1]");
  process.exit(2);
}
const step = Number(stepRaw);
if (!Number.isFinite(step) || step <= 0) {
  console.error(`每N秒必须是正数，收到 ${stepRaw}`);
  process.exit(2);
}
const out = outDir || path.join("out", "frames", path.parse(mp4).name);
fs.mkdirSync(out, { recursive: true });
const ffmpeg = findFfmpeg();

let n = 0;
for (let i = 1; i <= 10000; i += 1) {
  const t = ((i - 0.5) * step).toFixed(3);
  const file = path.join(out, `f-${String(i).padStart(4, "0")}.png`);
  spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", t, "-i", mp4, "-frames:v", "1", file],
            { stdio: "ignore" });
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    if (fs.existsSync(file)) fs.rmSync(file);
    break;
  }
  n += 1;
}
if (n === 0) {
  console.error(`[FAIL] ${mp4} 一帧都没抽出来，检查成片是否完整`);
  process.exit(1);
}
console.log(`[OK] ${mp4} -> ${out}：抽了 ${n} 帧（每 ${step} 秒 1 帧，ffmpeg=${ffmpeg}）`);
console.log(`下一步: python ../qa.py ${out}`);
