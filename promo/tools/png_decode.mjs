// 极简 PNG 解码（8bit、非隔行、RGB/RGBA/灰度/调色板）——FOR-70 的 GIF 环节用。
// 不用第三方图像库：本机 ffmpeg 是 Playwright 的精简构建，只有 png 编码器，没有 gif/palette 滤镜，
// 所以帧从 ffmpeg 解出来是 PNG，这里在 Node 里解成 RGBA 再喂 gifenc。
import zlib from "node:zlib";
import fs from "node:fs";

const CHUNK = (type) => type;

export function decodePng(input) {
  const file = typeof input === "string" ? input : "<buffer>";
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG：" + file);
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IEND") break;
  }
  if (depth !== 8 || interlace !== 0) throw new Error("只支持 8bit 非隔行 PNG：" + file);
  const channels = color === 6 ? 4 : color === 2 ? 3 : color === 0 ? 1 : color === 4 ? 2 : color === 3 ? 1 : 0;
  if (!channels) throw new Error("不支持的色彩类型 " + color + "：" + file);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let val;
      if (filter === 0) val = v;
      else if (filter === 1) val = v + a;
      else if (filter === 2) val = v + b;
      else if (filter === 3) val = v + ((a + b) >> 1);
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = v + pr;
      }
      cur[x] = val & 0xff;
    }
    prev.set(cur);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (color === 3) {
        const idx = cur[x];
        out[o] = palette[idx * 3];
        out[o + 1] = palette[idx * 3 + 1];
        out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (channels === 3) {
        out[o] = cur[x * 3];
        out[o + 1] = cur[x * 3 + 1];
        out[o + 2] = cur[x * 3 + 2];
        out[o + 3] = 255;
      } else if (channels === 4) {
        out[o] = cur[x * 4];
        out[o + 1] = cur[x * 4 + 1];
        out[o + 2] = cur[x * 4 + 2];
        out[o + 3] = cur[x * 4 + 3];
      } else {
        const g = cur[x * channels];
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = channels === 2 ? cur[x * 2 + 1] : 255;
      }
    }
  }
  return { width: w, height: h, rgba: out };
}