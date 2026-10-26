// store.js —— chrome.storage.local 仓储（列表 / 状态 / 审计日志）。
//
// 三条硬规矩（FOR-63 验收 4 与 7）：
//   1) 抓取中断：已取数据保留，state.status = "incomplete" 并记 resumeFromPn，
//      「继续抓取」从断点页继续，靠 mid 去重保证不重不漏。
//   2) 只有 fetched == total 才允许 status = "complete"（isReadComplete 是唯一判据）。
//   3) 写盘前一律先 stripSecretFields + assertSecretFree：cookie / Key 绝不落盘。
//
// 模块不在顶层碰 chrome.*，所以能被 node:test 直接 import（内存 storage 顶上）。

import { assertSecretFree, stripSecretFields } from "./privacy.js";
import { PAGE_SIZE, isReadComplete, TOTAL_CAP_NOTE } from "./biliApi.js";

export const STATE_KEY = "scan_state";
export const ITEMS_PREFIX = "follow_items";
export const ITEMS_COUNT_KEY = "follow_items.count";
export const AUDIT_KEY = "audit_log";
export const ITEM_CHUNK_SIZE = 100; // 单键不塞整张表：812 条一次性写会顶到 storage 配额
export const AUDIT_KEEP = 500;

export const STATUS = {
  IDLE: "idle",
  SCANNING: "scanning",
  INCOMPLETE: "incomplete",
  COMPLETE: "complete",
};

export function defaultState() {
  return {
    status: STATUS.IDLE,
    mid: null,
    total: null,
    fetched: 0,
    pages: 0,
    ps: PAGE_SIZE,
    resumeFromPn: 1,
    incompleteReason: null,
    lastKind: null,
    lastError: null,
    transport: null, // "sw_fetch" | "page_fetch" | "dom_scrape"
    totalCapped: false,
    startedAt: null,
    updatedAt: null,
  };
}

/** chrome.storage.local 形状的内存实现，单测与「非扩展环境」跑通用。 */
export function memoryStorage() {
  const data = new Map();
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return { ...Object.fromEntries(data) };
      if (typeof keys === "string") {
        return data.has(keys) ? { [keys]: data.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (data.has(k)) out[k] = data.get(k);
        return out;
      }
      const out = {};
      for (const [k, fallback] of Object.entries(keys)) {
        out[k] = data.has(k) ? data.get(k) : fallback;
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    async clear() {
      data.clear();
    },
    _dump() {
      return { ...Object.fromEntries(data) };
    },
  };
}

export function defaultStorage() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return memoryStorage();
}

export function createStore({ storage = defaultStorage(), now = () => Date.now() } = {}) {
  const chunkKeys = () => storage.get([ITEMS_COUNT_KEY]).then((r) => {
    const count = Number(r && r[ITEMS_COUNT_KEY]) || 0;
    return Array.from({ length: count }, (_, i) => ITEMS_PREFIX + "." + i);
  });

  async function writeGuarded(payload, where) {
    const clean = stripSecretFields(payload);
    assertSecretFree(clean, where); // 命中凭据形态直接抛，绝不静默写盘
    await storage.set(clean);
    return clean;
  }

  async function getState() {
    const got = await storage.get([STATE_KEY]);
    const raw = got && got[STATE_KEY];
    if (!raw) return defaultState();
    return { ...defaultState(), ...raw };
  }

  /** 合并写状态；完成态只能由 fetched == total 换来（v2-spec §3.1）。 */
  async function saveState(patch = {}) {
    const next = { ...await getState(), ...stripSecretFields(patch) };
    next.updatedAt = now();
    if (next.fetched === null || next.fetched === undefined) next.fetched = 0;
    if (next.status === STATUS.COMPLETE && !isReadComplete(next)) {
      // 有人（或某个降级路径）想跳过读全门禁：拒绝。
      next.status = STATUS.INCOMPLETE;
      next.incompleteReason = next.incompleteReason || "gate_fetched_ne_total";
    }
    if (next.totalCapped && !next.note) next.note = TOTAL_CAP_NOTE;
    await writeGuarded({ [STATE_KEY]: next }, "chrome.storage scan_state");
    return next;
  }

  async function loadItems() {
    const keys = await chunkKeys();
    if (!keys.length) return [];
    const got = await storage.get(keys);
    const items = [];
    for (const k of keys) {
      const chunk = got && got[k];
      if (Array.isArray(chunk)) items.push(...chunk);
    }
    return items;
  }

  /** 全量替换（按 mid 去重后分块写）。返回落盘条数。 */
  async function replaceItems(list) {
    const seen = new Map();
    for (const it of Array.isArray(list) ? list : []) {
      if (it && it.mid) seen.set(String(it.mid), it);
    }
    const items = [...seen.values()];
    const oldKeys = await chunkKeys();
    const chunks = [];
    for (let i = 0; i < items.length; i += ITEM_CHUNK_SIZE) {
      chunks.push(items.slice(i, i + ITEM_CHUNK_SIZE));
    }
    const payload = {};
    chunks.forEach((chunk, i) => { payload[ITEMS_PREFIX + "." + i] = chunk; });
    payload[ITEMS_COUNT_KEY] = chunks.length;
    await writeGuarded(payload, "chrome.storage follow_items");
    const stale = oldKeys.filter((k) => !(k in payload));
    if (stale.length) await storage.remove(stale);
    const state = await saveState({ fetched: items.length });
    return { count: items.length, state };
  }

  /** 追加（断点续抓用）：与已有数据按 mid 合并，重复写同一页不会翻倍。 */
  async function appendItems(list) {
    const merged = await mergeItems(await loadItems(), list);
    return replaceItems(merged);
  }

  /** 只写增量分块，供大列表边抓边落盘（省内存、掉电不丢已取数据）。 */
  async function appendItemsIncremental(list) {
    const existing = await loadItems();
    const fresh = (Array.isArray(list) ? list : []).filter(
      (it) => it && it.mid && !existing.some((e) => String(e.mid) === String(it.mid)));
    if (!fresh.length) return { count: existing.length, added: 0 };
    const merged = await mergeItems(existing, fresh);
    const res = await replaceItems(merged);
    return { count: res.count, added: fresh.length };
  }

  async function mergeItems(existing, incoming) {
    const map = new Map();
    for (const it of existing) if (it && it.mid) map.set(String(it.mid), it);
    for (const it of Array.isArray(incoming) ? incoming : []) {
      if (!it || !it.mid) continue;
      const key = String(it.mid);
      const prev = map.get(key);
      map.set(key, prev ? { ...prev, ...compact(it) } : it);
    }
    return [...map.values()];
  }

  /** 断点：抓到的数据保留，只把状态标 incomplete（v2-spec §3.1）。 */
  async function markIncomplete(reason, { resumeFromPn, kind = null, lastError = null } = {}) {
    return saveState({
      status: STATUS.INCOMPLETE,
      incompleteReason: reason || null,
      lastKind: kind,
      lastError,
      resumeFromPn: resumeFromPn === undefined ? (await getState()).resumeFromPn : resumeFromPn,
    });
  }

  async function markComplete() {
    const state = await getState();
    if (!isReadComplete({ ...state, status: STATUS.COMPLETE })) {
      throw new Error(
        "cannot mark complete: fetched=" + state.fetched + " total=" + state.total +
        "（fetched == total 是硬门禁，v2-spec §3.1）");
    }
    return saveState({ status: STATUS.COMPLETE, incompleteReason: null, lastKind: null });
  }

  /** 只清扫描数据，不动用户在 v2 里填的 Key / 分类（那些键不在本模块命名空间里）。 */
  async function reset() {
    const got = await storage.get(null);
    const keys = Object.keys(got || {}).filter(
      (k) => k === STATE_KEY || k === ITEMS_COUNT_KEY || k.startsWith(ITEMS_PREFIX + "."));
    if (keys.length) await storage.remove(keys);
    return saveState(defaultState());
  }

  async function appendAudit(event) {
    const entry = { ts: now(), ...stripSecretFields(event || {}) };
    assertSecretFree(entry, "audit log");
    const log = await loadAudit();
    log.push(entry);
    const trimmed = log.slice(-AUDIT_KEEP);
    await writeGuarded({ [AUDIT_KEY]: trimmed }, "audit log");
    return trimmed.length;
  }

  async function loadAudit() {
    const got = await storage.get([AUDIT_KEY]);
    const log = got && got[AUDIT_KEY];
    return Array.isArray(log) ? log : [];
  }

  return {
    getState,
    saveState,
    loadItems,
    replaceItems,
    appendItems,
    appendItemsIncremental,
    markIncomplete,
    markComplete,
    reset,
    appendAudit,
    loadAudit,
  };
}

function compact(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}
