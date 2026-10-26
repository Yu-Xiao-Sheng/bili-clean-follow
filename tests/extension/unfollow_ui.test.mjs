// 取关与指令栏的 UI 静态门禁（FOR-65 验收 2/3 的 UI 侧）。
// 真实浏览器交互由 FOR-67 的 Playwright 套件覆盖；这里只钉「侧栏少东西就红」与
// 「护栏只在 unfollow.js 一处实现，UI 不得自己写一份判定」。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "extension", "sidepanel.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "extension", "sidepanel.js"), "utf8");

test("取关开关默认不勾选；批量上限默认 50、max 200、未开启时禁用", () => {
  assert.match(html, /<input id="unfollow-switch" type="checkbox">/, "开关不得默认 checked");
  assert.match(html, /<input id="unfollow-limit" type="number" min="1" max="200" value="50" disabled>/);
  assert.match(html, /<section class="card danger">/, "取关卡片要有明显的危险样式");
  assert.ok(html.includes("默认关闭 · 不可撤销"), "标题就要把风险写出来");
  assert.match(html, /<button id="btn-unfollow-exec" class="danger" disabled>/, "执行按钮默认禁用");
  assert.match(html, /<button id="btn-unfollow-preview" class="ghost" disabled>/);
  assert.match(html, /<button id="btn-unfollow-restore" class="ghost" disabled>/, "一键重新关注（补救）入口必须在位");
  assert.match(html, /<button id="btn-audit-csv" class="ghost" disabled>/, "审计 CSV 导出入口必须在位");
  assert.match(html, /<button id="btn-unfollow-resume" class="ghost" hidden>/, "断点续跑按钮要在位（有断点才显示）");
});

test("手输 UNFOLLOW 的输入框与确认按钮：确认默认禁用，token 常量来自 unfollow.js", () => {
  assert.match(html, /<dialog id="unfollow-dialog">/);
  assert.match(html, /<input id="unfollow-token" type="text"/);
  assert.match(html, /<button id="unfollow-confirm" class="danger" disabled>/);
  assert.ok(js.includes("CONFIRM_TOKEN"), "确认词来自 unfollow.js，UI 不自己定一个");
  assert.ok(js.includes("RESTORE_TOKEN"), "补救的确认词同样来自 unfollow.js");
  assert.ok(!js.includes('=== "UNFOLLOW"') && !js.includes("=== \"REFOLLOW\""),
    "UI 不得硬编码确认词（否则改了常量 UI 还放行）");
  assert.ok(js.includes("unfollowConfirm.disabled = unfollowToken.value.trim() !== want"),
    "输入不匹配就禁用确认");
});

test("UI 只收集确认，判定全在 unfollow.js：开关 / 预览武装 / 速率下限都引用同一处", () => {
  for (const call of [
    "loadWriteSwitch(", "setWriteSwitch(", "riskNotice(", "makeRiskAck(",
    "buildUnfollowPreview(", "armPreview(", "clearArm(", "loadCheckpoint(",
    "buildResumePreview(", "loadAudit(", "toAuditCsv(", "MIN_ITEM_INTERVAL_MS", "HARD_BATCH_LIMIT",
  ]) {
    assert.ok(js.includes(call), "侧栏要引用 unfollow/preview 的实现：" + call);
  }
  assert.ok(js.includes("riskNotice({"), "二次确认文案来自 riskNotice，别在 UI 里另写一份");
  assert.ok(!js.includes("fetch("), "侧栏不得自己发请求：写请求只能由 service worker 发");
  assert.ok(!/chrome\.storage\.local\.set\(/.test(js), "侧栏不得绕过 privacy 闸直接写存储");
  assert.ok(js.includes("EXECUTE_UNFOLLOW") && js.includes("RESTORE_UNFOLLOW"), "写操作只能经 service worker");
});

test("diff 预览在侧栏里看得见：影响条数、按类分组、样例、被挡计数", () => {
  assert.match(html, /<div id="unfollow-preview" class="preview" hidden><\/div>/);
  assert.match(html, /<div id="intent-preview" class="preview" hidden><\/div>/);
  assert.ok(js.includes('head.textContent = "影响 " + preview.affected + " 人'), "预览要写影响条数");
  assert.ok(js.includes("row.count + \" 人 / \" + row.ratio + \"%\""), "按类分组数量与占比（来自 categorySummary）");
  assert.ok(js.includes("昵称 + 简介 + 置信度"), "样例三要素要写清");
  assert.ok(js.includes("preview-blocked"), "被挡在外面的数量要显示（keep / 待确认 / 低置信 / 没表态）");
  assert.ok(js.includes("PREVIEW_NOTICE"), "预览要带「不会立刻取关，只生成候选」这句口径");
});

test("改批量上限就作废预览的武装；应用/回滚意图也作废（预览与执行必须是同一份）", () => {
  const clears = (js.match(/armedHash = null;/g) || []).length;
  assert.ok(clears >= 3, "上限改动 / 意图应用 / 回滚 / 执行失败 都要作废已武装的预览：实际 " + clears + " 处");
  assert.ok(js.includes("await clearArm(unfollowStorage);"));
  assert.ok(js.includes("btnUnfollowExec.disabled = !(writeState.enabled && lastUnfollowPreview && armedHash === lastUnfollowPreview.hash)"),
    "执行按钮只在「开关开 + 看过这份预览」时可用");
});

test("指令栏：解析 -> 预览 -> 确认应用 -> 回滚最近一步，四个动作都有入口", () => {
  assert.match(html, /<input id="cmd-input" type="text"/);
  assert.match(html, /<button id="btn-cmd-parse" class="primary" disabled>/);
  assert.match(html, /<button id="btn-cmd-apply" class="ghost" disabled>/);
  assert.match(html, /<button id="btn-cmd-rollback" class="ghost" disabled>/);
  assert.match(html, /<ul id="op-stack" class="ops"><\/ul>/, "操作栈要在侧栏可见（v2-spec §3.4）");
  assert.ok(js.includes("parseIntent({") && js.includes("applyIntents({") && js.includes("rollbackLast("));
  assert.ok(js.includes("pushOp("), "每一步意图都要入栈，否则回滚无从谈起");
  assert.ok(/确认应用（不会取关）/.test(html), "应用按钮要说清它不取关");
});

test("取关风险的口径写进侧栏脚注，不是只在 README", () => {
  const foot = /<p class="foot">[^<]*取关不可撤销[^<]*<\/p>/;
  assert.match(html, foot);
  assert.ok(html.includes("keep 类、待确认与低置信"), "白名单约束要在 UI 上说出来");
  assert.ok(html.includes("B站没有撤销 API"));
});