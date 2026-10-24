// 本地生成的 BGM：离线合成，不用任何第三方音源，零版权风险。
// 和弦垫（Am - F - C - G）+ 轻 kick + 反拍 hat + 安静琶音，master 归一化 + 淡入淡出。
//
//   node tools/gen_bgm.mjs                       # 两支片子的音轨都生成
//   node tools/gen_bgm.mjs --frames 1730 --out public/audio/bgm-promo.wav
//   node tools/gen_bgm.mjs --seconds 62 --out public/audio/bgm-walk.wav
//
// 产物不提交（public/audio/ 已在 .gitignore 里）；render 脚本会先跑这个。
import fs from "node:fs";
import path from "node:path";

const FPS = 30;
const SR = 44100;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};

const NOTE = {
  G2: 98.0, C3: 130.81, E3: 164.81, G3: 196.0, A3: 220.0, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F3: 174.61, F4: 349.23, G4: 392.0,
  A4: 440.0, C5: 523.25, E5: 659.25,
};
const CHORDS = [
  [NOTE.A3, NOTE.C4, NOTE.E4],   // Am
  [NOTE.F3, NOTE.A3, NOTE.C4],   // F
  [NOTE.C4, NOTE.E4, NOTE.G4],   // C
  [NOTE.G3, NOTE.B3, NOTE.D4],   // G
];
const CH = 4.0; // 每个和弦 4 秒

function render(seconds) {
  const N = Math.floor(SR * seconds);
  const out = new Float64Array(N);

  const add = (start, len, fn) => {
    const a = Math.floor(start * SR);
    const b = Math.min(N, Math.floor((start + len) * SR));
    for (let i = a; i < b; i++) out[i] += fn((i - a) / SR);
  };
  const env = (t, atk, dec) => Math.min(1, t / atk) * Math.exp(-t / dec);

  // 和弦垫
  for (let bar = 0; bar * CH < seconds; bar++) {
    const chord = CHORDS[bar % CHORDS.length];
    for (const f of chord) {
      add(bar * CH, CH + 0.5, (t) => {
        const e = env(t, 0.55, 2.6);
        return (
          0.055 * Math.sin(2 * Math.PI * f * t) +
          0.022 * Math.sin(2 * Math.PI * f * 2 * t) +
          0.012 * Math.sin(2 * Math.PI * f * 1.001 * t)
        ) * e;
      });
    }
  }

  // 琶音：八分音符，轻拨
  for (let s = 0; s * 0.25 < seconds; s++) {
    const t0 = s * 0.25;
    const chord = CHORDS[Math.floor(t0 / CH) % CHORDS.length];
    const f = chord[s % chord.length] * (s % 4 === 3 ? 2 : 1);
    add(t0, 0.5, (t) => 0.035 * Math.sin(2 * Math.PI * f * t) * env(t, 0.005, 0.16));
  }

  // 每拍一个软 kick
  for (let s = 0; s * 1.0 < seconds; s++) {
    add(s * 1.0, 0.4, (t) => {
      const f = 62 - 22 * Math.min(1, t / 0.12);
      return 0.16 * Math.sin(2 * Math.PI * f * t) * env(t, 0.004, 0.13);
    });
  }

  // 反拍 hat：高通噪声
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  let prev = 0;
  for (let s = 0; s * 0.5 + 0.25 < seconds; s++) {
    add(s * 0.5 + 0.25, 0.09, (t) => {
      const n = rnd();
      const hp = n - prev;
      prev = n;
      return 0.05 * hp * env(t, 0.001, 0.028);
    });
  }

  // master：淡入 1.2s / 淡出 1.6s，归一化 + soft clip
  const fade = (i) =>
    Math.min(1, i / SR / 1.2) * Math.min(1, (seconds - i / SR) / 1.6);
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i] * fade(i)));
  const gain = peak > 0 ? 0.62 / peak : 1;

  const pcm = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const v = Math.round(Math.tanh(out[i] * fade(i) * gain * 1.25) * 32767 * 0.98);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * 4, 28);
  hdr.writeUInt16LE(4, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

function write(outPath, seconds) {
  const wav = render(seconds);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, wav);
  console.log(`${outPath}  ${seconds.toFixed(2)}s  ${(wav.length / 1048576).toFixed(1)} MB`);
}

if (arg("out", null)) {
  const seconds = arg("frames", null)
    ? Number(arg("frames")) / FPS
    : Number(arg("seconds", 53));
  write(arg("out"), seconds);
} else {
  // 默认：两支片子各一条，长度对齐成片帧数
  write("public/audio/bgm-promo.wav", 1730 / FPS);
  write("public/audio/bgm-walk.wav", 1850 / FPS);
}
