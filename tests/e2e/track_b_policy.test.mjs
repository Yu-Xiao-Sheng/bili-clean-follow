// track_b_policy.test.mjs —— B 轨「真实账号 + 落盘快照」两条红线的门禁。
//
// 这条测试不需要浏览器、不需要账号，所以它能在 e2e-fixture job 里跑；
// 它盯的是取证脚本**永不越界**：写操作一律拒、快照字段一律白名单。
// 突变验证（2026-10-27 实测）：把 decideRequest 里「非 GET 先拒」挪到白名单之后，
// 本文件 17 条里 3 条判红；把 ITEM_FIELDS 放宽成「只要非空就过」，5 条判红。

import assert from "node:assert/strict";
import test from "node:test";

import {
  ITEM_FIELDS,
  READ_ENDPOINTS,
  WRITE_ENDPOINTS,
  decideRequest,
  findSecretKeys,
  publicItem,
  publicRequestLog,
  validateScanItems,
} from "./track_b_policy.mjs";

const READ = "https://api.bilibili.com/x/relation/followings?vmid=1&pn=2";

test("白名单只读端点逐个放行（GET、无请求体）", () => {
  for (const path of READ_ENDPOINTS) {
    const d = decideRequest({ method: "GET", url: "https://api.bilibili.com" + path });
    assert.equal(d.allowed, true, path + " 应当放行");
    assert.equal(d.kind, "read");
  }
});

test("取关 / 重新关注 / 拉黑 / 分组写：无论什么方法一律拒，且拒绝理由是 write_operation", () => {
  for (const path of WRITE_ENDPOINTS) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const d = decideRequest({ method, url: "https://api.bilibili.com" + path, hasPostData: method !== "GET" });
      assert.equal(d.allowed, false, path + " " + method + " 绝不能放行");
      assert.equal(d.kind, "write", path + " 的拒因必须是 write，不是 not_in_read_allowlist");
      assert.equal(d.reason, "write_operation_never_allowed_on_real_session");
    }
  }
});

test("POST 但路径没在写清单里（例如 /x/relation/tag/create 这类新端点）也拒：方法或请求体先拦", () => {
  const d = decideRequest({ method: "POST", url: "https://api.bilibili.com/x/relation/followings", hasPostData: true });
  assert.equal(d.allowed, false);
  assert.ok(["method", "body"].includes(d.kind), "拒因要能区分方法/请求体，实际 " + d.kind);
});

test("POST 但不带请求体也拒：写接口可以只靠查询串带参数（取关就是 fid + csrf）", () => {
  const d = decideRequest({ method: "POST", url: "https://api.bilibili.com/x/relation/followings?fid=1&csrf=x", hasPostData: false });
  assert.equal(d.allowed, false, "方法不是 GET 就必须拒，和有没有请求体无关");
  assert.equal(d.kind, "method");
});

test("GET 带请求体也拒（防止把表单塞进查询串绕过方法检查）", () => {
  const d = decideRequest({ method: "GET", url: READ, hasPostData: true });
  assert.equal(d.allowed, false);
  assert.equal(d.kind, "body");
});

test("非白名单宿主一律拒（B 轨不读第三方域，也不许被跳转带出去）", () => {
  for (const url of ["https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
    "https://api.bilibili.com.evil.example/x/relation/followings",
    "https://example.com/x/relation/followings"]) {
    const d = decideRequest({ method: "GET", url });
    assert.equal(d.allowed, false, url + " 必须拒");
    assert.equal(d.kind, "host");
  }
});

test("api.bilibili.com 上不在只读清单里的路径拒，且拒因与写操作区分开", () => {
  const d = decideRequest({ method: "GET", url: "https://api.bilibili.com/x/space/wbi/acc/info?mid=1" });
  assert.equal(d.allowed, false);
  assert.equal(d.kind, "path");
  assert.equal(d.reason, "not_in_read_allowlist");
});

test("写端点清单里必须含取关与补救端点（产品改名后端点漏列，这条当场判红）", () => {
  for (const p of ["/x/relation/delete", "/x/relation/add"]) {
    assert.ok(WRITE_ENDPOINTS.includes(p), p + " 必须在写端点清单里");
  }
  assert.ok(READ_ENDPOINTS.includes("/x/relation/followings"));
  assert.ok(!READ_ENDPOINTS.some((p) => WRITE_ENDPOINTS.includes(p)), "同一端点不能既只读又写");
});

test("publicItem 只留四列：face / sign / official / reason / rawCategory / source 全部丢掉", () => {
  const out = publicItem({
    mid: 123, nickname: "某个 UP 主", name: "", category: "tech", confidence: 0.674,
    face: "https://i0.hdslb.com/x.jpg", sign: "简介原文", official: "科技", verified: true,
    reason: "命中关键词", source: "local", rawCategory: "tech", movedToUnsure: false,
    SESSDATA: "should-never-survive",
  });
  assert.deepEqual(Object.keys(out).sort(), ITEM_FIELDS.slice().sort());
  assert.equal(out.mid, "123");
  assert.equal(out.name, "某个 UP 主", "扩展内部叫 nickname，快照列叫 name");
  assert.equal(out.confidence, 0.67, "置信度保留两位小数，避免报告里出现 0.6740000001");
  assert.ok(!("SESSDATA" in out));
});

test("快照自证：合法快照通过，且数量与类目分布对账", () => {
  const items = [
    { mid: "1", name: "阿比", category: "tech", confidence: 0.6 },
    { mid: "2", name: "🌸小花", category: "fun", confidence: 0.2 },
    { mid: "3", name: "官方号", category: "tech", confidence: 0.55 },
  ];
  const r = validateScanItems(items, { followTotal: 3, counts: { tech: 2, fun: 1, other: 0 } });
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("快照自证：多带一个字段就判红（白名单制，不是黑名单制）", () => {
  const r = validateScanItems([{ mid: "1", name: "a", category: "tech", confidence: 0.5, face: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /字段必须是 mid\/name\/category\/confidence/);
});

test("快照自证：mid 重复、昵称空、confidence 越界分别判红", () => {
  const dup = validateScanItems([{ mid: "1", name: "a", category: "t", confidence: 0.5 },
    { mid: "1", name: "b", category: "t", confidence: 0.5 }]);
  assert.match(dup.problems.join(";"), /mid 重复/);
  const blank = validateScanItems([{ mid: "2", name: "   ", category: "t", confidence: 0.5 }]);
  assert.match(blank.problems.join(";"), /昵称为空/);
  const bad = validateScanItems([{ mid: "3", name: "a", category: "t", confidence: 1.4 }]);
  assert.match(bad.problems.join(";"), /confidence 不在 0\.\.1/);
});

test("快照自证：条数与 cls.counts 对账，两个方向都要对", () => {
  const items = [{ mid: "1", name: "a", category: "tech", confidence: 0.5 }];
  assert.match(validateScanItems(items, { followTotal: 826 }).problems.join(";"), /follow_total/);
  assert.match(validateScanItems(items, { counts: { tech: 2 } }).problems.join(";"), /类目 tech 条数 1/);
  assert.match(validateScanItems(items, { counts: { fun: 1 } }).problems.join(";"), /类目 tech 有 1 条但报告/);
});

test("凭据形态键名递归检出（嵌套多深都检，命中即整份判红）", () => {
  const hits = findSecretKeys({ items: [{ ok: 1, inner: { SESSDATA: "x" } }], bili_jct: "y" });
  assert.ok(hits.includes("items.0.inner.SESSDATA"));
  assert.ok(hits.includes("bili_jct"));
  assert.deepEqual(findSecretKeys({ mid: "1", name: "a", category: "t", confidence: 0.5 }), []);
});

test("快照里带凭据形态的键时 validateScanItems 也判红（白名单之外的第二道闸）", () => {
  const r = validateScanItems([{ mid: "1", name: "a", category: "t", confidence: 0.5, cookie: "SESSDATA=x" }]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /凭据形态/);
});

test("请求日志落盘形状：只有 method/host/path/allowed/kind，永不带 header、cookie、响应体", () => {
  const log = publicRequestLog([
    { method: "GET", url: READ, headers: { Cookie: "SESSDATA=secret" }, body: "<原始响应体>" },
    { method: "POST", url: "https://api.bilibili.com/x/relation/delete", postData: "fid=1&csrf=x" },
  ]);
  assert.equal(log.length, 2);
  for (const row of log) {
    assert.deepEqual(Object.keys(row).sort(), ["allowed", "host", "kind", "method", "path"]);
  }
  assert.equal(log[0].allowed, true);
  assert.equal(log[1].allowed, false);
  assert.equal(log[1].kind, "write");
  const dumped = JSON.stringify(log);
  assert.ok(!dumped.includes("SESSDATA"), "日志里不得出现 cookie 值");
  assert.ok(!dumped.includes("csrf"), "日志里不得出现请求体");
});

test("空快照判红（真实会话没抓到东西时不许落一份 [] 进 git）", () => {
  assert.equal(validateScanItems([]).ok, false);
  assert.equal(validateScanItems(null).ok, false);
  assert.equal(validateScanItems({}).ok, false);
});

test("URL 解析失败判红而不是放行（fail-closed）", () => {
  const d = decideRequest({ method: "GET", url: "not-a-url" });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "url_unparseable");
  assert.equal(decideRequest().allowed, false, "空请求也要拒");
});