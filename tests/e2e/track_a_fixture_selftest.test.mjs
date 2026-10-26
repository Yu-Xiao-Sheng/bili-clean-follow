// A 轨夹具与替身的自证（不需要浏览器）：分页形状、mid 去重、字段多样性，
// 以及 mock 在真 TLS 下能按 pn 应答。
//
// 这条今天就能绿，但它不证明「扩展在真浏览器里跑得起来」——那条是 A 轨真机取证。
// 它钉的是 A 轨的地基：3 页 / total 62 / 去重后 62 / emoji 昵称 / 官方认证 /
// 缺简介，缺任何一条，A 轨的 B1-B5 断言就失去意义。

import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";

import { buildPages, startMockServer, uniqueMids, SELF_MID } from "./mock_bilibili.mjs";

const PAGES = [20, 20, 22];

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: "127.0.0.1", port, path, rejectUnauthorized: false, timeout: 5000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
      });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

test("夹具：3 页 / 原始 63 行 / 去重后 62 条（B1 的 mid 去重口径）", () => {
  const pages = buildPages(PAGES);
  assert.equal(pages.length, 3);
  assert.equal(pages.flat().length, 63, "跨页故意重复一条，用来证明去重真的在做事");
  assert.equal(uniqueMids(pages).size, 62);
});

test("夹具：真实形状三件套——emoji 昵称 / 官方认证 / 缺简介", () => {
  const raw = buildPages(PAGES).flat();
  assert.ok(raw.some((r) => /\p{Extended_Pictographic}/u.test(r.uname)), "必须有 emoji 昵称");
  assert.ok(raw.some((r) => r.official_verify && Number(r.official_verify.type) >= 0), "必须有官方认证");
  assert.ok(raw.some((r) => r.sign === ""), "必须有空简介");
  assert.ok(raw.some((r) => typeof r.sign === "undefined"), "必须有整字段缺失的简介");
});

test("mock：nav 给登录态，三页都报 total=62，pn 越界给空页", async () => {
  const mock = await startMockServer({ pages: buildPages(PAGES) });
  try {
    assert.equal(mock.total, 62, "替身对外宣称的关注数必须是去重后的 62");
    const nav = await get(mock.port, "/x/web-interface/nav");
    assert.equal(nav.status, 200);
    assert.equal(nav.json.data.isLogin, true);
    assert.equal(String(nav.json.data.mid), SELF_MID);

    for (const pn of [1, 2, 3]) {
      const r = await get(mock.port, "/x/relation/followings?vmid=" + SELF_MID + "&pn=" + pn + "&ps=20");
      assert.equal(r.json.code, 0, "第 " + pn + " 页必须 code=0");
      assert.equal(r.json.data.total, 62, "关注数 total 必须是去重后的 62");
      assert.ok(r.json.data.list.length > 0, "第 " + pn + " 页不能是空的");
    }
    const over = await get(mock.port, "/x/relation/followings?vmid=" + SELF_MID + "&pn=4&ps=20");
    assert.equal(over.json.data.list.length, 0, "越界页给空列表，不得凭空造条目");
    const pns = mock.requests.filter((r) => r.path === "/x/relation/followings").map((r) => r.pn);
    assert.deepEqual(pns, [1, 2, 3, 4], "请求日志按到达顺序记 pn，A 轨用它断言翻页序列");
  } finally {
    await mock.close();
  }
});

test("mock：注入风控页返回 code=-352（B3 续抓的前提）", async () => {
  const mock = await startMockServer({ pages: buildPages(PAGES), riskOnPage: 2 });
  try {
    const r = await get(mock.port, "/x/relation/followings?vmid=" + SELF_MID + "&pn=2&ps=20");
    assert.equal(r.json.code, -352);
  } finally {
    await mock.close();
  }
});