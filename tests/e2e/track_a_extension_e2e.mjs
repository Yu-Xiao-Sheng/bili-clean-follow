// track_a_extension_e2e.mjs —— A 轨真机取证：真 Chrome + 未打包扩展 + B站接口替身。
//
// 跑法（本机）：
//   node tests/e2e/track_a_extension_e2e.mjs            # 有桌面会话时按 headed 跑（扩展能装）
//   HEADLESS=1 node tests/e2e/track_a_extension_e2e.mjs # new headless；Chrome 156 下扩展装不上，会显式失败
//
// 取证口径：这条轨道的每条断言都标 kind=mock（B站接口是本机替身，不是真实会话）。
// 真实登录态那条是 B 轨，绝不混在这里。
//
// 已知环境门禁（实测 2026-10-26，写进报告别当哑弹）：
//   Chrome for Testing 156.0.8078.47 与 Playwright chromium-1248 都会**忽略** --load-extension，
//   连一个只有 manifest+sw.js 的 hello world 都不注册；CDP Extensions.loadUnpacked 返回
//   Invalid parameters。Playwright 默认还会注入 --disable-extensions（这里已经 ignoreDefaultArgs 摘掉）。
//   结论：A 轨真机取证必须在「扩展可装载」的浏览器形态下跑（Linux CI 的 headed+xvfb，
//   或钉一个仍支持 --load-extension 的 Chrome for Testing 版本）。装不上时本脚本以退出码 2
//   明确失败，不会静默绿。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

import { buildPages, resolverArgs, startMockServer, uniqueMids } from "./mock_bilibili.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const PAGES = [20, 20, 22];
const EXPECT_TOTAL = 62;

function findChromeForTesting() {
  const base = path.join(import.meta.dirname, "browser", "chrome");
  if (!fs.existsSync(base)) return process.env.CFT_PATH || null;
  const hit = fs.readdirSync(base).filter((d) => d.startsWith("win64-") || d.startsWith("linux64-"))
    .map((d) => path.join(base, d, "chrome-win64", "chrome.exe"))
    .filter((p) => fs.existsSync(p));
  return hit[0] || null;
}

function registeredExtensions(profileDir) {
  const file = path.join(profileDir, "Default", "Secure Preferences");
  if (!fs.existsSync(file)) return {};
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")).extensions || {}).settings || {};
  } catch {
    return {};
  }
}

async function launch({ mock, profileDir }) {
  const args = [
    "--disable-extensions-except=" + EXT,
    "--load-extension=" + EXT,
    resolverArgs(mock.port),
    "--ignore-certificate-errors",
    "--test-type",
    "--no-first-run",
  ];
  if (process.env.HEADLESS === "1") args.unshift("--headless=new");
  const executablePath = findChromeForTesting();
  return chromium.launchPersistentContext(profileDir, {
    headless: process.env.HEADLESS !== "1",
    executablePath: executablePath || undefined,
    ignoreDefaultArgs: ["--disable-extensions"],
    args,
  });
}

async function openSidePanel(ctx, profileDir) {
  for (let i = 0; i < 20; i++) {
    const settings = registeredExtensions(profileDir);
    const id = Object.keys(settings).find((key) => {
      const p = settings[key].path || "";
      return p && fs.existsSync(p) && fs.existsSync(path.join(p, "manifest.json")) &&
        fs.readFileSync(path.join(p, "manifest.json"), "utf8").includes("Bili Clean Follow");
    });
    if (id) {
      const page = await ctx.newPage();
      await page.goto("chrome-extension://" + id + "/sidepanel.html", { waitUntil: "domcontentloaded" });
      return { page, id };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const text = (page, sel) => page.textContent(sel).catch(() => "");

async function waitFetched(page, want, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = Number(await text(page, "#stat-fetched"));
    if (got >= want) return got;
    await page.waitForTimeout(500);
  }
  throw new Error("等不到 fetched>=" + want + "（当前 " + (await text(page, "#stat-fetched")) + "）");
}

async function scenarioHappyPath(log) {
  const mock = await startMockServer({ pages: buildPages(PAGES) });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-track-a-"));
  const ctx = await launch({ mock, profileDir });
  const offsite = [];
  ctx.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (!/(bilibili\.com|hdslb\.com|^$)/.test(host) && !req.url().startsWith("chrome-extension://") &&
      !req.url().startsWith("chrome://") && !req.url().startsWith("data:")) offsite.push(req.url());
  });
  try {
    const opened = await openSidePanel(ctx, profileDir);
    if (!opened) {
      const err = new Error("扩展没被注册：--load-extension 在这个浏览器形态下被忽略" +
        "（Chrome for Testing 156 / Playwright chromium-1248 实测如此）。" +
        "A 轨必须在能装载扩展的形态下跑：Linux CI headed+xvfb，或钉旧版 Chrome for Testing。");
      err.code = "EXTENSION_NOT_LOADED";
      throw err;
    }
    const { page, id } = opened;
    log.extensionId = id;

    // B2：抓全之前「开始分类」必须 disabled，且写明还没读全
    await page.click("#btn-start");
    await waitFetched(page, 20);
    const midDisabled = await page.getAttribute("#btn-classify", "disabled");
    const midLine = await text(page, "#progress-line");
    log.cases.push({
      id: "B2", kind: "mock",
      name: "抓全前分类按钮 disabled + 文案含「还没读全（已取 N/total）」",
      passed: midDisabled !== null && /还没读全（已取 \d+\/62/.test(midLine),
      detail: { disabled: midDisabled !== null, line: midLine },
    });

    await waitFetched(page, EXPECT_TOTAL);
    const fetched = Number(await text(page, "#stat-fetched"));
    const total = Number(await text(page, "#stat-total"));
    const pagesShown = Number(await text(page, "#stat-pages"));
    const pns = mock.requests.filter((r) => r.path === "/x/relation/followings").map((r) => r.pn);
    log.cases.push({
      id: "B1", kind: "mock",
      name: "3 页夹具抓全：fetched == total == 62，pn 序列 1..3，跨页重复被 mid 去重",
      passed: fetched === EXPECT_TOTAL && total === EXPECT_TOTAL && pns.join(",") === "1,2,3",
      detail: { fetched, total, pagesShown, pns, servedRows: buildPages(PAGES).flat().length },
    });
    const afterDisabled = await page.getAttribute("#btn-classify", "disabled");
    log.cases.push({
      id: "B5", kind: "mock",
      name: "抓全后分类解锁（按钮不再 disabled）",
      passed: afterDisabled === null, detail: { disabled: afterDisabled !== null },
    });

    // C2：没有 Key 时只能走离线规则，零外发
    await page.click("#btn-classify-local");
    await page.waitForFunction(() => {
      const el = document.querySelector("#classify-summary");
      return el && !/^还没分类/.test(el.textContent.trim());
    }, null, { timeout: 20000 }).catch(() => {});
    const counts = await page.$$eval("#category-list li", (lis) =>
      lis.map((li) => Number((li.textContent.match(/(\d+)\s*人/) || [0, 0])[1])));
    const sum = counts.reduce((a, b) => a + b, 0);
    log.cases.push({
      id: "C2", kind: "mock",
      name: "无 Key 走离线规则分类：分类条目数 == 关注条目数，且全程零外发",
      passed: sum === EXPECT_TOTAL && offsite.length === 0,
      detail: { counts, sum, offsite },
    });

    const audit = await page.$$eval("#audit-list li", (lis) => lis.map((li) => li.textContent.trim()));
    log.cases.push({
      id: "D7-scan", kind: "mock",
      name: "审计日志含 scan_start / scan_complete（取关侧审计等 FOR-65）",
      passed: audit.some((l) => l.includes("scan_start")) &&
        audit.some((l) => l.includes("scan_complete")),
      detail: { audit },
    });
    log.numbers = { follow_total: total, pages: pagesShown, cls_counts_sum: sum };
  } finally {
    await ctx.close();
    await mock.close();
  }
}

async function scenarioRiskControl(log) {
  const pages = buildPages(PAGES);
  const mock = await startMockServer({ pages, riskOnPage: 2 });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-track-a-risk-"));
  const ctx = await launch({ mock, profileDir });
  try {
    const opened = await openSidePanel(ctx, profileDir);
    if (!opened) {
      const err = new Error("扩展没被注册（同上：环境形态不支持 --load-extension）");
      err.code = "EXTENSION_NOT_LOADED";
      throw err;
    }
    const { page } = opened;
    await page.click("#btn-start");
    await page.waitForFunction(() => {
      const resume = document.querySelector("#btn-resume");
      return (resume && !resume.hidden) || Number(document.querySelector("#stat-fetched").textContent) >= 62;
    }, null, { timeout: 25000 }).catch(() => {});
    const resumeVisible = !(await page.isHidden("#btn-resume"));
    const disabled = await page.getAttribute("#btn-classify", "disabled");
    const fetched = Number(await text(page, "#stat-fetched"));
    log.cases.push({
      id: "B3", kind: "mock",
      name: "第 2 页注入 -352 风控：状态 incomplete、分类仍锁定、出现「继续抓取」且已取数据保留",
      passed: resumeVisible && disabled !== null && fetched > 0 && fetched < EXPECT_TOTAL,
      detail: { resumeVisible, classifyDisabled: disabled !== null, fetched },
    });
  } finally {
    await ctx.close();
    await mock.close();
  }
}

async function envVersions() {
  const probe = await chromium.launch({ headless: true, executablePath: findChromeForTesting() || undefined });
  const page = await probe.newPage();
  const ua = await page.evaluate(() => navigator.userAgent);
  await probe.close();
  const pw = (await import("playwright/package.json", { with: { type: "json" } })).default.version;
  return {
    os: process.platform + " " + os.release(),
    chrome: (ua.match(/Chrome\/([\d.]+)/) || [0, "unknown"])[1],
    node: process.version,
    playwright: pw,
    python: "见 pytest 侧报告（同一棵树同一环境）",
  };
}

const log = { track: "A", kind: "mock", startedAt: new Date().toISOString(), cases: [], numbers: {} };
let exitCode = 0;
try {
  log.env = await envVersions();
  await scenarioHappyPath(log);
  await scenarioRiskControl(log);
} catch (err) {
  log.fatal = String(err && err.message);
  exitCode = err && err.code === "EXTENSION_NOT_LOADED" ? 2 : 1;
}
log.finishedAt = new Date().toISOString();
log.passed = log.cases.filter((c) => c.passed).length;
log.total = log.cases.length;

const outDir = path.join(ROOT, "tmp", "qa-e2e");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "track-a.json"), JSON.stringify(log, null, 2));
console.log(JSON.stringify({ track: log.track, env: log.env, passed: log.passed, total: log.total,
  cases: log.cases.map((c) => ({ id: c.id, passed: c.passed })), fatal: log.fatal || null }, null, 2));
process.exit(exitCode);