// 仓储状态机与凭据边界（FOR-63 验收 4 + 7）。

import assert from "node:assert/strict";
import test from "node:test";

import { ITEMS_COUNT_KEY, ITEMS_PREFIX, STATE_KEY, STATUS, createStore, memoryStorage }
  from "../../extension/store.js";

function fresh() {
  const storage = memoryStorage();
  return { storage, store: createStore({ storage }) };
}
const items = (from, to) => Array.from({ length: to - from + 1 }, (_, i) =>
  ({ mid: String(from + i), nickname: "UP" + (from + i), bio: "简介" }));

test("默认状态是 idle，fetched=0，断点在第 1 页", async () => {
  const { store } = fresh();
  const state = await store.getState();
  assert.equal(state.status, STATUS.IDLE);
  assert.equal(state.fetched, 0);
  assert.equal(state.total, null);
  assert.equal(state.resumeFromPn, 1);
});

test("中断：数据保留 + status=incomplete + 断点页，续抓不重复计数", async () => {
  const { store } = fresh();
  await store.saveState({ status: STATUS.SCANNING, total: 62, mid: "42" });
  await store.appendItemsIncremental(items(1, 20));
  await store.saveState({ pages: 1, resumeFromPn: 2 });
  await store.markIncomplete("risk_control", { resumeFromPn: 2, kind: "risk_control", lastError: "-352" });

  let state = await store.getState();
  assert.equal(state.status, STATUS.INCOMPLETE);
  assert.equal(state.incompleteReason, "risk_control");
  assert.equal(state.resumeFromPn, 2);
  assert.equal((await store.loadItems()).length, 20, "中断后已取数据必须在");

  // 续抓：同一页重复写不会翻倍（mid 去重）
  await store.appendItemsIncremental(items(1, 20));
  assert.equal((await store.loadItems()).length, 20);
  await store.appendItemsIncremental(items(21, 40));
  await store.saveState({ fetched: 40, pages: 2, resumeFromPn: 3 });
  state = await store.getState();
  assert.equal(state.fetched, 40);
  assert.equal((await store.loadItems()).length, 40);
});

test("读全门禁：fetched != total 时既不能 markComplete，也不能被 patch 成 complete", async () => {
  const { store } = fresh();
  await store.saveState({ status: STATUS.SCANNING, total: 812 });
  await store.appendItemsIncremental(items(1, 431));
  await assert.rejects(() => store.markComplete(), /fetched == total 是硬门禁/);

  const state = await store.saveState({ status: STATUS.COMPLETE });
  assert.equal(state.status, STATUS.INCOMPLETE);
  assert.equal(state.incompleteReason, "gate_fetched_ne_total");

  await store.appendItemsIncremental(items(432, 812));
  await store.saveState({ fetched: 812 });
  const done = await store.markComplete();
  assert.equal(done.status, STATUS.COMPLETE);
  assert.equal(done.incompleteReason, null);
});

test("分块落盘：812 条不会被塞进单个 storage key，收缩后不留陈旧分块", async () => {
  const { storage, store } = fresh();
  await store.replaceItems(items(1, 250));
  assert.equal((await storage.get([ITEMS_COUNT_KEY]))[ITEMS_COUNT_KEY], 3);
  assert.equal((await store.loadItems()).length, 250);
  await store.replaceItems(items(1, 30));
  const dump = storage._dump();
  assert.equal(dump[ITEMS_COUNT_KEY], 1);
  assert.ok(!(ITEMS_PREFIX + ".2" in dump), "陈旧分块必须删掉，否则续抓会读到脏数据");
  assert.equal((await store.loadItems()).length, 30);
});

test("凭据边界：cookie 字段不落盘，含凭据形态的内容直接拒写", async () => {
  const { storage, store } = fresh();
  await store.replaceItems([{ mid: "1", nickname: "阿站", cookie: "SESSDATA=abcdef123456789" }]);
  let dump = JSON.stringify(storage._dump());
  assert.ok(!dump.includes("SESSDATA"), "cookie 字段必须被剥掉");
  assert.equal((await store.loadItems())[0].nickname, "阿站");

  await assert.rejects(() => store.replaceItems([{ mid: "2", nickname: "SESSDATA=zzzzzzzzzzzz" }]),
    /refusing to write credentials/);
  dump = JSON.stringify(storage._dump());
  assert.ok(!dump.includes("SESSDATA"), "拒写之后 storage 里也不许留下痕迹");
  assert.equal((await store.loadItems()).length, 1, "拒写不得破坏已有数据");

  await assert.rejects(() => store.appendAudit({ event: "x", note: "Authorization: Bearer abcdefghijklmnop" }),
    /refusing to write credentials/);
  assert.equal((await store.loadAudit()).length, 0);
});

test("审计日志只留安全字段，并按条数截断", async () => {
  const { storage, store } = fresh();
  await store.appendAudit({ event: "scan_start", cookie: "SESSDATA=aaaaaaaaaaaaaa", token: "sk-abcdefghijklmno" });
  const log = await store.loadAudit();
  assert.equal(log.length, 1);
  assert.ok(!JSON.stringify(log).includes("SESSDATA"));
  assert.ok(!JSON.stringify(log).includes("sk-"));
  for (let i = 0; i < 12; i += 1) await store.appendAudit({ event: "p" + i });
  const dump = await storage.get(["audit_log"]);
  assert.equal(dump.audit_log.length, 13, "未超过 AUDIT_KEEP 时全留");
  assert.ok(!JSON.stringify(dump).includes("SESSDATA"));
});

test("reset 只清扫描数据，不动别的键（用户的分类/Key 命名空间在别处）", async () => {
  const { storage, store } = fresh();
  await storage.set({ user_categories: ["科技数码"] });
  await store.saveState({ status: STATUS.SCANNING, total: 5 });
  await store.replaceItems(items(1, 5));
  await store.reset();
  assert.equal((await store.loadItems()).length, 0);
  assert.equal((await store.getState()).status, STATUS.IDLE);
  const dump = storage._dump();
  assert.deepEqual(dump.user_categories, ["科技数码"]);
  const afterReset = dump[STATE_KEY];
  assert.equal(afterReset.status, STATUS.IDLE, "reset 后状态回到默认值");
  assert.equal(afterReset.fetched, 0);
  assert.equal(afterReset.total, null);
});
