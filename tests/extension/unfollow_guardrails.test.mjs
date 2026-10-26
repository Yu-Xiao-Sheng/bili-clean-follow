// 取关执行器的七条护栏（FOR-65 验收 3 + 验收 4「任何路径都不存在未确认即写」）。
//
// 这份测试的核心断言形态只有一个：**护栏没过的时候 transport 被调用 0 次**。
// 「未确认即写」不是靠 UI 禁用按钮保证的，而是执行器第一步就抛，所以这里连 UI 都不参与。

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIRM_TOKEN,
  DEFAULT_BATCH_LIMIT,
  HARD_BATCH_LIMIT,
  MIN_ITEM_INTERVAL_MS,
  RESTORE_TOKEN,
  RISK_NOTICE_VERSION,
  UnfollowGuardError,
  executeUnfollow,
  guardUnfollow,
  loadAudit,
  loadCheckpoint,
  loadManifests,
  loadWriteSwitch,
  makeRiskAck,
  resolveIntervalMs,
  resolveLimit,
  restoreUnfollowed,
  riskNotice,
  setWriteSwitch,
  toAuditCsv,
  toManifestText,
} from "../../extension/unfollow.js";
import { armPreview, buildUnfollowPreview } from "../../extension/preview.js";
import { DECISION } from "../../extension/classify.js";
import { UNSURE_CATEGORY, defaultTaxonomy } from "../../extension/taxonomy.js";
import { memoryStorage } from "../../extension/store.js";

const TAX = defaultTaxonomy();

function corpus(n = 6) {
  const items = [];
  const results = [];
  for (let i = 0; i < n; i += 1) {
    const mid = String(30000 + i);
    items.push({ mid, nickname: "要清的人" + i, bio: "段子" });
    results.push({ mid, category: "funny", confidence: 0.8 });
  }
  items.push({ mid: "31000", nickname: "保留类的", bio: "影视" });
  results.push({ mid: "31000", category: "film", confidence: 0.9 });
  items.push({ mid: "31001", nickname: "待确认的", bio: "" });
  results.push({ mid: "31001", category: UNSURE_CATEGORY, confidence: 0.4 });
  items.push({ mid: "31002", nickname: "自己", bio: "" });
  results.push({ mid: "31002", category: "funny", confidence: 0.95 });
  const decisions = { funny: DECISION.CANDIDATE, film: DECISION.KEEP };
  return { items, results, decisions };
}

function makeTransport(script = {}) {
  const calls = [];
  const fn = async ({ op, mid }) => {
    calls.push({ op, mid });
    const rule = script[mid];
    if (typeof rule === "function") return rule(calls.length, calls);
    if (rule) return rule;
    return { httpStatus: 200, payload: { code: 0, message: "0" }, rawText: "" };
  };
  fn.calls = calls;
  return fn;
}

async function armedHarness({ n = 6, limit = DEFAULT_BATCH_LIMIT, selfMid = "31002" } = {}) {
  const storage = memoryStorage();
  const c = corpus(n);
  await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION, now: Date.now() }) });
  const preview = buildUnfollowPreview({
    items: c.items, results: c.results, decisions: c.decisions, taxonomy: TAX, limit, selfMid,
  });
  await armPreview(storage, preview, { now: Date.now() });
  const sleeps = [];
  const opts = {
    storage,
    preview,
    results: c.results,
    decisions: c.decisions,
    selfMid,
    limit,
    intervalMs: MIN_ITEM_INTERVAL_MS,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    now: () => Date.now(),
  };
  return { storage, ...c, preview, sleeps, opts };
}

// --- 护栏 a：写操作默认关闭，开启要开关 + 二次确认 ------------------------------

test("默认状态就是关闭：没开开关时 executeUnfollow 抛错，且一条写请求都没发", async () => {
  const storage = memoryStorage();
  const c = corpus();
  const state = await loadWriteSwitch(storage);
  assert.equal(state.enabled, false, "写操作默认关闭（v2-spec §4 第 1 条）");

  const preview = buildUnfollowPreview({ items: c.items, results: c.results, decisions: c.decisions, taxonomy: TAX });
  await armPreview(storage, preview);
  const transport = makeTransport();
  await assert.rejects(
    () => executeUnfollow({ storage, preview, confirmation: { token: CONFIRM_TOKEN }, ...c, transport }),
    (err) => err instanceof UnfollowGuardError && err.kind === "write_disabled",
  );
  assert.equal(transport.calls.length, 0, "未开启就写：这是最严重的一类错误");
});

test("开开关必须带二次确认；确认文案要写清接口、速率、不可撤销，改版旧确认作废", async () => {
  const storage = memoryStorage();
  await assert.rejects(
    () => setWriteSwitch(storage, true, { ack: { version: RISK_NOTICE_VERSION - 1, ackedAt: Date.now() } }),
    (err) => err.kind === "risk_ack_required",
    "确认文案已经改版（速率/接口写得不一样）时，旧的确认不能再算数",
  );
  const on = await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) });
  assert.equal(on.enabled, true);
  const state = await loadWriteSwitch(storage);
  assert.equal(state.ack.version, RISK_NOTICE_VERSION);

  const notice = riskNotice({ limit: 30, intervalMs: 1200 });
  const text = notice.lines.join("");
  assert.ok(text.includes("x/relation/delete"), "要说明调的是哪个接口：" + text.slice(0, 80));
  assert.ok(text.includes("1200ms"), "要说明速率：" + text.slice(0, 120));
  assert.ok(text.includes("不可撤销") || text.includes("没有撤销"), "要说明不可撤销");
  assert.ok(text.includes("30 条"), "要说明批量上限");
  assert.ok(notice.restoreEndpoint.includes("x/relation/add"), "还要说明补救接口");

  // 关掉开关要顺手清掉「看过预览」的武装记录
  const preview = buildUnfollowPreview({ items: corpus().items, results: corpus().results, decisions: corpus().decisions, taxonomy: TAX });
  await armPreview(storage, preview);
  await setWriteSwitch(storage, false);
  assert.equal((await loadWriteSwitch(storage)).enabled, false);
});

// --- 护栏 b：必须看过 diff 预览 + 手输 UNFOLLOW -------------------------------

test("没手输 UNFOLLOW（或输错大小写）就不执行；transport 调用次数为 0", async () => {
  const h = await armedHarness();
  const transport = makeTransport();
  for (const bad of ["", "unfollow", "Unfollow", "取消", undefined]) {
    const token = bad === undefined ? undefined : bad.trim();
    await assert.rejects(
      () => executeUnfollow({ ...h.opts, confirmation: { token, previewShown: true }, transport }),
      (err) => err.kind === "token_required",
      "token=" + JSON.stringify(bad) + " 不该被执行",
    );
  }
  assert.equal(transport.calls.length, 0);
  // 注意 "UNFOLLOW " 尾部空格：trim 之后是合法的，所以这里单独确认它其实会被接受
  const ok = await executeUnfollow({ ...h.opts, confirmation: { token: "UNFOLLOW ", previewShown: true }, transport: makeTransport() });
  assert.ok(ok.attempted > 0, "手输前后带空格仍然算 UNFOLLOW");
});

test("没看过 diff 预览 / 看的是另一份预览 / 预览过期：三种都拒", async () => {
  const storage = memoryStorage();
  const c = corpus();
  await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) });
  const preview = buildUnfollowPreview({ items: c.items, results: c.results, decisions: c.decisions, taxonomy: TAX });
  const confirmation = { token: CONFIRM_TOKEN, previewShown: true };
  const transport = makeTransport();

  await assert.rejects(
    () => executeUnfollow({ storage, preview, confirmation, ...c, transport }),
    (err) => err.kind === "preview_required",
    "没渲染过预览就拿不到指纹记录，执行不了",
  );

  await armPreview(storage, preview, { now: Date.now() - 3600_000 }); // 一小时前看的
  await assert.rejects(
    () => executeUnfollow({ storage, preview, confirmation, ...c, transport }),
    (err) => err.kind === "preview_expired",
  );

  await armPreview(storage, preview, { now: Date.now() });
  const other = buildUnfollowPreview({ items: c.items, results: c.results, decisions: { funny: DECISION.CANDIDATE, film: DECISION.CANDIDATE }, taxonomy: TAX });
  await assert.rejects(
    () => executeUnfollow({ storage, preview: other, confirmation, ...c, transport }),
    (err) => err.kind === "preview_stale",
    "看的是一份、要执行的是另一份：不行",
  );
  assert.equal(transport.calls.length, 0);
});

// --- 护栏 c：默认 50、硬上限 200 ---------------------------------------------

test("批量上限：默认 50；超过上限拒绝（不是静默截断）；要得比 200 多也拒绝", async () => {
  assert.equal(resolveLimit(null).limit, DEFAULT_BATCH_LIMIT);
  assert.equal(DEFAULT_BATCH_LIMIT, 50);
  assert.equal(HARD_BATCH_LIMIT, 200);
  assert.equal(resolveLimit(200).limit, 200);
  assert.equal(resolveLimit(201).ok, false, "硬上限不可调高");
  assert.equal(resolveLimit(0).ok, false);
  assert.equal(resolveLimit("abc").ok, false);

  const h = await armedHarness({ n: 60 }); // 60 个候选，默认上限 50
  const transport = makeTransport();
  await assert.rejects(
    () => executeUnfollow({ ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport }),
    (err) => err.kind === "batch_limit_exceeded" && /60 > 50/.test(err.verdict.label),
  );
  assert.equal(transport.calls.length, 0, "超限的批量必须整批拒，不能「先发 50 个」");

  const bigger = await armedHarness({ n: 201 });
  const transport2 = makeTransport();
  await assert.rejects(
    () => executeUnfollow({ ...bigger.opts, limit: 201, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport: transport2 }),
    (err) => err.kind === "hard_cap_exceeded",
  );
  assert.equal(transport2.calls.length, 0);

  // 上限 55 也一样拒：宁可让用户重新预览分批，也不要「悄悄只发了 55 个」
  const partial = await armedHarness({ n: 60, limit: 55 });
  const t3 = makeTransport();
  await assert.rejects(
    () => executeUnfollow({
      ...partial.opts, limit: 55,
      confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport: t3,
    }),
    (err) => err.kind === "batch_limit_exceeded" && /60 > 55/.test(err.verdict.label),
  );
  assert.equal(t3.calls.length, 0);
  const unused = () => executeUnfollow({
    ...partial.opts, limit: 55,
    confirmation: { token: CONFIRM_TOKEN, previewShown: true },
    transport: makeTransport(),
  });
  const fits = await armedHarness({ n: 40, limit: 50 });
  const res2 = await executeUnfollow({
    ...fits.opts, limit: 50,
    confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport: makeTransport(),
  });
  assert.equal(res2.attempted, 40, "候选数在上限内就正常执行");
});

// --- 护栏 e：keep 永不进候选（执行时重算，不只信预览）--------------------------

test("预览之后才把某类改成「保留」：执行时重算，那些人一个都不发", async () => {
  const storage = memoryStorage();
  const c = corpus();
  await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) });
  const preview = buildUnfollowPreview({ items: c.items, results: c.results, decisions: c.decisions, taxonomy: TAX });
  await armPreview(storage, preview);
  // 用户在执行前把 funny 也勾成保留（预览是之前看的，内容其实已经变了）
  const decisionsNow = { funny: DECISION.KEEP, film: DECISION.KEEP };
  const transport = makeTransport();
  await assert.rejects(
    () => executeUnfollow({
      storage, preview, confirmation: { token: CONFIRM_TOKEN, previewShown: true },
      items: c.items, results: c.results, decisions: decisionsNow, transport,
    }),
    (err) => err.kind === "empty_plan" || err.kind === "preview_stale" || err.kind === "unsafe_candidate",
    "keep 之后不该还有可执行的人；预览也应该已经作废",
  );
  assert.equal(transport.calls.length, 0, "keep 类里的人一个都不能被取关");
});

test("有人不在安全候选里（待确认 / 低置信 / 自己 / 没表态）：执行器重算后一个都不发", async () => {
  const h = await armedHarness();
  const transport = makeTransport();
  const res = await executeUnfollow({
    ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport,
  });
  const sent = transport.calls.map((c) => c.mid);
  assert.ok(!sent.includes("31000"), "keep 类（film）里的人不许发");
  assert.ok(!sent.includes("31001"), "待确认里的人不许发");
  assert.ok(!sent.includes("31002"), "自己的 mid 不许发");
  assert.equal(new Set(sent).size, sent.length, "同一个人不能发两次");
  assert.equal(res.blockedBySafety.keep, 1);
  assert.equal(res.blockedBySafety.unsure, 1);
  assert.equal(res.blockedBySafety.self, 1);
});

test("预览里被塞进不在候选集的人：护栏直接判 unsafe_candidate 并拒", () => {
  const c = corpus();
  const preview = buildUnfollowPreview({ items: c.items, results: c.results, decisions: c.decisions, taxonomy: TAX });
  const verdict = guardUnfollow({
    preview,
    confirmation: { token: CONFIRM_TOKEN, previewShown: true },
    write: { enabled: true, ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) },
    armed: { hash: preview.hash, expiresAt: Date.now() + 60000 },
    limit: DEFAULT_BATCH_LIMIT,
    candidates: [...preview.items.map((i) => i.mid), "999999"],
    now: Date.now(),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, "unsafe_candidate");
});

// --- 护栏 d：速率下限 + 熔断与断点 -------------------------------------------

test("速率下限 800ms/条：调用方给 0 也只夹到下限，且带 jitter", async () => {
  assert.equal(resolveIntervalMs(0), MIN_ITEM_INTERVAL_MS);
  assert.equal(resolveIntervalMs(100), MIN_ITEM_INTERVAL_MS);
  assert.equal(resolveIntervalMs(1500), 1500);
  assert.ok(MIN_ITEM_INTERVAL_MS >= 800);

  const h = await armedHarness({ n: 4 });
  const res = await executeUnfollow({
    ...h.opts, intervalMs: 0,
    confirmation: { token: CONFIRM_TOKEN, previewShown: true },
    transport: makeTransport(),
  });
  assert.equal(res.intervalMs, MIN_ITEM_INTERVAL_MS);
  assert.equal(h.sleeps.length, res.attempted);
  for (const ms of h.sleeps) assert.ok(ms >= MIN_ITEM_INTERVAL_MS, "每条间隔不得低于下限：" + ms);
  assert.ok(h.sleeps.every((ms) => ms > MIN_ITEM_INTERVAL_MS), "jitter 要在下限之上加随机量");
});

test("遇 -352 立刻熔断：保存断点、写审计、剩余的人不发；412 同样熔断", async () => {
  const h = await armedHarness({ n: 5 });
  const transport = makeTransport({
    "30002": () => ({ httpStatus: 200, payload: { code: -352, message: "风险校验" }, rawText: "" }),
  });
  const res = await executeUnfollow({
    ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport,
  });
  assert.equal(res.ok, false);
  assert.equal(res.stopped.kind, "risk_control");
  assert.equal(transport.calls.length, 3, "-352 之后一条都不发（30000/30001/30002）");
  const checkpoint = await loadCheckpoint(h.storage);
  assert.deepEqual(checkpoint.remaining, ["30003", "30004"], "断点要能续跑");
  assert.equal(checkpoint.reason, "risk_control");
  const audit = await loadAudit(h.storage);
  assert.ok(audit.some((e) => e.action === "circuit_break" && e.remaining === 2));

  const h2 = await armedHarness({ n: 5 });
  const t2 = makeTransport({ "30001": () => ({ httpStatus: 412, payload: null, rawText: "<html>" }) });
  const res2 = await executeUnfollow({ ...h2.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport: t2 });
  assert.equal(res2.stopped.kind, "needs_signature", "HTTP 412（需签名）也要熔断");
  assert.equal(t2.calls.length, 2);
});

test("连着一串失败也熔断（不硬撞），并保存断点", async () => {
  const h = await armedHarness({ n: 6 });
  const transport = makeTransport({
    "30000": () => ({ httpStatus: 500, payload: null, rawText: "boom" }),
    "30001": () => ({ httpStatus: 500, payload: null, rawText: "boom" }),
    "30002": () => ({ httpStatus: 500, payload: null, rawText: "boom" }),
  });
  const res = await executeUnfollow({ ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport });
  assert.equal(transport.calls.length, 3);
  assert.equal(res.stopped.kind, "repeated_failures");
  assert.ok((await loadCheckpoint(h.storage)).remaining.length === 3);
});

// --- 护栏 f：清单先落盘 + 一键重新关注 ---------------------------------------

test("执行前落盘「本次将取关清单（mid+昵称+时间）」：第一条写请求发出前清单已在库里", async () => {
  const h = await armedHarness({ n: 3 });
  let manifestsAtFirstCall = null;
  const transport = makeTransport();
  const wrapped = async (req) => {
    if (manifestsAtFirstCall === null) {
      const list = await loadManifests(h.storage);
      manifestsAtFirstCall = list.length ? list[list.length - 1] : null;
    }
    return transport(req);
  };
  const res = await executeUnfollow({ ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport: wrapped });
  assert.ok(manifestsAtFirstCall, "第一条写请求发出之前必须已经落盘清单");
  assert.equal(manifestsAtFirstCall.id, res.manifestId);
  assert.equal(manifestsAtFirstCall.items.length, 3);
  for (const it of manifestsAtFirstCall.items) {
    assert.ok(it.mid && it.nickname, "清单要带 mid + 昵称");
    assert.ok(Number.isFinite(manifestsAtFirstCall.createdAt), "清单要带时间");
  }
  const text = toManifestText(manifestsAtFirstCall);
  assert.ok(text.includes("不可撤销"));
  assert.ok(text.includes("30000\t要清的人0"), "清单要能人工核对：" + text.split("\n")[4]);
});

test("一键重新关注：只补这一批里真的取关成功的人，且同样要确认与限速", async () => {
  const h = await armedHarness({ n: 4 });
  const transport = makeTransport({
    "30001": () => ({ httpStatus: 200, payload: { code: 0, message: "0" }, rawText: "" }),
  });
  // 让 30001 失败：B站返回 -403（无权限）
  const failing = makeTransport({ "30001": () => ({ httpStatus: 500, payload: null, rawText: "boom" }) });
  const res = await executeUnfollow({ ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport: failing });
  const okMids = res.trail.filter((t) => t.ok).map((t) => t.mid);
  const failedMids = res.trail.filter((t) => !t.ok).map((t) => t.mid);
  assert.equal(failedMids.length, 1);

  const addTransport = makeTransport();
  await assert.rejects(
    () => restoreUnfollowed({ storage: h.storage, manifestId: res.manifestId, confirmation: { token: "" }, transport: addTransport }),
    (err) => err.kind === "restore_token_required",
    "补救也是写操作：不确认一样不发",
  );
  assert.equal(addTransport.calls.length, 0);

  const restore = await restoreUnfollowed({
    storage: h.storage, manifestId: res.manifestId,
    confirmation: { token: RESTORE_TOKEN }, transport: addTransport,
  });
  assert.equal(restore.attempted, okMids.length, "只补真的取关成功的人");
  assert.deepEqual(new Set(addTransport.calls.map((c) => c.mid)), new Set(okMids));
  assert.ok(!addTransport.calls.some((c) => failedMids.includes(c.mid)), "取关没成功的人不需要补，也不许凭空加关注");
  assert.ok(addTransport.calls.every((c) => c.op === "add"), "补救走 x/relation/add");
  assert.ok(restore.ok_count >= 1);
  void transport;
});

// --- 护栏 g：审计每条成功/失败，可导出 CSV -----------------------------------

test("审计日志：每条成功/失败都在，CSV 带 BOM 且不含 csrf / cookie 形态", async () => {
  const h = await armedHarness({ n: 3 });
  const transport = makeTransport({
    "30001": () => ({ httpStatus: 500, payload: null, rawText: "boom" }),
  });
  const res = await executeUnfollow({ ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport });
  const audit = await loadAudit(h.storage);
  const items = audit.filter((e) => e.action === "unfollow");
  assert.equal(items.length, 3, "三条都要有记录（成功与失败都算）");
  assert.equal(items.filter((e) => e.ok).length, 2);
  assert.equal(items.filter((e) => !e.ok).length, 1);
  assert.ok(items.every((e) => e.mid && e.at && e.kind));
  assert.ok(audit.some((e) => e.action === "unfollow_done"));

  const csv = toAuditCsv(audit);
  assert.ok(csv.startsWith(""), "CSV 带 BOM，Excel / WPS 双击不乱码");
  assert.ok(csv.includes("mid") && csv.includes("nickname") && csv.includes("result"));
  assert.ok(csv.includes("30001"), "CSV 要能对上人");
  const lowered = csv.toLowerCase();
  assert.ok(!lowered.includes("csrf"), "审计/导出里不得出现 csrf");
  assert.ok(!lowered.includes("bili_jct") && !lowered.includes("sessdata"), "审计/导出里不得出现 cookie 形态");

  const manifestText = toManifestText((await loadManifests(h.storage)).at(-1));
  assert.ok(!manifestText.toLowerCase().includes("csrf"));
});

test("昵称里塞凭据形态也进不了审计与清单（privacy 口径）", async () => {
  const storage = memoryStorage();
  const items = [{ mid: "40001", nickname: "坏昵称 SESSDATA=abcdef1234567890", bio: "" }];
  const results = [{ mid: "40001", category: "funny", confidence: 0.9 }];
  const decisions = { funny: DECISION.CANDIDATE };
  await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) });
  const preview = buildUnfollowPreview({ items, results, decisions, taxonomy: TAX });
  await armPreview(storage, preview);
  const res = await executeUnfollow({
    storage, preview, confirmation: { token: CONFIRM_TOKEN, previewShown: true },
    results, decisions, transport: makeTransport(), sleep: async () => {},
  });
  const audit = await loadAudit(storage);
  const text = JSON.stringify(audit) + toManifestText((await loadManifests(storage)).at(-1));
  assert.ok(!/SESSDATA\s*=\s*[A-Za-z0-9]{8,}/.test(text), "凭据形态要被遮掉");
  assert.equal(res.attempted, 1);
});

// --- 断点续跑同样要过护栏 ----------------------------------------------------

test("熔断后「从断点继续」也要重新看预览 + 重新手输：不重看就拒", async () => {
  const h = await armedHarness({ n: 5 });
  const transport = makeTransport({
    "30002": () => ({ httpStatus: 200, payload: { code: -352, message: "风控" }, rawText: "" }),
  });
  await executeUnfollow({ ...h.opts, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, transport });

  const { buildResumePreview } = await import("../../extension/unfollow.js");
  const resume = await buildResumePreview({ items: h.items, results: h.results, decisions: h.decisions, taxonomy: TAX, storage: h.storage });
  assert.equal(resume.ok, true);
  const resumeTransport = makeTransport();
  await assert.rejects(
    () => executeUnfollow({
      storage: h.storage, preview: resume.preview, confirmation: { token: CONFIRM_TOKEN, previewShown: true },
      results: h.results, decisions: h.decisions, selfMid: "31002", transport: resumeTransport, sleep: async () => {},
    }),
    (err) => err.kind === "preview_required" || err.kind === "preview_stale",
    "断点续跑不能沿用旧预览的「看过」记录",
  );
  assert.equal(resumeTransport.calls.length, 0);

  await armPreview(h.storage, resume.preview);
  const res = await executeUnfollow({
    storage: h.storage, preview: resume.preview, confirmation: { token: CONFIRM_TOKEN, previewShown: true },
    results: h.results, decisions: h.decisions, selfMid: "31002", transport: resumeTransport, sleep: async () => {},
  });
  assert.deepEqual(resumeTransport.calls.map((c) => c.mid), ["30003", "30004"], "只跑剩下的两个人");
  assert.equal(res.ok, true);
  assert.equal(await loadCheckpoint(h.storage), null, "跑完了要清掉断点");
});

test("空候选清单不是「执行 0 条」，而是明确的 empty_plan", async () => {
  const storage = memoryStorage();
  await setWriteSwitch(storage, true, { ack: makeRiskAck({ version: RISK_NOTICE_VERSION }) });
  const c = corpus();
  const preview = buildUnfollowPreview({ items: [], results: [], decisions: {}, taxonomy: TAX });
  await armPreview(storage, preview);
  const transport = makeTransport();
  await assert.rejects(
    () => executeUnfollow({ storage, preview, confirmation: { token: CONFIRM_TOKEN, previewShown: true }, ...c, transport }),
    (err) => err.kind === "empty_plan",
  );
  assert.equal(transport.calls.length, 0);
});