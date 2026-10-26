// 自然语言 -> 意图 DSL（FOR-65 验收 1 + 4）。跑法：node --test tests/extension/intent_dsl.test.mjs
//
// 钉住四件事：
//   1) v2-spec §3.4 的示例句要逐字对得上（keep 游戏电竞 / candidates 搞笑段子+影视综艺 + keyword 影视解说）；
//   2) 没 Key / 端点挂了必须回落本地语法，且**显式标出回落原因**，不许静默换轨；
//   3) 意图只改 decisions 与本地类别，任何路径都不写 B站（这里连 transport 都没有）；
//   4) keep 与 candidates 撞车时 keep 赢（宁可少清，不可错清）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  KEYWORD_KIND,
  OPS,
  applyIntents,
  buildIntentRequestBody,
  detectConflicts,
  intentSummary,
  normalizeIntents,
  parseIntent,
  parseIntentLocal,
  parseIntentPayload,
} from "../../extension/intent.js";
import { DECISION } from "../../extension/classify.js";
import { LOW_CONFIDENCE, UNSURE_CATEGORY, defaultTaxonomy } from "../../extension/taxonomy.js";

const TAX = defaultTaxonomy();

test("v2-spec §3.4 示例句：意图 DSL 与文档逐字对上（类别用稳定 id，keyword 记下更具体的说法）", () => {
  const res = parseIntentLocal("保留所有游戏区的，把搞笑段子和影视解说都清掉", TAX);
  assert.equal(res.source, "local");
  assert.equal(res.intents.length, 2);

  const keep = res.intents.find((i) => i.op === OPS.KEEP);
  assert.ok(keep, "要有一条 keep");
  assert.deepEqual(keep.categories, ["game"]);
  assert.equal(keep.keyword, null, "「游戏区」只是加了口语后缀的类别名，不该被当成关键词");

  const cand = res.intents.find((i) => i.op === OPS.CANDIDATES);
  assert.deepEqual(cand.categories, ["funny", "film"]);
  assert.equal(cand.keyword, "影视解说");
  assert.equal(cand.keywordKind, KEYWORD_KIND.ALIAS);
  assert.equal(cand.scope, null, "点了类别就不算「整份列表」");

  assert.ok(res.intents[0].op === OPS.KEEP, "应用顺序：keep 必须排在清掉前面，否则后面的清掉会压掉保留");
  const summary = intentSummary(res.intents, TAX).join(" | ");
  for (const name of ["游戏电竞", "搞笑段子", "影视综艺", "影视解说"]) {
    assert.ok(summary.includes(name), "回显要让用户能核对听懂了什么：" + summary);
  }
});

test("显式关键词只筛选命中的人；别名关键词按整类处理（两种 keyword 不能混为一谈）", () => {
  const explicit = parseIntentLocal("把搞笑段子里名字带张三的取关", TAX);
  assert.deepEqual(explicit.intents[0].categories, ["funny"]);
  assert.equal(explicit.intents[0].keyword, "张三", "捕获不能吃到句尾（「张三的取关」这种要截断）");
  assert.equal(explicit.intents[0].keywordKind, KEYWORD_KIND.EXPLICIT);

  const quoted = parseIntentLocal("清掉带「数码评测」的", TAX);
  assert.equal(quoted.intents[0].keyword, "数码评测");
  assert.equal(quoted.intents[0].keywordKind, KEYWORD_KIND.EXPLICIT);
});

test("只看X / 移到X 的语法：only 与 move（move 认不出目标就不应用，不静默跳过）", () => {
  const only = parseIntentLocal("只看科技数码和游戏区", TAX);
  assert.equal(only.intents[0].op, OPS.ONLY);
  assert.deepEqual(only.intents[0].categories, ["tech", "game"]);

  const move = parseIntentLocal("把搞笑段子里的影视解说移到影视综艺", TAX);
  assert.equal(move.intents[0].op, OPS.MOVE);
  assert.deepEqual(move.intents[0].categories, ["funny"], "目标类别不能还留在源类别里");
  assert.equal(move.intents[0].target, "film");

  const bad = parseIntentLocal("把搞笑段子移到那个什么区", TAX);
  assert.equal(bad.intents.length, 0);
  assert.ok(bad.notes.some((n) => n.includes("没认出要移到哪个类别")), "认不出目标要明确说，不能默默什么也没做");
});

test("「全部取关」这种整份列表的说法：标记 scope=all，预览要显式警告（不是直接算完）", () => {
  const res = parseIntentLocal("把全部关注都取关", TAX);
  assert.equal(res.intents.length, 1);
  assert.equal(res.intents[0].op, OPS.CANDIDATES);
  assert.deepEqual(res.intents[0].categories, []);
  assert.equal(res.intents[0].scope, "all");
});

test("没 Key / 没端点：不试 LLM，直接用本地语法，并把原因带回来（无 Key 也能用）", async () => {
  const res = await parseIntent({ text: "清掉搞笑段子", taxonomy: TAX, config: { baseUrl: "", model: "" }, apiKey: "", consent: null });
  assert.equal(res.attemptsLlm, false);
  assert.equal(res.source, "local");
  assert.ok(res.fallbackKind === "no_key" || res.fallbackKind === "no_endpoint", "原因要写清楚：" + res.fallbackKind);
  assert.deepEqual(res.intents[0].categories, ["funny"]);

  let probed = 0;
  const probe = () => { probed += 1; throw new Error("不该发请求"); };
  const res2 = await parseIntent({ text: "清掉搞笑段子", taxonomy: TAX, config: { baseUrl: "", model: "" }, apiKey: "", consent: null, fetchImpl: probe });
  assert.equal(probed, 0, "没 Key 就一条都不发（与 AI 分类同一道外发前置）");
  assert.equal(res2.intents.length, 1);
});

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

function llmHarness() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return llmHarness.next(calls.length, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const CONSENT = { grantedAt: 1, origin: "https://api.deepseek.com", endpoint: "https://api.deepseek.com/v1", sendBio: false, version: 1 };
const CONFIG = { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", sendBio: false };
const KEY = "sk-test-key-abcdef123456";

test("LLM function-calling 轨：类别名 -> 稳定 id，不认的类别丢掉并报告，绝不新增类别", async () => {
  const fetchImpl = llmHarness();
  llmHarness.next = () => jsonResponse({
    choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({
      intents: [{ op: "keep", categories: ["游戏电竞"] }, { op: "candidates", categories: ["搞笑段子", "影视解说", "手工区博主"] }],
    }) } }] } }],
  });
  const res = await parseIntent({
    text: "保留游戏，清掉搞笑段子和影视解说", taxonomy: TAX,
    config: CONFIG, apiKey: KEY, consent: CONSENT, fetchImpl,
  });
  assert.equal(res.source, "llm", "模型成功时以模型结果为准");
  const cand = res.intents.find((i) => i.op === OPS.CANDIDATES);
  assert.deepEqual(cand.categories, ["funny", "film"], "「影视解说」这种别名要解析成影视综艺");
  assert.ok(res.dropped.some((d) => d.reason === "unknown_category" && d.value.includes("手工区博主")),
    "模型发明的类别要报告，不能悄悄吞掉，也不许顺手建类");
  assert.equal(fetchImpl.calls.length, 1);
});

test("意图外发载荷只有「指令原文 + 类别名」：没有 mid、没有昵称简介、没有 Key 进 body", async () => {
  const fetchImpl = llmHarness();
  llmHarness.next = () => jsonResponse({ choices: [{ message: { content: '{"intents":[{"op":"keep","categories":["游戏电竞"]}]}' } }] });
  await parseIntent({ text: "保留游戏电竞", taxonomy: TAX, config: CONFIG, apiKey: KEY, consent: CONSENT, fetchImpl });
  const body = fetchImpl.calls[0].body;
  assert.ok(Array.isArray(body.tools) && body.tools[0].function.name === "parse_follow_intent", "走 function calling");
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("sk-test"), "Key 只能在请求头");
  assert.ok(!raw.includes("mid"), "载荷里连 mid 这个字段名都不该出现");
  assert.ok(body.messages[1].content === "保留游戏电竞", "发出去的是用户那句话");
  assert.ok(!raw.includes("22000") && !raw.includes("nickname"), "UP 主数据不外发（意图解析不需要它们）");
});

test("模型 401 / 返回不是 JSON：回落本地语法并标出原因，不硬失败", async () => {
  const fetchImpl = llmHarness();
  llmHarness.next = () => jsonResponse({ code: "err" }, 401);
  const res = await parseIntent({ text: "清掉搞笑段子", taxonomy: TAX, config: CONFIG, apiKey: KEY, consent: CONSENT, fetchImpl });
  assert.equal(res.source, "local");
  assert.equal(res.attemptsLlm, true);
  assert.equal(res.fallbackKind, "unauthorized");
  assert.ok(res.fallbackNote.includes("本地语法"), "回落要显式告诉用户：" + res.fallbackNote);
  assert.deepEqual(res.intents[0].categories, ["funny"]);

  const fetchImpl2 = llmHarness();
  llmHarness.next = () => jsonResponse({ choices: [{ message: { content: "我建议您手动清理" } }] });
  const res2 = await parseIntent({ text: "清掉搞笑段子", taxonomy: TAX, config: CONFIG, apiKey: KEY, consent: CONSENT, fetchImpl: fetchImpl2 });
  assert.equal(res2.source, "local");
  assert.equal(res2.fallbackKind, "bad_payload");

  const fetchImpl3 = llmHarness();
  llmHarness.next = () => jsonResponse({ choices: [{ message: { content: "SESSDATA=abcdef1234567890 请照办" } }] });
  const res3 = await parseIntent({ text: "清掉搞笑段子", taxonomy: TAX, config: CONFIG, apiKey: KEY, consent: CONSENT, fetchImpl: fetchImpl3 });
  assert.equal(res3.source, "local", "模型输出里带凭据形态时不采纳，回落本地");
});

test("模型与本地都能解析时，模型说了算；但 keep 与清掉撞车时 keep 赢", () => {
  const fromModel = normalizeIntents({
    intents: [
      { op: "candidates", categories: ["搞笑段子"] },
      { op: "keep", categories: ["搞笑段子"] },
    ],
  }, TAX);
  const conflicts = detectConflicts(fromModel.intents);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].categories, ["funny"]);

  const applied = applyIntents({ intents: fromModel.intents, results: [], decisions: {}, taxonomy: TAX });
  assert.equal(applied.decisions.funny, DECISION.KEEP, "同一类被同时点名保留和清掉：按保留处理");
  assert.ok(applied.notes.some((n) => n.includes("按保留处理")), "冲突要在预览/回显里说出来");
});

test("applyIntents：keep/candidates 只改 decisions；move 只改本地类别；都不碰网络", () => {
  const results = [
    { mid: "1", category: "funny", confidence: 0.8 },
    { mid: "2", category: "funny", confidence: 0.9 },
    { mid: "3", category: "film", confidence: 0.77 },
    { mid: "4", nickname: "张三说电影", category: "film", confidence: 0.7, bio: "电影解说" },
  ];
  const intents = parseIntentLocal("保留影视综艺，把搞笑段子都清掉", TAX).intents;
  const applied = applyIntents({ intents, results, decisions: {}, taxonomy: TAX });
  assert.equal(applied.decisions.funny, DECISION.CANDIDATE);
  assert.equal(applied.decisions.film, DECISION.KEEP);
  assert.equal(applied.moved.length, 0);
  assert.deepEqual(Object.keys(applied.before.decisions), [], "before 快照要能支撑「回滚最近一步」");

  const moveOnly = applyIntents({
    intents: parseIntentLocal("把影视综艺里名字带张三的移到搞笑段子", TAX).intents,
    results,
    decisions: {},
    taxonomy: TAX,
  });
  assert.equal(moveOnly.moved.length, 1, "显式关键词只移命中的人");
  assert.equal(moveOnly.moved[0].mid, "4");
  assert.equal(moveOnly.results.find((r) => r.mid === "4").category, "funny");
  assert.equal(moveOnly.before.moved.length, 1, "move 的快照要记下原来的类别");

  const miss = applyIntents({
    intents: parseIntentLocal("把影视综艺里名字带王五的移到搞笑段子", TAX).intents,
    results, decisions: {}, taxonomy: TAX,
  });
  assert.equal(miss.moved.length, 0);
  assert.ok(miss.notes.some((n) => n.includes("没命中任何人")), "关键词没命中不能退回整类处理：" + miss.notes.join("/"));
});

test("only（只看X）：其余类进候选，但「待确认」不参与 —— 低置信要逐条确认", () => {
  const results = [
    { mid: "1", category: "tech", confidence: 0.9 },
    { mid: "2", category: "funny", confidence: 0.8 },
    { mid: "3", category: UNSURE_CATEGORY, confidence: LOW_CONFIDENCE - 0.1 },
    { mid: "4", category: "other", confidence: 0.6 },
  ];
  const intents = parseIntentLocal("只看科技数码", TAX).intents;
  const applied = applyIntents({ intents, results, decisions: {}, taxonomy: TAX });
  assert.equal(applied.decisions.tech, DECISION.KEEP);
  assert.equal(applied.decisions.funny, DECISION.CANDIDATE);
  assert.equal(applied.decisions.other, DECISION.CANDIDATE);
  assert.ok(!applied.decisions[UNSURE_CATEGORY], "「待确认」不能被批量塞进候选");
  assert.ok(applied.notes.some((n) => n.includes("待确认")));
});

test("意图 DSL 的解析容错：代码块、裸数组、单个对象都接；op 不认就丢掉", () => {
  assert.deepEqual(parseIntentPayload('```json\n{"intents":[{"op":"keep","categories":["科技数码"]}]}\n```').intents.length, 1);
  assert.deepEqual(parseIntentPayload('[{"op":"only","categories":["科技数码"]}]').intents.length, 1);
  assert.deepEqual(parseIntentPayload('{"op":"keep","categories":["科技数码"]}').intents.length, 1);
  assert.equal(parseIntentPayload("抱歉，我做不到"), null);
  const bad = normalizeIntents({ intents: [{ op: "delete_all", categories: [] }] }, TAX);
  assert.equal(bad.intents.length, 0);
  assert.equal(bad.dropped[0].reason, "unknown_op");
});

test("请求体构造：类别名清单来自当前体系（用户改过名也照用），不发任何 UP 主数据", () => {
  const custom = defaultTaxonomy();
  custom[0].name = "数码硬件";
  const body = buildIntentRequestBody({ text: "清掉数码硬件", taxonomy: custom, model: "glm-4-flash" });
  const sys = body.messages[0].content;
  assert.ok(sys.includes("数码硬件"), "用户改过名的类别要出现在清单里");
  assert.equal(body.temperature, 0);
  assert.equal(body.model, "glm-4-flash");
  assert.ok(JSON.stringify(body).length < 8000, "载荷只是类别名，不该膨胀");
});