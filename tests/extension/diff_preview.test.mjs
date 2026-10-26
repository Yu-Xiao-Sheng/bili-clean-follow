// diff 预览与安全候选（FOR-65 验收 2 + FOR-64 交接里那条硬约束）。
//
// 交接原文：classify.candidateMids() 的语义是「排除勾了保留的类」，不是「只取高置信」，
// 所以「待确认」的人会出现在候选里。取关不可逆，预览与执行器必须先挡掉 ——
// 这里把这条契约钉成断言：candidateMids 里有 22002，safeCandidateMids 里必须没有。

import assert from "node:assert/strict";
import test from "node:test";

import {
  ARM_KEY,
  PREVIEW_NOTICE,
  armMatches,
  armPreview,
  buildIntentPreview,
  buildUnfollowPreview,
  clearArm,
  fingerprint,
  loadArm,
  safeCandidateMids,
} from "../../extension/preview.js";
import { DECISION, candidateMids, categorySummary } from "../../extension/classify.js";
import { LOW_CONFIDENCE, UNSURE_CATEGORY, defaultTaxonomy } from "../../extension/taxonomy.js";
import { parseIntentLocal } from "../../extension/intent.js";
import { CHECKPOINT_KEY, buildResumePreview } from "../../extension/unfollow.js";
import { createStore, memoryStorage } from "../../extension/store.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFollowItem } from "../../extension/biliApi.js";
import { classifyLocalBatch } from "../../extension/classifyLocal.js";

const TAX = defaultTaxonomy();

function corpus(count = 12) {
  const items = [];
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const mid = String(22000 + i);
    items.push({ mid, nickname: "UP主" + i, bio: i % 3 === 0 ? "影视解说十年老号" : "段子与整活" });
    const category = i < 5 ? "film" : i < 9 ? "funny" : UNSURE_CATEGORY;
    const confidence = category === UNSURE_CATEGORY ? 0.4 : 0.7 + (i % 3) * 0.05;
    results.push({ mid, category, confidence, label: "AI 分类（BYOK）", reason: "简介命中" });
  }
  // 一个「已分类但置信不够」的人：类别正经、置信 0.4，也必须挡住
  items.push({ mid: "23000", nickname: "证据不足的人", bio: "什么都看不出来" });
  results.push({ mid: "23000", category: "film", confidence: LOW_CONFIDENCE - 0.15, label: "离线粗分类" });
  // 一个完全没分类结果的人
  items.push({ mid: "23001", nickname: "还没分类的人", bio: "" });
  return { items, results };
}

test("意图预览：影响条数、按类分组、10 条样例（昵称+简介+置信度），且 willWrite 必须是 false", () => {
  const { items, results } = corpus(20);
  const intents = parseIntentLocal("把搞笑段子和影视综艺都清掉", TAX).intents;
  const preview = buildIntentPreview({ intents, items, results, decisions: {}, taxonomy: TAX, state: { mid: "999" } });

  assert.equal(preview.willWrite, false, "预览阶段绝不允许出现「要写」的标记");
  assert.ok(preview.notices.includes(PREVIEW_NOTICE), "预览要写明「不会立刻取关，只生成候选」");
  assert.ok(preview.affected > 0);

  // 分组数量与占比来自 categorySummary，不自己算
  const summary = categorySummary(results.filter((r) => preview.samples.some((s) => s.mid === r.mid)), TAX);
  assert.ok(Array.isArray(preview.byCategory) && preview.byCategory.length);
  for (const row of preview.byCategory) {
    assert.ok("name" in row && "count" in row && "ratio" in row, "汇总行字段沿用 categorySummary：" + Object.keys(row));
  }
  assert.ok(summary.length);

  assert.ok(preview.samples.length <= preview.sampleLimit, "样例最多 " + preview.sampleLimit + " 条");
  assert.equal(preview.samples.length, 10, "20 人受影响时要给满 10 条样例");
  for (const s of preview.samples) {
    assert.ok(s.nickname, "样例要有昵称");
    assert.ok(typeof s.bio === "string", "样例要有简介");
    assert.ok(Number.isFinite(s.confidence), "样例要有置信度");
  }
  assert.ok(preview.hash && preview.hash.startsWith("pv"), "预览要有内容指纹，供「确实看过」比对");
});

test("FOR-64 交接的硬约束：candidateMids 放行待确认，safeCandidateMids 必须挡掉（含低置信与 keep）", () => {
  const { results } = corpus(12); // 22009 起是 unsure(0.4)，23000 是 film 但置信 0.4
  const decisions = { film: DECISION.CANDIDATE, funny: DECISION.CANDIDATE };

  const loose = candidateMids(results, decisions).map(String);
  assert.ok(loose.includes("22009"), "classify.candidateMids 的行为没被我改：待确认仍在里面（FOR-64 钉过）");

  const safe = safeCandidateMids({ results, decisions });
  assert.ok(!safe.mids.includes("22009"), "待确认必须挡在取关候选之外");
  assert.ok(!safe.mids.includes("23000"), "类别正经但置信 < 0.55 的也要挡：证据不足不清洗");
  assert.ok(safe.blocked.unsure >= 1);
  assert.ok(safe.blocked.lowConfidence >= 1);

  // keep 类：一个人都不许进候选（护栏 e 的第一道）
  const kept = safeCandidateMids({ results, decisions: { film: DECISION.KEEP, funny: DECISION.CANDIDATE } });
  assert.ok(!kept.mids.some((mid) => results.find((r) => r.mid === mid)?.category === "film"));
  assert.ok(kept.blocked.keep >= 5, "keep 类要有计数，预览要显示被挡了多少人");

  // 自己的 mid 永不进候选
  const self = safeCandidateMids({ results, decisions, selfMid: "22000" });
  assert.ok(!self.mids.includes("22000"));
  assert.equal(self.blocked.self, 1);
});

test("写操作前的 diff 预览：只列安全候选，被挡的人按类别计数说明", () => {
  const { items, results } = corpus(12);
  const decisions = { film: DECISION.CANDIDATE, funny: DECISION.CANDIDATE };
  const preview = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX, limit: 50, selfMid: "999" });
  assert.equal(preview.kind, "unfollow");
  assert.equal(preview.willWrite, false, "预览本身仍然不是「要写」，写由执行器负责，而它先过护栏");
  const mids = preview.items.map((i) => i.mid);
  assert.ok(!mids.includes("22009") && !mids.includes("23000"));
  assert.ok(preview.notices.some((n) => n.includes("被挡在外面")));
  assert.ok(preview.affected === mids.length);
  assert.ok(preview.samples.length <= 10);
});

test("预览指纹：内容一致就稳定（忽略时间戳）；候选一变就变（旧武装自动作废）", () => {
  const { items, results } = corpus(12);
  const decisions = { film: DECISION.CANDIDATE };
  const a = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX, now: () => 1000 });
  const b = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX, now: () => 999999 });
  assert.equal(a.hash, b.hash, "同一份内容不同时间生成，指纹要一致，否则每次都要重看预览");

  const c = buildUnfollowPreview({ items, results, decisions: { film: DECISION.CANDIDATE, funny: DECISION.CANDIDATE }, taxonomy: TAX, now: () => 1000 });
  assert.notEqual(a.hash, c.hash, "候选范围变了就是另一份预览");

  const tampered = { ...a, items: [...a.items, { mid: "999999", nickname: "塞进来的", category: "film", confidence: 0.9 }] };
  assert.notEqual(fingerprint(tampered), a.hash, "预览内容被动过（比如塞人）指纹必须对不上");
});

test("「看过预览」的证据落 storage：带 TTL；过期 / 换预览 / 没看过 三种情况都要拒", async () => {
  const storage = memoryStorage();
  const { items, results } = corpus(12);
  const decisions = { film: DECISION.CANDIDATE, funny: DECISION.CANDIDATE };
  const preview = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX });

  assert.equal(await loadArm(storage), null, "没渲染过预览就没有武装记录");
  assert.equal(armMatches(null, preview).kind, "preview_required");

  const armed = await armPreview(storage, preview, { now: 1000, ttlMs: 5000 });
  assert.equal(armed.hash, preview.hash);
  assert.equal(armMatches(armed, preview, { now: 2000 }).ok, true);

  const stale = buildUnfollowPreview({ items, results, decisions: { film: DECISION.CANDIDATE }, taxonomy: TAX });
  assert.equal(armMatches(armed, stale, { now: 2000 }).kind, "preview_stale");

  assert.equal(armMatches(armed, preview, { now: 6001 }).kind, "preview_expired");

  await clearArm(storage);
  assert.equal(await loadArm(storage), null, "关掉取关开关 / 撤回确认时要顺手清掉武装记录");
  assert.ok(ARM_KEY.length > 0);
});

test("预览的分组数量与 ratio 来自 categorySummary（交接要求：别自己再算）", () => {
  const { items, results } = corpus(12);
  const decisions = { film: DECISION.CANDIDATE, funny: DECISION.CANDIDATE };
  const preview = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX });
  const film = preview.byCategory.find((r) => r.categoryId === "film");
  const funny = preview.byCategory.find((r) => r.categoryId === "funny");
  assert.equal(film.count, 5);
  assert.equal(funny.count, 4);
  assert.equal(film.name, "影视综艺", "显示名走 categorySummary，用户改过名也要跟着变");
  assert.ok(film.ratio > 0 && film.ratio <= 100);
});

test("断点续跑的预览只给剩下的人，指纹与原预览不同（不能共用一次「看过」）", async () => {
  const storage = memoryStorage();
  const { items, results } = corpus(12);
  const decisions = { film: DECISION.CANDIDATE, funny: DECISION.CANDIDATE };
  await storage.set({ [CHECKPOINT_KEY]: { manifestId: "mf1", remaining: ["22005", "22006"], reason: "risk_control", at: 1 } });
  const res = await buildResumePreview({ items, results, decisions, taxonomy: TAX, storage });
  assert.equal(res.ok, true);
  assert.deepEqual(res.preview.items.map((i) => i.mid), ["22005", "22006"]);
  const whole = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX });
  assert.notEqual(res.preview.hash, whole.hash, "剩下的 2 人是另一份预览，得重新看一遍才能执行");
  // 待确认 / 低置信即使在断点里，也照样被安全过滤挡掉
  const risky = await buildResumePreview({
    items, results, decisions, taxonomy: TAX, storage,
  });
  assert.ok(!risky.preview.items.some((i) => i.mid === "22009"));
  assert.ok(createStore);
});

// --- 交付口径追加验收（CEO 在 FOR-64 收口后钉的）：交付报告必须给两个数 ——
// 「待确认条目数」与「实际进入 diff 的条目数」。这里把它钉成可复算的断言，
// 夹具与 Python 侧「真实接口形状」同一份（tests/fixture-bili-real-list.json，20 条真实形状数据），
// 分类走离线规则（确定性、零外发），所以任何人 checkout 后都能把这两个数复算出来。
test("真实形状夹具上的两个数：待确认 6 条被挡在外面，真正进入取关 diff 的是 8 条", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(path.join(here, "..", "fixture-bili-real-list.json"), "utf8"));
  const items = fixture.data.list.map((row) => normalizeFollowItem(row)).filter(Boolean);
  assert.equal(items.length, 20, "夹具必须是 20 条，否则这两个数没有意义");
  const results = classifyLocalBatch(items, TAX, { now: Date.UTC(2026, 9, 26) });
  const unsure = results.filter((r) => r.category === UNSURE_CATEGORY).length;
  assert.equal(unsure, 6, "待确认条目数（证据不足 -> unsure）");

  // 最激进的情形：把所有非「待确认」的类统统勾成「进候选」
  const decisions = {};
  for (const row of categorySummary(results, TAX)) {
    if (!row.isUnsure) decisions[row.categoryId] = DECISION.CANDIDATE;
  }
  const preview = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX, selfMid: "0" });
  assert.equal(preview.affected, 8, "实际进入取关 diff 的条目数");
  assert.equal(preview.excluded.unsure, unsure, "待确认一条都不许进 diff（CEO 追加口径）");
  assert.equal(preview.excluded.lowConfidence, 6, "离线规则只给 0.2 的类同样被置信闸（0.55）挡掉");
  assert.equal(preview.excluded.keep, 0);
  assert.equal(preview.excluded.notOptedIn, 0);
  assert.equal(preview.affected + preview.excluded.unsure + preview.excluded.lowConfidence +
    preview.excluded.keep + preview.excluded.notOptedIn + preview.excluded.uncategorized, 20,
    "进入 + 被挡 = 全量：谁不会被取关，必须能对账");
  assert.ok(preview.samples.length <= 10, "样例最多 10 条（验收 2）");

  // 一个类都没表态时 diff 必须是空的：不表态 != 默认交出来
  assert.equal(buildUnfollowPreview({ items, results, decisions: {}, taxonomy: TAX, selfMid: "0" }).affected, 0);
  // 全部勾「保留」时也是空的（白名单硬约束，护栏 e）
  const allKeep = {};
  for (const row of categorySummary(results, TAX)) {
    if (!row.isUnsure) allKeep[row.categoryId] = DECISION.KEEP; // 连「进候选」都没勾的类也一并勾保留
  }
  const kept = buildUnfollowPreview({ items, results, decisions: allKeep, taxonomy: TAX, selfMid: "0" });
  assert.equal(kept.affected, 0);
  assert.equal(kept.excluded.keep, 14, "20 - 6 待确认 = 14 人全部落在 keep 白名单里（护栏 e）");
  assert.equal(kept.excluded.unsure, 6, "待确认即使没被勾保留，也照样进不了 diff");
});

