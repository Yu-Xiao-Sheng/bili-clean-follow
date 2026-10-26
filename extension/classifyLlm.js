// classifyLlm.js —— BYOK 大模型分类（OpenAI 兼容端点，v2-spec §3.3，FOR-64 验收 2/3）。
//
// 四条不可绕过的规矩：
//   1) 没有用户填的 endpoint + Key 就绝不发请求：调用方必须走 classifyLocal.js。
//      本文件里 PRESETS 只是「帮你少打字」的预设地址，不是「我们在联网」的证据。
//   2) 首次启用必须先告知再外发：consentNotice() 生成告知文案，consent 落库时绑定 origin；
//      换了 endpoint（origin 变了）consent 立即失效，必须重新确认。
//   3) 发出去的内容只有「昵称 (+简介)」与一个批次内的一次性代号 ref。
//      不发 mid、不发 cookie/UID、不发头像、不发关注关系 —— 模型回填 mid 也不采信，按 ref 映射。
//   4) Key 只存 chrome.storage.local 的独立键，绝不进配置对象、日志、审计、导出文件
//      （privacy.js 会把 key/api_key 这类字段名整条丢掉，所以绝不能把 Key 混进配置里写）。
//
// 降级：每批 40 条；解析失败重试一次；再失败则该批走离线分类并标注 source = "local_degraded"。

import { assertSecretFree, redactSecrets } from "./privacy.js";
import { LOW_CONFIDENCE, categoryName, resolveCategoryRef } from "./taxonomy.js";
import { LOCAL_MAX_CONFIDENCE, REASON_MAX, classifyLocally } from "./classifyLocal.js";

export const LLM_CONFIG_KEY = "llm_config.v1";
export const LLM_KEY_STORAGE = "llm_api_key.v1"; // 只有 Key 的独立键，不与配置混写
export const LLM_CONSENT_KEY = "llm_consent.v1";

export const BATCH_SIZE = 40; // 验收：每批 40 条
export const PARSE_RETRY_LIMIT = 1; // 验收：解析失败重试一次
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MIN_INTERVAL_MS = 300; // 批间隔，别把用户额度秒光
export const LLM_SOURCE = "llm";
export const LLM_DEGRADED_SOURCE = "local_degraded";
export const LLM_LABEL = "AI 分类（BYOK）";
export const LLM_DEGRADED_LABEL = "AI 失败降级为离线粗分类";

// 预设只覆盖「用户自己会填」的 OpenAI 兼容端点；不内置任何我们的服务。
export const PROVIDER_PRESETS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { id: "kimi", label: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "tongyi", label: "通义千问（DashScope 兼容模式）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "local", label: "本机 OpenAI 兼容服务（Ollama / LM Studio）", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b-instruct" },
  { id: "custom", label: "自定义 baseURL", baseUrl: "", model: "" },
];

export const LLM_ERROR_ZH = {
  no_endpoint: "没填模型端点：AI 分类不可用，已走离线粗分类。",
  no_key: "没填 API Key：AI 分类不可用，已走离线粗分类。",
  insecure_endpoint: "端点必须是 https://（或本机 http://127.0.0.1、http://localhost）。",
  consent_required: "还没确认「将发送哪些内容到哪个端点」，AI 分类未启动。",
  consent_stale: "端点换过了，之前的告知确认已失效，请重新确认。",
  unauthorized: "端点返回未授权：Key 可能不对或已过期。",
  rate_limited: "端点限流（HTTP 429）：这批降级为离线粗分类，稍后再试。",
  provider_error: "端点服务端错误：这批降级为离线粗分类。",
  network_error: "连不上端点：这批降级为离线粗分类。",
  bad_payload: "端点返回的内容解析不出 JSON：重试一次后该批降级。",
  aborted: "已按你的要求停止，已分类的结果保留。",
};

export function defaultLlmConfig() {
  return { preset: "custom", baseUrl: "", model: "", sendBio: true, enabled: false, updatedAt: null };
}

/** 配置读写。注意：Key 不在这里，别把 Key 塞进 config（privacy.js 会把它剥掉，然后你会以为 Key 丢了）。 */
export function normalizeLlmConfig(raw) {
  return { ...defaultLlmConfig(), ...(raw && typeof raw === "object" ? raw : {}) };
}

export function endpointOrigin(baseUrl) {
  const url = String(baseUrl || "").trim();
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch (err) {
    return null;
  }
}

/** 端点校验：https 优先；明文 http 只准本机（本机跑模型 = 数据其实也没出机器）。 */
export function validateEndpoint(baseUrl) {
  const url = String(baseUrl || "").trim();
  if (!url) return { ok: false, kind: "no_endpoint" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return { ok: false, kind: "no_endpoint" };
  }
  if (parsed.protocol === "https:") return { ok: true, origin: parsed.origin, url: url.replace(/\/+$/, "") };
  if (parsed.protocol === "http:") {
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (local) return { ok: true, origin: parsed.origin, url: url.replace(/\/+$/, ""), local: true };
    return { ok: false, kind: "insecure_endpoint" };
  }
  return { ok: false, kind: "insecure_endpoint" };
}

export function completionsUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  return base + "/chat/completions";
}

/**
 * 首次启用的告知文案（验收 3：逐条列出发什么、发到哪、不含什么）。
 * UI 必须把 lines 原样渲染给用户，且「确认」要落 consent（绑定 origin）。
 */
export function consentNotice({ count = 0, baseUrl, model, sendBio = true }) {
  const check = validateEndpoint(baseUrl);
  const fields = sendBio ? ["昵称", "简介"] : ["昵称"];
  return {
    title: "启用 AI 分类前请先确认",
    endpoint: check.ok ? check.url : String(baseUrl || "（未填）"),
    origin: check.ok ? check.origin : null,
    model: model || "（未填模型名）",
    count: Number(count) || 0,
    sendBio: Boolean(sendBio),
    sends: fields,
    lines: [
      "将发送 " + (Number(count) || 0) + " 条" + fields.join(" + ") + "到 " + (check.ok ? check.url : "（端点无效）") + "。",
      "不含：Cookie、登录凭据、UID、mid、头像、关注关系与任何取关/操作指令。",
      "每条只带一个本次批次内的一次性代号（r1、r2…），模型不知道也不该知道 UP 主的 mid。",
      "模型名：" + (model || "（未填）") + "；这是你自己的 BYOK 端点，我们不代收、不中转、不留存。",
      check.ok && check.local ? "这个端点在本机回环地址上，数据不出这台机器。" : "离开本机前，请确认这个端点是你自己的。",
      "Key 只存在浏览器扩展本地存储里，不进仓库、不进日志、不进导出文件。",
    ],
    privacyLine: "凭据永不出本机；昵称与简介只发给你自己指定的模型端点。",
  };
}

/** consent 落库：绑定 origin。换端点必须重新确认（validateConsent 会把旧确认判失效）。 */
export function makeConsent({ baseUrl, sendBio = true, count = 0, now = Date.now() }) {
  const check = validateEndpoint(baseUrl);
  return {
    grantedAt: now,
    origin: check.ok ? check.origin : null,
    endpoint: check.ok ? check.url : null,
    sendBio: Boolean(sendBio),
    count: Number(count) || 0,
    version: 1,
  };
}

export function validateConsent({ consent, baseUrl }) {
  if (!consent || consent.grantedAt === undefined || consent.grantedAt === null) {
    return { ok: false, kind: "consent_required" };
  }
  const check = validateEndpoint(baseUrl);
  if (!check.ok) return { ok: false, kind: check.kind };
  if (!consent.origin || consent.origin !== check.origin) return { ok: false, kind: "consent_stale" };
  return { ok: true };
}

/** 批次切分（验收：每批 40 条）。 */
export function batchItems(items, size = BATCH_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(1, Number(size) || BATCH_SIZE);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 外发载荷：只有 ref / 昵称 /（可选）简介。mid 与凭据一律不带。 */
export function buildBatchPayload(batch, taxonomy, { sendBio = true } = {}) {
  return (Array.isArray(batch) ? batch : []).map((item, i) => {
    const row = { ref: "r" + (i + 1), nickname: oneLine(item.nickname, 40) };
    if (sendBio) row.bio = oneLine(item.bio, 120);
    if (sendBio) {
      const official = oneLine(item.official || "", 40);
      if (official) row.official = official;
    }
    return row;
  });
}

/** 单批请求体（强制 JSON schema 输出）。 */
export function buildRequestBody(batch, taxonomy, { sendBio = true, model, strictSchema = true, retryHint = false } = {}) {
  const names = (taxonomy || []).map((c) => ({ name: c.name, aliases: c.aliases || [] }));
  const system = [
    "你要把 B站关注列表里的 UP 主按内容方向归类，只用于用户自己整理关注列表。",
    "可选类别（只能用这些名字）：" + names.map((n) => n.name + (n.aliases.length ? "(" + n.aliases.join("/") + ")" : "")).join("、"),
    "规则：只依据昵称与简介判断；证据不足时选「其他」并把 confidence 给到 0.4 以下，不要猜。",
    "confidence 是 0 到 1 的小数；reason 用中文，不超过 " + REASON_MAX + " 字，写清依据哪条信号。",
    "输出必须是 JSON：{\"items\": [{\"ref\": \"r1\", \"category\": \"类别名\", \"confidence\": 0.72, \"reason\": \"简介命中「数码评测」\"}]}",
    "items 数量必须与输入条数一致，ref 必须原样回传。不要输出任何解释文字。",
    retryHint ? "上一次输出无法解析成 JSON。这次只输出 JSON 对象，不要代码块、不要注释、不要多余文本。" : "",
  ].filter(Boolean).join("\n");

  const payload = buildBatchPayload(batch, taxonomy, { sendBio });
  const body = {
    model: model || "",
    temperature: 0,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ count: payload.length, rows: payload }) },
    ],
  };
  if (strictSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "follow_categories",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["ref", "category", "confidence", "reason"],
                properties: {
                  ref: { type: "string" },
                  category: { type: "string" },
                  confidence: { type: "number" },
                  reason: { type: "string", maxLength: REASON_MAX },
                },
              },
            },
          },
        },
      },
    };
  } else {
    body.response_format = { type: "json_object" };
  }
  return body;
}

/** 外发前最后一道闸：载荷里不许出现凭据形态，也不许出现 mid 值。 */
export function assertPayloadSafe(body, batch) {
  const text = JSON.stringify(body);
  assertSecretFree(text, "LLM request payload");
  for (const item of Array.isArray(batch) ? batch : []) {
    const mid = String(item.mid || "");
    if (!/^\d{4,}$/.test(mid)) continue;
    const sent = (body.messages || []).map((m) => String(m.content || "")).join(" ");
    if (sent.includes(mid)) {
      throw new Error("refusing to send mid " + mid + " to a third-party endpoint（只发昵称/简介，不发 mid）");
    }
  }
  return true;
}

/** 解析模型输出：允许裸数组、{items:[...]}、```json 包裹。解析不出返回 null。 */
export function parseLlmCategories(text, taxonomy) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const candidates = [raw, unwrapFence(raw), grabJsonObject(raw), grabJsonArray(raw)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      continue;
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.items) ? parsed.items : null;
    if (!rows) continue;
    const out = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const ref = String(row.ref ?? row.id ?? row.mid ?? "").trim();
      const category = resolveCategoryRef(taxonomy, row.category ?? row.label ?? row.class);
      if (!ref || !category) continue;
      out.push({
        ref,
        category,
        confidence: normalizeConfidence(row.confidence),
        reason: oneLine(row.reason ?? row.why ?? "", REASON_MAX),
      });
    }
    if (out.length) return out;
  }
  return null;
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n > 1 && n <= 100) return Number((n / 100).toFixed(2)); // 有些模型回 0-100
  return Number(Math.max(0, Math.min(1, n)).toFixed(2));
}

/**
 * 单批分类：一次请求 + 解析失败重试一次；再失败返回 {ok:false}，调用方把该批降级为离线。
 * @param fetchImpl 注入的 fetch（测试用 mock；运行时传 globalThis.fetch）
 */
export async function classifyBatch({ batch, taxonomy, config, apiKey, fetchImpl, sendBio = true, strictSchema = true, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const check = validateEndpoint(config.baseUrl);
  if (!check.ok) return { ok: false, kind: check.kind };
  if (!apiKey) return { ok: false, kind: "no_key" };
  const url = completionsUrl(config.baseUrl);
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!doFetch) return { ok: false, kind: "network_error" };

  let lastKind = "bad_payload";
  let lastStatus = null;
  for (let attempt = 0; attempt <= PARSE_RETRY_LIMIT; attempt += 1) {
    const body = buildRequestBody(batch, taxonomy, {
      sendBio,
      model: config.model,
      strictSchema: strictSchema && attempt === 0,
      retryHint: attempt > 0,
    });
    try {
      assertPayloadSafe(body, batch);
    } catch (err) {
      return { ok: false, kind: "bad_payload", message: redactSecrets(err.message) };
    }
    let response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err && (err.name === "AbortError")) return { ok: false, kind: "aborted" };
      return { ok: false, kind: "network_error", message: redactSecrets(err && err.message) };
    }
    const text = await readText(response);
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) return { ok: false, kind: "unauthorized", status: lastStatus };
    if (response.status === 429) return { ok: false, kind: "rate_limited", status: lastStatus };
    if (!response.ok) {
      lastKind = response.status >= 500 ? "provider_error" : "bad_payload";
      if (attempt === PARSE_RETRY_LIMIT) return { ok: false, kind: lastKind, status: lastStatus };
      continue; // 服务端错误 / 载荷不认：换宽松 schema 再试一次
    }
    const content = extractContent(text);
    const rows = parseLlmCategories(content, taxonomy);
    if (rows) {
      return { ok: true, rows, attempts: attempt + 1, status: lastStatus, strictSchema: strictSchema && attempt === 0 };
    }
    lastKind = "bad_payload";
  }
  return { ok: false, kind: lastKind, status: lastStatus };
}

/**
 * 通用 chat 调用（FOR-65 意图解析用）：与 classifyBatch 共用端点与错误语义，
 * 但载荷里没有 UP 主数据 —— 只有用户那句指令与类别名清单（v2-spec §3.4）。
 * 网络调用在本扩展里只有两处实现：classifyBatch（分类）与此处（意图）。
 * intent.js / preview.js / unfollow.js 一律不得出现 fetch(，它们靠注入的传输层。
 */
export async function callChatCompletion({ body, config, apiKey, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const check = validateEndpoint(config && config.baseUrl);
  if (!check.ok) return { ok: false, kind: check.kind };
  if (!apiKey) return { ok: false, kind: "no_key" };
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!doFetch) return { ok: false, kind: "network_error" };
  try {
    assertSecretFree(JSON.stringify(body), "intent request payload");
  } catch (err) {
    return { ok: false, kind: "bad_payload", message: redactSecrets(err.message) };
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await doFetch(completionsUrl(config.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err && err.name === "AbortError") return { ok: false, kind: "aborted" };
    return { ok: false, kind: "network_error", message: redactSecrets(err && err.message) };
  }
  if (timer) clearTimeout(timer);
  const text = await readText(response);
  if (response.status === 401 || response.status === 403) return { ok: false, kind: "unauthorized", status: response.status };
  if (response.status === 429) return { ok: false, kind: "rate_limited", status: response.status };
  if (!response.ok) {
    return { ok: false, kind: response.status >= 500 ? "provider_error" : "bad_payload", status: response.status };
  }
  const content = extractToolArguments(text) || extractContent(text);
  if (!content) return { ok: false, kind: "bad_payload", status: response.status };
  return { ok: true, content, status: response.status };
}

/** function-calling 回的是 tool_calls[].function.arguments：优先取它，再退回 message.content。 */
function extractToolArguments(text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    return null;
  }
  const first = (payload && Array.isArray(payload.choices) ? payload.choices[0] : null) || {};
  const message = (first.message || {});
  const call = Array.isArray(message.tool_calls)
    ? message.tool_calls.find((c) => c && c.function && c.function.arguments)
    : null;
  return call ? String(call.function.arguments) : null;
}
/**
 * 全量分类（按 40 条一批）。没有 Key 或未确认告知时一条都不发。
 * 降级：某批失败 → 该批走离线，source = "local_degraded"（验收 2）。
 */
export async function classifyWithLlm({
  items, taxonomy, config, apiKey, fetchImpl,
  consent, sendBio, now = Date.now(),
  batchSize = BATCH_SIZE, minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  signal, aborted = () => false, onBatch = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const cfg = normalizeLlmConfig(config);
  const useBio = sendBio === undefined ? cfg.sendBio !== false : Boolean(sendBio);
  const gate = preflightGate({ config: cfg, apiKey, consent });
  if (!gate.ok) return { ok: false, kind: gate.kind, results: [], sentBatches: 0, requests: 0 };

  const batches = batchItems(items, batchSize);
  const results = [];
  let requests = 0;
  let sentBatches = 0;
  let degradedBatches = 0;

  for (let i = 0; i < batches.length; i += 1) {
    if (aborted() || (signal && signal.aborted)) {
      return { ok: false, kind: "aborted", results, sentBatches, requests, degradedBatches };
    }
    const batch = batches[i];
    requests += 1;
    sentBatches += 1;
    const res = await classifyBatch({
      batch, taxonomy, config: cfg, apiKey, fetchImpl, sendBio: useBio, signal,
    });
    if (res.ok) {
      const map = new Map(res.rows.map((r) => [normalizeRef(r.ref), r]));
      for (const item of batch) {
        const hit = map.get(normalizeRef(refFor(batch, item)));
        if (hit) {
          results.push({
            mid: String(item.mid),
            category: hit.category,
            confidence: hit.confidence,
            reason: hit.reason || "模型未给理由",
            source: LLM_SOURCE,
            label: LLM_LABEL,
            confidenceIsLlm: true,
          });
        } else {
          results.push(degraded(item, taxonomy, now, "模型没回这一条（ref 对不上）"));
        }
      }
    } else {
      degradedBatches += 1;
      for (const item of batch) results.push(degraded(item, taxonomy, now, LLM_ERROR_ZH[res.kind] || res.kind));
    }
    onBatch({ index: i, total: batches.length, count: batch.length, ok: res.ok, kind: res.ok ? null : res.kind, done: results.length, rows: results });
    if (i < batches.length - 1 && minIntervalMs > 0) await sleep(minIntervalMs);
  }

  return { ok: true, results, sentBatches, requests, degradedBatches, sendBio: useBio, endpoint: validateEndpoint(cfg.baseUrl).url };
}

/** 外发前的门禁（没 Key / 没端点 / 没确认 -> 一律不发请求）。 */
export function preflightGate({ config, apiKey, consent }) {
  const cfg = normalizeLlmConfig(config);
  const check = validateEndpoint(cfg.baseUrl);
  if (!check.ok) return { ok: false, kind: check.kind };
  if (!String(apiKey || "").trim()) return { ok: false, kind: "no_key" };
  const agree = validateConsent({ consent, baseUrl: cfg.baseUrl });
  if (!agree.ok) return { ok: false, kind: agree.kind };
  return { ok: true, origin: check.origin };
}

function degraded(item, taxonomy, now, why) {
  const local = classifyLocally(item, taxonomy, { now });
  return {
    ...local,
    mid: String(item.mid),
    source: LLM_DEGRADED_SOURCE,
    label: LLM_DEGRADED_LABEL,
    degradeNote: oneLine(why || "", REASON_MAX),
  };
}

function refFor(batch, item) {
  const idx = batch.indexOf(item);
  return "r" + (idx >= 0 ? idx + 1 : batch.findIndex((x) => String(x.mid) === String(item.mid)) + 1);
}

function normalizeRef(value) {
  return String(value || "").trim().toLowerCase().replace(/^r/, "");
}

function extractContent(text) {
  const raw = String(text || "");
  try {
    const parsed = JSON.parse(raw);
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    if (choice && choice.message && typeof choice.message.content === "string") return choice.message.content;
    if (choice && typeof choice.text === "string") return choice.text;
    if (typeof parsed?.output_text === "string") return parsed.output_text;
    if (typeof parsed?.content === "string") return parsed.content;
    return raw;
  } catch (err) {
    return raw;
  }
}

async function readText(response) {
  if (!response) return "";
  try {
    return await response.text();
  } catch (err) {
    return "";
  }
}

function unwrapFence(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return m ? m[1].trim() : null;
}

function grabJsonObject(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? text.slice(a, b + 1) : null;
}

function grabJsonArray(text) {
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  return a >= 0 && b > a ? text.slice(a, b + 1) : null;
}

function oneLine(value, max) {
  const clean = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

export function lowConfidenceThreshold() {
  return LOW_CONFIDENCE;
}

export function llmConfidenceCeiling() {
  return LOCAL_MAX_CONFIDENCE;
}

export function categoryLabel(taxonomy, id) {
  return categoryName(taxonomy, id);
}