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
// FOR-63 边界：只读。这里没有任何写接口调用（x/relation/delete / add 都在
// biliApi.js 的 FORBIDDEN_ENDPOINTS 里），也没有 LLM 调用。

import {
  ENDPOINTS, KIND, KIND_LABEL_ZH, PAGE_SIZE, buildFollowingsUrl, incompleteHint,
  isReadComplete, parseFollowingsPayload, parseNavPayload, progressLabel,
  scanAllFollowings, shouldSwitchTransport, TOTAL_DRIFT_NOTE,
} from "./biliApi.js";
import { STATUS, createStore } from "./store.js";
import { assertSecretFree, safeLog } from "./privacy.js";

const store = createStore();
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
    if (type === "CHECK_LOGIN") {
      resolveSelf().then((r) => sendResponse({ ok: r.ok, mid: r.mid, kind: r.kind, message: r.message }))
        .catch((err) => sendResponse({ ok: false, message: String(err && err.message) }));
      return true;
    }
    return false;
  });
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
  const r = await fetchJsonSw(ENDPOINTS.nav);
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
