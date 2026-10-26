// track_b_real_readonly.mjs —— B 轨取证：真实登录态、只读、全量抓取 + 离线分类 + 逐条快照导出。
//
// 为什么单独一条轨道（FOR-67 硬条件①）：A 轨是 mock 登录态（假令牌 + 本机替身），报告里只能标
// kind=mock。CEO 的 No-Go 硬条件里「B4 真实登录态轨缺失或未取证」和「报告把 mock 写成真实会话」
// 都在盯这条轨道，所以本脚本的第一职责不是抓数据，而是**保证它不会越界、也不会冒充**：
//
//   1) 没有人的授权就不碰真实账号：必须显式 --consent=<卡片选项 id>，否则退出码 4（B 轨未取证）。
//   2) 只读是浏览器层硬拦的：CDP Fetch 域把**每一条 http(s) 请求**按 track_b_policy.decideRequest
//      判一遍，不在只读白名单里的一律 failRequest。产品代码若有写路径（FOR-65 的取关），在这里
//      发不出去，并会被记成 read-only violation（退出码 6）。
//   3) 真实会话是真的：开跑前用 GET /x/web-interface/nav 读 data.isLogin；不是登录态就退出码 5，
//      绝不拿替身数据冒充真实会话（--mock 分支只写 tmp/，永不写 docs/qa-evidence/）。
//   4) 落盘快照走字段白名单（mid / name / category / confidence），多一个键就不落盘：见
//      docs/qa-evidence/README.md 与 tests/e2e/track_b_policy.mjs。
//
// 跑法
//   # 替身自检（不需要账号，CI 里跑的就是这条；产物只进 tmp/，报告里必须标 mock）
//   node tests/e2e/track_b_real_readonly.mjs --mock
//
//   # 人给了一个已登录 B站的 Chrome 画像目录（卡片选项 give_profile）
//   node tests/e2e/track_b_real_readonly.mjs --consent=give_profile --profile="D:/bcf-profile"
//
//   # 人授权用本机现有登录态（卡片选项 grant_current_login）：把画像的登录相关文件复制到临时目录再跑，
//   # 不动真人正在用的 Chrome 画像（会被 Chrome 独占锁，也不该被取证改动）
//   node tests/e2e/track_b_real_readonly.mjs --consent=grant_current_login --copy-profile-from="C:/Users/<u>/AppData/Local/Google/Chrome/User Data"
//
//   # 全新画像 + 有头，等人扫码登录（最多 --max-wait-login 秒，默认 240）
//   HEADLESS=0 node tests/e2e/track_b_real_readonly.mjs --consent=grant_current_login --fresh-login
//
// 退出码：0 取证完成；1 断言判红；2 扩展装不进浏览器；4 未获人授权（真实会话不跑）；
// 5 画像里没有 B站登录态（真实会话未取证）；6 出现只读越界尝试（P0，报告必须写）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

import { SELF_MID, buildPages, resolverArgs, startMockServer } from "./mock_bilibili.mjs";
import { selectChromeForExtensionTest } from "./chrome_choice.mjs";
import {
  decideRequest,
  publicItem,
  publicRequestLog,
  validateScanItems,
} from "./track_b_policy.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const MOCK_PAGES = [20, 20, 22];
const MOCK_TOTAL = 62;
const CONSENT_OPTIONS = new Set(["grant_current_login", "give_profile"]);
const DEBUG = process.env.E2E_DEBUG === "1";
// 看门狗：拦截或等待卡死时，把「卡在哪」写进 tmp 并以退出码 7 结束，绝不无界挂下去。
const WATCHDOG_MS = Number(process.env.E2E_WATCHDOG_MS || 180000);
let stage = "启动";
const setStage = (s2) => { stage = s2; if (DEBUG) console.error("[stage] " + s2); };
const watchdog = setTimeout(() => {
  log.fatal = "看门狗超时（" + WATCHDOG_MS + "ms）：卡在「" + stage + "」。B 轨按未取证处理。";
  log.exitCode = 7;
  log.stage = stage;
  fs.mkdirSync(path.join(ROOT, "tmp", "qa-e2e"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "tmp", "qa-e2e", "track-b.json"), JSON.stringify(log, null, 2));
  console.error(log.fatal);
  process.exit(7);
}, WATCHDOG_MS);

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes("--" + name);

const mode = flag("mock") ? "mock" : "real";
const consent = arg("consent");
const profileDirArg = arg("profile");
const copyFromArg = arg("copy-profile-from");
const freshLogin = flag("fresh-login");
const maxWaitLogin = Number(arg("max-wait-login") || 240) * 1000;

const log = {
  track: "B",
  kind: mode === "mock" ? "mock" : "real",
  consent: consent || null,
  startedAt: new Date().toISOString(),
  cases: [],
  numbers: {},
  readOnly: { allowed: 0, denied: 0, writeAttempts: [], deniedHosts: new Set(), enableErrors: [] },
};
const requestRecords = [];
let phase = "product";   // "probe" = 本脚本自己发的拦截图腾，不算产品越界

// ---------------------------------------------------------------- CDP 客户端

function connectCdp(port) {
  return new Promise((resolve, reject) => {
    (async () => {
      let wsUrl = null;
      for (let i = 0; i < 80 && !wsUrl; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          wsUrl = (await (await fetch("http://127.0.0.1:" + port + "/json/version")).json()).webSocketDebuggerUrl;
        } catch { /* 浏览器还在起 */ }
      }
      if (!wsUrl) return reject(new Error("CDP 端口 " + port + " 没起来"));
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        let seq = 0;
        const pending = new Map();
        const handlers = [];
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
          if (msg.method) handlers.forEach((h) => h(msg));
        };
        resolve({
          send: (method, params = {}, sessionId = undefined) => new Promise((res) => {
            const id = ++seq;
            pending.set(id, res);
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
          }),
          on: (fn) => handlers.push(fn),
          close: () => ws.close(),
        });
      };
      ws.onerror = () => reject(new Error("CDP WebSocket 连不上"));
    })();
  });
}

/** 只读护栏：浏览器层 CDP Fetch 拦截，逐条按策略判，不在白名单里直接 failRequest。 */
async function startReadOnlyGuard(cdp) {
  const enabled = new Map(); // targetId -> sessionId：同一个 target 只留一条拦截会话
  let targetType = null;
  const FETCH_PATTERN = { patterns: [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests: false };
  const enableOn = async (targetId, sessionId) => {
    const r = await cdp.send("Fetch.enable", FETCH_PATTERN, sessionId);
    if (r && r.error) {
      log.readOnly.enableErrors.push({ targetId, type: targetType || "?", error: r.error.message });
      return false;
    }
    enabled.set(targetId, sessionId);
    return true;
  };
  // 同一个 target 上只留一条开 Fetch 的会话（两条都开会要求同一条请求应答两次，漏一次就永久挂起）。
  // 但**后到的会话要接管**：手动 attach 先建的会话有时收不到请求（Chrome 把请求交给最近 attach 的会话），
  // 那种情况下如果还守着先那条，护栏对这个 target 就是瞎的——R1 覆盖断言会在 4 次里红 2 次，实测过。
  const enableFetchFor = async (targetId, sessionId) => {
    if (enabled.get(targetId) === sessionId) return;
    if (enabled.has(targetId)) {
      const previous = enabled.get(targetId);
      enabled.delete(targetId);
      await cdp.send("Fetch.disable", {}, previous).catch(() => {});
    }
    const ok = await enableOn(targetId, sessionId);
    if (!ok && enabled.has(targetId)) return;
  };

  await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  cdp.on(async (msg) => {
    if (msg.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = msg.params;
      targetType = targetInfo.type;
      await enableFetchFor(targetInfo.targetId, sessionId);
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
    if (msg.method === "Target.targetCreated") {
      const t = msg.params.targetInfo;
      if (["service_worker", "shared_worker", "other"].includes(t.type)) {
        await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }).catch(() => {});
      }
    }
    if (msg.method === "Fetch.requestPaused") {
      const sessionId = msg.sessionId;
      const req = msg.params.request || {};
      const url = String(req.url || "");
      let protocol = "";
      try { protocol = new URL(url).protocol; } catch { protocol = "invalid:"; }
      // 非 http(s)（chrome-extension:// / data: / chrome://）不是出网，交给浏览器自己
      if (protocol !== "http:" && protocol !== "https:") {
        await cdp.send("Fetch.continueRequest", { requestId: msg.params.requestId }, sessionId).catch(() => {});
        return;
      }
      if (DEBUG) console.error("[guard] " + (sessionId || "browser") + " " + req.method + " " + url.slice(0, 110));
      const d = decideRequest({ method: req.method, url, hasPostData: Boolean(req.hasPostData || req.postData) });
      requestRecords.push({ method: req.method, url, hasPostData: Boolean(req.hasPostData || req.postData) });
      if (d.kind === "write") log.readOnly.writeAttempts.push({ phase, host: d.host, method: d.method, path: d.path });
      if (!d.allowed) {
        log.readOnly.denied++;
        log.readOnly.deniedHosts.add(d.kind + ":" + (d.path || d.host || url.slice(0, 60)));
        await cdp.send("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
        return;
      }
      log.readOnly.allowed++;
      await cdp.send("Fetch.continueRequest", { requestId: msg.params.requestId }, sessionId).catch(() => {});
    }
  });

  // 已经在跑的 target（含 service worker）补挂一遍：autoAttach 只管之后新建的
  // Target.attachToTarget 不会给发起方回 Target.attachedToTarget 事件，所以这些会话的 Fetch
  // 必须在返回值里手动开：漏掉这一步，MV3 service worker 的抓取请求就完全不过护栏，
  // 真账号上「只读」会变成一句没有拦截背书的空话（2026-10-27 实测就是这个现象）。
  const got = await cdp.send("Target.getTargets");
  // cdp.send 回的是 CDP 信封（{id, result}），targetInfos 在 result 里。
  // 以前直接读信封上的 targetInfos，永远拿到 undefined -> 空数组：这个补挂循环一次都没跑过，
  // 于是「装载时就已启动的 service worker」根本没进护栏，R1 覆盖断言 6 次里红 4 次。
  const targets = (got.result && got.result.targetInfos) || [];
  const attached = [];
  for (const t of targets) {
    const r = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }).catch(() => null);
    const sid = r && r.result && r.result.sessionId;
    if (!sid) continue;
    attached.push(t.type + ":" + t.targetId);
    targetType = t.type;
    await enableFetchFor(t.targetId, sid);
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
  }
  return { enabledCount: () => enabled.size, attached, stats: () => ({
    enabledTargets: [...enabled.keys()].length, attachedTargets: attached.length,
    attachedKinds: attached.map((a) => a.split(":")[0]), enableErrors: log.readOnly.enableErrors,
  }) };
}

// 替身画像专用：种**假**令牌，只为越过 background.js 的 not_logged_in 分支。
// 真实会话（mode=real）绝不会走到这里——那是 A 轨与替身自检的通路，报告里标 mock。
async function seedFakeLoginCookies(ctx) {
  const page = await ctx.newPage();
  const session = await ctx.newCDPSession(page);
  for (const [name, value] of [["bili_jct", "track-b-fake-csrf"], ["SESSDATA", "track-b-fake-sessdata"], ["DedeUserID", SELF_MID]]) {
    await session.send("Network.setCookie", { name, value, domain: ".bilibili.com", path: "/", secure: true, httpOnly: false, sameSite: "None" });
  }
  await session.detach().catch(() => {});
  await page.close().catch(() => {});
}

// ---------------------------------------------------------------- 画像处理

const PROFILE_COPY_FILES = [
  "Local State",
  "Default/Preferences",
  "Default/Secure Preferences",
  "Default/Cookies",
  "Default/Cookies-journal",
  "Default/Network/Cookies",
  "Default/Network/Cookies-journal",
  "Default/Login Data",
  "Default/Login Data-journal",
  "Default/Web Data",
];

/**
 * 复制画像里与登录态相关的文件到临时目录，**不动真人正在用的 Chrome 画像**：
 * 一是 Chrome 对 User Data 有独占锁，同一路径起第二个实例会直接失败；
 * 二是取证脚本不该有办法改动日常画像。复制不完整时后面的登录态检查会退 5，不会假装跑通。
 */
function copyProfileSubset(from, to) {
  const copied = [];
  const missing = [];
  for (const rel of PROFILE_COPY_FILES) {
    const src = path.join(from, rel);
    if (!fs.existsSync(src)) { missing.push(rel); continue; }
    const dst = path.join(to, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.copyFileSync(src, dst); copied.push(rel); } catch (err) { missing.push(rel + " (" + err.code + ")"); }
  }
  return { copied, missing };
}

// ---------------------------------------------------------------- 浏览器

async function launchBrowser({ extraArgs, profileDir, mock }) {
  const choice = await selectChromeForExtensionTest({
    extDir: EXT,
    onSkip: (msg) => console.error("[track-b][build] 跳过 " + msg),
  });
  const exe = choice.exe;
  if (!exe) {
    const e = new Error("找不到能装未打包扩展的 Chromium 构建：" +
      (choice.rejected.map((r) => r.build + " -> " + r.error).join(" | ") || "没有候选") +
      "（先跑 node tests/e2e/track_a_extension_e2e.mjs --doctor）");
    e.code = "EXTENSION_NOT_LOADED";
    throw e;
  }
  const port = Number(process.env.E2E_CDP_PORT || 9511);
  let args = [
    "--disable-gpu", "--no-sandbox", "--no-first-run", "--enable-extensions",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profileDir,
    "--ignore-certificate-errors",
    ...(mock ? [resolverArgs(mock.port)] : []),
    "about:blank",
  ];
  if (extraArgs.length) args = args.concat(extraArgs);
  if (process.env.HEADLESS !== "0") args = ["--headless=new", ...args];
  const proc = spawn(exe, args, { stdio: "ignore" });

  const cdp = await connectCdp(port);
  const loaded = await cdp.send("Extensions.loadUnpacked", { path: EXT.replace(/\\/g, "/") });
  if (!loaded.result || !loaded.result.id) {
    proc.kill();
    cdp.close();
    const e = new Error("扩展没装进浏览器：" + JSON.stringify(loaded.error));
    e.code = "EXTENSION_NOT_LOADED";
    throw e;
  }
  const guard = await startReadOnlyGuard(cdp);
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, { timeout: 60000 });
  const ctx = browser.contexts()[0] || (await browser.newContext());
  return { browser, ctx, proc, cdp, guard, extensionId: loaded.result.id, exe, build: choice.build, source: choice.source, rejected: choice.rejected };
}

async function openSidePanel(ctx, extensionId) {
  const url = "chrome-extension://" + extensionId + "/sidepanel.html";
  for (let i = 0; i < 12; i++) {
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    if (resp && resp.ok() && (await page.$("#btn-start"))) return page;
    await page.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** 真实会话自检：GET nav 读 data.isLogin。不是登录态就退 5，绝不拿替身冒充。 */
async function loginCheck(ctx) {
  const page = await ctx.newPage();
  const resp = await page.goto("https://api.bilibili.com/x/web-interface/nav", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
  let body = null;
  if (resp) body = await page.evaluate(() => document.body.innerText).catch(() => "");
  await page.close().catch(() => {});
  let json = null;
  try { json = JSON.parse(body); } catch { /* 非 JSON：没登录或被拦 */ }
  const data = json && json.data ? json.data : {};
  return {
    httpOk: Boolean(resp && resp.ok()),
    isLogin: Boolean(data.isLogin),
    mid: data.mid ? String(data.mid) : null,
    unamePresent: Boolean(data.uname),
  };
}

/** 等抓取读全：fetched == total，且状态不再变化（读全是 B1 硬门禁，不满足就不落盘）。 */
async function waitReadComplete(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = { fetched: -1, total: -1 };
  while (Date.now() < deadline) {
    const fetched = Number(await page.textContent("#stat-fetched").catch(() => "")) || 0;
    const total = Number(await page.textContent("#stat-total").catch(() => "")) || 0;
    last = { fetched, total };
    if (total > 0 && fetched >= total) return last;
    await page.waitForTimeout(1000);
  }
  return last;
}

/** 在侧栏页面上下文里 import 扩展自己的模块读 storage：不复制产品逻辑，读的是真落库结果。 */
async function readScanResultFromStorage(page) {
  return page.evaluate(async () => {
    const store = await import(chrome.runtime.getURL("store.js"));
    const classify = await import(chrome.runtime.getURL("classify.js"));
    const storage = chrome.storage.local;
    const st = store.createStore({ storage });
    const cs = classify.createClassifyStore({ storage });
    const state = await st.getState();
    const items = await st.loadItems();
    const results = await cs.loadResults();
    const taxonomy = await cs.loadTaxonomy();
    const summary = classify.categorySummary(results, taxonomy);
    return { state, items, results, summary };
  });
}

async function main() {
  // ---- 0. 人授权闸门：真实会话没有 --consent 就不许跑
  if (mode === "real" && (!consent || !CONSENT_OPTIONS.has(consent))) {
    log.fatal = "B 轨要跑真实登录态，必须带 --consent=<grant_current_login|give_profile>（对应 FOR-67 那张人工卡里的选项）。" +
      "没有人的授权就不碰真实账号；这不是参数缺失，是合规闸门。";
    log.exitCode = 4;
    return;
  }

  const mock = mode === "mock" ? await startMockServer({ pages: buildPages(MOCK_PAGES) }) : null;
  let profileDir = null;
  let ownedProfile = false;
  if (profileDirArg) {
    profileDir = path.resolve(profileDirArg);
    if (!fs.existsSync(profileDir)) { log.fatal = "--profile 指向的目录不存在：" + profileDir; log.exitCode = 1; }
  } else if (copyFromArg) {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-track-b-"));
    ownedProfile = true;
    log.numbers.profileCopy = copyProfileSubset(path.resolve(copyFromArg), profileDir);
  } else if (mode === "mock" || freshLogin) {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-track-b-"));
    ownedProfile = true;
  } else {
    log.fatal = "真实会话要指名画像：--profile=<已登录画像目录>，或 --copy-profile-from=<User Data 根目录>，" +
      "或 --fresh-login（有头，等人扫码）。";
    log.exitCode = 4;
    return;
  }
  log.numbers.profileDir = profileDir;

  const run = await launchBrowser({ extraArgs: [], profileDir, mock });
  try {
    if (mock) await seedFakeLoginCookies(run.ctx); // 替身画像：假令牌，只为越过 not_logged_in 分支

    // ---- 1. 真实会话是真的吗
    setStage("登录态自检");
    const login = await loginCheck(run.ctx);
    log.numbers.login = login;
    log.cases.push({
      id: "B4", kind: log.kind,
      name: mode === "mock" ? "登录态来自替身画像（假令牌）——本条只能标 mock，不得写进真实会话取证"
        : "真实登录态：GET /x/web-interface/nav 回 data.isLogin=true",
      passed: login.isLogin,
      detail: login,
    });
    if (mode === "real" && !login.isLogin) {
      log.fatal = "画像里没有 B站登录态（nav 回 isLogin=false）。B 轨真实会话未取证：不抓、不落盘、不写报告数字。";
      log.exitCode = 5;
      return;
    }

    const page = await openSidePanel(run.ctx, run.extensionId);
    if (!page) {
      const e = new Error("扩展装上了但侧栏打不开（chrome-extension://" + run.extensionId + "/sidepanel.html）");
      e.code = "EXTENSION_NOT_LOADED";
      throw e;
    }

    // ---- 2. 读全（B1 硬门禁：fetched == total）
    setStage("读全抓取");
    await page.click("#btn-start");
    const read = await waitReadComplete(page, mode === "mock" ? 40000 : 240000);
    const pagesShown = Number(await page.textContent("#stat-pages").catch(() => "")) || 0;
    log.cases.push({
      id: "B1", kind: log.kind,
      name: "全量读全：fetched == total（B站自己给的关注数），不是「抓了一部分」",
      passed: read.total > 0 && read.fetched >= read.total,
      detail: { ...read, pagesShown },
    });
    if (!(read.total > 0 && read.fetched >= read.total)) {
      log.fatal = "读全门禁没过（fetched=" + read.fetched + " total=" + read.total + "）：不落盘、不写报告数字。";
      log.exitCode = 1;
      return;
    }

    // ---- 3. 离线规则分类（零外发；BYOK 不在取证里开，报告口径只写离线分类）
    setStage("离线规则分类");
    await page.click("#btn-classify-local");
    const classified = await waitClassified(page, mode === "mock" ? 20000 : 120000);
    log.cases.push({
      id: "B5", kind: log.kind,
      name: "分类落库条数 == 关注条目数（抓全后分类解锁，且每条都有类目）",
      passed: classified.results.length === read.fetched,
      detail: { items: read.fetched, results: classified.results.length, cards: classified.summary.length },
    });

    // ---- 4. UI 卡片计数与存储结果对账（FOR-70 逐条镜头要的就是这份一致性）
    const cardCounts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("#category-list li")).map((li) => {
        const t = li.innerText.replace(/\s+/g, " ");
        const m = t.match(/(\d+)\s*条/);
        return m ? Number(m[1]) : 0;
      });
    });
    const cardSum = cardCounts.reduce((a, b) => a + b, 0);
    log.cases.push({
      id: "B6", kind: log.kind,
      name: "侧栏分类卡片条数之和 == 条目数（界面与存储不是两套数）",
      passed: cardSum === read.fetched && cardCounts.length === classified.summary.length,
      detail: { cardSum, cards: cardCounts.length, summaryCards: classified.summary.length },
    });

    // ---- 5. 只读护栏：先证明它**看得见**抓取路径（覆盖），再证明它**拦得住**写操作（负向对照）。
    // 「零写请求」本身不是证据：看不见所以没记录，和看见了但拦住了，落盘上长得一样。
    const guardFollowings = requestRecords.filter((r) => new URL(r.url).pathname === "/x/relation/followings").length;
    log.cases.push({
      id: "R1", kind: log.kind,
      name: "护栏覆盖：抓取主路径（service worker 的分页 followings）确实经过了拦截，条数 == 页数",
      passed: guardFollowings >= pagesShown && pagesShown > 0,
      detail: { guardSawFollowings: guardFollowings, pagesShown, allowed: log.readOnly.allowed, denied: log.readOnly.denied,
        guard: run.guard.stats() },
    });
    log.cases.push({
      id: "R2", kind: log.kind,
      name: "护栏对写操作有效（负向对照）：从扩展页面里主动 POST /x/relation/delete，必须被拦下且记成 write 拒因",
      passed: false, // 下面探针跑完再写结论
      detail: {},
    });
    const productWrites = log.readOnly.writeAttempts.filter((w) => w.phase === "product");
    log.cases.push({
      id: "R3", kind: log.kind,
      name: "产品自发请求里没有任何写操作（取关 / 加关 / 分组 / 拉黑），有就是 P0",
      passed: productWrites.length === 0,
      detail: { productWrites },
    });

    // 探针：真实账号上「只读」这句话必须有拦截图腾撑着，所以主动发一次取关请求看它是否被拦。
    // 探针本身在浏览器层被 failRequest，不会真的改动账号。
    setStage("写请求拦截探针");
    phase = "probe";
    const probe = await page.evaluate(async () => {
      try {
        const res = await fetch("https://api.bilibili.com/x/relation/delete?fid=1&csrf=probe", { method: "POST" });
        return { blocked: false, status: res.status };
      } catch (err) {
        return { blocked: true, error: String(err && err.message || err) };
      }
    });
    const probeWrites = log.readOnly.writeAttempts.filter((w) => w.phase === "probe");
    const r2 = log.cases.find((c) => c.id === "R2");
    r2.passed = probe.blocked === true && probeWrites.length >= 1;
    r2.detail = { probe, probeWrites };

    // ---- 6. 逐条快照：字段白名单 + 与条数/类目分布对账
    const byMid = new Map(classified.results.map((r) => [String(r.mid), r]));
    const items = classified.items.map((it) => {
      const r = byMid.get(String(it.mid)) || {};
      return publicItem({ ...it, ...r });
    });
    const counts = {};
    for (const row of classified.summary) counts[row.categoryId] = row.count;
    const v = validateScanItems(items, { followTotal: read.total, counts });
    log.cases.push({
      id: "B7", kind: log.kind,
      name: "scan-items 快照自证：四列白名单 / mid 唯一 / 昵称非空 / 置信度 0..1 / 条数与类目分布对账",
      passed: v.ok,
      detail: { items: items.length, problems: v.problems.slice(0, 8) },
    });

    log.numbers.followTotal = read.total;
    log.numbers.pages = pagesShown;
    log.numbers.fetched = read.fetched;
    log.numbers.clsCounts = counts;
    log.numbers.itemSampleCount = items.length;
    log.env = {
      os: process.platform + " " + os.release(),
      chromeBuild: run.build, chromeSource: run.source,
      rejectedBuilds: run.rejected, loadMethod: "cdp:Extensions.loadUnpacked",
      node: process.version,
    };

    // ---- 7. 落盘：mock 永不进 docs/qa-evidence/（把替身当真实会话是 No-Go 硬条件④）
    const allPassed = log.cases.every((c) => c.passed);
    const tmpOut = path.join(ROOT, "tmp", "qa-e2e");
    fs.mkdirSync(tmpOut, { recursive: true });
    if (mode === "mock") {
      fs.writeFileSync(path.join(tmpOut, "track-b-mock-scan-items.json"), JSON.stringify(items, null, 2));
      log.numbers.snapshotWritten = "tmp/qa-e2e/track-b-mock-scan-items.json（替身自检，不是取证产物）";
    } else if (allPassed && log.readOnly.writeAttempts.every((w) => w.phase === "probe")) {
      const target = path.join(ROOT, "docs", "qa-evidence", "scan-items.json");
      fs.writeFileSync(target, JSON.stringify(items, null, 2));
      log.numbers.snapshotWritten = "docs/qa-evidence/scan-items.json";
    } else {
      log.numbers.snapshotWritten = null;
      log.numbers.snapshotRefused = "断言未全过或有只读越界尝试：不落盘（写半份比不写更坏）";
    }
    fs.writeFileSync(path.join(tmpOut, "track-b-request-log.json"), JSON.stringify(publicRequestLog(requestRecords), null, 2));

    const productWriteCount = log.readOnly.writeAttempts.filter((w) => w.phase === "product").length;
    if (!allPassed) log.exitCode = productWriteCount ? 6 : 1;
    else log.exitCode = 0;
  } catch (err) {
    log.fatal = String(err && err.message);
    log.exitCode = err && err.code === "EXTENSION_NOT_LOADED" ? 2 : 1;
  } finally {
    try { await run.browser.close(); } catch { /* 已关 */ }
    try { run.cdp.close(); } catch { /* 已关 */ }
    run.proc.kill();
    if (mock) await mock.close();
    if (ownedProfile) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
    clearTimeout(watchdog);
    log.stage = stage;
    log.finishedAt = new Date().toISOString();
    log.deniedHosts = [...log.readOnly.deniedHosts];
    log.passed = log.cases.filter((c) => c.passed).length;
    log.total = log.cases.length;
    fs.mkdirSync(path.join(ROOT, "tmp", "qa-e2e"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "tmp", "qa-e2e", "track-b.json"), JSON.stringify(log, null, 2));
    console.log(JSON.stringify({
      track: log.track, kind: log.kind, consent: log.consent, exitCode: log.exitCode,
      passed: log.passed, total: log.total,
      cases: log.cases.map((c) => ({ id: c.id, kind: c.kind, passed: c.passed })),
      numbers: log.numbers, readOnly: { allowed: log.readOnly.allowed, denied: log.readOnly.denied, writeAttempts: log.readOnly.writeAttempts },
      fatal: log.fatal || null,
    }, null, 2));
    process.exit(log.exitCode || 0);
  }
}

async function waitClassified(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await readScanResultFromStorage(page).catch(() => null);
    if (data && data.results && data.results.length) return data;
    await page.waitForTimeout(1000);
  }
  return { items: [], results: [], summary: [] };
}

await main();