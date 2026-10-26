// extension/ 里不许有「调用了但从来没定义」的名字（FOR-67 A 轨真机取证踩到的那类 P0）。
//
// 为什么要有这条：FOR-63 把抓取主路径放进 MV3 service worker 之后，background.js 的
// resolveSelf() 一直调 `fetchJsonSw(...)`，而那个函数在改名后叫 `swFetchJson`。ReferenceError
// 只在真机点「读全我的关注列表」时才炸，182 项 node:test 全绿也照样带着这个坏点。所以把它
// 钉成静态门禁：调用点的名字必须能在本文件里声明、从别的模块 import、或者是已知全局。
//
// 口径（故意保守，宁可漏报不误报）：
//   * 只查「裸调用」：`name(`，前面不是 `.` / `?.`（属性调用不归它管）；
//   * 名字在**整个仓库的 extension/** 里**只出现这一次**，且没有声明、没有 import、不在全局白名单
//     —— 才判红。改名事故（旧名只剩一个调用点）正好落在这条上；参数当函数调、方法调用都不会误报。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const EXT_DIR = path.resolve(import.meta.dirname, "..", "..", "extension");

const KEYWORDS_AND_GLOBALS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "instanceof", "new",
  "delete", "void", "case", "do", "else", "try", "finally", "super", "import", "yield", "await",
  "constructor", "get", "set", "Number", "String", "Boolean", "Array", "Object", "JSON", "Math",
  "Date", "Promise", "Set", "Map", "WeakMap", "WeakSet", "RegExp", "Error", "TypeError",
  "RangeError", "SyntaxError", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch",
  "console", "structuredClone", "Intl", "Symbol", "Proxy", "Reflect", "BigInt", "globalThis", "URL",
  "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "CSS",
  "getComputedStyle", "requestAnimationFrame", "alert", "confirm", "prompt", "localStorage",
  "sessionStorage", "btoa", "atob", "matchMedia", "ResizeObserver", "IntersectionObserver",
  "MutationObserver", "Worker", "BroadcastChannel", "CustomEvent", "Event", "EventTarget", "Node",
  "FormData", "Blob", "File", "Response", "Request", "Headers", "XMLHttpRequest", "queueMicrotask",
  "require", "eval", "Function", "WeakRef", "AggregateError", "chrome", "document", "window",
  "navigator", "location", "self", "localStorage",
]);

/** 把注释、字符串、模板串、正则字面量换成空格，避免把文案里的名字当调用。 */
function blind(src) {
  const out = [];
  let i = 0;
  let prevSignificant = "";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out.push(" "); i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out.push(src[i] === "\n" ? "\n" : " "); i++; }
      out.push("  "); i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      prevSignificant = quote;
      continue;
    }
    if (c === "/" && !/[A-Za-z0-9_$)\]]/.test(prevSignificant)) {
      // 正则字面量：上一有效字符不可能是标识符结尾，才是除号
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        else if (src[i] === "\n") { break; }
        out.push(" ");
        i++;
      }
      while (i < src.length && /[a-z]/.test(src[i])) i++;
      prevSignificant = ")";
      continue;
    }
    out.push(c);
    if (/[^\s]/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join("");
}

function jsFiles(dir) {
  const hit = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) hit.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) hit.push(p);
  }
  return hit;
}

/** 本文件声明的名字 + import 进来的名字。 */
function declaredNames(src) {
  const names = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s*\[([^\]]*)\]\s*=/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      for (const part of (m[2] !== undefined ? m[2] : m[1]).split(",")) {
        const name = part.split(/[:=\[\{]/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  // 对象字面量 / 类里的方法简写：`_dump() { ... }` 也是声明（store.js 的调试出口就是这种写法）
  for (const m of src.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) names.add(m[1]);

  for (const m of src.matchAll(/import\s+([^;]*?)\s+from/g)) {
    const clause = m[1];
    for (const part of clause.replace(/[{}]/g, " ").split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] || bits[0] || "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // 参数名也算声明（把参数当函数调是合法写法）
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{|,)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[\s=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/function\s*\*?[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[\s=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

test("extension/ 没有「只出现一次的裸调用」——改名事故会在 CI 红，不用等真机", () => {
  const files = jsFiles(EXT_DIR);
  assert.ok(files.length >= 10, "extension/ 应该有一批模块被这条测试覆盖");
  const texts = new Map(files.map((f) => [f, blind(fs.readFileSync(f, "utf8"))]));
  const whole = [...texts.values()].join("\n");

  const bad = [];
  for (const [file, src] of texts) {
    const declared = declaredNames(src);
    for (const m of src.matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (KEYWORDS_AND_GLOBALS.has(name) || declared.has(name)) continue;
      const occurrences = (whole.match(new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b", "g")) || []).length;
      if (occurrences <= 1) bad.push(path.relative(EXT_DIR, file) + " 调了 " + name + "()，但全仓找不到它的定义");
    }
  }
  assert.deepEqual(bad, [], "extension/ 里存在未定义的调用（真机一点就 ReferenceError）:\n" + bad.join("\n"));
});

test("这条测试自己不是哑弹：旧名 fetchJsonSw 这种残留会被判红", () => {
  const src = blind('async function resolveSelf() {\n  const r = await fetchJsonSw(ENDPOINTS.nav);\n  return r;\n}\n');
  const declared = declaredNames(src);
  const hits = [...src.matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((m) => m[2])
    .filter((name) => !KEYWORDS_AND_GLOBALS.has(name) && !declared.has(name));
  assert.ok(hits.includes("fetchJsonSw"), "突变验证：单文件里只出现一次的裸调用必须被抓出来");
  assert.ok(!hits.includes("resolveSelf"), "自己声明的函数不该被判红");
});
