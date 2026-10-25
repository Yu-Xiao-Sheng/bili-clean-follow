// 真形状夹具 × mock LLM（FOR-64 验收「fixture 上 mock LLM 返回可控，分类结果可断言」）。
//
// 为什么单独一条：classify_gate / classify_llm 用的是合成条目（数量与错误形状好控制），
// classify_local 用的是 tests/fixture-bili-real-list.json（真实 B站返回形状）。
// 验收写的是「同口径夹具」，所以这里把那份夹具灌进 runClassification(llm)：
// mock 端点按**发出去的**昵称/简介/认证文案决定返回值——可控、可复算、不发网络。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeFollowItem } from "../../extension/biliApi.js";
import { createStore, memoryStorage } from "../../extension/store.js";
import {
  DECISION, MODE, candidateMids, categorySummary, createClassifyStore, keepMids, runClassification,
} from "../../extension/classify.js";
import { OTHER_CATEGORY, UNSURE_CATEGORY, defaultTaxonomy } from "../../extension/taxonomy.js";
import { makeConsent } from "../../extension/classifyLlm.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const BASE_URL = "https://api.example-llm.test/v1";
const API_KEY = "sk-TESTKEYabcdefghijkl1234";

// 与 Python 侧「真实接口形状」同一个夹具：20 条，含认证媒体、空简介、emoji 昵称。
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixture-bili-real-list.json"), "utf8"));
const ITEMS = FIXTURE.data.list.map((row) => normalizeFollowItem(row)).filter(Boolean);
assert.equal(ITEMS.length, 20, "夹具必须是 20 条，不然下面的数字没有意义");

function mockFetch(decide) {
  const calls = [];
  const fn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const rows = JSON.parse(body.messages[body.messages.length - 1].content).rows;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: rows.map(decide) }) } }],
        });
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** mock 的判定规则写死在这里，可复算：认证媒体 → 资讯时事；科技测评 → 科技数码；其余证据不足（0.4）。 */
function decide(row) {
  const text = [row.nickname, row.bio, row.official].filter(Boolean).join(" ");
  const base = { ref: row.ref, reason: "依据昵称与简介里的关键词" };
  if (/(媒体|新闻|总台|日报)/.test(text)) return { ...base, category: "资讯时事", confidence: 0.9 };
  if (/(科技|测评|硬核)/.test(text)) return { ...base, category: "科技数码", confidence: 0.86 };
  return { ...base, category: "搞笑段子", confidence: 0.4 };
}

async function harness() {
  const storage = memoryStorage();
  const scan = createStore({ storage });
  const classify = createClassifyStore({ storage });
  const state = await scan.saveState({
    status: "complete", mid: "12345", total: ITEMS.length, fetched: ITEMS.length,
    pages: Math.ceil(ITEMS.length / 20), ps: 20,
  });
  await scan.replaceItems(ITEMS);
  return { storage, scan, classify, state };
}

async function runLlm({ classify, scan, state }, fetchImpl) {
  await classify.saveApiKey(API_KEY);
  return runClassification({
    scanStore: scan, classifyStore: classify, state, items: ITEMS, taxonomy: defaultTaxonomy(),
    llm: true, config: { baseUrl: BASE_URL, model: "m", sendBio: true },
    apiKey: await classify.loadApiKey(),
    consent: makeConsent({ baseUrl: BASE_URL, sendBio: true, count: ITEMS.length }),
    fetchImpl, minIntervalMs: 0,
  });
}

test("真形状夹具走 AI：20 条一批跑完，结果按夹具 mid 逐条可断言", async () => {
  const ctx = await harness();
  const res = await runLlm(ctx, mockFetch(decide));

  assert.equal(res.meta.mode, MODE.LLM);
  assert.equal(res.meta.requests, 1, "20 条不到一批 40，只该发一次");
  assert.equal(res.results.length, ITEMS.length, "每条都要有结果，并按夹具 mid 回绑");

  const byMid = new Map(res.results.map((r) => [String(r.mid), r]));
  for (const mid of ["22000", "22001", "22004", "22017"]) { // 人民日报 / 央视新闻 / 影视飓风 / AI科技评论
    assert.equal(byMid.get(mid).category, "news", mid + " 该落资讯时事：" + byMid.get(mid).rawCategory);
    assert.ok(byMid.get(mid).confidence >= 0.55);
  }
  assert.equal(byMid.get("22011").category, "tech"); // 技术蛋老师 / 硬核科技测评
  for (const mid of ["22002", "22019"]) { // 老番茄（空简介）与 emoji 昵称：0.4 一律进待确认
    assert.equal(byMid.get(mid).category, UNSURE_CATEGORY, mid + " 不该被硬塞进任何类");
    assert.equal(byMid.get(mid).movedToUnsure, true, "要能追溯它本来像哪一类");
    assert.equal(byMid.get(mid).rawCategory, "funny");
  }

  const summary = categorySummary(res.results, defaultTaxonomy());
  const news = summary.find((row) => row.categoryId === "news");
  assert.equal(news.count, 4);
  assert.equal(news.ratio, 20, "占比按 20 条算：4/20 = 20%");
  assert.equal(news.name, "资讯时事");
  const unsure = summary.find((row) => row.categoryId === UNSURE_CATEGORY);
  assert.ok(unsure.count >= 13, "低置信条目都该在待确认里：" + unsure.count);
  assert.ok(!summary.some((row) => row.categoryId === "funny"), "被降级到待确认的条目不该还挂在 funny 上");
});

test("夹具走 AI 时外发仍然只有 ref + 昵称(+简介+认证文案)：mid、头像、Key 一个都不发", async () => {
  const ctx = await harness();
  const fetchImpl = mockFetch(decide);
  await runLlm(ctx, fetchImpl);
  const raw = JSON.stringify(fetchImpl.calls[0]);
  for (const item of ITEMS) {
    assert.ok(!raw.includes(String(item.mid)), "请求体里混进了 mid " + item.mid);
    assert.ok(!item.face || !raw.includes(item.face), "头像 URL 不许外发");
  }
  assert.ok(!raw.includes(API_KEY), "Key 只在请求头，不在请求体");
  const sent = JSON.parse(fetchImpl.calls[0].messages[fetchImpl.calls[0].messages.length - 1].content);
  assert.equal(sent.count, ITEMS.length, "载荷自报条数，模型必须按条回满");
  assert.equal(sent.rows.length, ITEMS.length);
  assert.equal(sent.rows[0].ref, "r1", "回绑靠批次内代号，不靠账号标识");
  for (const row of sent.rows) {
    assert.deepEqual(Object.keys(row).filter((k) => k !== "bio" && k !== "official").sort(), ["nickname", "ref"],
      "每条只准带 ref + 昵称（勾选时再加简介/认证文案）：" + JSON.stringify(row));
  }
});

test("同一夹具走离线：零网络（fetch 探针没被调用），认证媒体照样能落对（验收 4）", async () => {
  const ctx = await harness();
  let probed = 0;
  const guarded = (...args) => { probed += 1; return mockFetch(decide)(...args); };
  const res = await runClassification({
    scanStore: ctx.scan, classifyStore: ctx.classify, state: ctx.state, items: ITEMS,
    taxonomy: defaultTaxonomy(), llm: false, fetchImpl: guarded, minIntervalMs: 0,
  });
  assert.equal(probed, 0, "离线粗分类必须零外发");
  assert.equal(res.meta.requests, 0);
  assert.equal(res.results.length, ITEMS.length);
  const byMid = new Map(res.results.map((r) => [String(r.mid), r]));
  assert.equal(byMid.get("22000").category, "news", "官方认证媒体不靠模型也该落到资讯时事");
  assert.equal(byMid.get("22001").category, "news");
  assert.equal(byMid.get("22002").category, UNSURE_CATEGORY, "空简介无认证：离线规则也不该硬塞");
  assert.ok(byMid.get("22011").category === "tech" || byMid.get("22011").category === UNSURE_CATEGORY,
    "「技术蛋老师/硬核科技测评」在离线词表下要么落科技、要么并列进待确认，不能落到别的类");
});

test("勾完「保留 / 进候选」：keep 类永不进候选；待确认目前仍会进（FOR-65 必须再拦一道）", async () => {
  const ctx = await harness();
  await runLlm(ctx, mockFetch(decide));
  await ctx.classify.saveDecision("news", DECISION.KEEP);
  await ctx.classify.saveDecision("tech", DECISION.CANDIDATE);
  const decisions = await ctx.classify.loadDecisions();
  const results = await ctx.classify.loadResults();

  const kept = keepMids(results, decisions).map(String).sort();
  assert.deepEqual(kept, ["22000", "22001", "22004", "22017"].sort());
  const candidates = candidateMids(results, decisions).map(String);
  for (const mid of kept) {
    assert.ok(!candidates.includes(mid), "被勾成「保留」的类里，一个人都不许进候选：" + mid);
  }
  assert.ok(candidates.includes("22011"), "勾了进候选的类要在清单里");
  // 钉住现状（不是认可它）：candidateMids 是「排除 keep」的语义，所以待确认条目也在清单里。
  // FOR-65 的 diff 预览与执行器必须在这之前先挡掉「待确认」，否则低置信会被误清 ——
  // 这条断言就是留给 FOR-65 的显式契约，改语义时这里会红，而不是让坑静默。
  assert.ok(candidates.includes("22002"), "待确认条目目前会进候选：FOR-65 必须显式排除");
});
