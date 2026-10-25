// 导出格式口径：与 CLI（src/bili/export.py、score.py）交叉断言（FOR-63 验收 6 + 7）。
// 两头漂移过一次就会重演 v2-spec §2.1 担心的双实现问题，所以这里不写「期望字符串」，
// 直接把 Python 常量抓出来比对。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CSV_BOM, CSV_FIELDS, SIGNALS, UNFOLLOW_NOTICE, UNKNOWN_SIGNAL_LABEL,
  mdCell, providedSignals, signalWarning, toCsv, toMarkdown, toResultRows, toUnfollowList,
} from "../../extension/report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const EXPORT_PY = fs.readFileSync(path.join(ROOT, "src", "bili", "export.py"), "utf8");
const SCORE_PY = fs.readFileSync(path.join(ROOT, "src", "bili", "score.py"), "utf8");

/** 把 Python 里 `X = ( "a" "b" )` 的隐式拼接还原成一个字符串。 */
function pyJoinedConstant(name) {
  const block = new RegExp(name + " = \\(([\\s\\S]*?)\\n\\)").exec(EXPORT_PY);
  assert.ok(block, "export.py 里找不到常量 " + name);
  const raw = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
  // 还原 Python 源码里的转义（\n 是真换行）
  return raw.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

test("CSV：带 BOM，字段名与顺序 = export.to_csv 的 fields", () => {
  const pyBlock = /def to_csv[\s\S]*?fields = \[([\s\S]*?)\]/.exec(EXPORT_PY);
  assert.ok(pyBlock, "export.py to_csv 的 fields 找不到");
  const pyFields = [...pyBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(CSV_FIELDS, pyFields, "CSV 字段必须与 CLI 完全一致");

  const rows = toResultRows([{ mid: "7", nickname: "阿站", bio: "做数码" }]);
  const csv = toCsv(rows);
  assert.equal(csv.charCodeAt(0), 0xfeff, "CSV 必须带 UTF-8 BOM（FOR-38）");
  assert.equal(csv.slice(0, CSV_BOM.length), CSV_BOM);
  const lines = csv.slice(1).trim().split("\n");
  assert.equal(lines[0], CSV_FIELDS.join(","));
  assert.equal(lines[1].startsWith("7,阿站,unclassified,"), true, lines[1]);
  assert.ok(lines[1].includes("relevance"), "有简介就是 relevance 信号");
  assert.ok(lines[1].includes("recency;authority"), "缺的信号要写进 missing_signals");
});

test("CSV 数据层不做显示转义，但按 RFC4180 包引号（昵称里有逗号/引号/换行）", () => {
  const rows = toResultRows([{ mid: "1", nickname: '张三, "P大的" 简介', bio: "b" }]);
  const line = toCsv(rows).slice(1).trim().split("\n")[1];
  assert.ok(line.includes('"张三, ""P大的"" 简介"'), line);
});

test("Markdown：结构与 export.to_markdown 一致，昵称过单元格转义（FOR-58）", () => {
  const rows = toResultRows([
    { mid: "1", nickname: "带|竖线的昵称", bio: "简介一" },
    { mid: "2", nickname: "<img onerror=alert(1)>", bio: "" },
    { mid: "3", nickname: "换行\n昵称", bio: "简介三" },
  ]);
  const md = toMarkdown(rows, { state: { status: "complete", fetched: 3, total: 3, pages: 1 } });
  assert.ok(md.startsWith("# Bili Clean Follow Report\n"), md.slice(0, 40));
  assert.ok(md.includes("Total follows: 3"));
  assert.ok(md.includes("## UNCLASSIFIED (3)"), "本预览版只有抓全清单，不打分不分类");
  assert.ok(md.includes("| # | Name | Score | Signals | Last seen (d) | Last video (d) | Reason |"));
  assert.ok(md.includes("带\\|竖线的昵称"), "竖线必须转义，否则表格列会错位");
  assert.ok(md.includes("&lt;img onerror=alert(1)&gt;"), "昵称里的 HTML 不得在 Markdown 预览里执行");
  assert.ok(md.includes("换行 昵称") && !md.includes("换行\n昵称"), "换行会把一行截成两行");
  assert.ok(md.includes(UNKNOWN_SIGNAL_LABEL), "只有昵称时 Signals 显示「未知」");
  assert.ok(md.includes(UNKNOWN_SIGNAL_LABEL) === EXPORT_PY.includes('UNKNOWN_SIGNAL_LABEL = "未知"'));
});

test("缺 recency 过半时顶部打警告（与 export.signal_warning 同口径）", () => {
  const rows = toResultRows([
    { mid: "1", nickname: "a", bio: "x", last_seen_days: 3 },
    { mid: "2", nickname: "b", bio: "y" },
    { mid: "3", nickname: "c", bio: "z" },
  ]);
  const warning = signalWarning(rows);
  const pyHint = pyJoinedConstant("SIGNAL_FILL_HINT");
  assert.equal(toMarkdown(rows, {}).includes(pyHint), true, "警告文案必须与 CLI 一字不差");
  assert.match(warning, /^缺信号警告 missing-signal warning: 2\/3 \(67%\) 的记录没有 recency 信号。/);
  const allHave = toResultRows([
    { mid: "1", nickname: "a", bio: "x", last_seen_days: 1 },
    { mid: "2", nickname: "b", bio: "y", last_video_days: 2 },
  ]);
  assert.equal(signalWarning(allHave), "");
});

test("信号字段互补：signals_used 与 missing_signals 无交集且并集 = score.py SIGNALS", () => {
  const pySignals = /SIGNALS = \(([^)]*)\)/.exec(SCORE_PY)[1];
  const names = [...pySignals.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(SIGNALS, names);

  const row = toResultRows([{ mid: "1", nickname: "a", bio: "有简介", follower_count: 10,
    following_count: 20 }])[0];
  assert.deepEqual(providedSignals(row).sort(), ["authority", "relevance"]);
  const used = row.signals_used.split(";").filter(Boolean);
  const missing = row.missing_signals.split(";").filter(Boolean);
  assert.deepEqual(new Set(used.concat(missing)), new Set(names));
  assert.equal(used.filter((s) => missing.includes(s)).length, 0);
});

test("取关候选清单：抬头三行与 export.UNFOLLOW_NOTICE 逐字一致，行格式 mid<TAB>昵称", () => {
  const pyNotice = pyJoinedConstant("UNFOLLOW_NOTICE").replace(/\n$/, "");
  assert.equal(UNFOLLOW_NOTICE, pyNotice);
  const rows = [
    { follower_id: "1", mid: "1", nickname: "留着的人", class: "keep" },
    { follower_id: "2", mid: "2", nickname: "要清的人", class: "remove" },
    { follower_id: "3", mid: "3", nickname: "用户勾掉的候选", class: "unclassified", candidate: true },
  ];
  const out = toUnfollowList(rows);
  assert.deepEqual(out.split("\n").slice(0, 3), pyNotice.split("\n"));
  assert.ok(out.endsWith("\n"), "与 CLI 一样以换行收尾");
  assert.deepEqual(out.trimEnd().split("\n").slice(3), ["2\t要清的人", "3\t用户勾掉的候选"]);
  assert.ok(!out.includes("留着的人"), "keep 里的人不得进入候选清单");
});

test("导出文件里没有 Cookie / Key（FOR-63 验收 7）", () => {
  const dirty = [
    { mid: "1", nickname: "SESSDATA=abcdefghijklmnop", bio: "简介" },
    { mid: "2", nickname: "正常昵称", bio: "bili_jct: abcdef123456789" },
    { mid: "3", nickname: "sk-abcdefghijklmno", bio: "b" },
  ];
  const rows = toResultRows(dirty);
  for (const text of [toMarkdown(rows, {}), toCsv(rows), toUnfollowList(rows)]) {
    assert.ok(!/SESSDATA=[A-Za-z0-9]/.test(text), text.slice(0, 80));
    assert.ok(!/bili_jct[=: ]+[A-Za-z0-9]{8,}/.test(text));
    assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(text));
  }
  assert.ok(toCsv(rows).includes("[redacted:cookie_SESSDATA]"), "凭据形态要被替换掉而不是原样写出去");
});

test("抓全状态写进报告：incomplete 的清单必须自证不完整", () => {
  const rows = toResultRows([{ mid: "1", nickname: "a", bio: "b" }]);
  const partial = toMarkdown(rows, { state: { status: "incomplete", fetched: 431, total: 812,
    pages: 22, incompleteReason: "risk_control" } });
  assert.ok(partial.includes("抓全状态：已取 431/812"));
  assert.ok(partial.includes("不得作为取关依据"));
  const full = toMarkdown(rows, { state: { status: "complete", fetched: 1, total: 1, pages: 1 } });
  assert.ok(full.includes("抓全状态：已取 1/1"));
  assert.ok(full.includes("v2 插件预览版（FOR-63）"));
});
