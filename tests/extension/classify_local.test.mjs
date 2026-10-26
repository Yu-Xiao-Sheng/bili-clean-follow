// 离线分类（classifyLocal.js）验收：零外发 + 低置信不硬塞（FOR-64 验收 4）。
//
// fixture 与 Python 侧「真实接口形状」验收同一个（tests/fixture-bili-real-list.json）：
// 20 条真实形状数据，含空简介、认证媒体、emoji 昵称。别用假数据自证。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeFollowItem } from "../../extension/biliApi.js";
import {
  LOCAL_MAX_CONFIDENCE,
  bucketByConfidence,
  classifyLocalBatch,
  classifyLocally,
} from "../../extension/classifyLocal.js";
import {
  LOW_CONFIDENCE,
  OTHER_CATEGORY,
  UNSURE_CATEGORY,
  categoryName,
  defaultTaxonomy,
} from "../../extension/taxonomy.js";
import { categorySummary } from "../../extension/classify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixture-bili-real-list.json"), "utf8"));
const TAX = defaultTaxonomy();
const ITEMS = FIXTURE.data.list.map((row) => normalizeFollowItem(row)).filter(Boolean);
const NOW = Date.UTC(2026, 9, 26);

test("离线分类全程零外发：fetch / XHR / WebSocket 一次都没碰", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("离线分类不该发请求");
  };
  try {
    classifyLocalBatch(ITEMS, TAX, { now: NOW });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0, "离线路径发出了请求");
  const src = fs.readFileSync(path.join(ROOT, "extension", "classifyLocal.js"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const banned of ["fetch(", "XMLHttpRequest", "WebSocket", "import("]) {
    assert.ok(!src.includes(banned), "classifyLocal.js 里出现了网络原语：" + banned);
  }
});

test("fixture 上有信号的条目分类正确（认证媒体 / 简介命中关键词）", () => {
  const byMid = new Map(classifyLocalBatch(ITEMS, TAX, { now: NOW }).map((r) => [r.mid, r]));
  assert.equal(byMid.get("22000").category, "news", "人民日报（认证：知名科技媒体 + 简介含媒体）应进资讯时事");
  assert.equal(byMid.get("22001").category, "news", "央视新闻（昵称+简介含新闻/电视台）应进资讯时事");
  assert.equal(byMid.get("22005").category, "knowledge", "罗翔说刑法（简介：中国政法大学教授）应进知识教育");
  assert.equal(byMid.get("22009").category, "food", "绵羊料理（昵称给出美食方向 + 命中料理）应进美食");
  assert.equal(byMid.get("22018").category, "life", "日常小确幸（简介：分享日常）应进生活日常");
  for (const mid of ["22000", "22005", "22009"]) {
    assert.ok(byMid.get(mid).confidence >= LOW_CONFIDENCE, mid + " 应当高到能落类");
  }
});

test("没任何信号（简介为空 + 昵称无方向）进「其他」并写清原因，而不是硬塞", () => {
  const res = classifyLocalBatch(ITEMS, TAX, { now: NOW });
  const empty = ["22002", "22006", "22007", "22012", "22013", "22019"].map((mid) =>
    res.find((r) => r.mid === mid));
  for (const r of empty) {
    assert.ok(r, "fixture 缺条目");
    assert.equal(r.category, OTHER_CATEGORY, r.mid + " 没有信号，必须落「其他」");
    assert.ok(r.confidence <= 0.3, r.mid + " 置信度不能虚高");
    assert.match(r.reason, /无法判断/);
  }
});

test("只有一个弱命中时进「待确认」，并保留命中的词给用户看", () => {
  const one = classifyLocally(
    { mid: "90001", nickname: "某UP主", bio: "硬核科技测评", verified: false },
    TAX, { now: NOW });
  assert.equal(one.category, UNSURE_CATEGORY, "单条弱命中不足以定类：" + one.confidence);
  assert.ok(one.confidence < LOW_CONFIDENCE);
  assert.match(one.reason, /科技/);

  const strong = classifyLocally(
    { mid: "90002", nickname: "科技数码评测", bio: "手机数码评测与硬件拆解", verified: false },
    TAX, { now: NOW });
  assert.equal(strong.category, "tech");
  assert.ok(strong.confidence >= LOW_CONFIDENCE);
});

test("reason 一律 <= 40 字中文（验收口径）", () => {
  for (const r of classifyLocalBatch(ITEMS, TAX, { now: NOW })) {
    assert.ok(r.reason && r.reason.length > 0, r.mid + " reason 不能为空");
    assert.ok(r.reason.length <= 40, r.mid + " reason 超长：" + r.reason.length + " " + r.reason);
  }
});

test("离线路径置信度有天花板：0.68 封顶，不装 AI 的把握", () => {
  const fake = { mid: "90003", nickname: "科技数码", bio: "科技 数码 手机 评测 硬件 电脑 极客", verified: true, official: "知名科技媒体" };
  const r = classifyLocally(fake, TAX, { now: NOW });
  assert.ok(r.confidence <= LOCAL_MAX_CONFIDENCE, "离线上限 " + LOCAL_MAX_CONFIDENCE);
  assert.ok(LOCAL_MAX_CONFIDENCE < 0.7, "上限必须明显低于 1：UI 据此标「离线粗分类」");
});

test("低置信判据统一：0.54 进待确认，0.55 留下", () => {
  assert.equal(bucketByConfidence({ category: "tech", confidence: 0.54 }), UNSURE_CATEGORY);
  assert.equal(bucketByConfidence({ category: "tech", confidence: LOW_CONFIDENCE }), "tech");
  assert.equal(bucketByConfidence({ category: "tech", confidence: undefined }), UNSURE_CATEGORY);
});

test("每类数量与占比：加总等于总条数，占比加总 ~100%", () => {
  const res = classifyLocalBatch(ITEMS, TAX, { now: NOW });
  const rows = categorySummary(res, TAX);
  const sum = rows.reduce((acc, r) => acc + r.count, 0);
  assert.equal(sum, res.length);
  const ratio = rows.reduce((acc, r) => acc + r.ratio, 0);
  assert.ok(Math.abs(ratio - 100) < 0.2, "占比加总 " + ratio);
  const unsure = rows.find((r) => r.categoryId === UNSURE_CATEGORY);
  if (unsure) assert.equal(unsure.name, categoryName(TAX, UNSURE_CATEGORY));
});

test("用户改名/加自定义类之后，离线路径按新体系分类", async () => {
  const { addCategory, renameCategory, defaultTaxonomy: fresh } = await import("../../extension/taxonomy.js");
  const tax = fresh();
  assert.ok(renameCategory(tax, "tech", "硬件与软件").ok);
  assert.ok(addCategory(tax, { name: "手工DIY", keywords: ["手工", "机械", "改造"] }).ok);
  const res = classifyLocalBatch([{ mid: "90004", nickname: "手工耿", bio: "手工耿的发明改造车间", verified: false }], tax, { now: NOW });
  const hit = tax.find((c) => c.name === "手工DIY");
  assert.equal(res[0].category, hit.id, "自定义类必须参与匹配");
  assert.equal(categoryName(tax, res[0].category), "手工DIY");
});