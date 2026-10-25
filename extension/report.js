// report.js —— 只读报告与导出（Markdown / CSV 带 BOM / 取关候选清单）。
//
// 「沿用 CLI 的产物格式口径」不是口号，是逐字段对齐 src/bili/export.py：
//   CSV 字段名与顺序、CSV 带 UTF-8 BOM（FOR-38：Windows 双击不乱码）、
//   Markdown 表头与列、昵称单元格转义（FOR-58：竖线 / 换行 / <script>）、
//   signals_used 与 missing_signals 互补（recency;authority;relevance）、
//   缺 recency 过半时顶部打警告、取关清单抬头三行原文。
// 改这里任何一处，tests/extension/report_format.test.mjs 会把 export.py 里的
// 对应常量抓出来做交叉断言，防止 JS 与 CLI 两头漂移（v2-spec §2.1 的双实现漂移）。
//
// FOR-63 这一步只出「抓全清单」，不打分不分类：class 固定 unclassified，
// score 留空。取关候选清单只在显式候选（class === "remove" 或 candidate === true）
// 存在时才有行——工具本身不会自动取关。

import { assertSecretFree, redactSecrets } from "./privacy.js";
import { isReadComplete } from "./biliApi.js";

// 与 export.py CSV_ENCODING = "utf-8-sig" 同口径：文件内容前置 BOM。
export const CSV_BOM = "\ufeff";
export const CSV_FIELDS = [
  "follower_id", "nickname", "class", "score",
  "last_seen_days", "last_video_days", "follower_count", "following_count",
  "signals_used", "missing_signals",
];

// 与 export.py UNFOLLOW_NOTICE 逐字一致（测试会从 export.py 抓出来比对）。
export const UNFOLLOW_NOTICE = [
  "# bili-clean-follow · 取关候选清单 (unfollow candidates)",
  "# 这份清单只用于人工核对，工具不会自动取关。Report-only: this tool never unfollows anything by itself.",
  "# 每行格式 format: mid <TAB> 昵称 nickname",
].join("\n");

export const SIGNALS = ["recency", "authority", "relevance"]; // score.py SIGNALS
export const UNKNOWN_SIGNAL_LABEL = "未知"; // export.py UNKNOWN_SIGNAL_LABEL
export const MISSING_RECENCY_WARN_RATIO = 0.5; // export.py MISSING_RECENCY_WARN_RATIO
export const SIGNAL_FILL_HINT =
  "先补 last_seen_days / last_video_days / follower_count / following_count" +
  "（bili-merge 会生成已预填 mid + 昵称的待填模板），否则结果不可作为取关依据。" +
  " Fill those signals (bili-merge writes the fill-in template) before using this" +
  " report as an unfollow basis.";

// v2 预览版：抓全但未分类。这行是新增的（CLI 没有），因为它必须把
// 「这份报告来自读全的列表、还没分类」写进产物，不然用户会误读。
export const READ_STATE_UNCLASSIFIED_NOTE =
  "v2 插件预览版（FOR-63）：本报告只有抓全清单，未打分未分类；" +
  "class 为 unclassified，不可直接作为取关依据。";
export const READ_STATE_INCOMPLETE_WARN =
  "抓全门禁未通过：已取条数不等于关注数，这份清单不完整，" +
  "不得作为取关依据（继续抓取到 fetched == total 再出报告）。";

/** 抓全清单条目 → CLI 结果行（字段与 export.run() 对齐）。 */
export function toResultRows(items, state = {}) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const row = {
      follower_id: String(it.mid ?? it.follower_id ?? ""),
      mid: String(it.mid ?? it.follower_id ?? ""),
      nickname: cleanText(it.nickname),
      bio: cleanText(it.bio),
      class: it.class || "unclassified",
      score: typeof it.score === "number" ? it.score : "",
      reason: cleanText(it.reason),
      last_seen_days: numOrEmpty(it.last_seen_days),
      last_video_days: numOrEmpty(it.last_video_days),
      follower_count: numOrEmpty(it.follower_count),
      following_count: numOrEmpty(it.following_count),
      follow_ts: numOrEmpty(it.followTs),
      source: it.source || "",
      candidate: !!it.candidate,
    };
    const used = providedSignals(row);
    row.signals_used = used.join(";");
    row.missing_signals = SIGNALS.filter((s) => !used.includes(s)).join(";");
    return row;
  });
}

/** score.py _provided() 的 JS 版：信号「有没有」，不是「好不好」。 */
export function providedSignals(row) {
  const out = [];
  for (const name of SIGNALS) {
    if (name === "recency" && (isNum(row.last_seen_days) || isNum(row.last_video_days))) out.push(name);
    if (name === "authority" && isNum(row.follower_count) && isNum(row.following_count)) out.push(name);
    if (name === "relevance" && (String(row.bio || "").trim() || String(row.official || "").trim() || row.verified)) {
      out.push(name);
    }
  }
  return out;
}

export function signalDisplay(row) {
  const used = String(row.signals_used || "").split(";").filter(Boolean);
  return used.length ? used.join(";") : UNKNOWN_SIGNAL_LABEL;
}

export function recencyMissing(row) {
  const missing = String(row.missing_signals || "").split(";").filter(Boolean);
  if (missing.length) return missing.includes("recency");
  const used = String(row.signals_used || "").split(";").filter(Boolean);
  if (used.length) return !used.includes("recency");
  return !isNum(row.last_seen_days) && !isNum(row.last_video_days);
}

export function missingRecencyCount(rows) {
  return rows.filter(recencyMissing).length;
}

/** 与 export.signal_warning() 同口径的一行警告（"" = 无需警告）。 */
export function signalWarning(rows) {
  const total = rows.length;
  if (!total) return "";
  const missing = missingRecencyCount(rows);
  if (missing / total < MISSING_RECENCY_WARN_RATIO) return "";
  return "缺信号警告 missing-signal warning: " + missing + "/" + total + " (" +
    Math.round((missing / total) * 100) + "%) 的记录没有 recency 信号。" + SIGNAL_FILL_HINT;
}

/** Markdown 报告（结构对齐 export.to_markdown）。 */
export function toMarkdown(rows, meta = {}) {
  const lines = ["# Bili Clean Follow Report", "", "Total follows: " + rows.length, ""];
  const stateLine = readStateLine(meta.state);
  if (stateLine) lines.push("> " + stateLine, "");
  if (meta.state && !isReadComplete(meta.state)) {
    lines.push("> " + READ_STATE_INCOMPLETE_WARN, "");
  } else if (allUnclassified(rows)) {
    lines.push("> " + READ_STATE_UNCLASSIFIED_NOTE, "");
    lines.push("");
  }
  const warning = signalWarning(rows);
  if (warning) lines.push("> " + warning, "");

  const byClass = new Map();
  for (const r of rows) {
    const key = r.class || "unclassified";
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(r);
  }
  const order = ["keep", "review", "remove", "unclassified"]
    .filter((c) => byClass.has(c))
    .concat([...byClass.keys()].filter((c) => !["keep", "review", "remove", "unclassified"].includes(c)));
  for (const cls of order) {
    const group = byClass.get(cls);
    lines.push("## " + cls.toUpperCase() + " (" + group.length + ")", "");
    lines.push("| # | Name | Score | Signals | Last seen (d) | Last video (d) | Reason |");
    lines.push("|---|:---|---:|---:|---:|---:|:---|");
    group.forEach((r, i) => {
      lines.push("| " + (i + 1) + " | " + mdCell(r.nickname) + " | " + scoreCell(r.score) +
        " | " + signalDisplay(r) + " | " + fmt(r.last_seen_days) + " | " +
        fmt(r.last_video_days) + " | " + mdCell(String(r.reason || "").slice(0, 120)) + " |");
    });
    lines.push("");
  }
  return guard(finish(finishLines(lines)), "markdown report");
}

/** CSV（含 BOM）。字段与顺序 = CSV_FIELDS，多余字段忽略（同 extrasaction="ignore"）。 */
export function toCsv(rows) {
  const out = [CSV_FIELDS.join(",")];
  for (const r of rows) {
    out.push(CSV_FIELDS.map((f) => csvCell(r[f])).join(","));
  }
  return guard(CSV_BOM + finish(out.join("\n")), "csv export");
}

/** 取关候选清单（.txt）：只有 remove / 显式 candidate 行才进来，工具自己不取关。 */
export function toUnfollowList(rows) {
  const lines = [UNFOLLOW_NOTICE];
  for (const r of rows) {
    if (r.class !== "remove" && !r.candidate) continue;
    const mid = String(r.mid || r.follower_id || "");
    const nickname = String(r.nickname || "").replace(/[\t\r\n]+/g, " ");
    lines.push(mid + "\t" + nickname);
  }
  return guard(finish(lines.join("\n")), "unfollow list");
}

/** 导出前置检查：先遮值形态凭据，再断言干净（FOR-63 验收 7）。 */
function guard(text, where) {
  const safe = redactSecrets(text);
  assertSecretFree(safe, where);
  return safe;
}

function readStateLine(state) {
  if (!state) return "";
  const total = state.total === null || state.total === undefined ? "未知" : state.total;
  const fetched = state.fetched || 0;
  const pages = state.pages || 0;
  const tag = isReadComplete(state) ? "已读全" : "未读全（incomplete）";
  let line = "抓全状态：已取 " + fetched + "/" + total + "，页数 " + pages + "，状态 " + tag;
  if (state.incompleteReason) line += "，原因 " + state.incompleteReason;
  if (state.totalCapped) line += "（total 达到 B站展示上限 2000，需人工核对）";
  return line;
}

function allUnclassified(rows) {
  return rows.length > 0 && rows.every((r) => !r.class || r.class === "unclassified");
}

// --- 单元格转义：逐条对齐 export._md_cell / _html_escape / _clean_pipe ---------
function htmlEscape(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanPipe(s) {
  return s.replace(/\|/g, "\\|");
}

/** Markdown 单元格（FOR-58 顺序要紧：先反斜杠翻倍，再转义竖线）。 */
export function mdCell(value) {
  let s = htmlEscape(value).replace(/\\/g, "\\\\");
  for (const ch of ["\r\n", "\r", "\n", "\t"]) s = s.split(ch).join(" ");
  return cleanPipe(s);
}

/** CSV 单元格：数据层不转义（CSV 只按 RFC4180 引号包裹），与 CLI 一致。 */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function scoreCell(score) {
  return typeof score === "number" && Number.isFinite(score) ? score.toFixed(2) : "-";
}

function fmt(v) {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) && n === Math.floor(n) ? String(Math.floor(n)) : String(v);
}

function numOrEmpty(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isNum(v) {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

function cleanText(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[\r\n\t]+/g, " ").trim();
}

function finishLines(lines) {
  const out = [...lines];
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function finish(text) {
  return text.endsWith("\n") ? text : text + "\n";
}
