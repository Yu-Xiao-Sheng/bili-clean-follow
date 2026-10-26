// 发布门禁的可执行证明（FOR-68）：报告没 Go 就打包不了 v2.0.0。
//
// 为什么单独一份测试：CEO 的口径是「报告不存在或结论 No-Go 时不得打包、不得建 tag / Release」。
// 这条如果只写在文档里，它就是一条会被人忘记的提醒；写进 tools/package_release.mjs 之后，
// 它必须能被测试证明「缺报告时真的会红」，否则门禁只是装饰。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkManifest, readReportDecision, checkReportJson, runGates, buildZip, verifyZip, collectExtensionFiles,
  QA_JSON_FIELDS, QA_TRACK_LABELS,
} from "../../tools/package_release.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-" + name + "-"));
  return dir;
}

/** 造一棵最小假扩展树（正式版号 + 最小 host 集），用来验「报告 Go 时确实放行」。 */
function fakeExt(version = "2.0.0") {
  const dir = tmp("ext");
  fs.mkdirSync(path.join(dir, "content"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "fake", version,
    permissions: ["sidePanel", "storage"],
    host_permissions: ["https://api.bilibili.com/*", "https://www.bilibili.com/*", "https://space.bilibili.com/*"],
    background: { service_worker: "background.js", type: "module" },
    action: { default_popup: "popup.html" },
    side_panel: { default_path: "sidepanel.html" },
    content_scripts: [{ matches: ["https://space.bilibili.com/*/relation/follow*"], js: ["content/followpage.js"] }],
  }));
  for (const f of ["background.js", "popup.html", "sidepanel.html", "content/followpage.js"]) {
    fs.writeFileSync(path.join(dir, f), "// stub\n");
  }
  return dir;
}

function goodReport() {
  const dir = tmp("report");
  const md = path.join(dir, "qa-report-v2.md");
  fs.writeFileSync(md, "# v2 三轨取证报告\n\n## 结论\n\n发布结论：Go\n");
  const json = path.join(dir, "qa-report-v2.json");
  fs.writeFileSync(json, JSON.stringify({
    follow_total: 62, pages: 3, cls: { counts: { game: 20, tech: 20, news: 22 } },
    diff: { n: 30 }, unfollow: { done: 12 }, tracks: { A: "mock", B: "real", C: "offline" },
    env: { os: "linux", chrome: "156", node: "24", playwright: "1.64", python: "3.12" }, generated_at: "2026-10-26T00:00:00Z",
  }));
  return { dir, md, json };
}

test("报告缺失：门禁退出码 1，且文案点明是报告问题（不是「找不到文件」这种含糊话）", () => {
  const missing = path.join(tmp("noreport"), "qa-report-v2.md");
  const verdict = readReportDecision(missing);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 1);
  assert.match(verdict.why, /报告缺失/);
  assert.match(verdict.why, /不得建 tag \/ Release/);
  const gates = runGates({ extDir: fakeExt(), reportMd: missing, reportJson: missing + ".json" });
  assert.equal(gates.ok, false);
  assert.equal(gates.code, 1);
});

test("报告结论 No-Go：退出码 2，与「没跑」区分开", () => {
  const { dir, json } = goodReport();
  const md = path.join(dir, "qa-report-v2.md");
  fs.writeFileSync(md, "# 报告\n\n## 结论\n\n发布结论：No-Go（B 轨未取证）\n");
  const verdict = readReportDecision(md);
  assert.equal(verdict.code, 2);
  assert.match(verdict.why, /No-Go/);
  const gates = runGates({ extDir: fakeExt(), reportMd: md, reportJson: json });
  assert.equal(gates.ok, false, "No-Go 时不得放行");
  assert.equal(gates.code, 2);
});

test("报告里没有可读出的结论行：同样不放行", () => {
  const dir = tmp("noconclusion");
  const md = path.join(dir, "qa-report-v2.md");
  fs.writeFileSync(md, "# 报告\n\n跑了一些用例，通过率 90%。\n");
  assert.equal(readReportDecision(md).ok, false);
});

test("报告 Go + json 契约齐：放行（门禁不是「一律红」的摆设）", () => {
  const { md, json } = goodReport();
  const gates = runGates({ extDir: fakeExt(), reportMd: md, reportJson: json });
  assert.equal(gates.ok, true, JSON.stringify(gates.problems));
  assert.deepEqual(gates.problems, []);
});

test("json 契约：缺字段 / 对账不上 / B 轨不是 real —— 逐一拦下", () => {
  const { dir, md } = goodReport();
  const bad = (obj) => {
    const json = path.join(dir, "bad-" + Math.random().toString(36).slice(2) + ".json");
    fs.writeFileSync(json, JSON.stringify(obj));
    return checkReportJson(json, md);
  };
  const base = {
    follow_total: 62, pages: 3, cls: { counts: { game: 20, tech: 20, news: 22 } },
    diff: { n: 30 }, unfollow: { done: 12 }, tracks: { A: "mock", B: "real", C: "offline" },
  };
  assert.ok(bad({ ...base, cls: undefined }).some((p) => /缺字段 cls/.test(p)));
  assert.ok(bad({ ...base, cls: { counts: { game: 61 } } }).some((p) => /sum\(cls\.counts\)/.test(p)),
    "分类条数与关注条数对账不上必须拦（B5）");
  assert.ok(bad({ ...base, diff: { n: 5 }, unfollow: { done: 12 } }).some((p) => /D2/.test(p)),
    "实际执行数超过 diff 预览必须拦（D2）");
  assert.ok(bad({ ...base, unfollow: { done: 80 } }).some((p) => /D3/.test(p)), "单次 50 上限必须拦（D3）");
  assert.ok(bad({ ...base, tracks: { A: "real", B: "mock", C: "real" } }).some((p) => /B 轨/.test(p)),
    "把 mock 当真实会话发出去必须拦（FOR-67 硬条件①/④）");
  assert.ok(bad({ ...base, tracks: { A: "mock", B: undefined, C: "offline" } }).some((p) => /B 轨/.test(p)));
});

test("扩展形态：预发布版本号 / manifest 引用缺失 / host 权限超集，都不得进 release", () => {
  const pre = fakeExt("2.0.0-alpha.3");
  assert.ok(checkManifest(pre).some((p) => /不是正式版号/.test(p)),
    "2.0.0-alpha.3 这种号不能拿去打 v2.0.0 tag");
  fs.rmSync(path.join(pre, "sidepanel.html"));
  assert.ok(checkManifest(pre).some((p) => /manifest 引用的文件缺失/.test(p)));
  const wide = fakeExt("2.0.0");
  const mf = JSON.parse(fs.readFileSync(path.join(wide, "manifest.json"), "utf8"));
  mf.host_permissions = [...mf.host_permissions, "https://evil.example.com/*"];
  fs.writeFileSync(path.join(wide, "manifest.json"), JSON.stringify(mf));
  assert.ok(checkManifest(wide).some((p) => /超出最小集/.test(p)));
  const narrow = fakeExt("2.0.0");
  const mf2 = JSON.parse(fs.readFileSync(path.join(narrow, "manifest.json"), "utf8"));
  mf2.host_permissions = ["https://api.bilibili.com/*"];
  fs.writeFileSync(path.join(narrow, "manifest.json"), JSON.stringify(mf2));
  assert.ok(checkManifest(narrow).some((p) => /缺 https/.test(p)));
  assert.deepEqual(checkManifest(fakeExt("2.0.0")), []);
});

test("zip：可复现（两次字节一致）+ 自检能抓出缺文件", () => {
  const entries = [
    { rel: "manifest.json", data: Buffer.from('{"manifest_version":3}\n', "utf8") },
    { rel: "background.js", data: Buffer.from("export const x = 1;\n", "utf8") },
    { rel: "content/followpage.js", data: Buffer.from("(function(){})();\n", "utf8") },
  ];
  const a = buildZip(entries);
  const b = buildZip(entries);
  assert.ok(Buffer.compare(a, b) === 0, "同一棵树两次打包必须字节一致，否则 sha256 无意义");
  const check = verifyZip(a, entries);
  assert.ok(check.ok, JSON.stringify(check.problems));
  assert.deepEqual(check.names, ["manifest.json", "background.js", "content/followpage.js"]);
  const tampered = verifyZip(a, [...entries, { rel: "sidepanel.html", data: Buffer.from("x") }]);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.problems.some((p) => /zip 里缺 sidepanel\.html/.test(p)));
});

test("打包器不碰依赖目录：node_modules 与 .git 不进 zip", () => {
  const dir = fakeExt("2.0.0");
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "// nope\n");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
  const rels = collectExtensionFiles(dir).map((f) => f.rel);
  assert.ok(!rels.some((r) => r.startsWith("node_modules")), "依赖目录一旦进 zip，解压即用与体积都崩");
  assert.ok(!rels.includes(".DS_Store"));
});

test("门禁常量与 tests/test_release_hygiene.py 的兄弟文件契约同口径（只留一份真相）", () => {
  const py = fs.readFileSync(path.join(REPO, "tests", "test_release_hygiene.py"), "utf8");
  const fields = /QA_JSON_FIELDS = \(([^)]*)\)/.exec(py)[1].match(/"([^"]+)"/g).map((s) => s.replace(/"/g, ""));
  const tracks = /QA_TRACK_LABELS = \(([^)]*)\)/.exec(py)[1].match(/"([^"]+)"/g).map((s) => s.replace(/"/g, ""));
  assert.deepEqual(QA_JSON_FIELDS, fields, "qa-report-v2.json 字段口径在 Python 与 node 两侧漂移了");
  assert.deepEqual(QA_TRACK_LABELS, tracks, "三轨标注口径漂移");
});

test("FOR-68 交付物在位（工单清单逐条核对，缺一个就红）", () => {
  const need = [
    "userscripts/bili-clean.user.js",
    "docs/extension-install.md",
    "docs/edge-add-ons-submission.md",
    "PRIVACY.md",
    "tools/package_release.mjs",
  ];
  for (const rel of need) assert.ok(fs.existsSync(path.join(REPO, rel)), "缺交付物 " + rel);
  const changelog = fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^## \[2\.0\.0\]/m, "CHANGELOG 没有 v2.0.0 条目");
  assert.match(changelog, /待发布/, "v2.0.0 条目必须写明「待发布」，不能让读者以为已经发了");
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  assert.match(readme, /docs\/extension-install\.md/, "README 没链接图文安装教程");
  assert.match(readme, /userscripts\/bili-clean\.user\.js/, "README 没链接油猴脚本");
  assert.match(readme, /冻结在 v0\.1\.3/, "README 没写 CLI 进维护模式（冻结 v0.1.3，只做安全修复）");
  const privacy = fs.readFileSync(path.join(REPO, "PRIVACY.md"), "utf8");
  assert.ok(!/草案/.test(privacy), "PRIVACY.md 还挂着「草案」：FOR-68 要求定稿");
  assert.match(privacy, /不可撤销/, "PRIVACY.md 要写清取关不可撤销");
  assert.match(privacy, /风控/, "PRIVACY.md 要写清取关有 B站风控风险");
  assert.match(privacy, /userscripts\/bili-clean\.user\.js/, "PRIVACY.md 要覆盖油猴脚本的数据流");
});

test("报告 Go 之前，任何文档都不许挂 v2.0.0 的 Release 下载链接（假链接也是一种假话）", () => {
  const zipLink = /releases\/download\/(v[\w.+-]+)\/bili-clean-follow-([\w.+-]+)\.zip/g;
  for (const rel of ["README.md", "README_en.md", "docs/getting-started.md", "docs/extension-install.md"]) {
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    for (const m of text.matchAll(zipLink)) {
      assert.ok(!/^v2\./.test(m[1]), rel + " 挂着 " + m[1] + " 的 zip 链接，但 v2.0.0 Release 还不存在");
    }
  }
  const install = fs.readFileSync(path.join(REPO, "docs", "extension-install.md"), "utf8");
  assert.match(install, /report|报告/, "安装教程要说明 zip 依赖测试报告");
});
