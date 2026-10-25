// BYOK 大模型分类（classifyLlm.js）验收：每批 40、强制 JSON schema、失败重试一次后降级、
// 以及「没确认告知 / 没 Key 就一条都不发」（FOR-64 验收 2/3）。
//
// 用 mock fetch，不发任何真实网络请求；断言的是「发出去了什么」和「没发什么」。

import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_SIZE,
  LLM_DEGRADED_LABEL,
  LLM_DEGRADED_SOURCE,
  LLM_SOURCE,
  assertPayloadSafe,
  batchItems,
  buildRequestBody,
  classifyWithLlm,
  completionsUrl,
  consentNotice,
  makeConsent,
  parseLlmCategories,
  preflightGate,
  validateConsent,
  validateEndpoint,
} from "../../extension/classifyLlm.js";
import { UNSURE_CATEGORY, defaultTaxonomy, resolveCategoryRef } from "../../extension/taxonomy.js";

const TAX = defaultTaxonomy();
const BASE_URL = "https://api.example-llm.test/v1";

function items(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    mid: String(30000 + offset + i),
    nickname: "UP主" + (offset + i),
    bio: "科技数码评测第 " + (offset + i) + " 期",
    verified: false,
    official: "",
    followTs: Date.UTC(2024, 0, 1) / 1000,
  }));
}

function responder({ status = 200, content } = {}) {
  const body = JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

function mockFetch(makeResponse) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return makeResponse(calls.length, calls);
  };
  fn.calls = calls;
  return fn;
}

function okRows(batchSize, start = 1) {
  return { items: Array.from({ length: batchSize }, (_, i) => ({
    ref: "r" + (start + i),
    category: "科技数码",
    confidence: 0.81,
    reason: "简介命中科技数码评测",
  })) };
}

test("每批 40 条：81 条走 3 批，请求数 == 批数，最后一批只有 1 条", async () => {
  const list = items(81);
  const fetchImpl = mockFetch((n) => responder({ content: okRows(n === 3 ? 1 : 40) }));
  const res = await classifyWithLlm({
    items: list, taxonomy: TAX,
    config: { baseUrl: BASE_URL, model: "test-model", sendBio: true },
    apiKey: "test-key-not-a-real-one",
    consent: makeConsent({ baseUrl: BASE_URL, sendBio: true, count: 81 }),
    fetchImpl, minIntervalMs: 0,
  });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls.length, 3, "81 条应该切 3 批");
  assert.equal(buildRequestBody(items(40), TAX).messages.length, 2);
  assert.equal(batchItems(items(81)).length, Math.ceil(81 / BATCH_SIZE));
  assert.equal(batchItems(items(81))[0].length, BATCH_SIZE);
  assert.equal(batchItems(items(81))[2].length, 1);
  assert.equal(res.results.length, 81);
  assert.equal(res.results.filter((r) => r.source === LLM_SOURCE).length, 81);
});

test("外发载荷只有 ref + 昵称（+ 简介）：mid、Cookie、凭据形态一律不发", async () => {
  const list = items(3);
  const fetchImpl = mockFetch(() => responder({ content: okRows(3) }));
  await classifyWithLlm({
    items: list, taxonomy: TAX,
    config: { baseUrl: BASE_URL, model: "m", sendBio: true },
    apiKey: "test-key",
    consent: makeConsent({ baseUrl: BASE_URL, sendBio: true, count: 3 }),
    fetchImpl, minIntervalMs: 0,
  });
  const sent = JSON.stringify(fetchImpl.calls[0].body);
  for (const it of list) {
    assert.ok(!sent.includes(String(it.mid)), "载荷里出现了 mid " + it.mid);
  }
  assert.ok(sent.includes("UP主0"), "昵称要发，否则模型没法判断");
  assert.ok(sent.includes("科技数码评测"), "sendBio=true 时简介要发");
  const rows = JSON.parse(fetchImpl.calls[0].body.messages[1].content).rows;
  assert.deepEqual(Object.keys(rows[0]), ["ref", "nickname", "bio"], "外发字段只有这三样");
  assert.equal(rows[0].ref, "r1", "用一次性代号 ref 映射回来，模型永远不知道 mid");
  assert.ok(!("mid" in rows[0]) && !("face" in rows[0]) && !("followTs" in rows[0]));
  assert.ok(!/SESSDATA|bili_jct|DedeUserID/i.test(sent), "载荷里不能有任何凭据形态");
  assert.ok(sent.includes("可选类别"), "system 里要给类别清单，模型才不会自由发挥");
});

test("「只发昵称不发简介」开关生效：载荷里没有 bio", async () => {
  const fetchImpl = mockFetch(() => responder({ content: okRows(3) }));
  await classifyWithLlm({
    items: items(3), taxonomy: TAX,
    config: { baseUrl: BASE_URL, model: "m", sendBio: false },
    apiKey: "k", consent: makeConsent({ baseUrl: BASE_URL, sendBio: false, count: 3 }),
    fetchImpl, minIntervalMs: 0,
  });
  const sent = JSON.stringify(fetchImpl.calls[0].body);
  assert.ok(!sent.includes("科技数码评测"), "勾了只发昵称就不该带简介");
  assert.ok(sent.includes("UP主0"));
});

test("没 Key / 没端点 / 没确认告知 / 端点换过：一条都不发", async () => {
  const cases = [
    { config: { baseUrl: BASE_URL, model: "m" }, apiKey: "", consent: makeConsent({ baseUrl: BASE_URL }), kind: "no_key" },
    { config: { baseUrl: "", model: "m" }, apiKey: "k", consent: null, kind: "no_endpoint" },
    { config: { baseUrl: BASE_URL, model: "m" }, apiKey: "k", consent: null, kind: "consent_required" },
    { config: { baseUrl: "https://other.example.test/v1", model: "m" }, apiKey: "k",
      consent: makeConsent({ baseUrl: BASE_URL }), kind: "consent_stale" },
    { config: { baseUrl: "http://evil.example.test/v1", model: "m" }, apiKey: "k", consent: null, kind: "insecure_endpoint" },
  ];
  for (const c of cases) {
    const fetchImpl = mockFetch(() => responder({ content: okRows(3) }));
    const res = await classifyWithLlm({
      items: items(3), taxonomy: TAX, config: c.config, apiKey: c.apiKey, consent: c.consent,
      fetchImpl, minIntervalMs: 0,
    });
    assert.equal(res.ok, false, c.kind + " 时不得发请求");
    assert.equal(res.kind, c.kind);
    assert.equal(fetchImpl.calls.length, 0, c.kind + " 场景发出了请求");
    assert.equal(res.results.length, 0);
  }
  assert.equal(validateEndpoint("http://127.0.0.1:11434/v1").ok, true, "本机回环端点放行（数据不出机器）");
  assert.equal(completionsUrl(BASE_URL), "https://api.example-llm.test/v1/chat/completions");
});

test("告知文案：写清发几条、发到哪、不含什么（验收 3）", () => {
  const notice = consentNotice({ count: 431, baseUrl: BASE_URL, model: "deepseek-chat", sendBio: true });
  assert.match(notice.lines[0], /将发送 431 条昵称 \+ 简介到 https:\/\/api\.example-llm\.test\/v1/);
  assert.ok(notice.lines.some((l) => /不含：Cookie、登录凭据、UID、mid、头像、关注关系/.test(l)));
  assert.equal(notice.privacyLine, "凭据永不出本机；昵称与简介只发给你自己指定的模型端点。");
  assert.deepEqual(consentNotice({ count: 5, baseUrl: BASE_URL, sendBio: false }).sends, ["昵称"]);
  assert.equal(validateConsent({ consent: makeConsent({ baseUrl: BASE_URL }), baseUrl: BASE_URL }).ok, true);
});

test("解析失败：重试一次，再失败则该批降级为离线分类并标注来源（验收 2）", async () => {
  const fetchImpl = mockFetch(() => responder({ content: "抱歉，我没法输出 JSON。" }));
  const res = await classifyWithLlm({
    items: items(40), taxonomy: TAX,
    config: { baseUrl: BASE_URL, model: "m", sendBio: true },
    apiKey: "k", consent: makeConsent({ baseUrl: BASE_URL }), fetchImpl, minIntervalMs: 0,
  });
  assert.equal(fetchImpl.calls.length, 2, "只准重试一次，别把用户额度打爆");
  const second = fetchImpl.calls[1].body.messages[0].content;
  assert.match(second, /这次只输出 JSON/, "重试时要收紧指令");
  assert.equal(res.results.length, 40);
  assert.equal(res.degradedBatches, 1);
  for (const r of res.results) {
    assert.equal(r.source, LLM_DEGRADED_SOURCE);
    assert.equal(r.label, LLM_DEGRADED_LABEL);
  }
  assert.match(res.results[0].reason, /命中|无法判断/);
});

test("端点 429 / 401：不重试打爆额度，直接降级并给出中文原因", async () => {
  for (const [status, kind] of [[429, "rate_limited"], [401, "unauthorized"], [500, "provider_error"]]) {
    const fetchImpl = mockFetch(() => responder({ status, content: { error: kind } }));
    const res = await classifyWithLlm({
      items: items(5), taxonomy: TAX,
      config: { baseUrl: BASE_URL, model: "m" }, apiKey: "k",
      consent: makeConsent({ baseUrl: BASE_URL }), fetchImpl, minIntervalMs: 0,
    });
    const expectedCalls = status === 500 ? 2 : 1; // 5xx 允许换宽松 schema 再试一次
    assert.equal(fetchImpl.calls.length, expectedCalls, kind + " 的重试次数不对");
    assert.equal(res.results.every((r) => r.source === LLM_DEGRADED_SOURCE), true);
  }
});

test("模型输出容错：代码块包裹、置信度 0-100、类别别名、漏一条与多一条", async () => {
  const rows = parseLlmCategories("```json\n" + JSON.stringify({ items: [
    { ref: "R1", category: "数码", confidence: 81, reason: "简介命中科技" },
    { ref: "r2", category: "不存在的类", confidence: 0.9, reason: "瞎猜" },
    { ref: "r9", category: "科技数码", confidence: 0.7, reason: "多给的一条没人要" },
  ] }) + "\n```", TAX);
  assert.deepEqual(rows.map((r) => r.ref), ["R1", "r9"], "解析阶段原样保留 ref（大小写归一在映射阶段做），未知类别的行被丢掉");
  assert.equal(rows[0].category, "tech", "别名「数码」要能解析到 tech");
  assert.ok(!rows.some((r) => r.category === undefined));
  assert.equal(rows[0].confidence, 0.81, "0-100 要归一到 0-1");
  assert.equal(parseLlmCategories("完全不是 JSON", TAX), null);
  assert.equal(resolveCategoryRef(TAX, "影视解说"), "film");
  assert.equal(resolveCategoryRef(TAX, "待确认"), UNSURE_CATEGORY);

  const fetchImpl = mockFetch(() => responder({ content: { items: [{ ref: "r1", category: "科技数码", confidence: 0.9, reason: "命中" }] } }));
  const res = await classifyWithLlm({
    items: items(3), taxonomy: TAX, config: { baseUrl: BASE_URL, model: "m" }, apiKey: "k",
    consent: makeConsent({ baseUrl: BASE_URL }), fetchImpl, minIntervalMs: 0,
  });
  assert.equal(res.results.filter((r) => r.source === LLM_SOURCE).length, 1);
  assert.equal(res.results.filter((r) => r.source === LLM_DEGRADED_SOURCE).length, 2, "模型漏回的条目必须降级，不能凭空造结果");
});

test("强制 JSON schema 输出；重试时改用宽松 json_object", async () => {
  const body = buildRequestBody(items(2), TAX, { model: "m", sendBio: true, strictSchema: true });
  assert.equal(body.response_format.type, "json_schema");
  const schema = body.response_format.json_schema.schema;
  assert.deepEqual(schema.properties.items.items.required, ["ref", "category", "confidence", "reason"]);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.temperature, 0);
  const loose = buildRequestBody(items(2), TAX, { model: "m", strictSchema: false });
  assert.deepEqual(loose.response_format, { type: "json_object" });
  assert.throws(() => assertPayloadSafe({ messages: [{ content: "SESSDATA=abcdef123456" }] }, []), /credentials/);
});

test("中断与限速：批间隔只夹在批之间；aborted 后不再发下一批，已分类结果保留", async () => {
  const sleeps = [];
  const fetchImpl = mockFetch(() => responder({ content: okRows(40) }));
  let seen = 0;
  const res = await classifyWithLlm({
    items: items(120), taxonomy: TAX,
    config: { baseUrl: BASE_URL, model: "m" }, apiKey: "k",
    consent: makeConsent({ baseUrl: BASE_URL }), fetchImpl,
    minIntervalMs: 300, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    aborted: () => { seen += 1; return seen > 2; },
  });
  assert.equal(fetchImpl.calls.length, 2, "aborted 之后不该再发第三批");
  assert.equal(sleeps.length, 2, "每两批之间各夹一次限速（第三次检查才 abort）");
  assert.equal(res.kind, "aborted");
  assert.equal(res.results.length, 80, "已分类的要保留");
});