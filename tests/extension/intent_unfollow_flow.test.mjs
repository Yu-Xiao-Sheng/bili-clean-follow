// 端到端（mock 传输层）：一句话 -> 意图 -> diff 预览 -> 应用 -> 取关预览 -> 武装 -> 执行 -> 审计 -> 回滚。
//
// 这条链是 FOR-65 验收的整体验证：单独测护栏还不够，还要证明「按用户说的做、并且只做那些」。
// 真实登录态下的 B站联调归 FOR-67（v2-spec §5 的三轨 E2E），这里只走注入的 mock transport。

import assert from "node:assert/strict";
import test from "node:test";

import { applyIntents, parseIntentLocal } from "../../extension/intent.js";
import { buildIntentPreview, buildUnfollowPreview, armPreview } from "../../extension/preview.js";
import { pushOp, rollbackLast } from "../../extension/intentStack.js";
import {
  CONFIRM_TOKEN, RISK_NOTICE_VERSION, executeUnfollow, loadAudit, loadManifests,
  loadWriteSwitch, makeRiskAck, setWriteSwitch, toAuditCsv, toManifestText,
} from "../../extension/unfollow.js";
import { DECISION, createClassifyStore } from "../../extension/classify.js";
import { UNSURE_CATEGORY, defaultTaxonomy } from "../../extension/taxonomy.js";
import { createStore, memoryStorage } from "../../extension/store.js";

const TAX = defaultTaxonomy();

function corpus() {
  const items = [];
  const results = [];
  const plan = [
    ["funny", 8], ["film", 6], ["game", 5], [UNSURE_CATEGORY, 4], ["tech", 3],
  ];
  let n = 0;
  for (const [category, count] of plan) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const mid = String(60000 + n);
      const nickname = category === UNSURE_CATEGORY ? "看不清是谁" + i : (category === "funny" ? "搞笑Up" + i : category + "Up" + i);
      items.push({ mid, nickname, bio: category === UNSURE_CATEGORY ? "" : "简介" + category });
      results.push({
        mid,
        category,
        confidence: category === UNSURE_CATEGORY ? 0.35 : 0.72,
        label: "AI 分类（BYOK）",
      });
    }
  }
  return { items, results };
}

function mockTransport(script = {}) {
  const calls = [];
  const fn = async ({ op, mid }) => {
    calls.push({ op, mid });
    const rule = script[mid];
    if (rule) return typeof rule === "function" ? rule() : rule;
    return { httpStatus: 200, payload: { code: 0, message: "0" }, rawText: "" };
  };
  fn.calls = calls;
  return fn;
}

test("一句话指令 -> 意图 -> 预览 -> 应用：keep 类锁死，待确认不参与，且没有任何写操作发生", async () => {
  const storage = memoryStorage();
  const scan = createStore({ storage });
  const bucket = createClassifyStore({ storage });
  const { items, results } = corpus();
  await scan.replaceItems(items);
  await scan.saveState({ status: "complete", total: items.length, fetched: items.length, mid: "99999" });
  await bucket.saveResults(results);

  const intents = parseIntentLocal("保留所有游戏区的，把搞笑段子和影视解说都清掉", TAX).intents;
  const preview = buildIntentPreview({
    intents, items, results, decisions: {}, taxonomy: TAX,
    state: await scan.getState(),
  });
  assert.equal(preview.willWrite, false);
  // 「影响」是所有意图动到的人：保留 5 人 + 进取关候选 14 人
  assert.equal(preview.affected, 5 + 8 + 6);
  const perIntent = new Map(preview.intents.map((i) => [i.op, i.affected]));
  assert.equal(perIntent.get("keep"), 5, "keep 这条影响的是游戏电竞 5 人（他们被锁进白名单）");
  assert.equal(perIntent.get("candidates"), 14, "清掉这条影响 8 + 6 人");
  assert.equal(preview.unfollowCandidatesAfter, 14, "应用之后真正可取关的是这 14 人：待确认、game、没表态的 tech 都不算");

  const applied = applyIntents({ intents, results, decisions: {}, taxonomy: TAX });
  await bucket.saveDecisions(applied.decisions);
  await pushOp(storage, {
    intents, summary: ["保留所有游戏区的，把搞笑段子和影视解说都清掉"],
    before: applied.before, after: applied.after, previewHash: preview.hash, now: () => Date.now(),
  });
  const decisions = await bucket.loadDecisions();
  assert.equal(decisions.game, DECISION.KEEP);
  assert.equal(decisions.funny, DECISION.CANDIDATE);
  assert.equal(decisions.film, DECISION.CANDIDATE);
  assert.ok(!decisions[UNSURE_CATEGORY], "待确认不参与批量决策");
  assert.equal((await loadWriteSwitch(storage)).enabled, false, "到这一步为止取关仍是关闭状态：应用意图不是武装");
});

test("取关预览 -> 武装 -> 执行：只清「点了进候选且证据够」的人，审计与清单齐全", async () => {
  const storage = memoryStorage();
  const scan = createStore({ storage });
  const bucket = createClassifyStore({ storage });
  const { items, results } = corpus();
  await scan.replaceItems(items);
  await scan.saveState({ status: "complete", total: items.length, fetched: items.length, mid: "99999" });
  await bucket.saveResults(results);
  const intents = parseIntentLocal("保留所有游戏区的，把搞笑段子和影视解说都清掉", TAX).intents;
  const applied = applyIntents({ intents, results, decisions: {}, taxonomy: TAX });
  await bucket.saveDecisions(applied.decisions);
  // 操作栈要有这一步，否则「回滚最近一步」无从回滚（test 1 里是同一句话）
  await pushOp(storage, {
    intents, summary: ["保留所有游戏区的，把搞笑段子和影视解说都清掉"],
    before: applied.before, after: applied.after, previewHash: null, now: () => Date.now(),
  });
  await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) });

  const preview = buildUnfollowPreview({
    items, results: applied.results, decisions: applied.decisions, taxonomy: TAX, selfMid: "99999",
  });
  assert.equal(preview.affected, 14, "8 + 6：待确认、低置信、game、tech（没表态）都不在内");
  const mids = new Set(preview.items.map((i) => i.mid));
  for (const row of applied.results) {
    if (row.category === UNSURE_CATEGORY || row.category === "game" || row.category === "tech") {
      assert.ok(!mids.has(row.mid), row.category + " 的人不该在候选里：" + row.mid);
    }
  }
  await armPreview(storage, preview, { now: Date.now() });

  const transport = mockTransport({ [preview.items[3].mid]: () => ({ httpStatus: 200, payload: { code: -509, message: "对方不存在" }, rawText: "" }) });
  const res = await executeUnfollow({
    storage, preview, confirmation: { token: CONFIRM_TOKEN, previewShown: true },
    results: applied.results, decisions: applied.decisions, selfMid: "99999",
    transport, sleep: async () => {},
  });
  assert.equal(res.attempted, 14);
  assert.equal(transport.calls.length, 14);
  assert.equal(transport.calls.every((c) => c.op === "unfollow"), true);
  assert.equal(res.ok_count, 13);
  assert.equal(res.failed, 1);

  const audit = await loadAudit(storage);
  assert.equal(audit.filter((e) => e.action === "unfollow").length, 14, "每条成功/失败都要在审计里");
  const csv = toAuditCsv(audit);
  assert.ok(csv.startsWith(""));
  assert.ok(csv.split("\r\n").length >= 15);
  const manifests = await loadManifests(storage);
  assert.equal(manifests.length, 1);
  const text = toManifestText(manifests[0]);
  assert.equal(text.split("\n").length, 4 + 14, "清单要带 4 行抬头 + 每一行的人");
  assert.ok(text.includes("FAILED"), "清单里要能看出谁没成功");

  // 回滚这一步意图：候选清空，再执行就是 empty_plan
  const back = await rollbackLast(storage, { classifyStore: bucket });
  assert.equal(back.ok, true);
  assert.deepEqual(await bucket.loadDecisions(), {});
  const after = buildUnfollowPreview({ items, results, decisions: await bucket.loadDecisions(), taxonomy: TAX });
  assert.equal(after.affected, 0, "回滚之后没有任何人处于「进候选」状态：取关范围归零");
  await armPreview(storage, after, { now: Date.now() });
  const cleared = await bucket.loadDecisions();
  await assert.rejects(
    () => executeUnfollow({
      storage, preview: after, confirmation: { token: CONFIRM_TOKEN, previewShown: true },
      results, decisions: cleared, transport: mockTransport(), sleep: async () => {},
    }),
    (err) => err.kind === "empty_plan",
  );
});

test("预览之后有人被改回 keep：执行时按当前数据重算，不发那个人，并把差异写进审计", async () => {
  const storage = memoryStorage();
  const bucket = createClassifyStore({ storage });
  const { items, results } = corpus();
  await bucket.saveResults(results);
  const decisions = { funny: DECISION.CANDIDATE, film: DECISION.CANDIDATE };
  await bucket.saveDecisions(decisions);
  await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) });

  const preview = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX });
  await armPreview(storage, preview, { now: Date.now() });

  // 用户反悔：搞笑段子整类改回保留
  await bucket.saveDecisions({ funny: DECISION.KEEP, film: DECISION.CANDIDATE });
  const transport = mockTransport();
  const res = await executeUnfollow({
    storage, preview, confirmation: { token: CONFIRM_TOKEN, previewShown: true },
    results, decisions: await bucket.loadDecisions(), transport, sleep: async () => {},
  });
  assert.equal(res.attempted, 6, "只剩影视综艺那 6 个人");
  assert.equal(res.droppedFromPreview, 8, "预览里有的人现在不能动，要报告出来");
  assert.ok(transport.calls.every((c) => !results.filter((r) => r.category === "funny").some((r) => r.mid === c.mid)));
  const audit = await loadAudit(storage);
  assert.ok(audit.some((e) => e.action === "dropped_from_preview" && e.count === 8));
});