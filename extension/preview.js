// preview.js —— 任何意图先渲染 diff 预览；写操作前必须「看过」这份预览（v2-spec §3.4 + §4 护栏 b）。
//
// 为什么把「预览」和「武装」放在一起：护栏 b 说的是「执行前必须看到 diff 预览」。
// 如果执行器只是相信 UI 传来的 {sawPreview: true}，那这条护栏就只是 UI 层的礼貌——
// 控制台发一条消息就能绕过。所以这里给预览算一个指纹（内容哈希），armPreview() 把指纹
// 落到 storage（带 TTL），执行时再比对：**没渲染过这份预览就拿不到匹配的指纹**，写操作直接拒。
// 预览内容一变（分类结果变了、候选人数变了），指纹跟着变，旧的武装自动作废。
//
// 本模块不碰网络、不碰 chrome.*，纯函数 + 注入 storage，所以 node:test 能直接跑。

import { LOW_CONFIDENCE, UNSURE_CATEGORY, categoryName } from "./taxonomy.js";
import { DECISION, categorySummary, membersOf } from "./classify.js";
import { KEYWORD_KIND, SCOPE_ALL, opLabel } from "./intent.js";

export const PREVIEW_SAMPLE_LIMIT = 10; // 验收口径：10 条样例（昵称 + 简介 + 置信度）
export const ARM_KEY = "unfollow_arm.v1";
export const ARM_TTL_MS = 10 * 60 * 1000; // 预览过期时间：翻个页面再回来就不算「刚看过」
export const PREVIEW_NOTICE = "这将不会立刻取关，只生成候选。";
export const WRITE_PREVIEW_NOTICE = "下一步是真实取关：不可撤销，需手输 UNFOLLOW。";

/**
 * 安全候选（护栏 e 的执行处 + FOR-64 交接里钉住的那条硬约束）。
 *
 * classify.candidateMids() 的语义是「排除勾了保留的类」，不是「只取高置信」，
 * 所以它会放行「待确认」。取关不可逆，这一层必须再挡掉：
 *   1) keep 类里的一个人都不进（白名单硬约束）；
 *   1b) 只有**明确勾了「进候选」（decisions[类别] === CANDIDATE）**的类才可能进：
 *       没表过态的类不参与写操作 —— 取关必须是用户主动交出来的，不是「默认全都要清」；
 *   2) category === UNSURE_CATEGORY 不进（证据不足不清洗）；
 *   3) confidence < LOW_CONFIDENCE 不进（哪怕它被归到了某个正经类）；
 *   4) 自己的 mid 不进（插件不该能把自己取关）；
 *   5) 没有分类结果的人不进（没分过类 = 没证据）。
 */
export function safeCandidateMids({ results, decisions, selfMid = null, lowConfidence = null, extraExclude = [] }) {
  const rows = Array.isArray(results) ? results : [];
  const keep = new Set(Object.keys(decisions || {}).filter((k) => decisions[k] === DECISION.KEEP));
  const excluded = new Set(Array.isArray(extraExclude) ? extraExclude.map(String) : []);
  const self = selfMid ? String(selfMid) : null;
  const out = [];
  const blocked = { keep: 0, unsure: 0, lowConfidence: 0, self: 0, uncategorized: 0, notOptedIn: 0 };
  const opted = new Set(Object.keys(decisions || {}).filter((k) => decisions[k] === DECISION.CANDIDATE));
  for (const row of rows) {
    const mid = String(row.mid || "");
    if (!mid) continue;
    if (!row.category) { blocked.uncategorized += 1; continue; }
    if (keep.has(row.category)) { blocked.keep += 1; continue; }
    if (decisions && decisions[row.category] === DECISION.KEEP) { blocked.keep += 1; continue; }
    if (row.category === UNSURE_CATEGORY) { blocked.unsure += 1; continue; }
    const conf = Number(row.confidence);
    const floor = lowConfidence === null ? defaultFloor() : Number(lowConfidence);
    if (!Number.isFinite(conf) || conf < floor) { blocked.lowConfidence += 1; continue; }
    if (!opted.has(row.category)) { blocked.notOptedIn += 1; continue; } // 没勾「进候选」= 不动
    if (self && mid === self) { blocked.self += 1; continue; }
    if (excluded.has(mid)) continue;
    out.push(mid);
  }
  return { mids: out, blocked };
}

function defaultFloor() {
  // 阈值只有 taxonomy 一处：分类归桶与取关候选用同一个数，别在 UI 或执行器里另写。
  return LOW_CONFIDENCE;
}

/** 把 items（昵称/简介）与 results（类别/置信）按 mid 拼成预览行。 */
export function joinRows(items, results) {
  const byMid = new Map((Array.isArray(results) ? results : []).map((r) => [String(r.mid), r]));
  return (Array.isArray(items) ? items : []).map((item) => {
    const mid = String(item.mid || "");
    const r = byMid.get(mid);
    return {
      mid,
      nickname: item.nickname || "",
      bio: item.bio || "",
      official: item.official || "",
      category: r ? r.category : null,
      confidence: r ? Number(r.confidence) : null,
      label: r ? r.label || "" : "",
      reason: r ? r.reason || "" : "",
    };
  });
}

/** 意图的 diff 预览：确认前唯一的画面。willWrite 永远是 false。 */
export function buildIntentPreview({ intents, items, results, decisions, taxonomy, state = null, now = () => Date.now() }) {
  const rows = joinRows(items, results);
  const byMid = new Map(rows.map((r) => [r.mid, r]));
  const appliedRows = applyForPreview({ intents, rows, taxonomy });
  const affectedMids = affectedByIntents({ intents, rows, results, decisions, taxonomy });
  const affected = affectedMids.map((mid) => byMid.get(mid)).filter(Boolean);
  const summaryRows = categorySummary(affected, taxonomy);
  const excluded = new Set();
  for (const row of (Array.isArray(results) ? results : [])) {
    if (decisions && decisions[row.category] === DECISION.KEEP) excluded.add(String(row.mid));
    if (row.category === UNSURE_CATEGORY) excluded.add(String(row.mid));
    else if (!(Number(row.confidence) >= LOW_CONFIDENCE)) excluded.add(String(row.mid));
  }
  const afterSafe = safeCandidateMids({
    results: appliedRows.map((r) => ({ mid: r.mid, category: r.category, confidence: r.confidence })),
    decisions: decisionsAfterIntents({ intents, decisions }),
    selfMid: state && state.mid ? String(state.mid) : null,
  });
  const notices = [PREVIEW_NOTICE];
  for (const intent of Array.isArray(intents) ? intents : []) {
    if (intent.scope === SCOPE_ALL) notices.push("这条指令指向整份列表：只会清「已分类且证据够」的，keep 与「待确认」不参与。");
    if (intent.keywordKind === KEYWORD_KIND.EXPLICIT) notices.push("关键词「" + intent.keyword + "」按名字/简介包含匹配筛选，不会退回整类处理。");
  }
  const samples = affected.slice(0, PREVIEW_SAMPLE_LIMIT).map(toSample);
  const preview = {
    kind: "intent",
    createdAt: now(),
    sampleLimit: PREVIEW_SAMPLE_LIMIT,
    intents: (Array.isArray(intents) ? intents : []).map((it) => ({
      op: it.op,
      label: opLabel(it.op),
      categories: it.categories || [],
      names: (it.categories || []).map((id) => categoryName(taxonomy, id)),
      keyword: it.keyword || null,
      keywordKind: it.keywordKind || null,
      target: it.target || null,
      targetName: it.target ? categoryName(taxonomy, it.target) : null,
      affected: countIntentAffected({ intent: it, rows, results, decisions, taxonomy }),
    })),
    affected: affected.length,
    byCategory: summaryRows,
    samples,
    excludedFromUnfollow: {
      keep: afterSafe.blocked.keep,
      unsure: afterSafe.blocked.unsure,
      lowConfidence: afterSafe.blocked.lowConfidence,
      self: afterSafe.blocked.self,
      uncategorized: afterSafe.blocked.uncategorized,
    },
    unfollowCandidatesAfter: afterSafe.mids.length,
    willWrite: false,
    notices,
  };
  preview.hash = fingerprint(preview);
  return preview;
}

/** 写操作前的 diff 预览（护栏 b 的对象）。这里仍未写任何东西。 */
export function buildUnfollowPreview({
  items, results, decisions, taxonomy,
  limit = null, selfMid = null, restrictTo = null, now = () => Date.now(),
}) {
  const rows = joinRows(items, results);
  const byMid = new Map(rows.map((r) => [r.mid, r]));
  const safe = safeCandidateMids({
    results,
    decisions,
    selfMid: selfMid ? String(selfMid) : null,
  });
  // restrictTo：断点续跑只给「剩下的人」做预览。安全过滤（keep / 待确认 / 低置信）照样先过一遍。
  const restrict = restrictTo instanceof Set ? restrictTo : (Array.isArray(restrictTo) ? new Set(restrictTo.map(String)) : null);
  const picked = restrict ? safe.mids.filter((mid) => restrict.has(String(mid))) : safe.mids;
  const chosen = picked.map((mid) => byMid.get(mid)).filter(Boolean);
  const preview = {
    kind: "unfollow",
    createdAt: now(),
    sampleLimit: PREVIEW_SAMPLE_LIMIT,
    affected: chosen.length,
    byCategory: categorySummary(chosen.map((r) => ({ mid: r.mid, category: r.category, confidence: r.confidence })), taxonomy),
    samples: chosen.slice(0, PREVIEW_SAMPLE_LIMIT).map(toSample),
    items: chosen.map((r) => ({ mid: r.mid, nickname: r.nickname, category: r.category, confidence: r.confidence })),
    excluded: safe.blocked,
    limit: limit === null ? null : Number(limit),
    willWrite: false, // 「还没写」；只有 executeUnfollow 会真的动，而它先过护栏
    notices: [WRITE_PREVIEW_NOTICE,
      "被挡在外面：keep 类 " + safe.blocked.keep + " 人、待确认 " + safe.blocked.unsure +
      " 人、低置信(< " + LOW_CONFIDENCE + ") " + safe.blocked.lowConfidence +
      " 人、没勾「进候选」的类 " + safe.blocked.notOptedIn + " 人。"],
  };
  preview.hash = fingerprint(preview);
  return preview;
}

function toSample(row) {
  return {
    mid: row.mid,
    nickname: row.nickname || "(无昵称)",
    bio: String(row.bio || "").slice(0, 60),
    confidence: Number.isFinite(row.confidence) ? row.confidence : null,
    category: row.category || null,
    label: row.label || "",
  };
}

// --- 预览指纹与「看过」的记录（护栏 b 的实现处）--------------------------------

/** FNV-1a 32bit：够做「同一份预览」的比对，不当密码用。 */
export function fingerprint(value) {
  const text = typeof value === "string" ? value : canonicalForHash(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return "pv" + hash.toString(16).padStart(8, "0");
}

function canonicalForHash(preview) {
  if (Array.isArray(preview)) return "[" + preview.map(canonicalForHash).join(",") + "]";
  if (!preview || typeof preview !== "object") return JSON.stringify(preview ?? null);
  const parts = [];
  for (const key of Object.keys(preview).sort()) {
    if (key === "createdAt" || key === "hash") continue; // 时间戳不参与：内容一致就算同一份预览
    parts.push(key + ":" + canonicalForHash(preview[key]));
  }
  return "{" + parts.join(",") + "}";
}

/** UI 渲染完预览之后调用：把指纹落盘（带 TTL），这就是「确实看过」的证据。 */
export async function armPreview(store, preview, { now = Date.now(), ttlMs = ARM_TTL_MS } = {}) {
  if (!preview || !preview.hash) throw new Error("armPreview 需要一个已经算出指纹的预览");
  const armed = {
    hash: preview.hash,
    kind: preview.kind,
    count: Number(preview.affected) || 0,
    armedAt: now,
    expiresAt: now + ttlMs,
  };
  await store.set({ [ARM_KEY]: armed });
  return armed;
}

export async function loadArm(store) {
  const got = await store.get([ARM_KEY]);
  return (got && got[ARM_KEY]) || null;
}

export async function clearArm(store) {
  await store.remove([ARM_KEY]);
}

/** 比对「这次要执行的东西」和「刚才看过的那份预览」是不是同一份。 */
export function armMatches(armed, preview, { now = Date.now() } = {}) {
  if (!armed || !preview) return { ok: false, kind: "preview_required", label: "没看过 diff 预览：不能执行取关。" };
  if (armed.hash !== preview.hash) {
    return { ok: false, kind: "preview_stale", label: "预览已经过时（候选清单变了）：重新看一遍 diff 预览。" };
  }
  if (armed.expiresAt && now > armed.expiresAt) {
    return { ok: false, kind: "preview_expired", label: "预览超过 " + Math.round(ARM_TTL_MS / 60000) + " 分钟：重新看一遍再执行。" };
  }
  return { ok: true };
}

// --- 预览内容计算用的纯函数 ---------------------------------------------------

function decisionsAfterIntents({ intents, decisions }) {
  const next = { ...(decisions || {}) };
  for (const it of Array.isArray(intents) ? intents : []) {
    if (it.op === "keep") for (const id of it.categories || []) next[id] = DECISION.KEEP;
    if (it.op === "candidates") for (const id of it.categories || []) next[id] = DECISION.CANDIDATE;
    if (it.op === "only") for (const id of it.categories || []) next[id] = DECISION.KEEP;
  }
  return next;
}

/** 预览里的 results 视图：把 move 的结果先投影出来（不落库）。 */
function applyForPreview({ intents, rows, taxonomy }) {
  let out = rows.map((r) => ({ ...r }));
  for (const it of Array.isArray(intents) ? intents : []) {
    if (it.op !== "move" || !it.target) continue;
    const sources = (it.categories || []).length ? it.categories : null;
    const keyword = it.keywordKind === KEYWORD_KIND.EXPLICIT ? String(it.keyword || "").toLowerCase() : null;
    out = out.map((row) => {
      if (sources && !sources.includes(row.category)) return row;
      if (row.category === it.target) return row;
      if (keyword && !((row.nickname + " " + row.bio).toLowerCase().includes(keyword))) return row;
      return { ...row, category: it.target };
    });
  }
  return out;
}

function membersForIntent({ intent, rows, results, decisions, taxonomy }) {
  const keyword = intent.keywordKind === KEYWORD_KIND.EXPLICIT ? String(intent.keyword || "").toLowerCase() : null;
  if (intent.scope === SCOPE_ALL) return rows;
  if (intent.op === "only") {
    const listed = new Set(intent.categories || []);
    return rows.filter((r) => r.category && !listed.has(r.category) && r.category !== UNSURE_CATEGORY);
  }
  const cats = new Set(intent.categories || []);
  let picked = rows.filter((r) => cats.has(r.category));
  if (keyword) picked = picked.filter((r) => ((r.nickname + " " + r.bio).toLowerCase().includes(keyword)));
  if (intent.op === "candidates") {
    const keep = new Set(Object.keys(decisions || {}).filter((k) => decisions[k] === DECISION.KEEP));
    picked = picked.filter((r) => !keep.has(r.category));
  }
  return picked;
}

function countIntentAffected({ intent, rows, results, decisions, taxonomy }) {
  return membersForIntent({ intent, rows, results, decisions, taxonomy }).length;
}

function affectedByIntents({ intents, rows, results, decisions, taxonomy }) {
  const set = new Set();
  for (const intent of Array.isArray(intents) ? intents : []) {
    for (const row of membersForIntent({ intent, rows, results, decisions, taxonomy })) set.add(String(row.mid));
  }
  return [...set];
}

export function categoryNames(taxonomy, ids) {
  return (Array.isArray(ids) ? ids : []).map((id) => categoryName(taxonomy, id));
}

export { membersOf };