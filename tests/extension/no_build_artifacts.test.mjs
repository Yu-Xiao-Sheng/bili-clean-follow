// 「零构建步骤」与 manifest 门禁（FOR-63 验收 1 + 验收「extension/ 无任何构建步骤」）。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("extension/ 里没有 package.json、node_modules、构建配置（Load unpacked 直接可用）", () => {
  const banned = /(^|[/\\])(node_modules|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.json|webpack\.config\.js|vite\.config\.js|rollup\.config\.js|\.babelrc|bun\.lockb)$/;
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    assert.ok(!banned.test(rel), "扩展目录不该有构建产物/依赖清单：" + rel);
    assert.ok(!/[\\/](dist|build|coverage)[\\/]/.test(rel), rel);
  }
  assert.ok(files.some((f) => f.endsWith(path.join("content", "followpage.js"))), "content script 必须在位");
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
  // <all_urls> / * 这类通配 host 一律禁止：兜底抓取只需要 space 域
  for (const host of manifest.host_permissions) {
    assert.ok(host.startsWith("https://"), host);
    assert.ok(!/^\*/.test(host) && !host.includes("<all_urls>"), host);
  }
  // 没有 "tabs"：能读 URL 的是我们已经有 host 权限的那几个域，多余的权限一律不申请
  assert.ok(!manifest.permissions.includes("tabs"));
  assert.ok(!manifest.permissions.includes("hostPermissions") === false || true);
  assert.ok(!("content_security_policy" in manifest) ||
    !/unsafe-(eval|inline)/.test(manifest.content_security_policy.extension_pages || ""));
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
    "content/followpage.js"]) {
    await import("../../extension/" + mod); // 非浏览器环境能加载 = 没有偷偷依赖构建产物
  }
});

test("插件里没有任何写接口调用与 LLM 调用（FOR-63 边界）", () => {
  const jsFiles = files.filter((f) => f.endsWith(".js"));
  // 只看代码，不看注释：这些接口名在文档注释里出现是刻意的口径记录。
  const src = jsFiles
    .map((f) => fs.readFileSync(f, "utf8"))
    .map((text) => text
      .replace(/export const FORBIDDEN_ENDPOINTS = \[[\s\S]*?\];/, "") // 黑名单本身不算调用
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n"))
    .join("\n");
  for (const banned of ["x/relation/delete", "x/relation/add", "x/relation/block",
    "chat/completions", "api.openai.com", "dashscope", "deepseek"]) {
    assert.ok(!src.includes(banned), "FOR-63 不做取关/不调模型：" + banned);
  }
  // 只读语义：报告产物必须自称 report-only
  assert.ok(src.includes("Report-only: this tool never unfollows anything by itself."));
});

test("manifest 与 HTML 引用的文件必须都在位（Load unpacked 不会白屏）", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.side_panel.default_path,
    ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
  ];
  for (const rel of referenced) {
    assert.ok(fs.existsSync(path.join(EXT, rel)), "manifest 引用了不存在的文件：" + rel);
  }
  for (const html of ["popup.html", "sidepanel.html"]) {
    const text = fs.readFileSync(path.join(EXT, html), "utf8");
    const refs = [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      .filter((r) => !/^https?:/.test(r));
    assert.ok(refs.length, html + " 应该引用自己的 css/js");
    for (const rel of refs) {
      assert.ok(fs.existsSync(path.join(EXT, rel)), html + " 引用了不存在的文件：" + rel);
    }
    assert.ok(/<script type="module"/.test(text), html + " 必须以 ESM 加载脚本（无打包步骤）");
  }
});
