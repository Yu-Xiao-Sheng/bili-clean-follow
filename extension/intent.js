// intent.js —— 自然语言指令 -> 意图 DSL（v2-spec §3.4，FOR-65 验收 1）。
//
// 双轨解析：LLM function-calling（用户自己的 BYOK 端点）+ 本地语法（没 Key 也能用）。
// 本地轨是默认轨：没 Key、没端点、模型解析不出、模型返回空 -> 一律回落本地语法，
// 并且把回落原因显式带回来（source/fallbackKind），因为「模型把清掉听成保留」这类错
// 必须在侧栏看得见，不能静默换轨。
//
// 三条硬规矩：
//   1) 本模块只产出 DSL 与「怎么改」的纯函数（applyIntents），不碰 storage、不碰网络写：
//      落库与「回滚最近一步」在 intentStack.js，真正的取关在 unfollow.js。
//   2) 外发内容只有「用户这句话 + 类别名清单」。不发 mid、不发昵称、不发简介、不发凭据。
//      网络调用只有一处实现（classifyLlm.callChatCompletion），本文件不得出现 fetch。
//   3) keep 与 candidates 撞车时 **keep 赢**（宁可少清，不可错清），并在 diff 预览里说明。

import { UNSURE_CATEGORY, categoryName, resolveCategoryRef } from "./taxonomy.js";
import { callChatCompletion, preflightGate } from "./classifyLlm.js";
import { DECISION } from "./classify.js";

export const OPS = { KEEP: "keep", CANDIDATES: "candidates", MOVE: "move", ONLY: "only" };

export const OP_LABEL_ZH = {
  keep: "保留（这类永不进取关候选）",
  candidates: "进取关候选（还不取关）",
  move: "移类（只改本地分类结果）",
  only: "只看这几类（其余类进候选）",
};

export const KEYWORD_KIND = { ALIAS: "alias", EXPLICIT: "explicit" };

// 意图 DSL 里出现这个就当「整份列表」处理：预览必须显式警告，且不碰 keep/待确认。
export const SCOPE_ALL = "all";

export const INTENT_TOOL_NAME = "parse_follow_intent";

/** LLM function-calling 的 tool schema（DSL 形态与工单一致：{intents:[{op,categories,keyword}]}）。 */
export function intentToolSchema(taxonomy) {
  const names = (taxonomy || []).map((c) => c.name);
  return {
    type: "function",
    function: {
      name: INTENT_TOOL_NAME,
      description: "把用户对 B站关注列表的一句中文指令解析成结构化意图。不要执行任何操作。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          intents: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: [OPS.KEEP, OPS.CANDIDATES, OPS.MOVE, OPS.ONLY] },
                categories: { type: "array", items: { type: "string" }, description: "只能用这些类别名：" + names.join("、") },
                keyword: { type: "string", description: "用户提到的更具体的说法（如「影视解说」）或显式关键词，没有就留空" },
                target: { type: "string", description: "仅 op=move 用：目标类别名" },
              },
              required: ["op", "categories"],
            },
          },
        },
        required: ["intents"],
      },
    },
  };
}

/** 意图解析的请求体：载荷里没有 UP 主数据，只有指令原文与类别名。 */
export function buildIntentRequestBody({ text, taxonomy, model }) {
  const names = (taxonomy || []).map((c) => ({ name: c.name, aliases: c.aliases || [] }));
  return {
    model: model || "",
    temperature: 0,
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "你在把用户对 B站关注列表的一句中文指令翻译成结构化意图，只做解析，不做执行。",
          "可用类别名（categories 只能用这些名字，必须原样返回名字）：",
          names.map((n) => n.name + (n.aliases.length ? "(" + n.aliases.join("/") + ")" : "")).join("、"),
          "op 只有四种：keep=保留这类；candidates=把这类放进取关候选（还不执行取关）；move=把 UP 主从一个类移到另一个类；only=只保留这几类，其余类进候选。",
          "'保留所有游戏区的，把搞笑段子和影视解说都清掉' -> {\"intents\":[{\"op\":\"keep\",\"categories\":[\"游戏电竞\"]},{\"op\":\"candidates\",\"categories\":[\"搞笑段子\",\"影视综艺\"],\"keyword\":\"影视解说\"}]}",
          "拿不准的类别宁可不填，也不要发明类别名。不要输出任何解释文字。",
        ].join("\n"),
      },
      { role: "user", content: String(text || "") },
    ],
    tools: [intentToolSchema(taxonomy)],
    tool_choice: { type: "function", function: { name: INTENT_TOOL_NAME } },
  };
}

// --- 本地语法（没 Key 也能用）---------------------------------------------------
// 语序无关：按子句切，子句里先定动作再抓类名。动作判定顺序很重要：
// move / only 比 keep/candidates 更具体，先判；「不要清」是保留，不能被子串「不要」误判成清掉。

const MOVE_RE = /(移到|移动到|挪到|归到|归类到|改到|转到|放到|并进)/;
const ONLY_RE = /(只看|只保留|只留|仅保留|只关注|只留着)/;
const CANDIDATES_RE = /(清掉|清除|清空|清理|取关|取消关注|删掉|删除|移除|移出|去掉|干掉|赶走|不要了|不想要|都清|全清)/;
const KEEP_RE = /(保留|留下|留着|别动|不动|别清|不要清|不用清|不需清|不清|免清|保护|留着吧)/;

// 显式关键词：名字里带 X / 名字含 X / 带「X」的 / 关键词是 X
const EXPLICIT_KEYWORD_RES = [
  // 捕获里排掉中文虚词（的了再和与及）与标点：否则「名字带张三的移到影视综艺」会吃到句尾。
  /(?:名字|昵称|标题|简介)(?:里|中|内)?\s*(?:带|含|有|包含|包括|叫)\s*[「"“']?([^「」"“'，,。;；、\s的了吧呢再和与及移到给]{1,20})/,
  /带\s*[「"“']([^「」"“']{1,20})[」"“']\s*的?/,
  /(?:关键词|关键字)\s*(?:是|为|:|：)?\s*[「"“']?([^「」"“'，,。;；、\s的了吧呢]{1,20})/,
];

// 「区 / 类 / 频道」这类后缀是口语修饰，不算更具体的说法（游戏区 = 游戏电竞，不需要 keyword）。
const CATEGORY_SUFFIXES = ["区", "类", "频道", "领域", "方向"];

function splitClauses(text) {
  return String(text || "")
    .split(/[，,。;；!！?？\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 类名词典：类别名 + 别名，长名优先匹配，避免「影视」抢走「影视解说」。 */
export function categoryLexicon(taxonomy) {
  const entries = [];
  for (const cat of Array.isArray(taxonomy) ? taxonomy : []) {
    if (!cat || !cat.id) continue;
    for (const alias of cat.aliases || []) {
      const text = String(alias || "").trim();
      if (text) entries.push({ text, id: cat.id, isName: false });
    }
    const name = String(cat.name || "").trim();
    if (name) entries.push({ text: name, id: cat.id, isName: true });
  }
  return entries.sort((a, b) => b.text.length - a.text.length || (a.isName ? -1 : 1));
}

/**
 * 从句子里抓类别。返回 {ids, refs, keyword}：
 * refs 是命中的原文说法；keyword 只在「说法比类别名更具体」时记录（v2-spec §3.4 的示例口径）。
 */
export function findCategories(clause, taxonomy) {
  const text = String(clause || "");
  const lexicon = categoryLexicon(taxonomy);
  const hits = [];
  let rest = text;
  for (const entry of lexicon) {
    if (!entry.text) continue;
    let idx = rest.indexOf(entry.text);
    while (idx >= 0) {
      hits.push({ ...entry, at: idx });
      rest = rest.slice(0, idx) + " ".repeat(entry.text.length) + rest.slice(idx + entry.text.length);
      idx = rest.indexOf(entry.text);
    }
  }
  const ids = [];
  const refs = [];
  let keyword = null;
  for (const hit of hits.sort((a, b) => a.at - b.at)) {
    if (!ids.includes(hit.id)) ids.push(hit.id);
    if (!refs.some((r) => r.text === hit.text && r.id === hit.id)) refs.push(hit);
    if (hit.isName) continue; // 类别名本身：不记关键词
    const bare = stripCategorySuffix(hit.text);
    // 「游戏区」这类只是加了口语后缀（区/类/频道），去掉后缀就是类别名/别名 -> 不算更具体的说法。
    if (bare && bare !== hit.text && isSameCategoryRef(taxonomy, hit.id, bare)) continue;
    // 剩下的别名（如「影视解说」之于「影视综艺」）是用户说了个更具体的说法：
    // 记进 keyword 供预览回显（v2-spec §3.4 的示例口径），但**默认按整类处理**，不做子串筛选。
    if (!keyword) keyword = hit.text;
  }
  return { ids, refs, keyword };
}

function stripCategorySuffix(text) {
  let out = String(text || "").trim();
  for (const suffix of CATEGORY_SUFFIXES) {
    if (out.length > suffix.length && out.endsWith(suffix)) out = out.slice(0, -suffix.length);
  }
  return out;
}

function isSameCategoryRef(taxonomy, id, ref) {
  const cat = (Array.isArray(taxonomy) ? taxonomy : []).find((c) => c && c.id === id);
  if (!cat) return false;
  const names = [cat.name, ...(cat.aliases || [])].map((s) => String(s || "").trim()).filter(Boolean);
  return names.includes(ref);
}

function findExplicitKeyword(clause) {
  for (const re of EXPLICIT_KEYWORD_RES) {
    re.lastIndex = 0;
    const m = re.exec(String(clause || ""));
    if (m && m[1]) return String(m[1]).trim();
  }
  return null;
}

function findMoveTarget(clause, taxonomy) {
  const m = MOVE_RE.exec(String(clause || ""));
  if (!m) return null;
  const tail = String(clause || "").slice(m.index + m[0].length);
  const cut = tail.split(/[，,。;；\s的]+/).filter(Boolean);
  let best = null;
  for (const piece of cut.slice(0, 3)) {
    const id = resolveCategoryRef(taxonomy, piece) || resolveCategoryRef(taxonomy, stripCategorySuffix(piece));
    if (id) {
      best = { id, ref: piece };
      break;
    }
    if (!best && piece.length <= 12) best = { id: null, ref: piece };
  }
  return best;
}

function detectOp(clause) {
  const text = String(clause || "");
  if (MOVE_RE.test(text)) return OPS.MOVE;
  if (ONLY_RE.test(text)) return OPS.ONLY;
  if (KEEP_RE.test(text)) return OPS.KEEP; // 「不要清」先于「不要了」：keep 是更强的安全侧
  if (CANDIDATES_RE.test(text)) return OPS.CANDIDATES;
  return null;
}

/** 整份列表的说法：全部取关 / 清空关注 / 都清掉（没点任何类别）。 */
function looksLikeAll(clause, ids) {
  if (ids.length) return false;
  return /(全部|所有|全都|都|每个|整个|全).{0,6}(取关|清掉|清除|清空|清理|删掉|删除|移除)/.test(String(clause || "")) ||
    /(取关|清掉|清除|清空|清理|删掉|删除|移除).{0,6}(全部|所有|关注列表|整个列表|全部关注)/.test(String(clause || ""));
}

/**
 * 本地语法解析（无 Key 路径）。产出规范化的意图 DSL：
 * {op, categories:[稳定 id], names:[类别显示名], keyword, keywordKind, target, scope}
 */
export function parseIntentLocal(text, taxonomy) {
  const clauses = splitClauses(text);
  const merged = new Map();
  const unmatched = [];
  const notes = [];
  for (const clause of clauses) {
    const op = detectOp(clause);
    if (!op) {
      const { ids } = findCategories(clause, taxonomy);
      if (ids.length) unmatched.push({ clause, categories: ids });
      continue;
    }
    const { ids, refs, keyword: aliasKeyword } = findCategories(clause, taxonomy);
    const explicit = findExplicitKeyword(clause);
    let target = op === OPS.MOVE ? findMoveTarget(clause, taxonomy) : null;
    if (op === OPS.MOVE && (!target || !target.id)) {
      notes.push("「" + clause + "」里没认出要移到哪个类别：这条移类没有应用，请把目标类别名说清楚。");
      continue;
    }
    const categories = ids.filter((id) => !(target && target.id === id));
    if (!categories.length && !target && op !== OPS.ONLY && op !== OPS.KEEP) {
      if (looksLikeAll(clause, ids)) {
        const intent = makeIntent({ op, categories: [], scope: SCOPE_ALL, keyword: explicit, keywordKind: explicit ? KEYWORD_KIND.EXPLICIT : null });
        mergeIntent(merged, intent, op);
        notes.push("这句话指向整份关注列表：预览会按安全过滤后再给条数（keep 类与「待确认」不参与）。");
      }
      continue;
    }
    if (!categories.length && (op === OPS.KEEP || op === OPS.ONLY)) {
      notes.push("「" + clause + "」里没认出类别：这条指令没有应用，请把类别名说全。");
      continue;
    }
    for (const ref of refs) {
      if (!ids.includes(ref.id)) unmatched.push({ clause: ref.text, categories: [ref.id] });
    }
    const intent = makeIntent({
      op,
      categories,
      keyword: explicit || aliasKeyword || null,
      keywordKind: explicit ? KEYWORD_KIND.EXPLICIT : (aliasKeyword ? KEYWORD_KIND.ALIAS : null),
      target: target ? target.id : null,
      targetRef: target ? target.ref : null,
      clause,
    });
    mergeIntent(merged, intent, op);
  }
  return { intents: orderIntents([...merged.values()]), source: "local", notes, unmatched };
}

function makeIntent({ op, categories, keyword = null, keywordKind = null, target = null, targetRef = null, scope = null, clause = null }) {
  return { op, categories: [...categories], keyword, keywordKind, target, targetRef, scope, clause };
}

function mergeIntent(merged, intent, op) {
  const key = op + "|" + (intent.target || "");
  const prev = merged.get(key);
  if (!prev) {
    merged.set(key, intent);
    return;
  }
  for (const id of intent.categories) if (!prev.categories.includes(id)) prev.categories.push(id);
  if (!prev.keyword && intent.keyword) {
    prev.keyword = intent.keyword;
    prev.keywordKind = intent.keywordKind;
  }
  if (intent.scope === SCOPE_ALL) prev.scope = SCOPE_ALL;
}

/** 应用顺序固定：keep -> only -> move -> candidates。keep 先落，后面的清掉才压不掉它。 */
function orderIntents(intents) {
  const rank = { [OPS.KEEP]: 0, [OPS.ONLY]: 1, [OPS.MOVE]: 2, [OPS.CANDIDATES]: 3 };
  return intents.sort((a, b) => (rank[a.op] ?? 9) - (rank[b.op] ?? 9));
}

/**
 * 把 LLM 回来的 DSL 规范成本地同款：类别名/别名 -> 稳定 id，认不出的丢掉并记下来。
 * 模型说我们不认的类别名时**不新增类别**（那是 taxonomy 的事），也不猜。
 */
export function normalizeIntents(raw, taxonomy) {
  const list = Array.isArray(raw && raw.intents) ? raw.intents : Array.isArray(raw) ? raw : [];
  const intents = [];
  const dropped = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const op = String(entry.op || "").trim();
    if (!Object.values(OPS).includes(op)) {
      dropped.push({ reason: "unknown_op", value: entry });
      continue;
    }
    const refs = Array.isArray(entry.categories) ? entry.categories : [];
    const ids = [];
    const unknownRefs = [];
    for (const ref of refs) {
      const id = resolveCategoryRef(taxonomy, ref);
      if (id && id !== UNSURE_CATEGORY && !ids.includes(id)) ids.push(id);
      else if (!id) unknownRefs.push(String(ref));
    }
    const targetRef = entry.target ? resolveCategoryRef(taxonomy, entry.target) : null;
    if (op === OPS.MOVE && !targetRef) {
      dropped.push({ reason: "move_without_target", value: entry });
      continue;
    }
    const keyword = typeof entry.keyword === "string" && entry.keyword.trim() ? entry.keyword.trim() : null;
    intents.push(makeIntent({
      op,
      categories: ids.filter((id) => id !== targetRef),
      keyword,
      keywordKind: keyword ? KEYWORD_KIND.ALIAS : null,
      target: targetRef,
      targetRef: entry.target ? String(entry.target) : null,
    }));
    if (unknownRefs.length) dropped.push({ reason: "unknown_category", value: unknownRefs });
  }
  return { intents: orderIntents(intents), source: "llm", notes: [], dropped };
}

/** 双轨入口：先试 LLM（要有 Key + 端点 + 外发确认），拿不到就本地语法顶上。 */
export async function parseIntent({ text, taxonomy, config, apiKey, consent, fetchImpl, preferLlm = true }) {
  const local = parseIntentLocal(text, taxonomy);
  if (!preferLlm) return { ...local, attemptsLlm: false };
  const gate = preflightGate({ config, apiKey, consent });
  if (!gate.ok) {
    return { ...local, attemptsLlm: false, fallbackKind: gate.kind };
  }
  const body = buildIntentRequestBody({ text, taxonomy, model: config && config.model });
  const res = await callChatCompletion({ body, config, apiKey, fetchImpl });
  if (!res.ok) {
    return { ...local, attemptsLlm: true, fallbackKind: res.kind, fallbackNote: "AI 解析失败（" + res.kind + "），已用本地语法解析。" };
  }
  const parsed = normalizeIntents(parseIntentPayload(res.content), taxonomy);
  if (!parsed.intents.length) {
    return { ...local, attemptsLlm: true, fallbackKind: "bad_payload", fallbackNote: "AI 没解析出可执行意图，已用本地语法解析。", dropped: parsed.dropped };
  }
  const conflicts = detectConflicts(parsed.intents);
  return { ...parsed, conflicts, notes: local.notes, localIntents: local.intents };
}

/** 模型可能回 tool_call arguments、也可能回裸 JSON：两种都接。 */
export function parseIntentPayload(content) {
  const text = String(content || "").trim();
  if (!text) return null;
  const tries = [text, fenced(text), objectSlice(text)];
  for (const candidate of tries) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return { intents: parsed };
      if (parsed && Array.isArray(parsed.intents)) return parsed;
      if (parsed && typeof parsed.op === "string") return { intents: [parsed] };
    } catch (err) {
      continue;
    }
  }
  return null;
}

function fenced(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return m ? m[1].trim() : null;
}

function objectSlice(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/** keep 与 candidates 同时点到同一类：keep 赢（安全侧），并把它交给预览说明。 */
export function detectConflicts(intents) {
  const keep = new Set();
  for (const it of intents || []) if (it.op === OPS.KEEP) keep.add(it.categories);
  const kept = new Set();
  for (const set of keep) for (const id of set) kept.add(id);
  const conflicts = [];
  for (const it of intents || []) {
    if (it.op !== OPS.CANDIDATES) continue;
    const blocked = it.categories.filter((id) => kept.has(id));
    if (blocked.length) conflicts.push({ categories: blocked, op: it.op });
  }
  return conflicts;
}

// --- 意图的应用（纯函数：给出 before/after，落库与回滚在 intentStack.js）---------

/**
 * 把意图作用到 decisions / results 上。
 * keep/candidates/only 改的是「类级别决策」，move 改的是「单条结果的类别」。
 * 返回 {decisions, results, before, after, moved, notes, conflicts}。
 */
export function applyIntents({ intents, results, decisions, taxonomy }) {
  const before = { decisions: { ...(decisions || {}) }, moved: [] };
  const next = { ...(decisions || {}) };
  let nextResults = Array.isArray(results) ? results.map((r) => ({ ...r })) : [];
  const moved = [];
  const notes = [];
  const ordered = orderIntents(Array.isArray(intents) ? intents : []);
  const conflicts = detectConflicts(ordered);
  const keptIds = new Set();
  for (const it of ordered) if (it.op === OPS.KEEP) for (const id of it.categories) keptIds.add(id);

  for (const intent of ordered) {
    if (intent.op === OPS.KEEP) {
      for (const id of intent.categories) next[id] = DECISION.KEEP;
      continue;
    }
    if (intent.op === OPS.CANDIDATES) {
      for (const id of intent.categories) {
        if (keptIds.has(id)) {
          notes.push(categoryName(taxonomy, id) + " 同时被要求「保留」和「清掉」：按保留处理，一个人都不动。");
          continue;
        }
        next[id] = DECISION.CANDIDATE;
      }
      continue;
    }
    if (intent.op === OPS.ONLY) {
      for (const id of intent.categories) next[id] = DECISION.KEEP;
      const listed = new Set(intent.categories);
      for (const row of nextResults) {
        const id = row.category;
        if (!id || listed.has(id) || id === UNSURE_CATEGORY) continue;
        if (keptIds.has(id)) continue;
        next[id] = DECISION.CANDIDATE;
      }
      notes.push("「只看」这几类：其余类的决策变成「进候选」，但「待确认」不参与（低置信要逐条确认）。");
      continue;
    }
    if (intent.op === OPS.MOVE) {
      if (!intent.target) continue;
      const sources = intent.categories.length ? intent.categories : null;
      const keyword = intent.keywordKind === KEYWORD_KIND.EXPLICIT ? String(intent.keyword || "").toLowerCase() : null;
      for (const row of nextResults) {
        if (sources && !sources.includes(row.category)) continue;
        if (row.category === intent.target) continue;
        if (keyword && !hitsKeyword(row, keyword)) continue;
        moved.push({ mid: String(row.mid), from: row.category, to: intent.target });
        before.moved.push({ mid: String(row.mid), from: row.category, to: intent.target });
        row.category = intent.target;
        row.overridden = true;
      }
      if (intent.keywordKind === KEYWORD_KIND.EXPLICIT) {
        const n = moved.filter((m) => m.to === intent.target).length;
        if (!n) notes.push("关键词「" + intent.keyword + "」没命中任何人：这次移类没有改动任何条目（不会退回整类处理）。");
      }
      continue;
    }
    notes.push("未知意图 op=" + intent.op + "：已忽略。");
  }
  return {
    decisions: next,
    results: nextResults,
    before,
    after: { decisions: { ...next }, moved },
    moved,
    notes,
    conflicts,
  };
}

function hitsKeyword(row, keyword) {
  const hay = [row.nickname, row.name, row.bio, row.official].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(keyword);
}

/** 侧栏回显：把 DSL 翻回一句人话，让用户能核对我们到底听懂了什么。 */
export function intentSummary(intents, taxonomy) {
  return (Array.isArray(intents) ? intents : []).map((it) => {
    const names = (it.categories || []).map((id) => categoryName(taxonomy, id)).join("、") ||
      (it.scope === SCOPE_ALL ? "整份关注列表" : "（没认出类别）");
    const bits = [OP_LABEL_ZH[it.op] || it.op, names];
    if (it.keyword) bits.push(it.keywordKind === KEYWORD_KIND.EXPLICIT ? "关键词「" + it.keyword + "」" : "更具体的说法「" + it.keyword + "」");
    if (it.target) bits.push("-> " + categoryName(taxonomy, it.target));
    return bits.join("：");
  });
}

export function opLabel(op) {
  return OP_LABEL_ZH[op] || String(op || "");
}