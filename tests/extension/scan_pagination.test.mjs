// 分页合并 / mid 去重 / incomplete 断点 / 读全门禁（FOR-63 验收 4，v2-spec §3.1）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND, canClassify, incompleteHint, isReadComplete, mergeFollowItems,
  progressLabel, scanAllFollowings,
} from "../../extension/biliApi.js";

const NO_SLEEP = async () => {};
const item = (mid, extra = {}) => ({ mid: String(mid), nickname: "UP" + mid, bio: "简介" + mid, ...extra });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => item(from + i));

function scriptedPages(pages, total) {
  const calls = [];
  const fetchPage = async (pn) => {
    calls.push(pn);
    const spec = pages[pn];
    if (!spec) return { ok: true, kind: KIND.OK, code: 0, message: "", total, items: [] };
    if (spec.fail) return { ok: false, kind: spec.fail, code: spec.code ?? null, message: spec.message || "mock", total: null, items: [] };
    return { ok: true, kind: KIND.OK, code: 0, message: "", total, items: spec.items };
  };
  return { fetchPage, calls };
}

test("抓全 62 条：跨页重叠也靠 mid 去重，fetched == total 才算 complete", async () => {
  const pages = {
    1: { items: range(1, 20) }, // 20
    2: { items: range(19, 38) }, // 重复 19/20 -> 38
    3: { items: range(37, 56) }, // 重复 37/38 -> 56
    4: { items: range(55, 62) }, // 重复 55/56 -> 62
  };
  const { fetchPage, calls } = scriptedPages(pages, 62);
  const res = await scanAllFollowings({ fetchPage, sleep: NO_SLEEP, intervalMs: 0 });
  assert.equal(res.status, "complete");
  assert.equal(res.fetched, 62);
  assert.equal(res.total, 62);
  assert.equal(res.pages, 4);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.equal(new Set(res.items.map((i) => i.mid)).size, 62, "mid 必须唯一");
  assert.equal(isReadComplete({ ...res, status: "complete" }), true);
  assert.equal(canClassify({ ...res, status: "complete" }), true);
  assert.equal(progressLabel({ ...res, status: "complete" }, { withPages: false }), "已读全（已取 62/62）");
});

test("页数用尽但仍没读全 -> incomplete(pages_exhausted)，不得静默宣布完成", async () => {
  const pages = { 1: { items: range(1, 20) }, 2: { items: range(21, 40) } };
  const { fetchPage, calls } = scriptedPages(pages, 100);
  const res = await scanAllFollowings({ fetchPage, sleep: NO_SLEEP, intervalMs: 0 });
  assert.equal(res.status, "incomplete");
  assert.equal(res.incompleteReason, "pages_exhausted");
  assert.equal(res.fetched, 40);
  assert.equal(res.total, 100);
  assert.equal(calls.length, 5, "total=100 / ps=20 -> 最多翻到第 5 页");
  assert.equal(isReadComplete({ ...res, status: "incomplete" }), false);
  assert.equal(canClassify({ ...res, status: "incomplete" }), false);
  assert.match(progressLabel({ ...res, status: "incomplete" }, { withPages: false }),
    /^还没读全（已取 40\/100）$/);
  assert.match(incompleteHint({ ...res, status: "incomplete" }), /改用网页抓取兜底/);
});

test("-352 风控：保留已取数据、标 incomplete、断点停在失败页", async () => {
  const pages = {
    1: { items: range(1, 20) },
    2: { fail: KIND.RISK_CONTROL, code: -352, message: "风控校验失败" },
  };
  const { fetchPage, calls } = scriptedPages(pages, 62);
  const res = await scanAllFollowings({ fetchPage, sleep: NO_SLEEP, intervalMs: 0, maxRetries: 1 });
  assert.equal(res.status, "incomplete");
  assert.equal(res.incompleteReason, KIND.RISK_CONTROL);
  assert.equal(res.fetched, 20, "已取数据必须保留");
  assert.equal(res.resumeFromPn, 2, "断点必须停在失败的那一页");
  assert.deepEqual(calls, [1, 2, 2], "重试同一页，不跳页");
  assert.equal(res.errors.length, 2);
  assert.match(incompleteHint({ incompleteReason: KIND.RISK_CONTROL }), /继续抓取/);
});

test("-101 未登录：立即停止，不重试（实测匿名就是 -101）", async () => {
  const { fetchPage, calls } = scriptedPages({ 1: { fail: KIND.NOT_LOGGED_IN, code: -101 } }, 62);
  const res = await scanAllFollowings({ fetchPage, sleep: NO_SLEEP, intervalMs: 0 });
  assert.equal(res.status, "incomplete");
  assert.equal(res.incompleteReason, KIND.NOT_LOGGED_IN);
  assert.equal(calls.length, 1);
  assert.equal(res.fetched, 0);
  assert.match(incompleteHint({ incompleteReason: KIND.NOT_LOGGED_IN }), /先.*登录/);
});

test("用户中止：aborted + 断点页，继续抓取从下一页开始", async () => {
  const pages = { 1: { items: range(1, 20) }, 2: { items: range(21, 40) }, 3: { items: range(41, 62) } };
  const seen = [];
  const fetchPage = async (pn) => {
    seen.push(pn);
    const spec = pages[pn] || { items: [] };
    return { ok: true, kind: KIND.OK, code: 0, message: "", total: 62, items: spec.items };
  };
  let abort = false;
  const res = await scanAllFollowings({
    fetchPage, sleep: NO_SLEEP, intervalMs: 0,
    onProgress: (snap) => { if (snap.pages === 2) abort = true; },
    shouldAbort: () => abort,
  });
  assert.equal(res.status, "incomplete");
  assert.equal(res.incompleteReason, "aborted");
  assert.equal(res.fetched, 40);
  assert.equal(res.resumeFromPn, 3);

  // 续抓：带上已取数据从第 3 页继续，最终读全且不重复
  const resumed = await scanAllFollowings({
    fetchPage, sleep: NO_SLEEP, intervalMs: 0, startPn: 3,
    initialItems: res.items, initialTotal: res.total,
  });
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.fetched, 62);
  assert.equal(new Set(resumed.items.map((i) => i.mid)).size, 62);
  assert.equal(progressLabel({ ...resumed, status: "complete" }, { withPages: false }), "已读全（已取 62/62）");
});

test("total 未知时不宣布读全（无法证明 fetched == total）", async () => {
  const pages = { 1: { items: range(1, 20) }, 2: { items: [] } };
  const { fetchPage } = scriptedPages(pages, null);
  const res = await scanAllFollowings({ fetchPage, sleep: NO_SLEEP, intervalMs: 0 });
  assert.equal(res.status, "incomplete");
  assert.equal(res.incompleteReason, "total_unknown");
  assert.equal(isReadComplete({ ...res, status: "incomplete" }), false);
});

test("页数上限保护：不会因为 total 巨大而无限翻页", async () => {
  const fetchPage = async (pn) => ({ ok: true, kind: KIND.OK, code: 0, message: "", total: 90000,
    items: range((pn - 1) * 20 + 1, pn * 20) });
  const res = await scanAllFollowings({ fetchPage, sleep: NO_SLEEP, intervalMs: 0, maxPages: 3 });
  assert.equal(res.status, "incomplete");
  assert.equal(res.incompleteReason, "page_cap");
  assert.equal(res.pages, 3);
});

test("漂移：已取条数超过 total 时按 >= 判定读全，并给出核对提示", async () => {
  const fetchPage = async (pn) => (pn === 1
    ? { ok: true, kind: KIND.OK, code: 0, message: "", total: 5, items: range(1, 6) }
    : { ok: true, kind: KIND.OK, code: 0, message: "", total: 5, items: [] });
  const res = await scanAllFollowings({ fetchPage, sleep: NO_SLEEP, intervalMs: 0 });
  assert.equal(res.status, "complete");
  assert.equal(res.overCount, true);
  assert.equal(isReadComplete({ ...res, status: "complete" }), true);
});

test("mergeFollowItems：先到者胜，缺字段用后到的补齐（断点续抓不覆盖已有昵称）", () => {
  const merged = mergeFollowItems(
    [{ mid: "1", nickname: "阿站", bio: "" }, { mid: "2", nickname: "", bio: "有简介" }],
    [{ mid: "1", nickname: "改名了", bio: "新简介" }, { mid: "2", nickname: "补上的昵称" }, { mid: "3", nickname: "新增" }]);
  assert.deepEqual(merged.map((m) => m.mid), ["1", "2", "3"]);
  assert.equal(merged[0].nickname, "阿站");
  assert.equal(merged[0].bio, "新简介");
  assert.equal(merged[1].nickname, "补上的昵称");
});
