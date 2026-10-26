// 意图操作栈与「回滚最近一步」（FOR-65 验收 4）。
// 回滚必须能撤销两类改动：类别决策（keep/candidates/only）与 move 改过的单条类别。

import assert from "node:assert/strict";
import test from "node:test";

import { OP_STACK_KEY, OP_STACK_MAX, clearOps, loadOps, opStackLines, pushOp, rollbackLast } from "../../extension/intentStack.js";
import { DECISION, createClassifyStore } from "../../extension/classify.js";
import { applyIntents, parseIntentLocal } from "../../extension/intent.js";
import { UNSURE_CATEGORY, defaultTaxonomy } from "../../extension/taxonomy.js";
import { memoryStorage } from "../../extension/store.js";

const TAX = defaultTaxonomy();
const RESULTS = [
  { mid: "5001", category: "funny", confidence: 0.8 },
  { mid: "5002", category: "film", confidence: 0.9 },
  { mid: "5003", category: "game", confidence: 0.7 },
];

function harness() {
  const storage = memoryStorage();
  const classifyStore = createClassifyStore({ storage });
  return { storage, classifyStore };
}

async function applyAndPush({ storage, classifyStore }, text, results = RESULTS) {
  const decisions = await classifyStore.loadDecisions();
  const intents = parseIntentLocal(text, TAX).intents;
  const applied = applyIntents({ intents, results, decisions, taxonomy: TAX });
  await classifyStore.saveResults(applied.results);
  await classifyStore.saveDecisions(applied.decisions);
  const entry = await pushOp(storage, {
    intents,
    summary: [text],
    before: applied.before,
    after: applied.after,
    previewHash: "pv00000000",
    now: () => Date.now(),
  });
  return entry;
}

test("keep/candidates 这一步能整步撤销：回滚后决策回到执行前", async () => {
  const h = harness();
  await applyAndPush(h, "保留所有游戏区的，把搞笑段子和影视解说都清掉");
  let decisions = await h.classifyStore.loadDecisions();
  assert.equal(decisions.game, DECISION.KEEP);
  assert.equal(decisions.funny, DECISION.CANDIDATE);
  assert.equal(decisions.film, DECISION.CANDIDATE);

  const res = await rollbackLast(h.storage, { classifyStore: h.classifyStore });
  assert.equal(res.ok, true);
  decisions = await h.classifyStore.loadDecisions();
  assert.deepEqual(decisions, {}, "回滚要撤销这一步动过的每一个类别");
  assert.equal((await loadOps(h.storage)).length, 0, "回滚一次栈里就少一步");
});

test("move 这一步能撤销：单条结果回到原来的类别", async () => {
  const h = harness();
  await applyAndPush(h, "把搞笑段子里的影视解说移到影视综艺", [
    { mid: "5001", category: "funny", confidence: 0.8 },
    { mid: "5002", category: "game", confidence: 0.9 },
  ]);
  let results = await h.classifyStore.loadResults();
  assert.equal(results.find((r) => r.mid === "5001").category, "film", "move 生效：搞笑段子里的人落到影视综艺");
  assert.equal(results.find((r) => r.mid === "5002").category, "game", "不是这一步动的人不该被动");

  await rollbackLast(h.storage, { classifyStore: h.classifyStore });
  results = await h.classifyStore.loadResults();
  assert.equal(results.find((r) => r.mid === "5001").category, "funny", "move 撤销要按 mid 还原");
  assert.equal(results.find((r) => r.mid === "5002").category, "game");
});

test("两步操作按 LIFO 回滚：只撤销最近那一步，前一步的效果留着", async () => {
  const h = harness();
  await applyAndPush(h, "保留游戏电竞");
  await applyAndPush(h, "把搞笑段子清掉");
  assert.equal((await loadOps(h.storage)).length, 2);

  await rollbackLast(h.storage, { classifyStore: h.classifyStore });
  let decisions = await h.classifyStore.loadDecisions();
  assert.equal(decisions.game, DECISION.KEEP, "上一步的「保留游戏」不该被这次回滚抹掉");
  assert.ok(!decisions.funny, "最近一步（搞笑段子进候选）被撤销");

  await rollbackLast(h.storage, { classifyStore: h.classifyStore });
  decisions = await h.classifyStore.loadDecisions();
  assert.deepEqual(decisions, {});
});

test("回滚只撤销这一步动过的类别：用户后来手工改的其它类别不受影响", async () => {
  const h = harness();
  await applyAndPush(h, "把搞笑段子清掉");
  await h.classifyStore.saveDecision("music", DECISION.KEEP); // 用户手工改的，跟这一步无关
  await rollbackLast(h.storage, { classifyStore: h.classifyStore });
  const decisions = await h.classifyStore.loadDecisions();
  assert.equal(decisions.music, DECISION.KEEP, "回滚不该顺手把别的类别也抹掉");
  assert.ok(!decisions.funny);
});

test("没得回滚时说清楚：empty_stack，不是报错也不是静默成功", async () => {
  const h = harness();
  const res = await rollbackLast(h.storage, { classifyStore: h.classifyStore });
  assert.equal(res.ok, false);
  assert.equal(res.kind, "empty_stack");
  assert.ok(res.label.includes("没有可回滚"));
});

test("操作栈落 storage：换一个 store 实例（面板关掉再开）也读得到，能继续回滚", async () => {
  const h = harness();
  await applyAndPush(h, "把搞笑段子清掉");
  const reopened = createClassifyStore({ storage: h.storage });
  const ops = await loadOps(h.storage);
  assert.equal(ops.length, 1);
  assert.deepEqual(opStackLines(ops)[0].summary, "把搞笑段子清掉");
  const res = await rollbackLast(h.storage, { classifyStore: reopened });
  assert.equal(res.ok, true);
  assert.deepEqual(await reopened.loadDecisions(), {});
  await clearOps(h.storage);
  assert.equal((await loadOps(h.storage)).length, 0);
  assert.ok(OP_STACK_KEY.length > 0);
});

test("栈有上限：只留最近 OP_STACK_MAX 步，防止 812 人的列表把 storage 撑爆", async () => {
  const storage = memoryStorage();
  const classifyStore = createClassifyStore({ storage });
  for (let i = 0; i < OP_STACK_MAX + 10; i += 1) {
    await pushOp(storage, {
      intents: [{ op: "keep", categories: ["game"] }],
      summary: ["第" + i + "步"],
      before: { decisions: {}, moved: [] },
      after: { decisions: { game: DECISION.KEEP }, moved: [] },
      now: () => 1000 + i,
    });
  }
  const ops = await loadOps(storage);
  assert.equal(ops.length, OP_STACK_MAX);
  assert.equal(ops[ops.length - 1].summary[0], "第" + (OP_STACK_MAX + 9) + "步", "留下的必须是最近的几步");
});

test("回滚「只看X」这种一步改了很多类决策的操作", async () => {
  const h = harness();
  await h.classifyStore.saveResults(RESULTS.map((r) => ({ ...r })));
  await applyAndPush(h, "只看科技数码");
  let decisions = await h.classifyStore.loadDecisions();
  assert.equal(decisions.tech, DECISION.KEEP);
  assert.equal(decisions.funny, DECISION.CANDIDATE);
  assert.equal(decisions.film, DECISION.CANDIDATE);
  assert.equal(decisions.game, DECISION.CANDIDATE);
  await rollbackLast(h.storage, { classifyStore: h.classifyStore });
  decisions = await h.classifyStore.loadDecisions();
  assert.deepEqual(decisions, {}, "「只看」这一步要能一步全部撤回");
  const results = await h.classifyStore.loadResults();
  assert.deepEqual(results.map((r) => r.category), ["funny", "film", "game"], "只看不动本地类别");
});