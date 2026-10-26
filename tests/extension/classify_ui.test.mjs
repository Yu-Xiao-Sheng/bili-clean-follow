// 分类 UI 的静态门禁（FOR-64 验收 3/6）：告知弹窗、按钮禁用口径、类别卡片、体系编辑入口都在位。
//
// 真实浏览器交互由 FOR-67 的 Playwright 三轨套件覆盖；这一层只钉「UI 少东西就红」，
// 避免「功能写了但侧栏里根本没有入口」这种在 FOR-41 里吃过亏的断层。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "extension", "sidepanel.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "extension", "sidepanel.js"), "utf8");

test("读全之前「开始分类」默认 disabled，且离线分类入口独立存在", () => {
  assert.match(html, /<button id="btn-classify"[^>]*disabled>/);
  assert.match(html, /<button id="btn-classify-local"/);
  assert.match(html, /<button id="btn-classify-stop"/);
  assert.ok(js.includes("classificationGate("), "禁用判据必须是分类门禁，不是抓到了几条");
  assert.ok(js.includes("progressLabel(") && js.includes("gate.label"), "没读全时要把「已取 x/total」显示出来");
});

test("AI 分类必须先弹告知：dialog + 逐条文案 + 只发昵称开关 + 撤回确认", () => {
  assert.match(html, /<dialog id="consent-dialog">/);
  assert.match(html, /<ul id="consent-lines"/);
  assert.match(html, /<input id="consent-sendbio" type="checkbox"/);
  assert.ok(js.includes("consentNotice("), "告知文案必须来自 consentNotice，别在 UI 里另写一份措辞");
  assert.ok(js.includes("makeConsent("), "确认要落库（绑定 origin）");
  assert.ok(js.includes("clearConsent()"), "撤回确认 / 换配置的入口要在");
  assert.ok(/typeof consentDialog\.showModal === "function"/.test(js) && js.includes('setAttribute("open"'),
    "showModal 走能力检测并留 open 属性兜底，旧环境不该白屏");
});

test("外发前申请最小 origin 权限，且是在用户手势里 request（装扩展时不预授）", () => {
  assert.ok(js.includes("chrome.permissions.request"), "必须显式申请用户自己填的那个 origin");
  assert.ok(js.includes("chrome.permissions.contains"), "已授权就不重复弹");
  assert.ok(js.includes("ensureHostPermission("), "没拿到权限就退回离线，而不是硬发");
  assert.ok(!js.includes("<all_urls>"), "UI 里不得出现通配 origin");
});

test("Key 只通过 saveApiKey 走独立存储键，UI 不直接写 chrome.storage", () => {
  assert.ok(js.includes("classifyStore.saveApiKey("));
  assert.ok(js.includes("classifyStore.loadApiKey()"));
  assert.ok(!/chrome\.storage\.local\.set\(/.test(js), "UI 不得绕过 privacy 闸直接写存储");
  assert.match(html, /<input id="llm-key" type="password"/, "Key 输入框不能明文回显");
});

test("类别卡片显示数量与占比，并有「保留 / 进候选」与待确认桶", () => {
  assert.match(html, /<ul id="category-list" class="cats">/);
  assert.ok(js.includes("categorySummary("), "数量与占比来自同一处实现");
  assert.ok(js.includes("decisionButton(\"保留\"") && js.includes("decisionButton(\"进候选\""));
  assert.ok(js.includes("UNSURE_CATEGORY"), "「待确认」桶要在 UI 上可见");
  assert.ok(js.includes("keptDisabled") || js.includes("keepBtn.disabled = true"),
    "「待确认/其他」不参与批量决策：按钮要禁用而不是默默允许");
});

test("分类体系编辑入口：改名、关键词、删除、「其他」不可删", () => {
  assert.match(html, /<ul id="taxonomy-list" class="tax">/);
  assert.match(html, /<button id="btn-tax-add"/);
  assert.ok(js.includes("renameCategory(") && js.includes("setCategoryKeywords(") && js.includes("removeCategory("));
  assert.ok(js.includes("del.disabled = cat.id === OTHER_CATEGORY"), "「其他」的删除按钮必须禁用");
});

test("导出沿用「保留类永不进候选」的决策口径", () => {
  assert.ok(js.includes("candidateMids("), "导出的 candidate 列来自同一处硬约束");
  assert.ok(js.includes("classificationBlurb("), "侧栏与报告用同一段来源说明");
});