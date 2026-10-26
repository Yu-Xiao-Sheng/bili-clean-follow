// track_a_extension_e2e.mjs —— A 轨真机取证：真 Chromium + 未打包扩展 + B站接口替身。
//
// 跑法（本机）：
//   node tests/e2e/track_a_extension_e2e.mjs              # 默认 --headless=new（2026-10-26 实测能装扩展）
//   HEADLESS=0 node tests/e2e/track_a_extension_e2e.mjs   # 有桌面会话时按有头跑（排查用）
//   E2E_CHROME=<chrome 路径> node ...                     # 钉一个指定构建
//
// 取证口径：这条轨道的每条断言都标 kind=mock（B站接口是本机替身，不是真实会话）。
// 真实登录态那条是 B 轨，绝不混在这里。
//
// 装载方式（实测 2026-10-26，别再走回头路）：
//   1) --load-extension 在 branded 构建里被**忽略**：Google Chrome / Chrome for Testing 127+ 都停了这个
//      开关，Playwright 自带的 chromium-1248 就是 branded（CDP Browser.getVersion 回 product =
//      "Chrome/156.0.8078.4"）。这条不是本机配置能改的。
//   2) 真正能装的路子是浏览器级 CDP `Extensions.loadUnpacked`，--headless=new 下可用。
//   3) 之前「本机所有 chromium 形态都装不上未打包扩展」的根因不在浏览器，而是 extension/manifest.json
//      的 version 写成 `2.0.0-alpha.3`：Chrome 要求 version 是 1-4 段点分整数（每段 <= 65536），带后缀
//      直接拒（CDP 回 "Required value 'version' is missing or invalid"）。同一个构建换合法版本号当场装成功。
//      这条现在由 tools/package_release.mjs 的 chromeVersionOk() 钉成门禁。
//   装不上时本脚本以退出码 2 明确失败，绝不静默绿；报告里 A 轨写「未取证」。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

import { SELF_MID, buildPages, resolverArgs, startMockServer, uniqueMids } from "./mock_bilibili.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const PAGES = [20, 20, 22];
const EXPECT_TOTAL = 62;

function findChromeForTesting() {
  const base = path.join(import.meta.dirname, "browser", "chrome");
  if (!fs.existsSync(base)) return process.env.CFT_PATH || null;
  const hit = fs.readdirSync(base).filter((d) => d.startsWith("win64-") || d.startsWith("linux64-"))
    .map((d) => path.join(base, d, "chrome-win64", "chrome.exe"))
    .filter((p) => fs.existsSync(p));
  return hit[0] || process.env.CFT_PATH || null;
}

/** 找一个「能装扩展」的完整 Chromium 构建：headless_shell 没有扩展子系统，不能用。 */
function chromiumExecutable() {
  if (process.env.E2E_CHROME) return path.resolve(process.env.E2E_CHROME);
  const cft = findChromeForTesting();
  if (cft && fs.existsSync(cft)) return cft;
  let pw = null;
  try { pw = chromium.executablePath(); } catch { pw = null; }
  if (pw && fs.existsSync(pw) && !pw.includes("headless_shell")) return pw;
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "ms-playwright")
    : path.join(process.env.HOME || "", ".cache", "ms-playwright");
  const cands = [];
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      if (!/^chromium-\d+$/.test(dir)) continue;
      for (const sub of ["chrome-win64/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const p = path.join(base, dir, ...sub.split("/"));
        if (fs.existsSync(p)) cands.push([Number(dir.split("-")[1]), p]);
      }
    }
  }
  cands.sort((a, b) => b[0] - a[0]);
  return cands[0] ? cands[0][1] : pw;
}

/** CDP Extensions.loadUnpacked：Chrome 127+ 里唯一可靠的未打包扩展装载方式。 */
async function loadUnpackedViaCdp(port, extDir) {
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json/version");
      wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch { /* 浏览器还在起 */ }
  }
  if (!wsUrl) { const e = new Error("CDP 端口 " + port + " 没起来"); e.code = "CDP_NOT_READY"; throw e; }
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
    const r = await send("Extensions.loadUnpacked", { path: extDir.replace(/\\/g, "/") });
    if (r.error) {
      const e = new Error("Extensions.loadUnpacked 被拒：" + r.error.message);
      e.cdpError = r.error;
      throw e;
    }
    return r.result.id;
  } finally {
    ws.close();
  }
}

/**
 * 登录态替身：扩展读不到 bili_jct 就不抓（background.js 里的 not_logged_in 分支），所以 A 轨要在这个
 * 一次性画像里种 cookie。这是 **mock 登录态**，不是真实会话——真实登录态是 B 轨，绝不混。
 */
async function seedLoginCookies(ctx) {
  const page = await ctx.newPage();
  const session = await ctx.newCDPSession(page);
  for (const [name, value] of [["bili_jct", "e2e-csrf-token"], ["SESSDATA", "e2e-sessdata"], ["DedeUserID", SELF_MID]]) {
    await session.send("Network.setCookie", {
      name, value, domain: ".bilibili.com", path: "/", secure: true, httpOnly: false, sameSite: "None",
    });
  }
  await session.detach().catch(() => {});
  await page.close().catch(() => {});
}

let portSeq = Number(process.env.E2E_CDP_PORT || 9411);

async function launch({ mock, profileDir }) {
  const exe = chromiumExecutable();
  if (!exe || !fs.existsSync(exe)) {
    const e = new Error("找不到完整 Chromium 构建（headless_shell 不能装扩展）。用 E2E_CHROME=<chrome 路径> 指定。");
    e.code = "EXTENSION_NOT_LOADED";
    throw e;
  }
  const port = portSeq++;
  let args = [
    "--disable-gpu", "--no-sandbox", "--no-first-run", "--enable-extensions",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profileDir,
    resolverArgs(mock.port),
    "--ignore-certificate-errors",
    "about:blank",
  ];
  if (process.env.HEADLESS !== "0") args = ["--headless=new", ...args];
  const proc = spawn(exe, args, { stdio: "ignore" });
  let extensionId = null;
  let loadError = null;
  try {
    extensionId = await loadUnpackedViaCdp(port, EXT);
  } catch (err) {
    loadError = err;
  }
  if (!extensionId) {
    proc.kill();
    const err = new Error("扩展没装进浏览器：" + (loadError && loadError.message) +
      "。branded 构建会忽略 --load-extension，只能用 CDP Extensions.loadUnpacked；" +
      "manifest 的 version 不是 1-4 段点分整数也会在这里被拒。");
    err.code = "EXTENSION_NOT_LOADED";
    throw err;
  }
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, { timeout: 60000 });
  const ctx = browser.contexts()[0] || (await browser.newContext());
  await seedLoginCookies(ctx);
  return { browser, ctx, proc, extensionId, exe };
}

async function closeAll({ browser, proc }) {
  try { await browser.close(); } catch { /* 已经关了 */ }
  proc.kill();
  await new Promise((r) => setTimeout(r, 800));
}

/** 按 loadUnpacked 返回的 id 直接开侧栏（不再从 Secure Preferences 里猜 id）。 */
async function openSidePanel(ctx, extensionId) {
  const url = "chrome-extension://" + extensionId + "/sidepanel.html";
  for (let i = 0; i < 12; i++) {
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
    if (resp && resp.ok() && (await page.$("#btn-start"))) return { page, id: extensionId };
    await page.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const text = (page, sel) => page.textContent(sel).catch(() => "");

async function waitFetched(page, want, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = Number(await text(page, "#stat-fetched"));
    if (got >= want) return got;
    await page.waitForTimeout(500);
  }
  throw new Error("等不到 fetched>=" + want + "（当前 " + (await text(page, "#stat-fetched")) + "）");
}

async function scenarioHappyPath(log) {
  const mock = await startMockServer({ pages: buildPages(PAGES) });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-track-a-"));
  const run = await launch({ mock, profileDir });
  const { ctx } = run;
  const offsite = [];
  ctx.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (!/(bilibili\.com|hdslb\.com|^$)/.test(host) && !req.url().startsWith("chrome-extension://") &&
      !req.url().startsWith("chrome://") && !req.url().startsWith("data:")) offsite.push(req.url());
  });
  try {
    const opened = await openSidePanel(ctx, run.extensionId);
    if (!opened) {
      const err = new Error("扩展装上了但侧栏打不开（chrome-extension://" + run.extensionId + "/sidepanel.html）");
      err.code = "EXTENSION_NOT_LOADED";
      throw err;
    }
    const { page, id } = opened;
    log.extensionId = id;
    // B2：抓全之前「开始分类」必须 disabled，且写明还没读全
    await page.click("#btn-start");
    await waitFetched(page, 20);
    const midDisabled = await page.getAttribute("#btn-classify", "disabled");
    const midLine = await text(page, "#progress-line");
    log.cases.push({
      id: "B2", kind: "mock",
      name: "抓全前分类按钮 disabled + 文案含「还没读全（已取 N/total）」",
      passed: midDisabled !== null && /还没读全（已取 \d+\/62/.test(midLine),
      detail: { disabled: midDisabled !== null, line: midLine },
    });

    await waitFetched(page, EXPECT_TOTAL);
    const fetched = Number(await text(page, "#stat-fetched"));
    const total = Number(await text(page, "#stat-total"));
    const pagesShown = Number(await text(page, "#stat-pages"));
    const pns = mock.requests.filter((r) => r.path === "/x/relation/followings").map((r) => r.pn);
    log.cases.push({
      id: "B1", kind: "mock",
      name: "3 页夹具抓全：fetched == total == 62，pn 序列 1..3，跨页重复被 mid 去重",
      passed: fetched === EXPECT_TOTAL && total === EXPECT_TOTAL && pns.join(",") === "1,2,3",
      detail: { fetched, total, pagesShown, pns, servedRows: buildPages(PAGES).flat().length },
    });
    const afterDisabled = await page.getAttribute("#btn-classify", "disabled");
    log.cases.push({
      id: "B5", kind: "mock",
      name: "抓全后分类解锁（按钮不再 disabled）",
      passed: afterDisabled === null, detail: { disabled: afterDisabled !== null },
    });

    // C2：没有 Key 时只能走离线规则，零外发
    await page.click("#btn-classify-local");
    await page.waitForFunction(() => {
      const el = document.querySelector("#classify-summary");
      return el && !/^还没分类/.test(el.textContent.trim());
    }, null, { timeout: 20000 }).catch(() => {});
    // 卡片真实文案是「类目名 23 条 · 37.1% 平均置信 …」：取数按「N 条」，不是「N 人」
    const counts = await page.$$eval("#category-list li", (lis) =>
      lis.map((li) => Number((li.textContent.match(/(\d+)\s*条/) || [0, 0])[1])));
    const sum = counts.reduce((a, b) => a + b, 0);
    log.cases.push({
      id: "C2", kind: "mock",
      name: "无 Key 走离线规则分类：分类条目数 == 关注条目数，且全程零外发",
      passed: sum === EXPECT_TOTAL && offsite.length === 0,
      detail: { counts, sum, offsite },
    });

    const audit = await page.$$eval("#audit-list li", (lis) => lis.map((li) => li.textContent.trim()));
    log.cases.push({
      id: "D7-scan", kind: "mock",
      name: "审计日志含 scan_start / scan_complete（取关侧审计等 FOR-65）",
      passed: audit.some((l) => l.includes("scan_start")) &&
        audit.some((l) => l.includes("scan_complete")),
      detail: { audit },
    });
    log.numbers = { follow_total: total, pages: pagesShown, cls_counts_sum: sum };
  } finally {
    await closeAll(run);
    await mock.close();
  }
}

async function scenarioRiskControl(log) {
  const pages = buildPages(PAGES);
  const mock = await startMockServer({ pages, riskOnPage: 2 });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-track-a-risk-"));
  const run = await launch({ mock, profileDir });
  try {
    const opened = await openSidePanel(run.ctx, run.extensionId);
    if (!opened) {
      const err = new Error("扩展装上了但侧栏打不开（风控场景，同上）");
      err.code = "EXTENSION_NOT_LOADED";
      throw err;
    }
    const { page } = opened;
    await page.click("#btn-start");
    await page.waitForFunction(() => {
      const resume = document.querySelector("#btn-resume");
      return (resume && !resume.hidden) || Number(document.querySelector("#stat-fetched").textContent) >= 62;
    }, null, { timeout: 25000 }).catch(() => {});
    const resumeVisible = !(await page.isHidden("#btn-resume"));
    const disabled = await page.getAttribute("#btn-classify", "disabled");
    const fetched = Number(await text(page, "#stat-fetched"));
    log.cases.push({
      id: "B3", kind: "mock",
      name: "第 2 页注入 -352 风控：状态 incomplete、分类仍锁定、出现「继续抓取」且已取数据保留",
      passed: resumeVisible && disabled !== null && fetched > 0 && fetched < EXPECT_TOTAL,
      detail: { resumeVisible, classifyDisabled: disabled !== null, fetched },
    });
  } finally {
    await closeAll(run);
    await mock.close();
  }
}

async function envVersions() {
  const exe = chromiumExecutable();
  const probe = await chromium.launch({ headless: true, executablePath: exe || undefined });
  const page = await probe.newPage();
  const ua = await page.evaluate(() => navigator.userAgent);
  await probe.close();
  const pw = (await import("playwright/package.json", { with: { type: "json" } })).default.version;
  return {
    os: process.platform + " " + os.release(),
    chrome: (ua.match(/Chrome\/([\d.]+)/) || [0, "unknown"])[1],
    chromePath: exe || "unknown",
    loadMethod: "cdp:Extensions.loadUnpacked",
    node: process.version,
    playwright: pw,
    python: "见 pytest 侧报告（同一棵树同一环境）",
  };
}

const log = { track: "A", kind: "mock", startedAt: new Date().toISOString(), cases: [], numbers: {} };
let exitCode = 0;
try {
  log.env = await envVersions();
  await scenarioHappyPath(log);
  await scenarioRiskControl(log);
} catch (err) {
  log.fatal = String(err && err.message);
  exitCode = err && err.code === "EXTENSION_NOT_LOADED" ? 2 : 1;
}
if (!log.fatal && log.cases.some((c) => !c.passed)) exitCode = 1;  // 任一条判红，取证脚本不能退 0
log.finishedAt = new Date().toISOString();
log.passed = log.cases.filter((c) => c.passed).length;
log.total = log.cases.length;

const outDir = path.join(ROOT, "tmp", "qa-e2e");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "track-a.json"), JSON.stringify(log, null, 2));
console.log(JSON.stringify({ track: log.track, env: log.env, passed: log.passed, total: log.total,
  cases: log.cases.map((c) => ({ id: c.id, passed: c.passed })), fatal: log.fatal || null }, null, 2));
process.exit(exitCode);
