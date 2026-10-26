// 写操作边界（FOR-65）：写接口只有一个发起点、候选清单不由 UI 决定、README 显著标注风险。
//
// 这条测试存在的原因：护栏写在 unfollow.js 里，但如果哪里还能直接 fetch 写接口，
// 或者 UI 能把「要取关谁」当参数传进来，护栏就形同虚设。所以把它钉成静态门禁。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WRITE_ENDPOINTS, buildWriteForm } from "../../extension/biliApi.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const EXT = path.join(ROOT, "extension");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const jsFiles = walk(EXT).filter((f) => f.endsWith(".js"));
const src = (file) => fs.readFileSync(file, "utf8");
const rel = (file) => path.relative(EXT, file);
const codeOnlyOf = (text) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
const read = (name) => {
  const file = path.join(EXT, name);
  assert.ok(fs.existsSync(file), "模块要在位：" + name);
  return src(file);
};

test("写接口名只出现在接口层与取关护栏模块（其它模块出现即红）", () => {
  const allowed = new Set(["biliApi.js", "unfollow.js"]);
  const offenders = [];
  for (const file of jsFiles) {
    const name = path.basename(file);
    if (allowed.has(name)) continue;
    const text = src(file);
    for (const literal of ["/x/relation/delete", "/x/relation/add"]) {
      if (text.includes(literal)) offenders.push(rel(file) + " -> " + literal);
    }
  }
  assert.deepEqual(offenders, [], "写接口名只能在那两个模块里出现");
  assert.equal(WRITE_ENDPOINTS.unfollow, "https://api.bilibili.com/x/relation/delete");
  assert.equal(WRITE_ENDPOINTS.addFollow, "https://api.bilibili.com/x/relation/add");
});

test("只有 service worker 能发请求：护栏模块与 UI 里没有 fetch(，写传输只在 background.js", () => {
  const bg = read("background.js");
  // SW 里的三处 fetch：sw_fetch 只读抓取、注入到页面里的 page_fetch 兜底、writeTransport 写请求
  assert.equal((bg.match(/fetch\(/g) || []).length, 3, "SW 里只允许这三处 fetch");
  for (const name of ["unfollow.js", "preview.js", "intent.js", "intentStack.js", "sidepanel.js", "store.js", "classify.js"]) {
    assert.ok(!codeOnlyOf(read(name)).includes("fetch("), name + " 里不得出现 fetch(：传输层是注入的（注释里提到不算）");
  }
  assert.equal((bg.match(/transport: writeTransport/g) || []).length, 2,
    "写传输只交给 executeUnfollow 与 restoreUnfollowed 两个入口");
});

test("候选清单不由消息决定：service worker 从 storage 重算预览与候选", () => {
  const bg = read("background.js");
  assert.ok(bg.includes("buildUnfollowPreview({"), "预览在 SW 侧按当前数据重算");
  assert.ok(bg.includes("await currentCorpus()"), "items/results/decisions 一律从 storage 读，不信 UI");
  assert.match(bg, /export async function runUnfollow\(\{ confirmation = \{\}, limit = null, intervalMs = null \} = \{\}\)/,
    "消息参数里不得出现 mid 清单 / 候选数组");
  assert.ok(!/runUnfollow\(\{[^}]*mids/.test(bg) && !/runUnfollow\(\{[^}]*items/.test(bg));
  assert.ok(bg.includes("isReadComplete(state)"), "没读全就不许进入写流程（FOR-63 的门禁不放宽）");
  assert.ok(bg.includes("UnfollowGuardError"), "护栏失败要能被识别成 kind，而不是笼统报错");
});

test("护栏在网络之前：guardUnfollow 的调用位置早于任何 transport 调用", () => {
  const unf = read("unfollow.js");
  const guardAt = unf.indexOf("const guard = guardUnfollow(");
  const transportAt = unf.indexOf("await transport({ op: \"unfollow\", mid })");
  assert.ok(guardAt > 0 && transportAt > 0);
  assert.ok(guardAt < transportAt, "先过护栏再发请求");
  assert.ok(unf.includes("throw new UnfollowGuardError(guard);"), "过不了就抛，不返回「部分成功」");
  assert.ok(unf.includes("safeCandidateMids({"), "执行时按当前 results/decisions 重算候选（护栏 e）");
  const restoreAt = unf.indexOf("await transport({ op: \"add\", mid })");
  const restoreGuardAt = unf.indexOf("token !== RESTORE_TOKEN");
  assert.ok(restoreGuardAt > 0 && restoreGuardAt < restoreAt, "补救（加关注）同样要先确认");
});

test("写请求表单体：form fid + csrf；缺 csrf 或非数字 mid 一律不发", () => {
  const form = buildWriteForm({ mid: "12345", csrf: "abcdef123456" });
  const params = new URLSearchParams(form);
  assert.equal(params.get("fid"), "12345");
  assert.equal(params.get("csrf"), "abcdef123456");
  assert.throws(() => buildWriteForm({ mid: "", csrf: "abcdef123456" }), /fid/);
  assert.throws(() => buildWriteForm({ mid: "abc", csrf: "abcdef123456" }), /fid/);
  assert.throws(() => buildWriteForm({ mid: "12345", csrf: "" }), /csrf/);
  // csrf 只存在于这一处：清单、审计、导出的实现都不读 cookie
  const unf = codeOnlyOf(read("unfollow.js"));
  assert.ok(!unf.includes("bili_jct") && !unf.includes("chrome.cookies"),
    "取关模块不碰 cookie（注释里提到不算）：csrf 由 service worker 现场取");
  assert.ok(read("background.js").includes("name: \"bili_jct\""), "cookie 读取只在 SW");
  assert.ok(read("background.js").includes("async function hasCsrfCookie"), "SW 能回答「有没有 csrf」但不外传值");
});

test("README 显著位置写清取关风险（v2-spec §4 第 7 条）", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const head = readme.split("\n").slice(0, 40).join("\n");
  assert.match(head, /取关/, "取关风险要在 README 前部，不是埋在末尾");
  assert.match(head, /风险|不可撤销/);
  const body = readme;
  for (const needle of ["UNFOLLOW", "800ms", "200", "keep", "待确认", "x/relation/delete", "不可撤销", "重新关注"]) {
    assert.ok(body.includes(needle), "README 要写清护栏：" + needle);
  }
  assert.ok(body.includes("默认关闭"), "口径是「默认只报告，写操作要显式武装」");
});