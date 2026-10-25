// 「零构建步骤」与 manifest / 外发边界门禁（FOR-63 验收 1，FOR-64 扩到 BYOK 分类）。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PROVIDER_PRESETS } from "../../extension/classifyLlm.js";

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

const files = walk(EXT);
const codeOnly = (file) => fs.readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

test("extension/ 里没有 package.json、node_modules、构建配置（Load unpacked 直接可用）", () => {
  const banned = /(^|[/\\])(node_modules|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.json|webpack\.config\.js|vite\.config\.js|rollup\.config\.js|\.babelrc|bun\.lockb)$/;
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    assert.ok(!banned.test(rel), "扩展目录不该有构建产物/依赖清单：" + rel);
    assert.ok(!/[\\/](dist|build|coverage)[\\/]/.test(rel), rel);
  }
  assert.ok(files.some((f) => f.endsWith(path.join("content", "followpage.js"))), "content script 必须在位");
  for (const mod of ["classify.js", "classifyLocal.js", "classifyLlm.js", "taxonomy.js"]) {
    assert.ok(fs.existsSync(path.join(EXT, mod)), "FOR-64 的分类模块必须在位：" + mod);
  }
});

test("manifest：MV3 + 最小权限（sidePanel/storage/cookies/scripting）+ 最小 host", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(),
    ["cookies", "scripting", "sidePanel", "storage"]);
  assert.deepEqual([...manifest.host_permissions].sort(), [
    "https://api.bilibili.com/*",
    "https://space.bilibili.com/*",
    "https://www.bilibili.com/*",
  ]);
  assert.equal(manifest.background.type, "module", "service worker 必须是 ESM，才能 import biliApi.js");
  assert.ok(manifest.background.service_worker.endsWith(".js"));
  assert.ok(manifest.side_panel.default_path.endsWith("sidepanel.html"));
  assert.ok(manifest.action.default_popup.endsWith("popup.html"));
  for (const host of manifest.host_permissions) {
    assert.ok(host.startsWith("https://"), host);
    assert.ok(!/^\*/.test(host) && !host.includes("<all_urls>"), host);
  }
  // 没有 "tabs"：能读 URL 的是我们已经有 host 权限的那几个域，多余的权限一律不申请
  assert.ok(!manifest.permissions.includes("tabs"));
  assert.ok(!("content_security_policy" in manifest) ||
    !/unsafe-(eval|inline)/.test(manifest.content_security_policy.extension_pages || ""));
});

test("BYOK 的 host 权限走 optional_host_permissions：装好时不预授，用户确认端点时才申请", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const optional = manifest.optional_host_permissions || [];
  assert.ok(optional.length, "AI 分类需要一个可选 host 权限，否则跨域 fetch 走不通");
  for (const entry of optional) {
    assert.ok(!entry.includes("<all_urls>"), entry);
    assert.ok(entry.startsWith("https://") || entry === "http://localhost/*" || entry === "http://127.0.0.1/*",
      "明文 http 只放行本机回环：" + entry);
  }
  // 不申请额外的 Chrome API 权限（optional_permissions 应为空或不存在）
  assert.ok(!manifest.optional_permissions || !manifest.optional_permissions.length,
    "BYOK 只需要 origin，不需要新的 Chrome API 权限");
});

test("每个扩展 JS 都是可解析的 ESM（无编译步骤），核心模块能被 node 直接 import", async () => {
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const tmp = path.join(os.tmpdir(), "bcf-syntax-" + path.basename(file, ".js") + ".mjs");
    fs.copyFileSync(file, tmp);
    const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    assert.equal(res.status, 0, path.relative(ROOT, file) + " 语法检查失败：\n" + res.stderr);
    fs.rmSync(tmp, { force: true });
  }
  for (const mod of ["privacy.js", "biliApi.js", "store.js", "report.js", "background.js",
    "content/followpage.js", "taxonomy.js", "classifyLocal.js", "classifyLlm.js", "classify.js"]) {
    await import("../../extension/" + mod); // 非浏览器环境能加载 = 没有偷偷依赖构建产物
  }
});

test("写操作接口仍然全禁（取关由 FOR-65 带护栏接入，这一版一条都不写）", () => {
  const src = files.filter((f) => f.endsWith(".js"))
    .map(codeOnly)
    .map((text) => text.replace(/export const FORBIDDEN_ENDPOINTS = \[[\s\S]*?\];/, "")) // 黑名单本身不算调用
    .join("\n");
  for (const banned of ["x/relation/delete", "x/relation/add", "x/relation/block", "x/relation/tag"]) {
    assert.ok(!src.includes(banned), "本版不得出现写接口：" + banned);
  }
  // 只读语义：报告产物必须自称 report-only
  assert.ok(src.includes("Report-only: this tool never unfollows anything by itself."));
});

test("外发目的地只有两类：B站自己的域，和用户自己填的 BYOK 预设端点", () => {
  const allowed = new Set([
    "https://api.bilibili.com", "https://www.bilibili.com", "https://space.bilibili.com",
    // 本机回环：这是「数据不出机器」的本地端点写法，不是我们的目的地
    "http://127.0.0.1", "http://localhost",
    ...PROVIDER_PRESETS.map((p) => p.baseUrl).filter(Boolean).map((u) => new URL(u).origin),
  ]);
  const offenders = [];
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const text = codeOnly(file);
    for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)) {
      if (!allowed.has(m[0])) offenders.push(path.relative(ROOT, file) + " -> " + m[0]);
    }
  }
  assert.deepEqual(offenders, [], "出现白名单外的硬编码目的地（我们不做任何中转/遥测）");
  // 只有 classifyLlm.js 允许出现 OpenAI 兼容路径，其它模块连提都不该提
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    if (path.basename(file) === "classifyLlm.js") continue;
    assert.ok(!codeOnly(file).includes("chat/completions"),
      path.relative(ROOT, file) + " 里出现了模型调用路径（外发只允许一处实现）");
  }
});

test("离线/存储/报告模块里没有任何网络原语（离线 = 真的零外发）", () => {
  for (const rel of ["taxonomy.js", "classifyLocal.js", "store.js", "privacy.js", "report.js",
    "content/followpage.js"]) {
    const text = codeOnly(path.join(EXT, rel));
    for (const banned of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "import("]) {
      assert.ok(!text.includes(banned), rel + " 里出现了 " + banned);
    }
  }
});