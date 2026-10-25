// classify.js —— 分类编排 + 结果落库 + 类别汇总（FOR-64 验收 5/6）。
//
// 门禁写在这里，不在 UI 里复制一份：
//   * 「抓全才解锁」沿用 biliApi.isReadComplete（fetched == total）。没读全就调用分类 -> 抛错，
//     不是「给个提示」。FOR-63 的 store.saveState 是第二道闸（想标 complete 但 fetched != total 会被降级）。
//   * 低置信（< LOW_CONFIDENCE = 0.55）一律进「待确认」，LLM 和离线都同一条判据。
//   * 结果按块落 chrome.storage.local（812 条一次写会顶配额），每批 LLM 回来就落一次，
//     中途关面板不丢已分类结果，meta 里标 partial。
//
// decisions（保留 / 进候选）是给 FOR-65 的输入：keep 类里的 UP 主永不进候选，
// 这条约束在 candidateMids() 里钉住，FOR-65 想绕也绕不过。

import { assertSecretFree, stripSecretFields } from "./privacy.js";
import { isReadComplete, progressLabel } from "./biliApi.js";
import { createStore } from "./store.js";
import {
  LOW_CONFIDENCE,
  OTHER_CATEGORY,
  TAXONOMY_KEY,
  UNSURE_CATEGORY,
  categoryName,
  defaultTaxonomy,
  normalizeTaxonomy,
} from "./taxonomy.js";
import { LOCAL_LABEL, LOCAL_SOURCE, bucketByConfidence, classifyLocalBatch } from "./classifyLocal.js";
import {
  LLM_CONSENT_KEY,
  LLM_CONFIG_KEY,
  LLM_DEGRADED_LABEL,
  LLM_DEGRADED_SOURCE,
  LLM_ERROR_ZH,
  LLM_KEY_STORAGE,
  LLM_LABEL,
  LLM_SOURCE,
  classifyWithLlm,
  normalizeLlmConfig,
  preflightGate,
  validateEndpoint,
} from "./classifyLlm.js";

export const RESULTS_PREFIX = "classify_results";
export const RESULTS_COUNT_KEY = "classify_results.count";
export const META_KEY = "classify_meta.v1";
export const DECISIONS_KEY = "classify_decisions.v1";
export const RESULT_CHUNK_SIZE = 100;

export const MODE = { LOCAL: "local", LLM: "llm" };
export const DECISION = { KEEP: "keep", CANDIDATE: "candidate", UNDECIDED: "undecided" };

/** 读全门禁：没读全就分类是 bug，不是「体验问题」。 */
export function classificationGate({ state, items = [] }) {
  if (!isReadComplete(state)) {
    return { ok: false, kind: "not_read_complete", label: progressLabel(state, { withPages: false }) };
  }
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, kind: "no_items", label: "列表是空的：先抓全关注列表。" };
  }
  const fetched = Number(state.fetched) || 0;
  if (items.length < fetched) {
    return { ok: false, kind: "storage_short", label: "已取 " + fetched + " 条但本地只存下 " + items.length + " 条：先重抓一次。" };
  }
  return { ok: true, label: progressLabel(state, { withPages: false }), count: items.length };
}

export class ClassificationLockedError extends Error {
  constructor(gate) {
    super("classification locked: " + (gate && gate.label ? gate.label : "没读全"));
    this.name = "ClassificationLockedError";
    this.kind = (gate && gate.kind) || "not_read_complete";
  }
}

export function assertClassificationUnlocked(gateArgs) {
  const gate = classificationGate(gateArgs);
  if (!gate.ok) throw new ClassificationLockedError(gate);
  return gate;
}

/**
 * 分类结果与决策的仓储。写入前一律 stripSecretFields + assertSecretFree：
 * Key、Cookie、昵称里塞的凭据形态都进不了 storage。
 */
export function createClassifyStore({ storage, now = () => Date.now() } = {}) {
  const chunkKeys = async () => {
    const got = await storage.get([RESULTS_COUNT_KEY]);
    const chunks = Number(got && got[RESULTS_COUNT_KEY]) || 0;
    return Array.from({ length: chunks }, (_, i) => RESULTS_PREFIX + "." + i);
  };

  async function guarded(payload, where) {
    const clean = stripSecretFields(payload);
    assertSecretFree(clean, where);
    await storage.set(clean);
    return clean;
  }

  async function loadTaxonomy() {
    const got = await storage.get([TAXONOMY_KEY]);
    return normalizeTaxonomy(got && got[TAXONOMY_KEY]);
  }

  async function saveTaxonomy(taxonomy) {
    await guarded({ [TAXONOMY_KEY]: normalizeTaxonomy(taxonomy) }, "chrome.storage taxonomy");
    return normalizeTaxonomy(taxonomy);
  }

  async function loadLlmConfig() {
    const got = await storage.get([LLM_CONFIG_KEY]);
    return normalizeLlmConfig(got && got[LLM_CONFIG_KEY]);
  }

  async function saveLlmConfig(config) {
    const clean = stripSecretFields(normalizeLlmConfig(config)); // Key 永远不在这个对象里
    await guarded({ [LLM_CONFIG_KEY]: clean }, "llm_config");
    return clean;
  }

  /** Key 单独一个键存。它必须绕开 stripSecretFields（否则会被自己的隐私闸吃掉），
   *  但绝不能进日志、审计、导出：这些路径都不读这个键。 */
  async function saveApiKey(key) {
    const value = String(key || "");
    if (!value) {
      await storage.remove([LLM_KEY_STORAGE]);
      return { stored: false };
    }
    await storage.set({ [LLM_KEY_STORAGE]: value });
    return { stored: true, hint: keyHint(value) };
  }

  async function loadApiKey() {
    const got = await storage.get([LLM_KEY_STORAGE]);
    return String((got && got[LLM_KEY_STORAGE]) || "");
  }

  async function loadConsent() {
    const got = await storage.get([LLM_CONSENT_KEY]);
    return got && got[LLM_CONSENT_KEY] ? got[LLM_CONSENT_KEY] : null;
  }

  async function saveConsent(consent) {
    await guarded({ [LLM_CONSENT_KEY]: consent }, "llm_consent");
    return consent;
  }

  async function clearConsent() {
    await storage.remove([LLM_CONSENT_KEY]);
  }

  async function loadResults() {
    const keys = await chunkKeys();
    if (!keys.length) return [];
    const got = await storage.get(keys);
    const out = [];
    for (const k of keys) {
      const chunk = got && got[k];
      if (Array.isArray(chunk)) out.push(...chunk);
    }
    return out;
  }

  /** 全量替换结果（分块写）。 */
  async function saveResults(results) {
    const list = Array.isArray(results) ? results : [];
    const old = await chunkKeys();
    const payload = {};
    const chunks = [];
    for (let i = 0; i < list.length; i += RESULT_CHUNK_SIZE) chunks.push(list.slice(i, i + RESULT_CHUNK_SIZE));
    chunks.forEach((chunk, i) => { payload[RESULTS_PREFIX + "." + i] = chunk; });
    payload[RESULTS_COUNT_KEY] = chunks.length;
    await guarded(payload, "classify_results");
    const stale = old.filter((k) => !(k in payload));
    if (stale.length) await storage.remove(stale);
    return list.length;
  }

  async function loadMeta() {
    const got = await storage.get([META_KEY]);
    return got && got[META_KEY] ? got[META_KEY] : null;
  }

  async function saveMeta(meta) {
    await guarded({ [META_KEY]: meta }, "classify_meta");
    return meta;
  }

  async function loadDecisions() {
    const got = await storage.get([DECISIONS_KEY]);
    return { ...(got && got[DECISIONS_KEY] ? got[DECISIONS_KEY] : {}) };
  }

  async function saveDecision(categoryId, decision) {
    const map = await loadDecisions();
    if (!decision || decision === DECISION.UNDECIDED) delete map[categoryId];
    else map[categoryId] = decision;
    await guarded({ [DECISIONS_KEY]: map }, "classify_decisions");
    return map;
  }

  async function clearAll() {
    const got = await storage.get(null);
    const keys = Object.keys(got || {}).filter(
      (k) => k === META_KEY || k === DECISIONS_KEY || k === RESULTS_COUNT_KEY || k.startsWith(RESULTS_PREFIX + "."));
    if (keys.length) await storage.remove(keys);
    return { removed: keys.length };
  }

  return {
    loadTaxonomy,
    saveTaxonomy,
    loadLlmConfig,
    saveLlmConfig,
    loadApiKey,
    saveApiKey,
    loadConsent,
    saveConsent,
    clearConsent,
    loadResults,
    saveResults,
    loadMeta,
    saveMeta,
    loadDecisions,
    saveDecision,
    clearAll,
  };
}

/**
 * 跑一次分类。llm 传 true 表示用户想用 AI；不满足外发前置（Key / 端点 / 告知）
 * 就整批走离线，并把原因写进 meta.fallbackKind —— UI 必须显示这个原因。
 */
export async function runClassification({
  scanStore, classifyStore, storage,
  taxonomy, items, state,
  llm = false, config, apiKey, consent, fetchImpl,
  now = () => Date.now(),
  onProgress = () => {},
  aborted = () => false,
  batchSize, minIntervalMs,
}) {
  const scan = scanStore || createStore({ storage, now });
  const bucket = classifyStore || createClassifyStore({ storage, now: now });
  const allItems = Array.isArray(items) ? items : await scan.loadItems();
  const scanState = state || await scan.getState();
  const gate = assertClassificationUnlocked({ state: scanState, items: allItems });

  const tax = Array.isArray(taxonomy) && taxonomy.length ? normalizeTaxonomy(taxonomy) : await bucket.loadTaxonomy();

  let results = [];
  let meta = {
    status: "complete",
    mode: MODE.LOCAL,
    total: allItems.length,
    classifiedAt: now(),
    threshold: LOW_CONFIDENCE,
    gate: { fetched: Number(scanState.fetched) || 0, total: Number(scanState.total) || 0 },
    requests: 0,
    batches: 0,
    degradedBatches: 0,
    sendBio: false,
    endpoint: null,
    fallbackKind: null,
    sources: {},
  };

  if (llm) {
    const cfg = normalizeLlmConfig(config);
    const gateLlm = preflightGate({ config: cfg, apiKey, consent });
    if (!gateLlm.ok) {
      meta.fallbackKind = gateLlm.kind;
      meta.fallbackLabel = LLM_ERROR_ZH[gateLlm.kind] || gateLlm.kind;
    } else {
      meta.mode = MODE.LLM;
      meta.endpoint = validateEndpoint(cfg.baseUrl).url;
      meta.sendBio = cfg.sendBio !== false;
      const res = await classifyWithLlm({
        items: allItems,
        taxonomy: tax,
        config: cfg,
        apiKey,
        consent,
        fetchImpl,
        batchSize,
        minIntervalMs,
        aborted,
        now: now(),
        onBatch: async (info) => {
          // 边跑边落盘：关面板 / 端点挂了都不丢已经分类的部分。
          const partialRows = (info.rows || []).map(applyConfidenceBucket);
          meta.batches = (info.index || 0) + 1;
          meta.status = "running";
          meta.unclassified = Math.max(0, allItems.length - partialRows.length);
          await bucket.saveResults(partialRows);
          await bucket.saveMeta(meta);
          const { rows, ...rest } = info;
          onProgress({ ...rest, mode: MODE.LLM, saved: partialRows.length });
        },
      });
      results = res.results;
      meta.requests = res.requests || 0;
      meta.batches = res.sentBatches || 0;
      meta.degradedBatches = res.degradedBatches || 0;
      if (!res.ok) {
        meta.status = "partial";
        meta.fallbackKind = res.kind;
        meta.fallbackLabel = LLM_ERROR_ZH[res.kind] || res.kind;
      }
    }
  }

  if (!results.length) {
    results = classifyLocalBatch(allItems, tax, { now: now() });
    if (meta.mode !== MODE.LLM) meta.mode = MODE.LOCAL;
    meta.batches = meta.batches || Math.ceil(allItems.length / (batchSize || 40));
  }

  if (meta.status === "running") meta.status = "complete"; // 批间断点态收尾
  const bucketed = results.map((r) => applyConfidenceBucket(r));
  meta.unclassified = Math.max(0, allItems.length - bucketed.length);
  if (meta.unclassified > 0) meta.status = "partial";
  await bucket.saveResults(bucketed);
  meta.sources = sourceCounts(bucketed);
  meta.unsure = countCategory(bucketed, UNSURE_CATEGORY);
  await bucket.saveMeta(meta);
  if (scan.appendAudit) {
    await scan.appendAudit({
      event: "classify_done",
      mode: meta.mode,
      rows: bucketed.length,
      status: meta.status,
      batches: meta.batches,
      degradedBatches: meta.degradedBatches,
      fallback: meta.fallbackKind || null,
      sendBio: meta.sendBio,
      endpointOrigin: meta.endpoint ? safeOrigin(meta.endpoint) : null,
    });
  }
  return { results: bucketed, meta, gate };
}

/** 低置信 -> 待确认（验收 5：不硬塞）。 */
export function applyConfidenceBucket(result) {
  const raw = result.rawCategory || result.category;
  const category = bucketByConfidence({ ...result, category: raw });
  return {
    ...result,
    category,
    rawCategory: raw, // 低置信被挪进「待确认」时，本来像哪一类要能追溯
    movedToUnsure: category !== raw,
    label: result.label || sourceLabel(result.source),
  };
}

export function sourceLabel(source) {
  if (source === LLM_SOURCE) return LLM_LABEL;
  if (source === LLM_DEGRADED_SOURCE) return LLM_DEGRADED_LABEL;
  if (source === LOCAL_SOURCE) return LOCAL_LABEL;
  return source || "";
}

export function sourceCounts(results) {
  const out = {};
  for (const r of results) out[r.source || "unknown"] = (out[r.source || "unknown"] || 0) + 1;
  return out;
}

/** 每类数量与占比（验收 6：分类卡片要显示数量与占比）。 */
export function categorySummary(results, taxonomy) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length || 0;
  const counts = new Map();
  const sums = new Map();
  for (const r of list) {
    const id = r.category || OTHER_CATEGORY;
    counts.set(id, (counts.get(id) || 0) + 1);
    sums.set(id, (sums.get(id) || 0) + (Number(r.confidence) || 0));
  }
  const rows = [];
  for (const [id, count] of counts.entries()) {
    rows.push({
      categoryId: id,
      name: categoryName(taxonomy, id),
      count,
      ratio: total ? Math.round((count / total) * 1000) / 10 : 0,
      avgConfidence: count ? Number(((sums.get(id) || 0) / count).toFixed(2)) : 0,
      isUnsure: id === UNSURE_CATEGORY,
      isOther: id === OTHER_CATEGORY,
    });
  }
  rows.sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), "zh"));
  return rows;
}

export function countCategory(results, categoryId) {
  return (Array.isArray(results) ? results : []).filter((r) => r.category === categoryId).length;
}

/** 按类取成员。FOR-65 的 diff 预览与取关候选都从这里取人。 */
export function membersOf(results, categoryId) {
  return (Array.isArray(results) ? results : []).filter((r) => r.category === categoryId);
}

/** keep 类永不进候选（v2-spec §4 第 4 条护栏的第一道实现处）。 */
export function candidateMids(results, decisions) {
  const keep = new Set(Object.keys(decisions || {}).filter((k) => decisions[k] === DECISION.KEEP));
  return (Array.isArray(results) ? results : [])
    .filter((r) => !keep.has(r.category))
    .map((r) => String(r.mid));
}

export function keepMids(results, decisions) {
  const keep = new Set(Object.keys(decisions || {}).filter((k) => decisions[k] === DECISION.KEEP));
  return (Array.isArray(results) ? results : [])
    .filter((r) => keep.has(r.category))
    .map((r) => String(r.mid));
}

/** 侧栏/报告用的来源说明，措辞与 PRIVACY.md 一致。 */
export function classificationBlurb(meta) {
  if (!meta) return "还没分类。";
  if (meta.mode === MODE.LLM) {
    const sent = meta.sendBio ? "昵称 + 简介" : "只有昵称";
    const base = "AI 分类：已发送 " + meta.total + " 条" + sent + "到你填的端点（" + safeOrigin(meta.endpoint) + "）。";
    if (meta.degradedBatches) return base + " 其中 " + meta.degradedBatches + " 批失败，已降级为离线粗分类。";
    return base;
  }
  const why = meta.fallbackKind ? "（原因：" + (meta.fallbackLabel || meta.fallbackKind) + "）" : "";
  return "离线粗分类：零外发，只用本机已有的昵称/简介/认证。" + why;
}

function safeOrigin(url) {
  try {
    return new URL(String(url)).origin;
  } catch (err) {
    return "未知端点";
  }
}

function keyHint(value) {
  const s = String(value || "");
  return s.length <= 8 ? "已保存" : "已保存（结尾 " + s.slice(-4) + "）";
}

// 存储键与批大小从 classifyLlm.js 转发出来：UI 与测试只该认 classify.js 一个入口。
export { BATCH_SIZE, LLM_CONFIG_KEY, LLM_CONSENT_KEY, LLM_KEY_STORAGE, consentNotice, makeConsent, preflightGate } from "./classifyLlm.js";

export const CATEGORY_IDS = { OTHER: OTHER_CATEGORY, UNSURE: UNSURE_CATEGORY };
export const LABELS = { LLM: LLM_LABEL, LOCAL: LOCAL_LABEL, DEGRADED: LLM_DEGRADED_LABEL };
export const DEFAULT_TAXONOMY = defaultTaxonomy;