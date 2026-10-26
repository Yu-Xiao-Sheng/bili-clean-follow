// FOR-70 取数门禁测试：片内数字只能来自取证报告，注入失败就不许渲染。
// 跑法：node --test tests/promo/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  NOT_FILLED,
  buildTable,
  deriveValues,
  fmtWith,
  placeholdersIn,
  resolveValues,
  validateReport,
} from "../../promo/src/numbersCore.mjs";
import { COMPLIANCE, PROMO, WALK } from "../../promo/src/v2-copy.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");
const CLI = path.join(ROOT, "promo", "tools", "fill_numbers.mjs");
const GENERATED = path.join(ROOT, "promo", "src", "numbers.generated.ts");
const REPORT = path.join(ROOT, "docs", "qa-report-v2.json");
const SCRATCH = path.join(ROOT, "tmp", "for70-numbers");

const fixture = () => ({
  follow_total: 826,
  pages: 42,
  cls: {
    counts: {
      game: 214, tech: 168, film: 121, knowledge: 96, food: 61, life: 55,
      funny: 44, music: 28, anime: 21, sports: 9, beauty: 6, news: 3,
    },
  },
  diff: { n: 137 },
  unfollow: { done: 48, hard_limit: 50 },
  tracks: { A: "mock", B: "real", C: "offline" },
  env: { os: "Windows 11", chrome: "134", node: "24", playwright: "1.49", python: "3.12" },
  generated_at: "2026-10-26T09:00:00.000Z",
});

test("契约：合规报告通过，派生量按插件常量推", () => {
  const r = fixture();
  assert.equal(validateReport(r).ok, true, validateReport(r).error);
  const v = deriveValues(r);
  assert.equal(v.partialFetched, 826 - 40, "中断样本 = total - 2 页(20 条/页)");
  assert.equal(v.batchTotal, 21, "批次 = ceil(826/40)，BATCH_SIZE 来自 classifyLlm.js");
  assert.equal(v.categories[0].id, "game", "类目按条数降序");
  assert.equal(v.categories.reduce((a, c) => a + c.n, 0), 826);
});

test("契约：四类不自洽一律判红", () => {
  const drop = structuredClone(fixture());
  drop.cls.counts.game -= 1;
  assert.match(validateReport(drop).error, /sum\(cls\.counts\)/);

  const badDiff = structuredClone(fixture());
  badDiff.diff.n = 12;
  assert.match(validateReport(badDiff).error, /diff\.n/);

  const badTrack = structuredClone(fixture());
  badTrack.tracks.B = "true";
  assert.match(validateReport(badTrack).error, /tracks\.B/);

  const badEnv = structuredClone(fixture());
  delete badEnv.env.chrome;
  assert.match(validateReport(badEnv).error, /env\.chrome/);
});

test("渲染门禁：stub 状态下取数直接抛，不出片", () => {
  const stub = { filled: false, values: null };
  assert.throws(() => resolveValues(stub), (e) => e.message === NOT_FILLED);
  const inconsistent = { filled: true, values: { followTotal: 10, categories: [{ id: "game", n: 9, pct: 90 }] } };
  assert.throws(() => resolveValues(inconsistent), /取数不自洽/);
});

test("文案：所有占位符都有取数来源，替换后不留 {{}}", () => {
  const v = deriveValues(fixture());
  const blob = JSON.stringify({ PROMO, WALK, COMPLIANCE });
  const keys = placeholdersIn(blob);
  assert.ok(keys.length >= 12, "文案里应当确实用到占位符，实得 " + keys.length);
  const out = fmtWith(blob, v);
  assert.match(out, /826/, "follow_total 要真的落进文案");
  assert.doesNotMatch(out, /\{\{/, "不允许有未解析的占位符");
  const table = buildTable(v);
  for (const k of keys) assert.ok(table[k] !== undefined, "占位符 {{" + k + "}} 没有取数来源");
});

test("文案：不得出现手写会话数字（白名单只有护栏常量）", () => {
  const src = fs.readFileSync(path.join(ROOT, "promo", "src", "v2-copy.ts"), "utf8");
  const stripped = src
    .replace(/\/\/.*$/gm, "")
    .replace(/\bv\d+(?:\.\d+)+\b/g, "VERSION")
    .replace(/STEP \d+/g, "STEP_N");
  const hits = (stripped.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) || []).filter(
    (n) => !["50", "200", "800", "12", "0.55"].includes(n)
  );
  assert.deepEqual(hits, [], "v2-copy.ts 里出现裸数字 " + hits.join(", ") + "：数量必须写成 {{占位符}}");
});

test("CLI：报告缺失 / 报告不自洽都会退出码 1，合规报告才生成注入文件", () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const missing = path.join(SCRATCH, "nope.json");
  const outTs = path.join(SCRATCH, "generated.ts");
  if (fs.existsSync(outTs)) fs.rmSync(outTs);

  const r1 = spawnSync(process.execPath, [CLI, "--from=" + missing, "--out=" + outTs], { encoding: "utf8" });
  assert.equal(r1.status, 1, "报告不存在必须失败");
  assert.match(r1.stderr, /真实取证报告/);
  assert.equal(fs.existsSync(outTs), false, "失败时不得写出注入文件");

  const bad = path.join(SCRATCH, "bad.json");
  const badReport = fixture();
  badReport.cls.counts.funny += 3;
  fs.writeFileSync(bad, JSON.stringify(badReport), "utf8");
  const r2 = spawnSync(process.execPath, [CLI, "--from=" + bad, "--out=" + outTs], { encoding: "utf8" });
  assert.equal(r2.status, 1, "分类计数与 total 不符必须失败");
  assert.match(r2.stderr, /sum\(cls\.counts\)/);
  assert.equal(fs.existsSync(outTs), false);

  const good = path.join(SCRATCH, "good.json");
  fs.writeFileSync(good, JSON.stringify(fixture()), "utf8");
  const r3 = spawnSync(process.execPath, [CLI, "--from=" + good, "--out=" + outTs], { encoding: "utf8" });
  assert.equal(r3.status, 0, r3.stderr);
  const gen = fs.readFileSync(outTs, "utf8");
  assert.match(gen, /"filled":\s*true/);
  assert.match(gen, /"followTotal": 826/);
  assert.match(gen, /AUTO-GENERATED/);
});

test("注入文件不得脱离取证报告存在（防手写数字混进片子）", () => {
  const gen = fs.readFileSync(GENERATED, "utf8");
  const filled = /"filled":\s*true/.test(gen);
  if (filled) {
    assert.ok(fs.existsSync(REPORT), "numbers.generated.ts 说已注入，但 docs/qa-report-v2.json 不在——数字是手写的");
  } else {
    console.log("[numbers_gate] 当前是 stub（未注入）：两支 v2 影片此刻渲染必失败，这是预期门禁");
  }
});