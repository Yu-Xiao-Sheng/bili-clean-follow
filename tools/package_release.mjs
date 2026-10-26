#!/usr/bin/env node
// tools/package_release.mjs —— v2.0.0 交付物打包 + 发布门禁（FOR-68 交付物 1）
//
// 这条命令是 CEO 口径的执行装置：**报告不存在或结论 No-Go 时，打包必须失败。**
// 写进代码而不是写进 checklist，因为 checklist 会被忘记，退出码不会。
//
//   node tools/package_release.mjs                 # 过门禁 -> 产出 dist/bili-clean-follow-<version>-extension.zip
//   node tools/package_release.mjs --check         # 只过门禁，不写文件（CI 用）
//   node tools/package_release.mjs --expect-version=2.0.0
//
// 退出码：0 通过；1 门禁不过（报告缺失 / 结论不是 Go / json 契约不符 / 版本号不是正式版）；
//         2 报告结论明确写 No-Go（与 1 分开，方便 CI 上分辨「没跑」与「跑了但不合格」）。
//
// zip 是无依赖实现（node:zlib + 手写 central directory），可复现：条目按路径排序、
// 固定时间戳（SOURCE_DATE_EPOCH，缺省 2026-01-01T00:00:00Z）。同一个树两次打包字节一致，
// Release 附件的 sha256 才有意义。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import process from "node:process";

const REPO = path.resolve(import.meta.dirname, "..");
const EXT_DIR = path.join(REPO, "extension");
const REPORT_MD = path.join(REPO, "docs", "qa-report-v2.md");
const REPORT_JSON = path.join(REPO, "docs", "qa-report-v2.json");

// 与 tests/test_release_hygiene.py 的 QA_JSON_FIELDS / QA_TRACK_LABELS 同口径
// （release_package_gate.test.mjs 会从那份 .py 里抓出来比对，漂移即红）。
const QA_JSON_FIELDS = ["follow_total", "pages", "cls", "diff", "unfollow"];
const QA_TRACK_LABELS = ["mock", "real", "offline"];

// 扩展 host_permissions 的最小集（v2-spec §1.2）：只准 B站三个域。
const MINIMAL_HOSTS = [
  "https://api.bilibili.com/*",
  "https://www.bilibili.com/*",
  "https://space.bilibili.com/*",
];

const SKIP_NAMES = new Set(["node_modules", ".git", ".DS_Store", "Thumbs.db"]);
const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/;   // 2.0.0 可以，2.0.0-alpha.3 不可以

/** 收集要进 zip 的文件，返回 [{ abs, rel }]，按 rel 排序（可复现）。 */
function collectExtensionFiles(extDir = EXT_DIR) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push({ abs, rel });
    }
  };
  walk(extDir, "");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** 读扩展 manifest 并做发布前的形态校验。问题以字符串数组返回（空数组 = 没问题）。 */
function checkManifest(extDir = EXT_DIR) {
  const problems = [];
  const file = path.join(extDir, "manifest.json");
  if (!fs.existsSync(file)) return ["extension/manifest.json 不存在"];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return ["extension/manifest.json 不是合法 JSON：" + err.message];
  }
  if (manifest.manifest_version !== 3) problems.push("manifest_version 必须是 3，收到 " + manifest.manifest_version);
  if (!RELEASE_VERSION_RE.test(String(manifest.version || ""))) {
    problems.push("扩展版本 " + manifest.version + " 不是正式版号（预发布后缀不算 release）：" +
      "发 v2.0.0 之前把 extension/manifest.json 的 version 改成 2.0.0");
  }
  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  for (const h of hosts) {
    if (!MINIMAL_HOSTS.includes(h)) problems.push("host_permissions 超出最小集：" + h);
  }
  for (const need of MINIMAL_HOSTS) {
    if (!hosts.includes(need)) problems.push("host_permissions 缺 " + need + "（抓取主路径要用）");
  }
  // manifest 引用的文件必须真的在树里，否则「解压即用」当场失效。
  const refs = [
    manifest.background && manifest.background.service_worker,
    manifest.action && manifest.action.default_popup,
    manifest.side_panel && manifest.side_panel.default_path,
    ...((manifest.content_scripts || []).flatMap((cs) => cs.js || [])),
  ].filter(Boolean);
  for (const rel of refs) {
    if (!fs.existsSync(path.join(extDir, rel))) problems.push("manifest 引用的文件缺失：" + rel);
  }
  return problems;
}

/**
 * 报告结论解析（唯一权威：docs/qa-report-v2.md 里的结论行）。
 * 返回 { ok, code, why }：code 2 = 明确 No-Go，code 1 = 缺失 / 读不出结论。
 */
function readReportDecision(mdPath = REPORT_MD) {
  if (!fs.existsSync(mdPath)) {
    return { ok: false, code: 1, why: "测试报告缺失：" + path.relative(REPO, mdPath) +
      " 不存在。CEO 口径（FOR-67 / FOR-68）：报告不存在不得打包 v2.0.0，不得建 tag / Release。" };
  }
  const text = fs.readFileSync(mdPath, "utf8");
  const lines = text.split(/\r?\n/);
  const hits = lines.filter((l) => /(发布)?结论|Go\s*\/\s*No-?Go|No-?\s*Go/i.test(l) && /go/i.test(l));
  if (!hits.length) {
    return { ok: false, code: 1, why: "报告里没有可读出的 Go / No-Go 结论行（写一行「发布结论：Go」或「发布结论：No-Go」）。" };
  }
  const line = hits[hits.length - 1].trim();
  if (/no-?\s*go/i.test(line)) return { ok: false, code: 2, why: "报告结论是 No-Go：" + line };
  if (!/\bgo\b/i.test(line)) return { ok: false, code: 1, why: "报告结论行读不出 Go：" + line };
  return { ok: true, code: 0, why: line };
}

/** qa-report-v2.json 契约（与 FOR-67 的兄弟文件门禁同口径）。 */
function checkReportJson(jsonPath = REPORT_JSON, mdPath = REPORT_MD) {
  const problems = [];
  if (!fs.existsSync(jsonPath)) {
    if (fs.existsSync(mdPath)) problems.push("报告 md 在位但 " + path.relative(REPO, jsonPath) +
      " 缺失：FOR-70 取不到片内数字，且发布数字无人核对");
    return problems;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (err) {
    return [path.relative(REPO, jsonPath) + " 不是合法 JSON：" + err.message];
  }
  for (const f of QA_JSON_FIELDS) if (!(f in data)) problems.push("qa-report-v2.json 缺字段 " + f);
  if (problems.length) return problems;
  const counts = data.cls.counts;
  if (!counts || typeof counts !== "object" || !Object.keys(counts).length) {
    problems.push("cls.counts 必须是 类目 -> 条数 的映射");
  } else if (Object.values(counts).reduce((s, n) => s + Number(n || 0), 0) !== Number(data.follow_total)) {
    problems.push("sum(cls.counts) != follow_total（验收清单 B5 对账不上）");
  }
  if (!(Number(data.pages) > 0)) problems.push("pages 必须 > 0");
  const done = Number(data.unfollow.done);
  const diffN = Number(data.diff.n);
  if (!(diffN >= done) || !(done >= 0)) problems.push("diff.n >= unfollow.done >= 0 不成立（D2）");
  if (!(Number(data.unfollow.done) <= 50)) problems.push("unfollow.done <= 50 不成立（D3）");
  for (const t of ["A", "B", "C"]) {
    if (!QA_TRACK_LABELS.includes((data.tracks || {})[t])) {
      problems.push(t + " 轨必须标 mock / real / offline，收到 " + JSON.stringify((data.tracks || {})[t]));
    }
  }
  // CEO 在 FOR-67 上钉的四条 No-Go 硬条件之一：真实登录态轨（B 轨）未取证就不许发布。
  if ((data.tracks || {}).B !== "real") {
    problems.push("B 轨（真实登录态只读 smoke）不是 real：按 FOR-67 硬条件①，缺真实会话不判 Go");
  }
  return problems;
}

/** 全部前置检查。返回 { ok, code, reportLine, problems }。 */
function runGates({ extDir = EXT_DIR, reportMd = REPORT_MD, reportJson = REPORT_JSON, expectVersion = null } = {}) {
  const problems = [];
  problems.push(...checkManifest(extDir));
  if (expectVersion) {
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
    if (String(manifest.version) !== String(expectVersion)) {
      problems.push("扩展版本 " + manifest.version + " 与期望的 " + expectVersion + " 不一致");
    }
  }
  const decision = readReportDecision(reportMd);
  if (!decision.ok) return { ok: false, code: decision.code, reportLine: "", problems: [decision.why] };
  problems.push(...checkReportJson(reportJson, reportMd));
  if (problems.length) return { ok: false, code: 1, reportLine: decision.why, problems };
  return { ok: true, code: 0, reportLine: decision.why, problems: [] };
}

// ---------------------------------------------------------------- zip（store=0 / deflate=8，可复现）

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(epochMs) {
  const d = new Date(epochMs);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  };
}

/** 把 [{ rel, data }] 打成一个 zip Buffer（条目已排序，时间戳固定）。 */
function buildZip(entries, epochMs = Number(process.env.SOURCE_DATE_EPOCH || Date.parse("2026-01-01T00:00:00Z"))) {
  const { date, time } = dosDateTime(epochMs);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { rel, data } of entries) {
    const nameBuf = Buffer.from(rel, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                 // version needed
    local.writeUInt16LE(0x0800, 6);             // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** 自检：把刚写出来的 zip 读回来，逐条比对名字与 CRC（Release 附件不能靠肉眼）。 */
function verifyZip(zipBuf, expected) {
  const names = [];
  let bad = [];
  let p = 0;
  while (p + 4 <= zipBuf.length && zipBuf.readUInt32LE(p) === 0x04034b50) {
    const method = zipBuf.readUInt16LE(p + 8);
    const crc = zipBuf.readUInt32LE(p + 14);
    const compSize = zipBuf.readUInt32LE(p + 18);
    const nameLen = zipBuf.readUInt16LE(p + 26);
    const extraLen = zipBuf.readUInt16LE(p + 28);
    const name = zipBuf.slice(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    const body = zipBuf.slice(start, start + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(body) : body;
    names.push(name);
    if (crc32(raw) !== crc) bad.push(name + " 的 CRC 不匹配");
    p = start + compSize;
  }
  for (const e of expected) if (!names.includes(e.rel)) bad.push("zip 里缺 " + e.rel);
  for (const n of names) if (!expected.some((e) => e.rel === n)) bad.push("zip 里多了没预期的 " + n);
  return { ok: bad.length === 0, names, problems: bad };
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const expectVersion = (args.find((a) => a.startsWith("--expect-version=")) || "").split("=")[1] || null;
  const gates = runGates({ expectVersion });
  if (!gates.ok) {
    console.error("[package_release] 门禁不过（退出码 " + gates.code + "）：");
    for (const p of gates.problems) console.error("  - " + p);
    console.error("  口径来源：FOR-68「禁止：在 qa-report-v2.md 缺失或结论为 No-Go 时建 tag / Release」。");
    process.exit(gates.code);
  }
  console.log("[package_release] 报告门禁通过：" + gates.reportLine);
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  if (checkOnly) {
    console.log("[package_release] --check：只验门禁，不产出 zip（扩展版本 " + manifest.version + "）");
    return;
  }
  const files = collectExtensionFiles();
  const entries = files.map((f) => ({ rel: f.rel, data: fs.readFileSync(f.abs) }));
  const zip = buildZip(entries);
  const check = verifyZip(zip, entries);
  if (!check.ok) {
    console.error("[package_release] zip 自检失败：");
    for (const p of check.problems) console.error("  - " + p);
    process.exit(1);
  }
  const outDir = path.join(REPO, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const outName = "bili-clean-follow-" + manifest.version + "-extension.zip";
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, zip);
  const sha = crypto.createHash("sha256").update(zip).digest("hex");
  console.log("[package_release] 产出 " + path.relative(REPO, outPath) +
    "：" + entries.length + " 个文件，" + zip.length + " 字节，sha256 " + sha);
  console.log("[package_release] 解压即用检查：条目里含 manifest.json / background.js / sidepanel.html，" +
    "零 node_modules（Load unpacked 选这个目录就行）。");
}

export { collectExtensionFiles, checkManifest, readReportDecision, checkReportJson, runGates,
  buildZip, verifyZip, QA_JSON_FIELDS, QA_TRACK_LABELS, MINIMAL_HOSTS, RELEASE_VERSION_RE };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();