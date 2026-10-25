// 门禁 + 结果落库 + 保留/进候选决策（FOR-64 验收 5、验收「Key 不进仓库/日志/导出」）。
//
// 关键点：门禁不是 UI 文案，是 runClassification 会抛错；
// Key 走独立存储键，任何配置对象/审计/meta 里都不该出现它（privacy.js 会抛）。

import assert from "node:assert/strict";
import test from "node:test";

import { createStore, memoryStorage } from "../../extension/store.js";
import {
  DECISION,
  LLM_KEY_STORAGE,
  META_KEY,
  MODE,
  RESULTS_COUNT_KEY,
  ClassificationLockedError,
  candidateMids,
  classificationBlurb,
  classificationGate,
  createClassifyStore,
  keepMids,
  runClassification,
} from "../../extension/classify.js";
import { UNSURE_CATEGORY, defaultTaxonomy } from "../../extension/taxonomy.js";
import { LLM_SOURCE, makeConsent } from "../../extension/classifyLlm.js";

const BASE_URL = "https://api.example-llm.test/v1";
const API_KEY = "sk-TESTKEYabcdefghijkl1234"; // 形状是真的，值是假的：泄漏就会被 privacy 拦下

function fixture(count = 20) {
  const tax = defaultTaxonomy();
  const items = Array.from({ length: count }, (_, i) => ({
    mid: String(40000 + i),
    nickname: i % 4 === 0 ? "手工耿" + i : "科技评测" + i,
    bio: i % 4 === 0 ? "" : "硬核科技测评，手机数码硬件",
    verified: false,
    official: "",
  }));
  return { tax, items };
}

function makeStores() {
  const storage = memoryStorage();
  return { storage, scan: createStore({ storage }), classify: createClassifyStore({ storage }) };
}

function completeState(scan, count) {
  return scan.saveState({ status: "complete", mid: "12345", total: count, fetched: count, pages: Math.ceil(count / 20), ps: 20 });
}

function okRows(size) {
  return { items: Array.from({ length: size }, (_, i) => ({ ref: "r" + (i + 1), category: "科技数码", confidence: 0.83, reason: "简介命中科技数码" })) };
}

function mockFetch(contentFor) {
  const calls = [];
  const fn = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const content = contentFor(calls.length);
    return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }); } };
  };
  fn.calls = calls;
  return fn;
}

test("没读全就分类：抛错，且文案是验收口径「还没读全（已取 431/812）」", async () => {
  const { scan, classify } = makeStores();
  const state = await scan.saveState({ status: "incomplete", total: 812, fetched: 431, pages: 22 });
  const gate = classificationGate({ state, items: [] });
  assert.equal(gate.ok, false);
  assert.equal(gate.kind, "not_read_complete");
  assert.equal(gate.label, "还没读全（已取 431/812）");
  await assert.rejects(
    runClassification({ scanStore: scan, classifyStore: classify, storage: scan.storage, state, items: [], taxonomy: defaultTaxonomy() }),
    (err) => err instanceof ClassificationLockedError && err.kind === "not_read_complete",
  );
});

test("列表为空 / 存储条数少于已取条数：都不许分类", async () => {
  const { scan, classify } = makeStores();
  const empty = await completeState(scan, 5);
  assert.equal(classificationGate({ state: empty, items: [] }).kind, "no_items");
  const drift = await completeState(scan, 812);
  assert.equal(classificationGate({ state: drift, items: new Array(500).fill({ mid: "1" }) }).kind, "storage_short");
});

test("读全之后离线分类：结果分块落 storage，meta 记来源与门禁快照", async () => {
  const { storage, scan, classify } = makeStores();
  const { tax, items } = fixture(120);
  const state = await completeState(scan, items.length);
  const res = await runClassification({ scanStore: scan, classifyStore: classify, state, items, taxonomy: tax, llm: false });
  assert.equal(res.meta.mode, MODE.LOCAL);
  assert.equal(res.meta.requests, 0);
  assert.equal(res.results.length, items.length);
  const loaded = await classify.loadResults();
  assert.equal(loaded.length, items.length, "结果必须真的落盘（分块）");
  const count = (await storage.get([RESULTS_COUNT_KEY]))[RESULTS_COUNT_KEY];
  assert.equal(count, Math.ceil(items.length / 100), "812 条这种量级不能一个键塞完");
  const meta = await classify.loadMeta();
  assert.equal(meta.gate.fetched, items.length);
  assert.equal(meta.gate.total, items.length);
  assert.equal(meta.threshold, 0.55);
  assert.ok(meta.unsure > 0, "fixture 里有空简介条目，必须有进「待确认」的");
  assert.ok(loaded.some((r) => r.category === UNSURE_CATEGORY && r.rawCategory && r.movedToUnsure),
    "待确认要能追溯它本来像哪一类");
  assert.match(classificationBlurb(meta), /离线粗分类：零外发/);
});

test("选了 AI 但没 Key / 没确认：整批走离线，并把原因写进 meta（UI 要显示）", async () => {
  const { scan, classify } = makeStores();
  const { tax, items } = fixture(20);
  const state = await completeState(scan, items.length);
  const fetchImpl = mockFetch(() => okRows(20));
  const res = await runClassification({
    scanStore: scan, classifyStore: classify, state, items, taxonomy: tax,
    llm: true, config: { baseUrl: BASE_URL, model: "m", sendBio: true }, apiKey: "", consent: null,
    fetchImpl, minIntervalMs: 0,
  });
  assert.equal(fetchImpl.calls.length, 0, "没 Key 还发请求就是隐私事故");
  assert.equal(res.meta.mode, MODE.LOCAL);
  assert.equal(res.meta.fallbackKind, "no_key");
  assert.match(classificationBlurb(res.meta), /没填 API Key/);
});

test("AI 分类跑通：来源标 llm、meta 只记端点 origin，Key 不进 meta / 审计 / 配置", async () => {
  const { storage, scan, classify } = makeStores();
  const { tax, items } = fixture(45);
  const state = await completeState(scan, items.length);
  await classify.saveApiKey(API_KEY);
  assert.equal(await classify.loadApiKey(), API_KEY, "Key 单独键存储");
  const fetchImpl = mockFetch((n) => okRows(n === 2 ? 5 : 40));
  const consent = makeConsent({ baseUrl: BASE_URL, sendBio: true, count: items.length });
  await classify.saveConsent(consent);
  const res = await runClassification({
    scanStore: scan, classifyStore: classify, state, items, taxonomy: tax,
    llm: true, config: { baseUrl: BASE_URL, model: "m", sendBio: true },
    apiKey: await classify.loadApiKey(), consent, fetchImpl, minIntervalMs: 0,
  });
  assert.equal(fetchImpl.calls.length, 2, "45 条应该切两批");
  assert.equal(res.meta.mode, MODE.LLM);
  assert.equal(res.meta.endpoint, BASE_URL);
  assert.equal(res.results.filter((r) => r.source === LLM_SOURCE).length, items.length);
  const snapshot = storage._dump();
  const keyKeys = Object.keys(snapshot).filter((k) => JSON.stringify(snapshot[k]).includes(API_KEY));
  assert.deepEqual(keyKeys, [LLM_KEY_STORAGE], "Key 只准待在它自己的键里，别处一份都不许有");
  const audit = await scan.loadAudit();
  assert.ok(audit.some((e) => e.event === "classify_done" && e.mode === "llm"));
  assert.ok(!JSON.stringify(audit).includes(API_KEY), "审计日志里出现了 Key");
  assert.ok(!JSON.stringify(await classify.loadMeta()).includes(API_KEY));
  assert.match(classificationBlurb(res.meta), /已发送 45 条昵称 \+ 简介到你填的端点/);
});

test("「只发昵称不发简介」在编排层同样生效，且 meta 记录 sendBio=false", async () => {
  const { scan, classify } = makeStores();
  const { tax, items } = fixture(10);
  const state = await completeState(scan, items.length);
  const fetchImpl = mockFetch(() => okRows(10));
  const res = await runClassification({
    scanStore: scan, classifyStore: classify, state, items, taxonomy: tax,
    llm: true, config: { baseUrl: BASE_URL, model: "m", sendBio: false }, apiKey: "k",
    consent: makeConsent({ baseUrl: BASE_URL, sendBio: false }), fetchImpl, minIntervalMs: 0,
  });
  const sent = JSON.stringify(fetchImpl.calls[0]);
  assert.ok(!sent.includes("硬核科技测评"), "简介外发了");
  assert.equal(res.meta.sendBio, false);
  assert.match(classificationBlurb(res.meta), /只有昵称/);
});

test("Key 想混进配置对象：被 privacy.js 剥掉，绝不落盘", async () => {
  const { storage, classify } = makeStores();
  await classify.saveLlmConfig({ baseUrl: BASE_URL, model: "m", key: API_KEY, apiKey: API_KEY });
  const dump = storage._dump();
  assert.ok(!JSON.stringify(dump).includes(API_KEY));
  assert.equal(dump["llm_config.v1"].baseUrl, BASE_URL, "正常配置字段要保住");
});

test("中断：已分类结果保留，meta 标 partial 并给出未分类条数", async () => {
  const { storage, scan, classify } = makeStores();
  const { tax, items } = fixture(120);
  const state = await completeState(scan, items.length);
  const fetchImpl = mockFetch(() => okRows(40));
  const all = await runClassification({
    scanStore: scan, classifyStore: classify, state, items, taxonomy: tax,
    llm: true, config: { baseUrl: BASE_URL, model: "m" }, apiKey: "k",
    consent: makeConsent({ baseUrl: BASE_URL }), fetchImpl, minIntervalMs: 0, batchSize: 40,
  });
  assert.equal(all.results.length, items.length);
  assert.equal(all.meta.status, "complete");
  let checks = 0;
  const fetchImpl2 = mockFetch(() => okRows(40));
  const stopped = await runClassification({
    scanStore: scan, classifyStore: classify, state, items, taxonomy: tax,
    llm: true, config: { baseUrl: BASE_URL, model: "m" }, apiKey: "k",
    consent: makeConsent({ baseUrl: BASE_URL }), fetchImpl: fetchImpl2, minIntervalMs: 0, batchSize: 40,
    aborted: () => { checks += 1; return checks > 2; }, // 第三批之前停
  });
  assert.equal(stopped.results.length, 80, "停下来时已分类的要保留");
  assert.equal(stopped.meta.status, "partial");
  assert.equal(stopped.meta.unclassified, 40);
  const dumped = await classify.loadMeta();
  assert.equal(dumped[META_KEY], undefined, "meta 里不该套一层键名");
  assert.equal((await classify.loadResults()).length, 80);
});

test("保留 / 进候选：keep 类里的 UP 主永不进候选（FOR-65 的白名单硬约束）", async () => {
  const { scan, classify } = makeStores();
  const { tax, items } = fixture(20);
  const state = await completeState(scan, items.length);
  const res = await runClassification({ scanStore: scan, classifyStore: classify, state, items, taxonomy: tax, llm: false });
  const tech = res.results.filter((r) => r.category === "tech").map((r) => r.mid);
  assert.ok(tech.length, "fixture 应该有 tech 类成员");
  await classify.saveDecision("tech", DECISION.KEEP);
  await classify.saveDecision("funny", DECISION.CANDIDATE);
  const decisions = await classify.loadDecisions();
  assert.equal(decisions.tech, DECISION.KEEP);
  const all = new Set(res.results.map((r) => r.mid));
  const candidates = new Set(candidateMids(res.results, decisions));
  for (const mid of tech) assert.ok(!candidates.has(mid), mid + " 在 keep 类里却进了候选");
  assert.equal(candidates.size, all.size - tech.length);
  assert.deepEqual(new Set(keepMids(res.results, decisions)), new Set(tech));
  await classify.saveDecision("tech", DECISION.UNDECIDED);
  assert.equal((await classify.loadDecisions()).tech, undefined, "取消决策要真的删掉");
  assert.equal(new Set(candidateMids(res.results, await classify.loadDecisions())).size, all.size);
});