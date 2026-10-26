// 真实插件 UI 取证截图（FOR-70）
//
// 拍的是 extension/sidepanel.html + sidepanel.css + sidepanel.js 本体：起一个本机静态
// 服务把扩展目录当页面加载，用 chrome.* 的最小替身（storage / runtime / permissions）
// 让侧栏在普通 chromium 里跑起来——FOR-67 已实测本机所有 chromium 形态都不注册未打包
// 扩展，所以走「页面上下文加载真实 UI」这条路（不是手绘 mock，也不是旧 Web 报告界面）。
//
//   node tools/capture_ui.mjs [--from=../docs/qa-report-v2.json]
//                             [--items=../docs/qa-evidence/scan-items.json]
//                             [--out=public/v2] [--allow-fixture]
//
// 取数纪律：截图里的数量同样只能来自取证报告；报告不在就退出码 1。
// 逐条列表镜头需要 FOR-67 另交的抓取快照（--items）；没有它就只拍聚合层，
// 并且把缺失写进 manifest.json，渲染端会因此拒绝出片（--allow-fixture 只做管线自检）。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");            // promo/
const REPO = path.resolve(ROOT, "..");
const EXT = path.join(REPO, "extension");

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.slice(2).includes("--" + name);

const fail = (m) => {
  console.error("[capture_ui] " + m);
  process.exit(1);
};

const FROM = path.resolve(ROOT, arg("from", "../docs/qa-report-v2.json"));
const ITEMS = path.resolve(ROOT, arg("items", "../docs/qa-evidence/scan-items.json"));
const OUT = path.resolve(ROOT, arg("out", "public/v2"));
const FIXTURE_OK = flag("allow-fixture");

if (!fs.existsSync(FROM)) {
  fail("取数文件不存在：" + FROM + "\n  界面截图里的数量也必须来自真实取证会话，报告没落地之前不拍。");
}
const report = JSON.parse(fs.readFileSync(FROM, "utf8"));

let items = null;
if (fs.existsSync(ITEMS)) {
  items = JSON.parse(fs.readFileSync(ITEMS, "utf8"));
  if (!Array.isArray(items) || !items.length) fail("抓取快照不是非空数组：" + ITEMS);
} else if (FIXTURE_OK) {
  console.warn("[capture_ui] --allow-fixture：没有真实抓取快照，逐条列表用占位昵称，只可用于管线自检。");
} else {
  console.warn("[capture_ui] 没有抓取快照（" + ITEMS + "）：只拍聚合层，逐条列表镜头跳过。");
}

// 由 cls.counts 造出「哪个类目有多少人」的 UI 状态；数量全部来自报告。
const counts = report.cls.counts;
const total = report.follow_total;
const byCat = new Map(Object.entries(counts));
const names = items ? items.map((it) => ({ mid: String(it.mid), name: String(it.name || it.mid) })) : null;

const seedItems = (start, end) => {
  if (names) return names.slice(start, end);
  const out = [];
  for (let i = start; i < end; i++) out.push({ mid: String(100000 + i), name: "样本UP主-" + (i + 1) });
  return out;
};

const results = [];
{
  let cursor = 0;
  for (const [cat, n] of byCat.entries()) {
    const slice = seedItems(cursor, cursor + n);
    cursor += n;
    slice.forEach((it, i) =>
      results.push({ mid: it.mid, name: it.name, category: cat, confidence: Math.round((0.62 + (i % 30) / 100) * 100) / 100, source: "llm" })
    );
  }
}

const stateComplete = {
  status: "complete",
  mid: 0,
  total,
  fetched: total,
  pages: report.pages,
  ps: 20,
  resumeFromPn: report.pages,
  incompleteReason: null,
  lastKind: null,
  lastError: null,
  transport: "sw_fetch",
  totalCapped: false,
  startedAt: Date.now() - 180000,
  updatedAt: Date.now(),
};
const statePartial = {
  ...stateComplete,
  status: "incomplete",
  fetched: total - 40,
  pages: report.pages - 2,
  resumeFromPn: report.pages - 1,
  incompleteReason: "rate_limited",
  lastKind: "http_412",
};

const audit = [
  { ts: Date.now() - 90000, event: "scan_complete", fetched: total, pages: report.pages },
  { ts: Date.now() - 80000, event: "classify_shown", mode: "llm", rows: total },
  { ts: Date.now() - 60000, event: "intent_parse", source: "nl", intents: ["keep", "move_to_candidate"], willWrite: false },
  { ts: Date.now() - 40000, event: "unfollow_preview", affected: report.diff.n },
  { ts: Date.now() - 20000, event: "unfollow_done", done: report.unfollow.done },
];

const CHUNK = 100;
const chunkKeys = (arr, prefix) => {
  const out = {};
  for (let i = 0; i < arr.length; i += CHUNK) {
    out[prefix + "." + Math.floor(i / CHUNK)] = arr.slice(i, i + CHUNK);
  }
  return out;
};

const seedBase = {
  follow_items: null,
  "follow_items.count": total,
  scan_state: stateComplete,
  audit_log: audit,
  classify_results_count_placeholder: null,
};

const seedFor = (mode) => {
  const itemsArr = mode === "empty" ? [] : seedItems(0, mode === "partial" ? statePartial.fetched : total);
  const resultsArr = mode === "classified" ? results : [];
  const data = {
    ...seedBase,
    ...chunkKeys(itemsArr, "follow_items"),
    "follow_items.count": itemsArr.length,
    scan_state: mode === "partial" ? statePartial : stateComplete,
    classify_results_count_placeholder: null,
  };
  if (resultsArr.length) {
    Object.assign(data, chunkKeys(resultsArr, "classify_results"));
    data["classify_results.count"] = resultsArr.length;
    data["classify_meta.v1"] = {
      mode: "llm",
      total,
      sendBio: false,
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      model: "byok",
      threshold: 0.55,
      status: "complete",
      unsure: 0,
      unclassified: 0,
      degradedBatches: 0,
      classifiedAt: Date.now(),
    };
    // keep 白名单 + 两个「进候选」类目：diff 预览的人数由它们决定
    data["classify_decisions.v1"] = {
      game: "keep",
      funny: "candidate",
      film: "candidate",
    };
  }
  const auditOut = [];
  for (let i = 0; i < audit.length; i += CHUNK) auditOut.push(...audit.slice(i, i + CHUNK));
  data["audit_log"] = auditOut;
  return data;
};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const server = http.createServer((req, res) => {
  const rel = (req.url || "/").split("?")[0].replace(/^\/+/, "") || "sidepanel.html";
  const file = path.join(EXT, rel);
  if (!file.startsWith(EXT) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port + "/sidepanel.html";

const loadPlaywright = () => {
  try {
    const req = createRequire(path.join(REPO, "tests", "e2e", "placeholder.js"));
    return req("playwright");
  } catch {
    fail("找不到 playwright。先跑：npm --prefix tests/e2e install");
  }
};
const { chromium } = loadPlaywright();

const stub = (seed) => {
  const data = new Map(Object.entries(seed));
  const listeners = [];
  const fire = (changes) => listeners.forEach((fn) => fn(changes, "local"));
  const store = {
    get(keys) {
      if (keys == null) return Promise.resolve(Object.fromEntries(data));
      if (typeof keys === "string") return Promise.resolve(data.has(keys) ? { [keys]: data.get(keys) } : {});
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (data.has(k)) out[k] = data.get(k);
        return Promise.resolve(out);
      }
      const out = {};
      for (const [k, fb] of Object.entries(keys)) out[k] = data.has(k) ? data.get(k) : fb;
      return Promise.resolve(out);
    },
    set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data.get(k), newValue: v };
        data.set(k, v);
      }
      fire(changes);
      return Promise.resolve();
    },
    remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
      return Promise.resolve();
    },
    clear() {
      data.clear();
      return Promise.resolve();
    },
  };
  window.chrome = {
    storage: {
      local: store,
      session: store,
      onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} },
    },
    runtime: {
      id: "capture-ui",
      lastError: null,
      getURL: (p) => p,
      sendMessage: async (msg) => ({ ok: false, unavailable: "capture_ui", kind: String((msg && msg.type) || "unknown") }),
      onMessage: { addListener() {}, removeListener() {} },
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
    },
    tabs: { query: async () => [], create: async () => ({}) },
  };
};

const browser = await chromium.launch({ headless: true });
fs.mkdirSync(OUT, { recursive: true });

const open = async (mode) => {
  const ctx = await browser.newContext({ viewport: { width: 460, height: 1000 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(stub, seedFor(mode));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
};

const shots = [];

// 界面像素必须与取证报告逐一对上；对不上的镜头不许进片（FOR-70 硬条件 4）。
const CHECKS = {
  "scan-partial": (x) => [
    [x.fetched === String(total - 40), "已取 " + x.fetched + " != " + (total - 40)],
    [x.total === String(total), "total " + x.total + " != " + total],
    [/还没读全/.test(x.lock || ""), "读全门禁文案没出现"],
  ],
  "scan-complete": (x) => [
    [x.fetched === String(total) && x.total === String(total), "已取/total 不是 " + total],
    [x.pages === String(report.pages), "页数 " + x.pages + " != " + report.pages],
    [/已读全/.test(x.lock || ""), "解锁文案没出现"],
  ],
  "classify-cards": (x) => [
    [x.cats === byCat.size, "分类卡片 " + x.cats + " 张 != " + byCat.size + " 类"],
    [(x.classifySummary || "").includes(String(total)), "分类概览里没有 " + total],
  ],
  "command-bar": (x) => [
    [/影响 \d+ 人/.test(x.intent || ""), "意图条里没有人数"],
    [!!x.cmdSource, "指令来源标签缺失"],
  ],
  "diff-preview": (x) => [
    [/影响 \d+ 人/.test(x.unfollowPreview || ""), "diff 预览没有人数"],
    [(x.unfollowPreview || "").includes("手输 UNFOLLOW"), "预览里没有 UNFOLLOW 提示"],
    [((x.unfollowPreview || "").match(/影响 (\d+) 人/) || [])[1] === String(report.diff.n),
      "diff 预览 " + ((x.unfollowPreview || "").match(/影响 (\d+) 人/) || [])[1] + " != 报告 diff.n " + report.diff.n],
  ],
  "guardrail-risk": (x) => [[(x.dialogsOpen || []).includes("risk-dialog"), "二次确认卡没打开"]],
  "unfollow-token": (x) => [[(x.dialogsOpen || []).includes("unfollow-dialog"), "UNFOLLOW 确认卡没打开"]],
  "audit-list": (x) => [[x.auditRows >= 5, "审计只有 " + x.auditRows + " 条"]],
};

const snap = async (page, name) => {
  const el = await page.$("body");
  const file = path.join(OUT, name + ".png");
  await el.screenshot({ path: file });
  const probe = await page.evaluate(() => {
    const txt = (id) => { const e = document.querySelector(id); return e ? String(e.textContent || "").trim() : null; };
    const count = (sel) => document.querySelectorAll(sel).length;
    return {
      pill: txt("#status-pill"),
      fetched: txt("#stat-fetched"),
      total: txt("#stat-total"),
      pages: txt("#stat-pages"),
      progress: txt("#progress-line"),
      lock: txt("#classify-lock"),
      classifySummary: txt("#classify-summary"),
      cats: count("#category-list li"),
      cmdSource: txt("#cmd-source"),
      intent: txt("#intent-preview"),
      unfollowPreview: txt("#unfollow-preview"),
      unfollowState: txt("#unfollow-state"),
      auditRows: count("#audit-list li"),
      dialogsOpen: Array.from(document.querySelectorAll("dialog")).filter((d) => d.open).map((d) => d.id),
      ink: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200),
    };
  });
  const rules = CHECKS[name] ? CHECKS[name](probe) : [];
  const bad = rules.filter((r) => !r[0]).map((r) => r[1]);
  shots.push({ name, file: path.relative(REPO, file).replace(/\\/g, "/"), usable: bad.length === 0, unusableReason: bad.join("; ") || null, probe });
  console.log("  拍了 " + name + (bad.length ? " [不合格: " + bad.join("; ") + "]" : "") + " :: " + JSON.stringify(probe).slice(0, 200));
};

const SHOTS = [];
async function step(name, fn) {
  try {
    await fn();
    SHOTS.push({ name, ok: true });
  } catch (e) {
    SHOTS.push({ name, ok: false, error: String(e && e.message ? e.message : e) });
    console.error("  跳过 " + name + "：" + (e && e.message ? e.message : e));
  }
}

let h;
h = await open("partial");
await snap(h.page, "scan-partial");
await h.ctx.close();

h = await open("complete");
await snap(h.page, "scan-complete");
await h.ctx.close();

h = await open("classified");
await snap(h.page, "classify-cards");
await step("command-bar", async () => {
  await h.page.fill("#cmd-input", "保留所有游戏区的，把搞笑段子和影视解说都清掉");
  await h.page.click("#btn-cmd-parse");
  await h.page.waitForTimeout(600);
  await snap(h.page, "command-bar");
});
await step("guardrail-risk", async () => {
  await h.page.click("#unfollow-switch");
  await h.page.waitForTimeout(400);
  await snap(h.page, "guardrail-risk");
  await h.page.click("#risk-ack");
  await h.page.click("#risk-accept");
  await h.page.waitForTimeout(400);
});
await step("diff-preview", async () => {
  await h.page.click("#btn-unfollow-preview");
  await h.page.waitForTimeout(700);
  await snap(h.page, "diff-preview");
});
await step("unfollow-token", async () => {
  await h.page.click("#btn-unfollow-exec");
  await h.page.waitForTimeout(500);
  await snap(h.page, "unfollow-token");
});
await snap(h.page, "audit-list");
await h.ctx.close();

await browser.close();
server.close();

const manifest = {
  generatedAt: new Date().toISOString(),
  numbersFrom: path.relative(REPO, FROM).replace(/\\/g, "/"),
  reportGeneratedAt: report.generated_at,
  tracks: report.tracks,
  itemsFrom: names ? path.relative(REPO, ITEMS).replace(/\\/g, "/") : null,
  syntheticNames: !names,
  allowFixture: FIXTURE_OK,
  shots,
  steps: SHOTS,
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

const failed = SHOTS.filter((s) => !s.ok);
const unusable = shots.filter((s) => !s.usable);
console.log("[capture_ui] 完成 " + shots.length + " 张 -> " + path.relative(REPO, OUT) +
  (failed.length ? "；失败 " + failed.length + " 步" : "") + (unusable.length ? "；不合格 " + unusable.length + " 张" : ""));
if (!shots.length) fail("一张都没拍到");
if (unusable.length) fail("像素与报告对不上，这些镜头不许进片：" + unusable.map((u) => u.name + "=" + u.unusableReason).join(" | "));
if (failed.length && !FIXTURE_OK) fail("有镜头没拍到：" + failed.map((f) => f.name + "=" + f.error).join(" | "));