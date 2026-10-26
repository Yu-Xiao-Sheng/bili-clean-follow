// background.js —— service worker：抓取调度、三级传输降级、断点与审计（v2-spec §2.2）。
//
// 传输降级顺序（都带 cookie，都在用户登录态里）：
//   1) sw_fetch    : service worker 直接打 api.bilibili.com（host_permissions 已给）。
//   2) page_fetch  : 在插件自己的 space.bilibili.com 标签页里，用 MAIN world 的 fetch
//                    重放同一请求（Origin / Referer / UA 都是浏览器给的真值）。
//                    412（需签名）与 -352（风控）通常就是缺这层上下文。
//   3) dom_scrape  : content script 在 space.bilibili.com/<mid>/relation/follow 翻页抓 DOM。
// 三条路都必须翻到最后一页：完成判据始终是 fetched == total（isReadComplete）。
//
// FOR-63 边界是「只读」。FOR-65 起，这里多出**唯一**的写请求发起点 writeTransport，
// 它只被 executeUnfollow / restoreUnfollowed（unfollow.js，七条护栏）调用：
//   * 候选清单不在消息里 —— 本文件从 storage 里读 items/results/decisions 自己重算预览，
//     所以「从控制台发一条消息就取关某人」这条路不存在；
//   * 护栏（开关 + 二次确认 + 预览指纹 + 手输 UNFOLLOW + 批量上限 + 速率下限）在 unfollow.js 里，
//     过不了就抛 UnfollowGuardError，一条请求都不会发；
//   * csrf（bili_jct）只在这里现场从 cookie 取，只在内存里，不进 storage / 审计 / 日志 / 返回值。
// LLM 调用仍然只在 classifyLlm.js，不在这里。

import {
  ENDPOINTS, KIND, KIND_LABEL_ZH, PAGE_SIZE, WRITE_ENDPOINTS, buildFollowingsUrl,
  buildWriteForm, incompleteHint, isReadComplete, parseFollowingsPayload, parseNavPayload,
  progressLabel, scanAllFollowings, shouldSwitchTransport, TOTAL_DRIFT_NOTE,
} from "./biliApi.js";
import { STATUS, createStore, memoryStorage } from "./store.js";
import { assertSecretFree, safeLog } from "./privacy.js";
import { createClassifyStore } from "./classify.js";
import { buildUnfollowPreview, loadArm } from "./preview.js";
import { UnfollowGuardError, executeUnfollow, restoreUnfollowed } from "./unfollow.js";

const store = createStore();
const bucketStore = createClassifyStore({ storage: storageBackend() });
const unfollowStorage = storageBackend();

/** chrome.storage.local（非扩展环境下退到内存实现，保证模块能被 node 直接 import）。 */
function storageBackend() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) return chrome.storage.local;
  return memoryStorage();
}
let scanRunning = false;
let abortRequested = false;
let ownedTabId = null; // 插件自己开的后台标签，只用它做兜底，绝不劫持用户标签

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = msg && msg.type;
    if (type === "START_SCAN" || type === "RESUME_SCAN") {
      startScan(type === "RESUME_SCAN").catch((err) => console.warn("[bcf]", safeLog(err && err.message)));
      sendResponse({ accepted: true });
      return false;
    }
    if (type === "ABORT_SCAN") {
      abortRequested = true;
      sendResponse({ accepted: true });
      return false;
    }
    if (type === "GET_SNAPSHOT") {
      snapshot().then(sendResponse).catch((err) => sendResponse({ error: String(err && err.message) }));
      return true; // 异步回复
    }
    if (type === "EXECUTE_UNFOLLOW") {
      // 只接「确认」，不接清单：要取关谁由本文件从 storage 重算，UI 说了不算。
      // 进度靠 UNFOLLOW_PROGRESS 广播，最终结果走这个异步回复。
      runUnfollow(msg)
        .then((r) => sendResponse(r))
        .catch((err) => {
          const kind = err instanceof UnfollowGuardError ? err.kind : "executor_error";
          broadcast({ type: "UNFOLLOW_ERROR", kind, message: safeLog(err && err.message) });
          sendResponse({ accepted: false, kind, message: safeLog(err && err.message) });
        });
      return true; // 异步回复
    }
    if (type === "RESTORE_UNFOLLOW") {
      runRestore(msg).then((r) => sendResponse({ accepted: true, ...r }))
        .catch((err) => sendResponse({
          accepted: false,
          kind: err instanceof UnfollowGuardError ? err.kind : "executor_error",
          message: safeLog(err && err.message),
        }));
      return false;
    }
    if (type === "ABORT_UNFOLLOW") {
      unfollowAbort = true;
      sendResponse({ accepted: true });
      return false;
    }
    if (type === "CHECK_LOGIN") {
      resolveSelf().then((r) => sendResponse({ ok: r.ok, mid: r.mid, kind: r.kind, message: r.message }))
        .catch((err) => sendResponse({ ok: false, message: String(err && err.message) }));
      return true;
    }
    return false;
  });
}

// --- 取关执行（FOR-65）：唯一写路径，护栏在 unfollow.js，这里只负责取数据与发请求 -----

let unfollowRunning = false;
let unfollowAbort = false;

async function currentCorpus() {
  const state = await store.getState();
  const items = await store.loadItems();
  const results = await bucketStore.loadResults();
  const decisions = await bucketStore.loadDecisions();
  const taxonomy = await bucketStore.loadTaxonomy();
  return { state, items, results, decisions, taxonomy };
}

/**
 * 执行取关。注意这里**不看消息里的清单**：预览由本函数按 storage 里的数据重算，
 * 指纹对不上「刚才看过的那份」就拒（unfollow.guardUnfollow -> preview_stale）。
 */
export async function runUnfollow({ confirmation = {}, limit = null, intervalMs = null } = {}) {
  if (unfollowRunning) return { accepted: false, kind: "already_running", message: "上一次取关还在跑。" };
  const { state, items, results, decisions, taxonomy } = await currentCorpus();
  if (!isReadComplete(state)) {
    return { accepted: false, kind: "not_read_complete", message: progressLabel(state, { withPages: false }) };
  }
  if (!(await hasCsrfCookie())) {
    // 没登录就一条都不发：写请求没有 csrf 必然被 B站拒，白发只会白白消耗风控额度
    return { accepted: false, kind: "not_logged_in", message: "拿不到 csrf（bili_jct）：先在浏览器里登录 B站再执行。" };
  }
  unfollowRunning = true;
  unfollowAbort = false;
  try {
    const preview = buildUnfollowPreview({
      items, results, decisions, taxonomy, limit, selfMid: state.mid || null,
    });
    const res = await executeUnfollow({
      storage: unfollowStorage,
      preview,
      confirmation,
      results,
      decisions,
      selfMid: state.mid || null,
      limit: limit === null ? undefined : limit,
      intervalMs: intervalMs === null ? undefined : intervalMs,
      transport: writeTransport,
      aborted: () => unfollowAbort,
      onProgress: (p) => broadcast({ type: "UNFOLLOW_PROGRESS", ...p }),
    });
    await store.appendAudit({ event: "unfollow_done", manifestId: res.manifestId, attempted: res.attempted, ok: res.ok_count, failed: res.failed });
    broadcast({ type: "UNFOLLOW_DONE", manifestId: res.manifestId, attempted: res.attempted, ok: res.ok_count, failed: res.failed, stopped: res.stopped });
    return { accepted: true, manifestId: res.manifestId, attempted: res.attempted, ok: res.ok_count, failed: res.failed, stopped: res.stopped };
  } finally {
    unfollowRunning = false;
  }
}

export async function runRestore({ confirmation = {}, manifestId = null, limit = null, intervalMs = null } = {}) {
  if (unfollowRunning) return { accepted: false, kind: "already_running", message: "上一次写操作还在跑。" };
  unfollowRunning = true;
  unfollowAbort = false;
  try {
    const res = await restoreUnfollowed({
      storage: unfollowStorage,
      manifestId,
      confirmation,
      transport: writeTransport,
      limit: limit === null ? undefined : limit,
      intervalMs: intervalMs === null ? undefined : intervalMs,
      aborted: () => unfollowAbort,
      onProgress: (p) => broadcast({ type: "UNFOLLOW_PROGRESS", ...p, action: "refollow" }),
    });
    await store.appendAudit({ event: "refollow_done", manifestId: res.manifestId, attempted: res.attempted, ok: res.ok_count });
    broadcast({ type: "REFOLLOW_DONE", manifestId: res.manifestId, ok: res.ok_count, attempted: res.attempted });
    return { accepted: true, manifestId: res.manifestId, ok: res.ok_count, attempted: res.attempted };
  } finally {
    unfollowRunning = false;
  }
}

/** 只回答「有没有 csrf」，永远不把 cookie 值传出去（privacy.js 的口径）。 */
async function hasCsrfCookie() {
  if (typeof chrome === "undefined" || !chrome.cookies || !chrome.cookies.get) return false;
  for (const url of ["https://api.bilibili.com", "https://www.bilibili.com"]) {
    try {
      const cookie = await chrome.cookies.get({ url, name: "bili_jct" });
      if (cookie && cookie.value) return true;
    } catch (err) {
      // 读不到就往下一个域试；失败本身不进日志
    }
  }
  return false;
}

/**
 * 唯一的写请求发起点。csrf 在这里现场取，出函数就消失：
 * 返回值里没有 cookie、没有 header、没有 body，只有 status / payload / 截断后的 rawText。
 */
export async function writeTransport({ op, mid }) {
  if (typeof chrome === "undefined" || !chrome.cookies || !chrome.cookies.get) {
    return { httpStatus: 0, payload: null, rawText: "chrome.cookies 不可用", kind: KIND.NOT_LOGGED_IN };
  }
  let csrf = null;
  for (const url of ["https://api.bilibili.com", "https://www.bilibili.com"]) {
    try {
      const cookie = await chrome.cookies.get({ url, name: "bili_jct" });
      if (cookie && cookie.value) {
        csrf = cookie.value;
        break;
      }
    } catch (err) {
      // 继续试另一个域
    }
  }
  if (!csrf) {
    // 没有 csrf 就不发（buildWriteForm 也会抛）：宁可失败也不要发一个必然被拒的写请求
    return { httpStatus: 0, payload: null, rawText: "missing bili_jct", kind: KIND.NOT_LOGGED_IN };
  }
  const endpoint = op === "add" ? WRITE_ENDPOINTS.addFollow : WRITE_ENDPOINTS.unfollow;
  const body = buildWriteForm({ mid, csrf });
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const text = await res.text();
    return toTransportResult(res.status, text);
  } catch (err) {
    return { httpStatus: 0, payload: null, rawText: safeLog(err && err.message), kind: KIND.TRANSPORT };
  }
}

export async function snapshot() {
  const state = await store.getState();
  return {
    state,
    progress: progressLabel(state),
    hint: incompleteHint(state),
    canClassify: isReadComplete(state),
    running: scanRunning,
  };
}

/** 登录态：nav 给 code=-101 就是没登录，直接 incomplete，不重试（实测匿名 -101）。 */
async function resolveSelf() {
  const r = await swFetchJson(ENDPOINTS.nav);
  const parsed = parseNavPayload(r.payload, { httpStatus: r.httpStatus, rawText: r.rawText });
  if (!parsed.login) {
    return { ok: false, mid: null, kind: parsed.kind, message: parsed.message || KIND_LABEL_ZH[parsed.kind] };
  }
  await store.saveState({ mid: parsed.mid });
  return { ok: true, mid: parsed.mid, nickname: parsed.nickname, kind: KIND.OK };
}

async function startScan(resume) {
  if (scanRunning) return snapshot();
  scanRunning = true;
  abortRequested = false;
  try {
    const self = await resolveSelf();
    if (!self.ok) {
      await store.markIncomplete(self.kind === KIND.NOT_LOGGED_IN ? KIND.NOT_LOGGED_IN : (self.kind || "unknown_error"),
        { kind: self.kind, lastError: self.message });
      await store.appendAudit({ event: "scan_refused", reason: self.kind, message: self.message });
      return null;
    }
    const state = await store.getState();
    const startPn = resume ? (state.resumeFromPn || 1) : 1;
    if (!resume) await store.reset();
    await store.saveState({
      status: STATUS.SCANNING, startedAt: state.startedAt || Date.now(),
      resumeFromPn: startPn, incompleteReason: null, ps: PAGE_SIZE, mid: self.mid,
    });
    await store.appendAudit({ event: "scan_start", resume: !!resume, startPn });

    const result = await scanAllFollowings({
      vmid: self.mid,
      ps: PAGE_SIZE,
      startPn,
      initialItems: resume ? await store.loadItems() : [],
      initialTotal: resume ? (await store.getState()).total : null,
      shouldAbort: () => abortRequested,
      fetchPage: makeFetchPage(self.mid),
      onProgress: async (snap) => {
        await store.appendItemsIncremental(snap.items);
        await store.saveState({
          total: snap.total, pages: snap.pages, resumeFromPn: snap.lastPn + 1,
          transport: currentTransport, totalCapped: snap.totalCapped,
        });
        broadcast({ type: "PROGRESS", fetched: snap.fetched, total: snap.total, pages: snap.pages });
      },
    });

    await store.appendItemsIncremental(result.items);
    await store.saveState({
      total: result.total, fetched: result.fetched, pages: result.pages,
      transport: currentTransport, totalCapped: result.totalCapped,
      overCount: !!result.overCount, note: result.overCount ? TOTAL_DRIFT_NOTE : null,
      resumeFromPn: result.resumeFromPn || 1,
    });

    if (result.status === "complete") {
      await store.markComplete();
      await store.appendAudit({ event: "scan_complete", fetched: result.fetched, total: result.total,
        pages: result.pages, transport: currentTransport });
    } else {
      await store.markIncomplete(result.incompleteReason || (result.lastKind || "unknown_error"),
        { resumeFromPn: result.resumeFromPn, kind: result.lastKind,
          lastError: result.lastError ? result.lastError.message : null });
      await store.appendAudit({ event: "scan_incomplete", reason: result.incompleteReason,
        fetched: result.fetched, total: result.total, pages: result.pages, transport: currentTransport });
    }
    return result;
  } finally {
    scanRunning = false;
    await closeOwnedTab();
    broadcast({ type: "SCAN_DONE" });
  }
}

// --- 三级传输 ---------------------------------------------------------------

let currentTransport = "sw_fetch";

function makeFetchPage(vmid) {
  return async (pn) => {
    const url = buildFollowingsUrl({ vmid, pn, ps: PAGE_SIZE });

    let r = await attempt(swFetchJson, url);
    if (r.ok || r.kind === KIND.NOT_LOGGED_IN) { currentTransport = "sw_fetch"; return r; }
    if (!shouldSwitchTransport(r.kind)) return r;

    let p = await attempt(pageFetchJson, url);
    if (p.ok) { currentTransport = "page_fetch"; return p; }
    if (p.kind === KIND.NOT_LOGGED_IN) return p;

    let d = await domScrapePage(vmid, pn);
    if (d.ok) { currentTransport = "dom_scrape"; return d; }

    return { ok: false, kind: p.kind || r.kind, code: p.code ?? r.code ?? null,
      message: [r.message, p.message, d.message].filter(Boolean).join(" | ") };
  };
}

async function attempt(transport, url) {
  try {
    const r = await transport(url);
    const parsed = parseFollowingsPayload(r.payload, { httpStatus: r.httpStatus, rawText: r.rawText });
    return { ...parsed, transport: true };
  } catch (err) {
    return { ok: false, kind: KIND.TRANSPORT, code: null, total: null, items: [],
      message: safeLog(err && err.message) };
  }
}

async function swFetchJson(url) {
  const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
  const text = await res.text();
  return toTransportResult(res.status, text);
}

/** 在插件自己的 B站标签页里发同一请求（MAIN world，浏览器给真 Origin/Referer/UA）。 */
async function pageFetchJson(url) {
  const tab = await ensureOwnedTab("https://space.bilibili.com/");
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (u) => {
      try {
        const res = await fetch(u, { credentials: "include", headers: { Accept: "application/json" } });
        return { status: res.status, text: await res.text() };
      } catch (err) {
        return { status: 0, text: "IN_PAGE_FETCH_ERROR " + String((err && err.message) || err) };
      }
    },
    args: [url],
  });
  if (!inj || !inj.result) throw new Error("executeScript 没拿到结果");
  return toTransportResult(inj.result.status, inj.result.text);
}

function toTransportResult(status, text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    payload = null;
  }
  return { httpStatus: status, payload, rawText: payload ? "" : String(text || "").slice(0, 160) };
}

// --- DOM 兜底：content script 抓关注页 DOM，必须翻到最后一页 -----------------

async function domScrapePage(vmid, pn) {
  const target = "https://space.bilibili.com/" + vmid + "/relation/follow" +
    "?pn=" + pn + "&ps=" + PAGE_SIZE + "&order=desc&order_field=ptime";
  const tab = await ensureOwnedTab(target);
  if (pageFromUrl(tab.url) !== pn) {
    await chrome.tabs.update(tab.id, { url: target });
    await waitForTabComplete(tab.id);
    await sleep(1200); // B站关注页首屏还有一次异步补载
  }
  let scraped = await askContentScript(tab.id, { type: "SCRAPE_FOLLOW_PAGE" });
  if (!scraped) {
    // 标签页是在扩展装载前打开的：用 scripting 补注入同一份 content script 再问一次。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/followpage.js"] });
    scraped = await askContentScript(tab.id, { type: "SCRAPE_FOLLOW_PAGE" });
  }
  if (!scraped || !scraped.ok) {
    return { ok: false, kind: scraped && scraped.kind ? scraped.kind : KIND.MALFORMED,
      code: null, total: scraped ? scraped.total : null, items: [],
      message: (scraped && scraped.message) || "DOM 兜底没抓到内容" };
  }
  return { ok: true, kind: KIND.OK, code: 0, message: "", total: scraped.total,
    items: scraped.items || [] };
}

async function askContentScript(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    return null;
  }
}

function pageFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/\/relation\/follow/.test(u.pathname)) return null;
    const pn = Number(u.searchParams.get("pn"));
    return Number.isFinite(pn) && pn > 0 ? pn : 1;
  } catch (err) {
    return null;
  }
}

async function ensureOwnedTab(url) {
  if (ownedTabId !== null) {
    try {
      const tab = await chrome.tabs.get(ownedTabId);
      if (tab) return tab;
    } catch (err) {
      ownedTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  ownedTabId = tab.id;
  await waitForTabComplete(tab.id);
  return tab;
}

async function closeOwnedTab() {
  if (ownedTabId === null) return;
  const id = ownedTabId;
  ownedTabId = null;
  try {
    await chrome.tabs.remove(id);
  } catch (err) {
    // 用户可能已经手动关了，忽略
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tab) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };
    const listener = (id, changeInfo, tab) => {
      if (id === tabId && (changeInfo.status === "complete" || tab.status === "complete")) finish(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab && tab.status === "complete") finish(tab); }).catch(() => {});
    setTimeout(() => finish(null), 15000); // 拿不到 complete 也继续，让降级链去判定
  });
}

function broadcast(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {});
  } catch (err) {
    // 没有接收方（侧栏没开）是常态
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { startScan, store, assertSecretFree };
