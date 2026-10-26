// FOR-67 A 轨：挑一个「真能把未打包扩展装进去」的 Chromium 构建。
//
// 为什么不能按字典序取第一个（FOR-71 在 47499ec 上复核出的夹具缺陷）：
// tests/e2e/browser/chrome/ 下常常并存多个 Chrome for Testing 构建，readdirSync 回来的是
// 字典序，win64-126.0.6478.127 排第一 —— 但浏览器级 CDP 的 Extensions.loadUnpacked 在 126
// 里根本不存在，134 返回 "Method not available."，只有 156 可用。于是默认跑法直接 fatal
// 退出码 2，报「A 轨未取证」：坏的是夹具选择，不是产品。
//
// 本机（win32，同一份 extension/，只换构建）实测的原始报错：
//   126.0.6478.127 -> CDP -32601  "'Extensions.loadUnpacked' wasn't found"
//   134.0.6998.88  -> CDP -32000  "Method not available."
//   156.0.8078.47  -> OK，回 extension id
//
// 所以这里做两件事：① 按版本号**数值**降序排（字典序会把 99 排在 100 前）；
// ② 对候选构建真探一次 Extensions.loadUnpacked，第一个能装的才用，被拒的构建连版本号与
// 原始报错一起记进 env.rejectedBuilds —— 下一台机器再看到多构建时不会把它当产品回归。
//
// 覆盖方式：E2E_CHROME=<chrome.exe 路径> 直接钉死（不探针）；E2E_CHROME_PROBE=0 只按版本
// 排序取最高的那个，不启动浏览器探针。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const CFT_DIR = path.join(import.meta.dirname, "browser", "chrome");

const ARCH_SUBPATH = {
  win64: ["chrome-win64", "chrome.exe"],
  linux64: ["chrome-linux64", "chrome"],
};

/** 从目录名 win64-156.0.8078.47 / linux64-140.0.0 里取出版本号数组；不是构建目录回 null。 */
export function buildVersion(dir) {
  const m = /^(win64|linux64)-(\d+(?:\.\d+)*)$/.exec(dir);
  return m ? m[2].split(".").map(Number) : null;
}

function compareVersionDesc(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] || 0) - (a[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 列出目录里真实可用的构建，按版本号数值降序；.metadata、缺 exe 的半截下载都会被跳掉。 */
export function listChromeBuilds(base = CFT_DIR) {
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const dir of fs.readdirSync(base)) {
    const ver = buildVersion(dir);
    if (!ver) continue;
    const sub = ARCH_SUBPATH[dir.split("-")[0]];
    if (!sub) continue;
    const exe = path.join(base, dir, ...sub);
    if (!fs.existsSync(exe)) continue;
    out.push({ dir, version: ver.join("."), exe });
  }
  out.sort((a, b) => compareVersionDesc(buildVersion(a.dir), buildVersion(b.dir)) || a.dir.localeCompare(b.dir));
  return out;
}

/** Playwright 自带的完整 chromium 构建（headless_shell 没有扩展子系统，不能要）。 */
export function listPlaywrightBuilds(env = process.env) {
  const base = process.platform === "win32"
    ? path.join(env.LOCALAPPDATA || "", "ms-playwright")
    : path.join(env.HOME || "", ".cache", "ms-playwright");
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const dir of fs.readdirSync(base)) {
    const m = /^chromium-(\d+)$/.exec(dir);
    if (!m) continue;
    const subs = process.platform === "win32" ? ["chrome-win64", "chrome.exe"] : ["chrome-linux64", "chrome"];
    const exe = path.join(base, dir, ...subs);
    if (!fs.existsSync(exe)) continue;
    out.push({ dir, version: m[1], exe });
  }
  out.sort((a, b) => Number(b.version) - Number(a.version));
  return out;
}

/**
 * 全局 WebSocket 的前置检查。
 * 为什么单独钉它（本轮实测口径）：A 轨靠浏览器级 CDP 的 Extensions.loadUnpacked，而这条调用
 * 用的是 Node 的全局 WebSocket。Node 20 的官方文档把 WebSocket 标成 Stability: 1 - Experimental，
 * 必须加 --experimental-websocket 才存在；而 ci.yml 里 setup-node 之前钉的是 20 —— 也就是说
 * track-a job 就算被触发也会摔成 "WebSocket is not defined"，取证日志看不出根因。
 * 缺了它就直接失败并把 Node 版本号写进报错，而不是留一句 ReferenceError 给下一轮排查。
 */
export function requireWebSocketGlobal(version = process.version) {
  if (typeof globalThis.WebSocket !== "function") {
    const e = new Error("当前 Node " + version + " 没有全局 WebSocket，A 轨的浏览器级 CDP 跑不了："
      + "用 Node 21+（CI 里是 22），或给 Node 20 加 --experimental-websocket。");
    e.code = "WEBSOCKET_GLOBAL_MISSING";
    throw e;
  }
}

async function waitForCdp(port, { tries = 80, delay = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json/version");
      const url = (await res.json()).webSocketDebuggerUrl;
      if (url) return url;
    } catch { /* 浏览器还在起 */ }
  }
  const e = new Error("CDP 端口 " + port + " 没起来");
  e.code = "CDP_NOT_READY";
  throw e;
}

async function callCdp(wsUrl, calls) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  try {
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => new Promise((res) => {
      const i = ++seq;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    return await calls(send);
  } finally {
    ws.close();
  }
}

let probePortSeq = Number(process.env.E2E_PROBE_PORT || 9520);

/**
 * 真探针：起这个构建，问它 Extensions.loadUnpacked 认不认。
 * 返回 {ok, product, extensionId, error}；不抛异常 —— 探针失败是数据，不是事故。
 */
export async function probeUnpackedSupport(exe, extDir) {
  requireWebSocketGlobal();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-probe-"));
  const port = probePortSeq++;
  const proc = spawn(exe, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--enable-extensions", "--no-first-run",
    "--remote-debugging-port=" + port, "--user-data-dir=" + profileDir, "about:blank",
  ], { stdio: "ignore" });
  try {
    const wsUrl = await waitForCdp(port);
    const res = await callCdp(wsUrl, async (send) => {
      const ver = await send("Browser.getVersion", {});
      const load = await send("Extensions.loadUnpacked", { path: extDir.replace(/\\/g, "/") });
      return { ver, load };
    });
    const product = (res.ver.result && res.ver.result.product) || null;
    if (res.load.error) {
      return { ok: false, product, error: "CDP " + res.load.error.code + " " + res.load.error.message };
    }
    return { ok: true, product, extensionId: res.load.result.id, error: null };
  } catch (err) {
    return { ok: false, product: null, error: String(err && err.message) };
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 600));
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

/**
 * 选构建：E2E_CHROME 钉死 > Chrome for Testing（版本降序 + 探针）> Playwright 自带 chromium。
 * 返回 {exe, source, build, version, rejected[]}，rejected 里是被拒构建的原始报错。
 */
export async function selectChromeForExtensionTest({
  env = process.env,
  base = CFT_DIR,
  extDir,
  probe = probeUnpackedSupport,
  onSkip = () => {},
} = {}) {
  const rejected = [];
  if (env.E2E_CHROME) {
    return { exe: path.resolve(env.E2E_CHROME), source: "env:E2E_CHROME", build: null, version: null, rejected };
  }
  const cands = listChromeBuilds(base).map((b) => ({ ...b, source: "cft" }));
  if (!env["E2E_CHROME_PROBE"] || env.E2E_CHROME_PROBE !== "0") {
    for (const b of cands.concat(listPlaywrightBuilds(env).map((b) => ({ ...b, source: "playwright" })))) {
      const r = await probe(b.exe, extDir);
      if (r.ok) return { exe: b.exe, source: b.source + ":" + b.dir, build: b.dir, version: b.version, rejected };
      rejected.push({ build: b.dir, version: b.version, product: r.product || null, error: r.error || "unknown" });
      onSkip(b.dir + " -> " + (r.error || "unknown"));
    }
    return { exe: cands[0] ? cands[0].exe : null, source: "none", build: null, version: null, rejected };
  }
  // 只按版本排序，不探针（留给明确知道机器状态的场合）
  const first = cands[0] || listPlaywrightBuilds(env)[0];
  return first
    ? { exe: first.exe, source: "version-only:" + first.dir, build: first.dir, version: first.version, rejected }
    : { exe: null, source: "none", build: null, version: null, rejected };
}

/**
 * 全量探针矩阵：把每一个候选构建都探一遍，**不中途停**。
 *
 * 为什么单独要这条（FOR-71 在 be22275 上复核出的取证口径）：selectChromeForExtensionTest
 * 是「探到第一个能用就停」，所以在这台最高版本正好能用的机器上 env.rejectedBuilds 是空数组，
 * track-a.json 里看不见 126 / 134 的原始拒因 —— 「被拒构建的报错会进 env」只在最高版本装不进
 * 扩展的机器上成立。报告要展示环境矩阵就引用 --doctor-matrix 的产物 tmp/qa-e2e/chrome-matrix.json。
 */
export async function probeChromeBuildMatrix({
  env = process.env,
  base = CFT_DIR,
  extDir,
  probe = probeUnpackedSupport,
} = {}) {
  const pinned = env.E2E_CHROME ? path.resolve(env.E2E_CHROME) : null;
  const cands = listChromeBuilds(base).map((b) => ({ ...b, source: "cft" }))
    .concat(listPlaywrightBuilds(env).map((b) => ({ ...b, source: "playwright" })));
  const matrix = [];
  for (const b of cands) {
    const r = await probe(b.exe, extDir);
    matrix.push({
      build: b.dir,
      source: b.source,
      version: b.version,
      product: r.product || null,
      ok: Boolean(r.ok),
      error: r.ok ? null : (r.error || "unknown"),
    });
  }
  const usable = matrix.filter((r) => r.ok);
  return { pinned, probed: matrix.length, usable: usable.length, chosen: usable[0] || null, matrix };
}
