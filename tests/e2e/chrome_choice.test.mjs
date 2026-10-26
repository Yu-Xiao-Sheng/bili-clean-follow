// FOR-67 A 轨夹具选择门禁（L1）。
// 这条测试的存在理由：FOR-71 在 47499ec 上重跑 A 轨时，本机 tests/e2e/browser/chrome/ 下并存
// 三个 Chrome for Testing 构建，旧实现 readdirSync 后取 hit[0] —— 字典序最小的 126 被选中，
// 而 126 没有浏览器级 CDP 的 Extensions.loadUnpacked，默认跑法直接退 2 报「A 轨未取证」。
// 突变验证：把 findChromeForTesting 的字典序取法塞回去，下面第 1、2、4 条判红。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildVersion, listChromeBuilds, selectChromeForExtensionTest } from "./chrome_choice.mjs";

/** 造一棵假的 browser/chrome 目录：只有目录名与 exe 文件在位即可，探针是被 stub 掉的。 */
function fakeCftRoot(dirs, { arch = "win64" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-cft-"));
  for (const dir of dirs) {
    const exePath = dir.startsWith("linux64-")
      ? path.join(root, dir, "chrome-linux64", "chrome")
      : path.join(root, dir, "chrome-win64", "chrome.exe");
    if (dir.endsWith("NO_EXE")) { fs.mkdirSync(path.dirname(exePath), { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, "");
  }
  void arch;
  return root;
}

test("多构建并存时按版本号数值降序选，不是 readdirSync 的第一个", () => {
  const root = fakeCftRoot(["win64-126.0.6478.127", "win64-134.0.6998.88", "win64-156.0.8078.47"]);
  const listed = listChromeBuilds(root);
  assert.deepEqual(listed.map((b) => b.dir), [
    "win64-156.0.8078.47", "win64-134.0.6998.88", "win64-126.0.6478.127",
  ]);
  // 把缺陷本身钉住：按目录原序取第一个，拿到的就是装不进扩展的 126。
  const lexicographic = fs.readdirSync(root).filter((d) => d.startsWith("win64-"))[0];
  assert.equal(lexicographic, "win64-126.0.6478.127");
  assert.notEqual(listed[0].dir, lexicographic);
});

test("版本号比较是数值的：100 排在 99 前（字典序会反过来）", () => {
  const root = fakeCftRoot(["win64-99.0.0", "win64-100.0.0"]);
  assert.deepEqual(listChromeBuilds(root).map((b) => b.dir), ["win64-100.0.0", "win64-99.0.0"]);
  assert.deepEqual(buildVersion("win64-156.0.8078.47"), [156, 0, 8078, 47]);
  assert.equal(buildVersion(".metadata"), null);
});

test("非构建目录与半截下载不参与选择；linux64 走 chrome-linux64/chrome", () => {
  const root = fakeCftRoot(["win64-156.0.8078.47", "win64-140.0.0", "linux64-150.0.0"]);
  fs.writeFileSync(path.join(root, ".metadata"), "{}");
  fs.mkdirSync(path.join(root, "chrome-1248"), { recursive: true });
  fs.rmSync(path.join(root, "win64-140.0.0", "chrome-win64", "chrome.exe"));   // 半截下载：目录在位但 exe 没下全
  const listed = listChromeBuilds(root);
  assert.deepEqual(listed.map((b) => b.dir), ["win64-156.0.8078.47", "linux64-150.0.0"]);
  assert.ok(listed[1].exe.endsWith(path.join("chrome-linux64", "chrome")));
  assert.ok(!listed.some((b) => b.dir === "win64-140.0.0"));   // 没有 exe 的半截下载不入选
});

test("探针会把不支持 Extensions.loadUnpacked 的构建退掉，并把原始报错记进 rejected", async () => {
  const root = fakeCftRoot(["win64-156.0.8078.47", "win64-134.0.6998.88", "win64-126.0.6478.127"]);
  const seen = [];
  const choice = await selectChromeForExtensionTest({
    env: {},
    base: root,
    extDir: "C:/repo/extension",
    probe: async (exe) => {
      const dir = path.basename(path.dirname(path.dirname(exe)));
      seen.push(dir);
      if (dir === "win64-156.0.8078.47") {
        return { ok: false, product: "Chrome/156.0.0", error: "CDP -32601 'Extensions.loadUnpacked' wasn't found" };
      }
      return { ok: true, product: "Chrome/134.0.0", extensionId: "abc" };
    },
  });
  assert.equal(choice.build, "win64-134.0.6998.88");
  assert.equal(choice.source, "cft:win64-134.0.6998.88");
  assert.deepEqual(seen, ["win64-156.0.8078.47", "win64-134.0.6998.88"]);   // 探到能用就停
  assert.equal(choice.rejected.length, 1);
  assert.equal(choice.rejected[0].build, "win64-156.0.8078.47");
  assert.match(choice.rejected[0].error, /Extensions\.loadUnpacked/);
});

test("全部候选都被拒时，rejected 里留齐每一个构建的报错，供报告与 CI 读", async () => {
  const root = fakeCftRoot(["win64-156.0.8078.47", "win64-134.0.6998.88", "win64-126.0.6478.127"]);
  const skips = [];
  const choice = await selectChromeForExtensionTest({
    env: {},
    base: root,
    extDir: "C:/repo/extension",
    probe: async (exe) => ({ ok: false, product: null, error: "CDP -32000 Method not available." }),
    onSkip: (msg) => skips.push(msg),
  });
  assert.equal(choice.source, "none");
  assert.equal(choice.rejected.length, 3);
  assert.deepEqual(choice.rejected.map((r) => r.build),
    ["win64-156.0.8078.47", "win64-134.0.6998.88", "win64-126.0.6478.127"]);
  assert.equal(skips.length, 3);
  assert.equal(choice.exe, path.join(root, "win64-156.0.8078.47", "chrome-win64", "chrome.exe"));
});

test("E2E_CHROME 显式钉构建时不再探针（CI 里钉死版本的用法）", async () => {
  const root = fakeCftRoot(["win64-156.0.8078.47"]);
  const choice = await selectChromeForExtensionTest({
    env: { E2E_CHROME: path.join(root, "win64-156.0.8078.47", "chrome-win64", "chrome.exe") },
    base: root,
    extDir: "C:/repo/extension",
    probe: async () => { throw new Error("E2E_CHROME 在位时不该探针"); },
  });
  assert.equal(choice.source, "env:E2E_CHROME");
  assert.equal(choice.rejected.length, 0);
  assert.ok(choice.exe.endsWith(path.join("chrome-win64", "chrome.exe")));
});

test("E2E_CHROME_PROBE=0 只按版本取最高的那个，不起浏览器", async () => {
  const root = fakeCftRoot(["win64-126.0.6478.127", "win64-156.0.8078.47"]);
  const choice = await selectChromeForExtensionTest({
    env: { E2E_CHROME_PROBE: "0" },
    base: root,
    extDir: "C:/repo/extension",
    probe: async () => { throw new Error("关掉探针就不该起浏览器"); },
  });
  assert.equal(choice.build, "win64-156.0.8078.47");
  assert.equal(choice.source, "version-only:win64-156.0.8078.47");
});
