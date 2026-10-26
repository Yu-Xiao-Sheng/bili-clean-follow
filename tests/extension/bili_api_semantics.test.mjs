// 错误语义映射与接口面门禁（v2-spec §1.2 实施要求 + FOR-63 验收 3）。
// 跑法：node --test tests/extension

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODES, ENDPOINTS, FORBIDDEN_ENDPOINTS, KIND, PAGE_SIZE, buildFollowingsUrl,
  classifyResponse, parseFollowingsPayload, parseNavPayload, shouldStopForKind,
  shouldSwitchTransport,
} from "../../extension/biliApi.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, "..", "..", "extension");

test("返回码语义：0 成功 / -101 未登录 / -352 风控 / 412 需签名", () => {
  assert.equal(classifyResponse({ httpStatus: 200, payload: { code: 0, message: "0" } }).kind, KIND.OK);
  assert.equal(classifyResponse({ httpStatus: 200, payload: { code: -101, message: "账号未登录" } }).kind,
    KIND.NOT_LOGGED_IN);
  assert.equal(classifyResponse({ httpStatus: 200, payload: { code: -352, message: "风险校验" } }).kind,
    KIND.RISK_CONTROL);
  assert.equal(classifyResponse({ httpStatus: 200, payload: { code: 412, message: "签名校验失败" } }).kind,
    KIND.SIGNED_REQUIRED);
  // 实测 x/space/arc/search 是 HTTP 412（body 里没有 code），走 HTTP 层映射
  assert.equal(classifyResponse({ httpStatus: 412, payload: null, rawText: "<html>" }).kind,
    KIND.SIGNED_REQUIRED);
  assert.equal(classifyResponse({ httpStatus: 429, payload: null }).kind, KIND.RISK_CONTROL);
  assert.equal(classifyResponse({ httpStatus: 200, payload: null, rawText: "<html>风控页</html>" }).kind,
    KIND.MALFORMED);
  assert.equal(classifyResponse({ httpStatus: 500, payload: null }).kind, KIND.TRANSPORT);
  assert.equal(CODES.NOT_LOGGED_IN, -101);
  assert.equal(CODES.RISK_CONTROL, -352);
});

test("降级判定：风控/需签名换传输路径，未登录不重试", () => {
  assert.equal(shouldSwitchTransport(KIND.RISK_CONTROL), true);
  assert.equal(shouldSwitchTransport(KIND.SIGNED_REQUIRED), true);
  assert.equal(shouldSwitchTransport(KIND.TRANSPORT), true);
  assert.equal(shouldSwitchTransport(KIND.NOT_LOGGED_IN), false);
  assert.equal(shouldStopForKind(KIND.NOT_LOGGED_IN), true);
  assert.equal(shouldStopForKind(KIND.RISK_CONTROL), false);
});

test("主路径 URL：pn/ps/order/order_field 与实测口径一致，ps 不许超过 20", () => {
  const url = new URL(buildFollowingsUrl({ vmid: "12345", pn: 3 }));
  assert.equal(url.origin, "https://api.bilibili.com");
  assert.equal(url.pathname, "/x/relation/followings");
  assert.equal(url.searchParams.get("vmid"), "12345");
  assert.equal(url.searchParams.get("pn"), "3");
  assert.equal(url.searchParams.get("ps"), String(PAGE_SIZE));
  assert.equal(url.searchParams.get("order"), "desc");
  assert.equal(url.searchParams.get("order_field"), "ptime");
  assert.equal(new URL(buildFollowingsUrl({ vmid: 1, pn: 0, ps: 50 })).searchParams.get("ps"), "20");
  assert.throws(() => buildFollowingsUrl({ vmid: "" }), /vmid 不能为空/);
});

test("关注页响应解析：真实形状（data.list + uname + sign + total），mid 缺失的行直接丢", () => {
  const payload = {
    code: 0,
    data: {
      total: 812,
      list: [
        { mid: 1, uname: "阿 站", sign: "做数码的", mtime: 1700000000, official_verify: { type: 0 } },
        { follower_id: 2, name: "没有 uname 的老字段", sign: "" },
        { uname: "没有 mid 的行", sign: "应当被丢掉" },
      ],
    },
  };
  const parsed = parseFollowingsPayload(payload, { httpStatus: 200 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.total, 812);
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items.map((i) => i.mid), ["1", "2"]);
  assert.equal(parsed.items[0].nickname, "阿 站");
  assert.equal(parsed.items[0].verified, true);
  assert.equal(parsed.items[0].followTs, 1700000000);
});

test("nav 解析：-101 就是「未登录」，不给 mid", () => {
  const anon = parseNavPayload({ code: -101, message: "账号未登录" }, { httpStatus: 200 });
  assert.equal(anon.login, false);
  assert.equal(anon.kind, KIND.NOT_LOGGED_IN);
  assert.equal(anon.mid, null);
  const me = parseNavPayload({ code: 0, data: { mid: 42, uname: "我", isLogin: true } }, { httpStatus: 200 });
  assert.equal(me.login, true);
  assert.equal(me.mid, "42");
});

test("接口面门禁：实测不可用与写接口只出现在 biliApi.js 的黑名单里，别处一律不许出现", () => {
  const files = fs.readdirSync(EXT_DIR, { recursive: true })
    .filter((f) => String(f).endsWith(".js"))
    .map((f) => path.join(EXT_DIR, String(f)));
  assert.ok(files.length >= 6, "至少要覆盖 background/biliApi/store/report/sidepanel/popup/content");
  for (const file of files) {
    if (path.basename(file) === "biliApi.js") continue;
    const src = fs.readFileSync(file, "utf8");
    for (const banned of FORBIDDEN_ENDPOINTS) {
      assert.ok(!src.includes(banned),
        path.relative(EXT_DIR, file) + " 里出现了禁用接口 " + banned + "（接口层只准 biliApi.js 一处）");
    }
    if (path.basename(file) !== "background.js") {
      assert.ok(!src.includes("api.bilibili.com"),
        path.relative(EXT_DIR, file) + " 里不该自己拼 B站接口地址");
    }
  }
  // 允许清单必须是实测可用的那几个
  assert.equal(ENDPOINTS.followings, "https://api.bilibili.com/x/relation/followings");
  assert.ok(!FORBIDDEN_ENDPOINTS.includes(ENDPOINTS.followings));
  assert.ok(ENDPOINTS.relationStat.endsWith("/x/relation/stat"));
});

test("FORBIDDEN_ENDPOINTS 覆盖 v2-spec §1.2 实测不可用的四个接口", () => {
  for (const banned of ["/x/relation/followers", "/x/space/wbi/acc/info", "/x/space/arc/search",
    "/x/polymer/web-dynamic/v1/feed/space"]) {
    assert.ok(FORBIDDEN_ENDPOINTS.includes(banned), banned + " 必须在黑名单里");
  }
});
