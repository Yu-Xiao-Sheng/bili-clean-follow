// userscripts/bili-clean.user.js 的只读护栏与口径门禁（FOR-68 交付物 2）。
//
// 这份测试要回答一个问题：油猴脚本凭什么说自己「只读、不会取关」？
// 答案不能是注释。这里钉四件事：
//   1) 请求构造器只放行 api.bilibili.com 的三个只读接口 + GET + 无请求体；
//   2) 写接口字符串在源码里只准出现在 DENIED_ENDPOINTS 禁用清单里，别处出现即红；
//   3) 只读常量（分页粒度、限速下限、total 上限、置信阈值）与 extension/biliApi.js 同源；
//   4) 分类体系与 extension/taxonomy.js 一致（油猴版是复制的一份，漂移必须被发现）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { MIN_INTERVAL_MS as EXT_MIN_INTERVAL, PAGE_SIZE as EXT_PAGE_SIZE, TOTAL_CAP as EXT_TOTAL_CAP }
  from "../../extension/biliApi.js";
import { PRESET_TAXONOMY as EXT_TAXONOMY, LOW_CONFIDENCE as EXT_LOW_CONF } from "../../extension/taxonomy.js";
import { UNFOLLOW_NOTICE as EXT_UNFOLLOW_NOTICE, CSV_BOM as EXT_CSV_BOM } from "../../extension/report.js";

const FILE = path.resolve(import.meta.dirname, "../../userscripts/bili-clean.user.js");
const SOURCE = fs.readFileSync(FILE, "utf8");

/** 在没有 window/document 的沙箱里加载，只拿到纯函数出口（__BCF_USERSCRIPT__）。 */
function loadApi() {
  const ctx = vm.createContext({ URL, URLSearchParams, setTimeout, console,
    Math, Date, Number, String, Object, Array, JSON, Map, Set, Error, RegExp, Blob: class {} });
  vm.runInContext(SOURCE, ctx, { filename: FILE });
  const api = ctx.__BCF_USERSCRIPT__;
  assert.ok(api, "油猴脚本没有导出 __BCF_USERSCRIPT__，纯函数部分无法取证");
  return api;
}

const u = loadApi();

test("只读护栏：只放行 api.bilibili.com 的 GET，其余一律抛", () => {
  const ok = u.buildReadonlyRequest(u.READONLY_ENDPOINTS.followings + "?vmid=1&pn=1&ps=20", { method: "GET" });
  assert.equal(new URL(ok.url).origin, "https://api.bilibili.com");
  assert.equal(ok.init.method, "GET");
  assert.equal(ok.init.credentials, "include");

  assert.throws(() => u.buildReadonlyRequest(u.READONLY_ENDPOINTS.nav, { method: "POST" }), /只允许 GET/);
  assert.throws(() => u.buildReadonlyRequest(u.READONLY_ENDPOINTS.nav, { method: "GET", body: "fid=1" }), /不允许请求体/);
  assert.throws(() => u.buildReadonlyRequest("https://evil.example.com/x/web-interface/nav"), /只允许 api\.bilibili\.com/);
  assert.throws(() => u.buildReadonlyRequest("https://api.bilibili.com/x/web-interface/card?mid=1"), /只读白名单/);
  assert.throws(() => u.buildReadonlyRequest(u.READONLY_ENDPOINTS.followings + "?vmid=1&csrf=abc"), /凭据形态/);
});

test("写接口 / 风控接口在源码里只出现在禁用清单里（油猴版不会取关，可静态验证）", () => {
  for (const denied of u.DENIED_ENDPOINTS) assert.ok(SOURCE.includes('"' + denied + '"'), "禁用清单缺 " + denied);
  const stripped = SOURCE.replace(/const DENIED_ENDPOINTS = \[[\s\S]*?\];/, "const DENIED_ENDPOINTS = [];");
  for (const denied of u.DENIED_ENDPOINTS) {
    assert.ok(!stripped.includes(denied), "写接口 " + denied + " 出现在禁用清单之外，油猴版必须是只读的");
  }
  assert.ok(!/GM_xmlhttpRequest|unsafeWindow|GM_setValue|document\.cookie/.test(SOURCE),
    "不允许用 userscript 特权绕过只读口径（GM_xmlhttpRequest / unsafeWindow / cookie）");
  assert.equal((SOURCE.match(/\bfetch\(/g) || []).length, 1, "全脚本只准有一处 fetch，护栏才只有一处");
  assert.ok(!/\bxhr\b|XMLHttpRequest|WebSocket|EventSource|import\(/.test(SOURCE), "不允许其它出网通道");
});

test("源码里的外链 host 只有 B站与仓库元数据（没有第三方目的地）", () => {
  const hosts = new Set();
  for (const m of SOURCE.matchAll(/https?:\/\/([^/\s"']+)/g)) hosts.add(m[1]);
  const allowed = new Set(["api.bilibili.com", "www.bilibili.com", "space.bilibili.com", "github.com"]);
  for (const h of hosts) assert.ok(allowed.has(h), "出现白名单之外的 host：" + h);
});

test("只读常量与 extension/biliApi.js 同源（分页粒度 / 限速下限 / total 上限）", () => {
  assert.equal(u.PAGE_SIZE, EXT_PAGE_SIZE, "分页粒度必须与插件一致（更大的 ps 会被 B站截断）");
  assert.equal(u.MIN_INTERVAL_MS, EXT_MIN_INTERVAL, "自我限速下限必须与插件一致");
  assert.equal(u.TOTAL_CAP, EXT_TOTAL_CAP);
  assert.equal(u.LOW_CONFIDENCE, EXT_LOW_CONF);
  assert.ok(u.MIN_INTERVAL_MS >= 450, "只读抓取不得比 450ms/页更快");
});

test("分类体系与 extension/taxonomy.js 一致（油猴版是复制的一份，漂移即红）", () => {
  assert.equal(u.PRESET_TAXONOMY.length, EXT_TAXONOMY.length);
  for (const ext of EXT_TAXONOMY) {
    const mine = u.PRESET_TAXONOMY.find((c) => c.id === ext.id);
    assert.ok(mine, "油猴版缺类别 " + ext.id);
    assert.equal(mine.name, ext.name, ext.id + " 的中文名漂移");
    assert.deepEqual([...mine.keywords].sort(), [...ext.keywords].sort(), ext.id + " 的关键词漂移");
  }
});

test("解析与去重：真实形状的昵称/简介/认证三件套，mid 缺失直接丢", () => {
  const parsed = u.parseFollowingsPayload({ code: 0, data: { total: 3, list: [
    { mid: 11, uname: "带 emoji 的 UP 🎮", sign: "游戏攻略 实况", official_verify: { type: 1 }, mtime: 1700000000 },
    { mid: 22, name: "只有昵称", tags: [] },
    { name: "没有 mid 的行" },
  ] } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.items.length, 2, "mid 缺失的行必须丢掉（去重全靠 mid）");
  assert.equal(parsed.items[0].nickname, "带 emoji 的 UP 🎮");
  assert.equal(parsed.items[0].bio, "游戏攻略 实况");
  assert.equal(parsed.items[0].verified, true);
  const merged = u.mergeItems(parsed.items, [{ mid: "22", nickname: "", bio: "补上了简介" }, { mid: "33", nickname: "新" }]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((x) => x.mid === "22").bio, "补上了简介");
});

test("接口返回码：-101 与 -352 的语义与插件一致，且不静默当空列表", () => {
  const a = u.parseFollowingsPayload({ code: -101, message: "账号未登录" });
  assert.equal(a.kind, "not_logged_in");
  assert.match(a.message, /未登录/);
  const b = u.parseFollowingsPayload({ code: -352 });
  assert.equal(b.kind, "risk_control");
  assert.match(b.message, /风控/);
});

test("读全门禁：只有 fetched >= total 才 complete，2000 与漂移都要显式提示", () => {
  assert.equal(u.scanGate({ fetched: 431, total: 812 }).complete, false);
  assert.match(u.scanGate({ fetched: 431, total: 812 }).note, /还没读全/);
  assert.equal(u.scanGate({ fetched: 62, total: 62 }).complete, true);
  assert.equal(u.scanGate({ fetched: 62, total: null }).complete, false, "拿不到 total 不得宣布读全");
  const drift = u.scanGate({ fetched: 70, total: 62 });
  assert.equal(drift.complete, true);
  assert.equal(drift.warn, true);
  assert.match(drift.note, /漂移/);
  const cap = u.scanGate({ fetched: 2000, total: 2000 });
  assert.equal(cap.warn, true);
  assert.match(cap.note, /上限/);
});

test("抓取循环：3 页 62 条（含重复行）读全；风控页停在断点且不算读全", async () => {
  const pages = { 1: 20, 2: 21, 3: 22 };
  let calls = 0;
  const seq = [];
  const mk = (pn) => {
    calls += 1; seq.push(pn);
    const items = [];
    for (let i = 0; i < pages[pn]; i += 1) items.push({ mid: 1000 + (pn - 1) * 20 + i, uname: "UP" + (1000 + (pn - 1) * 20 + i) });
    items.push({ mid: 1001, uname: "重复行" }); // 每页都回一条已见过的
    return { ok: true, kind: "ok", code: 0, total: 62, items };
  };
  const res = await u.scanAll({ vmid: 9, fetchPage: mk, sleep: async () => {}, intervalMs: 0 });
  assert.equal(res.complete, true);
  assert.equal(res.items.length, 62, "去重后必须正好 62 条");
  assert.deepEqual(seq, [1, 2, 3], "读全之后不得继续翻页");
  assert.equal(calls, 3);

  const risk = await u.scanAll({
    vmid: 9, sleep: async () => {}, intervalMs: 0,
    fetchPage: (pn) => (pn === 2 ? { ok: false, kind: "risk_control", code: -352, total: null, items: [], message: "风控" } : mk(pn)),
  });
  assert.equal(risk.complete, false, "风控后不得宣布读全");
  assert.ok(risk.items.length > 0, "已取数据必须保留");
  assert.equal(risk.resumeFromPn, 2, "必须记下断点页");
});

test("离线粗分类：低置信进「待确认」，且每条都被归桶（总数对账）", () => {
  const items = [
    { mid: "1", nickname: "某游戏解说", bio: "游戏攻略 实况 单机", official: "知名游戏UP主", verified: true },
    { mid: "2", nickname: "央视新闻", bio: "", official: "中央广播电视总台", verified: true },
    { mid: "3", nickname: "张三", bio: "", official: "", verified: false },
    { mid: "4", nickname: "厨房里的老王", bio: "家常菜 菜谱 烘焙", official: "", verified: false },
  ];
  const rows = u.classifyAll(items);
  assert.equal(rows.length, 4, "每条都要被归类，总数必须对账");
  assert.equal(rows[0].category, "game");
  assert.ok(rows[0].confidence <= u.LOCAL_MAX, "离线置信不得越过封顶 " + u.LOCAL_MAX);
  assert.equal(rows[2].category, "unsure", "证据不足必须进待确认，不能硬塞类别");
  assert.ok(rows[2].rawCategory, "待确认要能追溯它本来像哪一类");
  const cand = u.candidateRows(rows);
  assert.ok(!cand.some((r) => r.category === "unsure" || r.category === "other"),
    "待确认 / 其他 永不进候选");
  assert.ok(cand.some((r) => r.mid === "1"));
});

test("导出：CSV 带 UTF-8 BOM、字段顺序固定、换行与制表符压平", () => {
  const rows = [{ mid: "1", nickname: "有,逗号\n和换行\t以及制表符", class: "游戏电竞", confidence: 0.62,
    reason: "命中 游戏", official: "", bio: "", follow_time: 1700000000 }];
  const csv = u.toCsv(rows);
  assert.equal(csv[0], EXT_CSV_BOM, "CSV 必须带 BOM，Excel/WPS 双击才不乱码");
  assert.equal(csv.replace(u.CSV_BOM, "").split("\n")[0], u.CSV_FIELDS.join(","));
  const dataRow = csv.split("\n")[1];
  assert.match(dataRow, /"有,逗号 和换行 以及制表符"/);
  const outsideQuotes = dataRow.replace(/"[^"]*"/g, "\"X\"");
  assert.equal(outsideQuotes.split(",").length, u.CSV_FIELDS.length, "压平加引号之后列数必须正好等于字段数");
});

test("候选清单身与插件/CLI 逐字一致（同一份口径，不能各写一版）", () => {
  assert.equal(u.UNFOLLOW_NOTICE, EXT_UNFOLLOW_NOTICE);
  const txt = u.toUnfollowList([{ mid: "11", nickname: "UP 甲" }, { mid: "22", nickname: "UP 乙" }]);
  const lines = txt.split("\n");
  assert.equal(lines[0], EXT_UNFOLLOW_NOTICE.split("\n")[0]);
  assert.equal(lines[3], "11\tUP 甲", "每行必须是 mid <TAB> 昵称");
  assert.equal(lines[4], "22\tUP 乙");
});

test("Markdown 报告在未读全时明确写出「不作为取关依据」", () => {
  const rows = u.classifyAll([{ mid: "1", nickname: "游戏解说", bio: "游戏攻略" }]);
  const md = u.toMarkdown(rows, { total: 812, fetched: 20, complete: false });
  assert.match(md, /读全：否/);
  assert.match(md, /离线粗分类/);
  assert.match(md, /油猴脚本（只读/);
});

test("UserScript 元数据：只注入关注页，零特权 grant（不给绕过护栏留口子）", () => {
  assert.match(SOURCE, /^\/\/ @match\s+https:\/\/space\.bilibili\.com\/\*\/relation\/follow\*$/m);
  const grants = [...SOURCE.matchAll(/^\/\/ @grant\s+(.*)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(grants, ["none"], "grant 必须是 none：一旦申请特权，只读承诺就不成立");
  assert.match(SOURCE, /^\/\/ @version\s+2\.0\.0$/m);
  assert.match(SOURCE, /^\/\/ @noframes$/m);
});