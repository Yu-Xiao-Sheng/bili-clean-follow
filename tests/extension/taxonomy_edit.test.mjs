// 12 类体系与「用户可增删改名」（FOR-64 验收 1）+ 体系落 chrome.storage.local 的往返。

import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_LOCKED,
  LOW_CONFIDENCE,
  OTHER_CATEGORY,
  PRESET_TAXONOMY,
  TAXONOMY_KEY,
  UNSURE_CATEGORY,
  addCategory,
  categoryName,
  defaultTaxonomy,
  find,
  matchKeywords,
  normalizeTaxonomy,
  removeCategory,
  renameCategory,
  resolveCategoryRef,
  resolveCategoryRefs,
  setCategoryKeywords,
} from "../../extension/taxonomy.js";
import { createClassifyStore } from "../../extension/classify.js";
import { memoryStorage } from "../../extension/store.js";

test("预置 12 类 + 「其他」兜底 + 「待确认」低置信桶（阈值 0.55）", () => {
  const named = PRESET_TAXONOMY.filter((c) => c.id !== OTHER_CATEGORY);
  assert.equal(named.length, 12, "预置内容类别必须是 12 类，实际 " + named.length);
  assert.deepEqual(named.map((c) => c.name), [
    "科技数码", "游戏电竞", "影视综艺", "知识教育", "美食", "生活日常",
    "搞笑段子", "音乐", "动漫二次元", "体育", "时尚美妆", "资讯时事",
  ]);
  assert.equal(categoryName(defaultTaxonomy(), OTHER_CATEGORY), "其他");
  assert.equal(categoryName(defaultTaxonomy(), UNSURE_CATEGORY), "待确认");
  assert.equal(LOW_CONFIDENCE, 0.55);
});

test("改名后稳定 id 不变：旧结果不会变成孤儿", () => {
  const tax = defaultTaxonomy();
  const before = resolveCategoryRef(tax, "科技数码");
  assert.equal(renameCategory(tax, before, "硬件与软件").ok, true);
  assert.equal(find(tax, before).name, "硬件与软件");
  assert.equal(resolveCategoryRef(tax, "硬件与软件"), before);
  assert.ok(matchKeywords(tax, ["", "手机评测", ""])[0].id === before);
});

test("自定义类可增；同名、空名、超长名一律拒绝", () => {
  const tax = defaultTaxonomy();
  const added = addCategory(tax, { name: "手工DIY", keywords: ["手工", "改造"] });
  assert.equal(added.ok, true);
  assert.equal(addCategory(tax, { name: "手工DIY" }).ok, false, "同名要拒绝");
  assert.equal(addCategory(tax, { name: "   " }).ok, false);
  assert.equal(addCategory(tax, { name: "这个名字长得离谱专门用来测试上限的类别名称超过二十四个字" }).ok, false);
  assert.ok(find(tax, added.category.id).custom === true);
});

test("「其他」与「待确认」删不掉：删了结果就没地方落", () => {
  const tax = defaultTaxonomy();
  assert.equal(removeCategory(tax, OTHER_CATEGORY).ok, false);
  assert.equal(removeCategory(tax, UNSURE_CATEGORY).ok, false);
  assert.ok(BUILTIN_LOCKED.includes(OTHER_CATEGORY));
  const custom = addCategory(tax, { name: "临时" });
  assert.equal(removeCategory(tax, custom.category.id).ok, true);
  assert.equal(find(tax, custom.category.id), null);
});

test("normalizeTaxonomy：用户存的体系与预置合并，缺「其他」自动补，脏数据不炸", () => {
  assert.equal(normalizeTaxonomy(null).length, 13);
  const merged = normalizeTaxonomy([
    { id: "tech", name: "硬核科技", keywords: ["机器人"] },
    { name: "园艺", keywords: ["种花"] },
    { id: "game", removed: true },
    null,
    { id: "", name: "" },
  ]);
  assert.equal(find(merged, "tech").name, "硬核科技");
  assert.deepEqual(find(merged, "tech").keywords, ["机器人"]);
  assert.equal(find(merged, "game"), null, "用户删掉的预置类要真的消失");
  assert.ok(merged.some((c) => c.name === "园艺"));
  assert.ok(merged.some((c) => c.id === OTHER_CATEGORY), "兜底类必须存在");
});

test("类别引用解析（类名 / 别名 / 模糊）：模型与用户随口叫法都能落到稳定 id", () => {
  const tax = defaultTaxonomy();
  assert.equal(resolveCategoryRef(tax, "科技数码"), "tech");
  assert.equal(resolveCategoryRef(tax, "数码"), "tech", "别名要认");
  assert.equal(resolveCategoryRef(tax, " tech "), "tech", "id 也认");
  assert.equal(resolveCategoryRef(tax, "影视解说"), "film");
  assert.equal(resolveCategoryRef(tax, "外星来客"), null, "解析不出就 null，不许瞎给");
  assert.deepEqual(resolveCategoryRefs(tax, ["游戏电竞", "电竞", "搞笑段子", "电竞"]), ["game", "funny"]);
});

test("关键词命中按字段分档：简介里的「科技」压过昵称里的「老师」，且同一词不重复计数", () => {
  const tax = defaultTaxonomy();
  const byBio = matchKeywords(tax, ["", "技术蛋老师", "硬核科技测评"]);
  assert.equal(byBio[0].id, "tech", "简介信号应胜过昵称信号");
  const single = matchKeywords(tax, ["", "", "科技"]);
  assert.equal(single[0].occurrences, 1, "「科技」在 keywords 与 aliases 里各写一次也只算一次");
  const multi = matchKeywords(tax, ["", "日常小确幸", "分享日常"]);
  assert.equal(multi[0].id, "life");
  assert.equal(multi[0].occurrences, 2, "昵称与简介各出现一次 = 两个独立信号");
});

test("自定义关键词立刻影响匹配；删光关键词就不会再命中该类", () => {
  const tax = defaultTaxonomy();
  const added = addCategory(tax, { name: "钓鱼佬", keywords: ["钓鱼", "路亚"] });
  assert.equal(matchKeywords(tax, ["", "野钓日记", "路亚教学"])[0].id, added.category.id);
  setCategoryKeywords(tax, added.category.id, []);
  assert.ok(!matchKeywords(tax, ["", "野钓日记", "路亚教学"]).some((s) => s.id === added.category.id));
});

test("体系落 chrome.storage.local：往返一致，且带凭据形态的内容被拒写", async () => {
  const storage = memoryStorage();
  const store = createClassifyStore({ storage });
  const tax = defaultTaxonomy();
  renameCategory(tax, "tech", "硬件与软件");
  addCategory(tax, { name: "手工DIY", keywords: ["手工"] });
  await store.saveTaxonomy(tax);
  const back = await store.loadTaxonomy();
  assert.equal(find(back, "tech").name, "硬件与软件");
  assert.ok(back.some((c) => c.name === "手工DIY"));
  const dump = JSON.stringify(storage._dump());
  assert.ok(dump.includes(TAXONOMY_KEY));
  await assert.rejects(store.saveTaxonomy([{ id: "x", name: "坏类 SESSDATA=abcdef1234567890" }]), /credentials/);
});