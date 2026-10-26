// import 图校验：把 extension/ 里每个 import 具名符号对到目标模块的真实导出上。
//
// 为什么单独钉这个：`node --check` 只查语法，不查符号；侧栏少一个导出名就是白屏，
// 而 sidepanel.js / popup.js 依赖 DOM，没法在 node:test 里直接 import 执行。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const EXT = path.join(ROOT, "extension");

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const IMPORT_RE = /import\s+([^;]*?)\s+from\s+["'](\.[^"']+\.js)["']/g;

test("extension/ 里每个 import 的具名符号都能在目标模块里找到（侧栏不会白屏）", async () => {
  const cache = new Map();
  const problems = [];
  for (const file of jsFiles(EXT)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const clause = match[1];
      const target = path.resolve(path.dirname(file), match[2]);
      if (!fs.existsSync(target)) {
        problems.push(path.relative(ROOT, file) + " 引用了不存在的模块 " + match[2]);
        continue;
      }
      if (!cache.has(target)) cache.set(target, await import("file:///" + target.replace(/\\/g, "/")));
      const names = (clause.match(/\{([^}]*)\}/) || [, ""])[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      for (const name of names) {
        if (!(name in cache.get(target))) {
          problems.push(path.relative(ROOT, file) + " 想 import {" + name + "}，但 " +
            path.relative(ROOT, target) + " 没有这个导出");
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("UI 用到的分类能力都从 classify.js 这一个入口拿（避免 UI 自己实现一份门禁）", async () => {
  const text = fs.readFileSync(path.join(EXT, "sidepanel.js"), "utf8");
  for (const name of ["classificationGate", "runClassification", "categorySummary", "candidateMids",
    "createClassifyStore", "classificationBlurb", "preflightGate", "consentNotice", "makeConsent"]) {
    assert.ok(new RegExp("\\b" + name + "\\b").test(text), "sidepanel.js 应该用 classify.js 的 " + name);
  }
  const mod = await import("../../extension/classify.js");
  for (const name of ["classificationGate", "runClassification", "categorySummary", "candidateMids",
    "createClassifyStore", "classificationBlurb", "preflightGate", "consentNotice", "makeConsent"]) {
    assert.ok(name in mod, "classify.js 必须导出 " + name);
  }
});