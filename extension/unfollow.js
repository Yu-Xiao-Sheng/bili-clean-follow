// unfollow.js —— 真实取关执行器与七条安全护栏（v2-spec §4，FOR-65 验收 3）。
//
// 七条护栏（缺一不可，测试逐条钉）：
//   a 写操作默认关闭：开启要侧栏开关 + 二次确认（说明接口、速率、不可撤销），二者都落库；
//   b 执行前必须看到 diff 预览（指纹落库 + TTL）且手输 UNFOLLOW；
//   c 单次批量上限默认 50、硬上限 200（要得比硬上限多 = 拒绝，不静默截半）；
//   d 速率下限 800ms/条 + jitter（调用方给更小值也只夹到下限），遇 -352 / HTTP 412 立刻熔断并存断点；
//   e keep 分类永不进候选（执行时再算一遍安全候选，不只信预览）；
//   f 执行前落盘「本次将取关清单（mid + 昵称 + 时间）」，并提供一键重新关注（x/relation/add）作补救；
//   g 审计日志每条成功/失败，可导出 CSV。
//
// 「任何路径都不存在未确认即写」是怎么保证的：
//   * 唯一的写请求发起点是 background.js 的 writeTransport，它只被本文件的 executeUnfollow /
//     restoreUnfollowed 调用；而这两个函数第一步就是 guardUnfollow/guardRestore，不过就抛错。
//   * 「看过预览」不是 UI 传来的布尔值，而是 storage 里那条带 TTL 的预览指纹（preview.armPreview），
//     执行时按内容指纹比对：预览内容变了 / 过期了 / 没渲染过 = 拿不到匹配指纹 = 拒。
//   * csrf 不在本模块出现，执行器只把 {op, mid} 交给传输层（background.js 现场从 cookie 取 bili_jct），
//     所以清单、审计、日志里结构上不可能带 csrf。
//
// 本模块不碰 chrome.*、不出现 fetch(：storage 与 transport 都注入，node:test 用内存实现跑。

import { KIND, classifyResponse } from "./biliApi.js";
import { assertSecretFree, redactSecrets, stripSecretFields } from "./privacy.js";
import { categoryName } from "./taxonomy.js";
import { CSV_BOM, csvCell } from "./report.js";
import { armMatches, buildUnfollowPreview, clearArm, fingerprint, loadArm, safeCandidateMids } from "./preview.js";

// --- 存储键（都在本模块命名空间里，reset 时一起清） --------------------------
export const WRITE_SWITCH_KEY = "unfollow_write_switch.v1";
export const RISK_ACK_KEY = "unfollow_risk_ack.v1";
export const MANIFESTS_KEY = "unfollow_manifests.v1";
export const CHECKPOINT_KEY = "unfollow_checkpoint.v1";
export const AUDIT_KEY = "unfollow_audit.v1";
export const MANIFEST_KEEP = 20; // 只留最近 20 批补救清单
export const AUDIT_KEEP = 5000;

// --- 护栏常量（口径唯一来源） ------------------------------------------------
export const CONFIRM_TOKEN = "UNFOLLOW"; // 护栏 b：手输
export const RESTORE_TOKEN = "REFOLLOW"; // 补救方向（加关注）也要显式确认
export const DEFAULT_BATCH_LIMIT = 50; // 护栏 c：默认
export const HARD_BATCH_LIMIT = 200; // 护栏 c：硬上限
export const MIN_ITEM_INTERVAL_MS = 800; // 护栏 d：下限，不跟 B站风控赛跑
export const JITTER_RATIO = 0.5; // 每条再随机加 0~50% 间隔
export const RISK_NOTICE_VERSION = 2; // 二次确认文案改版 -> 旧确认自动作废
export const CIRCUIT_BREAK_KINDS = [KIND.RISK_CONTROL, KIND.SIGNED_REQUIRED]; // -352 / 412
export const STOP_KINDS = [KIND.NOT_LOGGED_IN]; // -101：没登录，后面全是白发
export const MAX_CONSECUTIVE_FAILURES = 3; // 连着一串失败也熔断，别硬撞

export const GUARD_LABEL_ZH = {
  write_disabled: "取关能力没开启：先打开「开启取关能力」并完成二次确认。",
  risk_ack_required: "二次确认没做或已过期：请重新确认「接口 / 速率 / 不可撤销」那段说明。",
  token_required: "没有手输 " + CONFIRM_TOKEN + "：不执行。",
  preview_required: "没有 diff 预览就不能执行取关。",
  preview_stale: "预览与要执行的清单不是同一份：重新看一遍 diff 预览。",
  preview_expired: "预览已过期：重新看一遍 diff 预览。",
  batch_limit_exceeded: "本次条数超过批量上限：请减小范围或分多次执行。",
  hard_cap_exceeded: "批量上限最多 " + HARD_BATCH_LIMIT + "，硬上限不可调高。",
  empty_plan: "候选清单是空的：没有要取关的人。",
  unsafe_candidate: "候选清单里有不该动的人（keep 类 / 待确认 / 低置信 / 自己）：已拒绝执行。",
  restore_token_required: "补救（重新关注）也需要显式确认。",
  restore_unknown_manifest: "找不到那一批的清单：无法补救。",
  restore_nothing_done: "那一批里没有成功取关的记录：不需要补救。",
  no_transport: "没有可用的传输层（service worker 不可达）：不执行。",
};

export class UnfollowGuardError extends Error {
  constructor(verdict) {
    super("unfollow guard: " + ((verdict && verdict.label) || (verdict && verdict.kind) || "refused"));
    this.name = "UnfollowGuardError";
    this.kind = (verdict && verdict.kind) || "refused";
    this.verdict = verdict;
  }
}

/** 护栏 a 的「二次确认」文案：接口、速率、不可撤销必须写清楚，UI 不得另写一份。 */
export function riskNotice({ limit = DEFAULT_BATCH_LIMIT, intervalMs = MIN_ITEM_INTERVAL_MS } = {}) {
  const rate = Math.max(MIN_ITEM_INTERVAL_MS, Number(intervalMs) || MIN_ITEM_INTERVAL_MS);
  const cap = Math.min(HARD_BATCH_LIMIT, Math.max(1, Number(limit) || DEFAULT_BATCH_LIMIT));
  return {
    version: RISK_NOTICE_VERSION,
    title: "开启取关能力前请先确认（不可撤销）",
    endpoint: "POST x/relation/delete（表单 fid + csrf，走你自己的登录态）",
    restoreEndpoint: "POST x/relation/add（一键重新关注，用于补救）",
    rateLabel: "速率下限 " + rate + "ms/条（另加随机 jitter），批量上限 " + cap + " 条/次",
    lines: [
      "这会真的调用 B站写接口 " + "x/relation/delete" + "，每取关一个就少一个关注。",
      "B站没有撤销 API：取错了只能靠「一键重新关注」把这一批补回来，不保证补全（对方设了权限就加不回来）。",
      "自动化取关属于账号操作，可能触发风控（code -352 / HTTP 412）；工具不绕签名、不绕过限速，" +
        "速率下限 " + rate + "ms/条，单次不超过 " + cap + " 条，遇风控码立刻熔断并保存断点。",
      "keep 类别、以及「待确认」/低置信（<0.55）的 UP 主永不进入候选；执行前还会再算一遍。",
      "执行前会落盘本次清单（mid + 昵称 + 时间），每条成功/失败都进审计日志，可导出 CSV。",
      "本工具不代你承担账号风险：请自己确认这份清单再执行。",
    ],
    token: CONFIRM_TOKEN,
  };
}

export function makeRiskAck({ version = RISK_NOTICE_VERSION, now = Date.now() }) {
  return { version, ackedAt: now };
}

export function riskAckIsValid(ack, { now = Date.now(), ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!ack || ack.version !== RISK_NOTICE_VERSION) return { ok: false, kind: "risk_ack_required" };
  if (ttlMs && ack.ackedAt && now - ack.ackedAt > ttlMs) return { ok: false, kind: "risk_ack_required" };
  return { ok: true };
}

/** 护栏 a：开关与二次确认必须成对出现，且确认的文案版本要对得上。 */
export async function setWriteSwitch(store, on, { ack, now = () => Date.now() } = {}) {
  if (on) {
    const check = riskAckIsValid(ack || makeRiskAck({ version: RISK_NOTICE_VERSION, now: now() }));
    if (!check.ok) throw new UnfollowGuardError({ ...check, label: GUARD_LABEL_ZH.risk_ack_required });
    await store.set({
      [WRITE_SWITCH_KEY]: { enabled: true, since: now() },
      [RISK_ACK_KEY]: makeRiskAck({ now: now() }),
    });
    return { enabled: true };
  }
  await store.set({ [WRITE_SWITCH_KEY]: { enabled: false, since: now() } });
  await clearArm(store);
  return { enabled: false };
}

export async function loadWriteSwitch(store) {
  const got = await store.get([WRITE_SWITCH_KEY, RISK_ACK_KEY]);
  const sw = (got && got[WRITE_SWITCH_KEY]) || { enabled: false };
  return { enabled: Boolean(sw.enabled), since: sw.since || null, ack: (got && got[RISK_ACK_KEY]) || null };
}

/** 护栏 c：默认 50、硬上限 200。要得比硬上限多 = 拒，不做「静默砍一半」。 */
export function resolveLimit(raw) {
  if (raw === null || raw === undefined || raw === "") return { ok: true, limit: DEFAULT_BATCH_LIMIT, defaulted: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, kind: "hard_cap_exceeded", label: GUARD_LABEL_ZH.hard_cap_exceeded };
  if (n > HARD_BATCH_LIMIT) return { ok: false, kind: "hard_cap_exceeded", label: GUARD_LABEL_ZH.hard_cap_exceeded };
  return { ok: true, limit: Math.floor(n) };
}

/** 护栏 d：速率只夹不降。 */
export function resolveIntervalMs(raw) {
  const n = Number(raw);
  const base = Number.isFinite(n) && n > 0 ? n : MIN_ITEM_INTERVAL_MS;
  return Math.max(MIN_ITEM_INTERVAL_MS, Math.floor(base));
}

export function jitteredDelay(intervalMs, random = Math.random, ratio = JITTER_RATIO) {
  const base = resolveIntervalMs(intervalMs);
  const extra = Math.floor(Math.max(0, Math.min(1, random())) * base * ratio);
  return base + extra;
}

/**
 * 七条护栏的集中判定（不含网络）。执行器与 background 都会调它：
 * UI 被绕过（控制台直发消息）也照样要过这一关。
 */
export function guardUnfollow({ preview, confirmation, write, armed, limit, candidates, now = Date.now() }) {
  const conf = confirmation || {};
  if (!write || !write.enabled) return { ok: false, kind: "write_disabled", label: GUARD_LABEL_ZH.write_disabled };
  const ack = riskAckIsValid(write.ack, { now });
  if (!ack.ok) return { ...ack, label: GUARD_LABEL_ZH.risk_ack_required };
  if (preview && preview.affected === 0) return { ok: false, kind: "empty_plan", label: GUARD_LABEL_ZH.empty_plan };
  if (!preview) return { ok: false, kind: "preview_required", label: GUARD_LABEL_ZH.preview_required };
  const armedCheck = armMatches(armed, preview, { now });
  if (!armedCheck.ok) return { ...armedCheck, label: GUARD_LABEL_ZH[armedCheck.kind] || armedCheck.kind };
  const token = String(conf.token === undefined ? "" : conf.token).trim();
  if (token !== CONFIRM_TOKEN) return { ok: false, kind: "token_required", label: GUARD_LABEL_ZH.token_required };
  if (conf.previewShown !== true) {
    return { ok: false, kind: "preview_required", label: GUARD_LABEL_ZH.preview_required };
  }
  const limitCheck = resolveLimit(limit);
  if (!limitCheck.ok) return { ok: false, kind: limitCheck.kind, label: limitCheck.label };
  const list = Array.isArray(candidates) ? candidates.map(String) : [];
  if (!list.length) return { ok: false, kind: "empty_plan", label: GUARD_LABEL_ZH.empty_plan };
  if (list.length > limitCheck.limit) {
    return {
      ok: false,
      kind: "batch_limit_exceeded",
      label: GUARD_LABEL_ZH.batch_limit_exceeded + "（" + list.length + " > " + limitCheck.limit + "）",
      limit: limitCheck.limit,
    };
  }
  const previewMids = new Set((preview.items || []).map((i) => String(i.mid)));
  const strays = list.filter((mid) => !previewMids.has(mid));
  if (strays.length) return { ok: false, kind: "unsafe_candidate", label: GUARD_LABEL_ZH.unsafe_candidate, strays: strays.slice(0, 10) };
  return { ok: true, limit: limitCheck.limit };
}

// --- 执行 -------------------------------------------------------------------

/**
 * 执行取关。第一步就是重算安全候选（护栏 e）+ 过护栏（a/b/c），不过就抛 UnfollowGuardError。
 * transport: async ({ op, mid }) => { httpStatus, payload, rawText }
 *   —— csrf 只存在于传输层内部；本模块不知道也不该知道它。
 */
export async function executeUnfollow({
  storage, preview, confirmation = {}, results, decisions, selfMid = null,
  limit = DEFAULT_BATCH_LIMIT, intervalMs = MIN_ITEM_INTERVAL_MS,
  transport, write = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random, now = () => Date.now(),
  onProgress = () => {}, aborted = () => false,
}) {
  if (typeof transport !== "function") {
    throw new UnfollowGuardError({ kind: "no_transport", label: GUARD_LABEL_ZH.no_transport });
  }
  if (!preview || preview.kind !== "unfollow") {
    throw new UnfollowGuardError({ kind: "preview_required", label: GUARD_LABEL_ZH.preview_required });
  }
  const state = write || (await loadWriteSwitch(storage));
  const armed = await loadArm(storage);

  // 护栏 e 的执行处：按「当前」results/decisions 重算一遍，不拿预览里的清单直接发。
  const safe = safeCandidateMids({ results, decisions, selfMid: selfMid ? String(selfMid) : null });
  const previewMids = new Set((preview.items || []).map((i) => String(i.mid)));
  const chosen = safe.mids.filter((mid) => previewMids.has(mid));
  const guard = guardUnfollow({
    preview, confirmation, write: state, armed, limit, candidates: chosen, now: now(),
  });
  if (!guard.ok) throw new UnfollowGuardError(guard);

  // 预览里有的人现在不安全了（比如中途被改回 keep / 掉进待确认）：不算错误，但要说出来。
  const droppedFromPreview = (preview.items || []).length - chosen.length;
  const batch = chosen.slice(0, guard.limit);
  const nameByMid = new Map((preview.items || []).map((i) => [String(i.mid), i]));
  const categoryByMid = new Map((Array.isArray(results) ? results : []).map((r) => [String(r.mid), r]));

  // 护栏 f：先把「本次将取关清单」落盘，一条写请求都还没发。
  const manifest = await writeManifest(storage, {
    previewHash: preview.hash,
    items: batch.map((mid) => {
      const row = categoryByMid.get(mid) || {};
      return {
        mid,
        nickname: safeNickname((nameByMid.get(mid) || {}).nickname || ""),
        category: row.category || null,
        confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        unfollowedAt: null,
        ok: null,
      };
    }),
    createdAt: now(),
  });

  const interval = resolveIntervalMs(intervalMs);
  const trail = [];
  let stopped = null;
  let consecutiveFailures = 0;
  const startedAt = now();

  for (let i = 0; i < batch.length; i += 1) {
    if (aborted()) {
      stopped = { kind: "aborted", label: "已按你的要求停止。" };
      await saveCheckpoint(storage, { manifestId: manifest.id, remaining: batch.slice(i), reason: "aborted", at: now() });
      break;
    }
    const mid = batch[i];
    const nickname = safeNickname((nameByMid.get(mid) || {}).nickname || "");
    await sleep(jitteredDelay(interval, random)); // 护栏 d：下限 + jitter，一条都不快
    let response = null;
    let verdict = null;
    try {
      response = await transport({ op: "unfollow", mid });
      verdict = classifyResponse({
        httpStatus: response && response.httpStatus,
        payload: response && response.payload,
        rawText: response && response.rawText,
      });
    } catch (err) {
      verdict = { ok: false, kind: KIND.TRANSPORT, code: null, message: redactSecrets(String(err && err.message || err)) };
    }
    const entry = {
      at: now(),
      action: "unfollow",
      manifestId: manifest.id,
      mid,
      nickname,
      category: (categoryByMid.get(mid) || {}).category || null,
      ok: !!(verdict && verdict.ok),
      code: verdict && verdict.code !== undefined && verdict.code !== null ? verdict.code : null,
      httpStatus: response && response.httpStatus ? response.httpStatus : null,
      kind: verdict ? verdict.kind : KIND.UNKNOWN,
      previewHash: preview.hash,
    };
    trail.push(entry);
    await appendAudit(storage, entry);
    await updateManifestItem(storage, manifest.id, mid, { ok: entry.ok, unfollowedAt: entry.at, code: entry.code, kind: entry.kind });
    onProgress({ index: i + 1, total: batch.length, mid, nickname, ok: entry.ok, kind: entry.kind, code: entry.code });

    if (entry.ok) {
      consecutiveFailures = 0;
      continue;
    }
    consecutiveFailures += 1;
    // 护栏 d：-352 / 412（以及 -101）立刻熔断 + 存断点
    if (CIRCUIT_BREAK_KINDS.includes(entry.kind) || STOP_KINDS.includes(entry.kind)) {
      stopped = { kind: entry.kind, label: "熔断：" + entry.kind + "，已保存断点。" };
      await saveCheckpoint(storage, { manifestId: manifest.id, remaining: batch.slice(i + 1), reason: entry.kind, at: now() });
      await appendAudit(storage, { at: now(), action: "circuit_break", manifestId: manifest.id, mid, kind: entry.kind, code: entry.code, remaining: batch.length - i - 1 });
      break;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stopped = { kind: "repeated_failures", label: "连续 " + consecutiveFailures + " 条失败：已停止并保存断点。" };
      await saveCheckpoint(storage, { manifestId: manifest.id, remaining: batch.slice(i + 1), reason: "repeated_failures", at: now() });
      await appendAudit(storage, { at: now(), action: "circuit_break", manifestId: manifest.id, mid, kind: "repeated_failures", remaining: batch.length - i - 1 });
      break;
    }
  }

  if (droppedFromPreview > 0) {
    await appendAudit(storage, {
      at: now(), action: "dropped_from_preview", manifestId: manifest.id, count: droppedFromPreview,
      previewHash: preview.hash,
    });
  }
  if (!stopped) await clearCheckpoint(storage);
  const done = trail.filter((t) => t.ok).length;
  await appendAudit(storage, {
    at: now(), action: "unfollow_done", manifestId: manifest.id,
    attempted: batch.length, ok: done, failed: trail.length - done,
    stopped: stopped ? stopped.kind : null, durationMs: now() - startedAt,
  });
  return {
    ok: !stopped,
    manifestId: manifest.id,
    attempted: batch.length,
    ok_count: done,
    failed: trail.length - done,
    trail,
    stopped,
    intervalMs: interval,
    blockedBySafety: safe.blocked,
    droppedFromPreview,
  };
}

/**
 * 从断点继续（护栏 d 的后半句：熔断要能接上）。
 * 关键：续跑同样要过护栏 —— 先给「剩余的人」生成新预览、重新 arm、重新手输 UNFOLLOW。
 */
export async function buildResumePreview({ items, results, decisions, taxonomy, storage, now = () => Date.now() }) {
  const checkpoint = await loadCheckpoint(storage);
  if (!checkpoint || !Array.isArray(checkpoint.remaining) || !checkpoint.remaining.length) {
    return { ok: false, kind: "no_checkpoint", label: "没有断点可续。" };
  }
  const restrict = new Set(checkpoint.remaining.map(String));
  const preview = buildUnfollowPreview({
    items, results, decisions, taxonomy, selfMid: null, now,
    restrictTo: restrict,
  });
  preview.checkpoint = { manifestId: checkpoint.manifestId, reason: checkpoint.reason };
  // restrictTo 版预览的内容与原始预览不同，指纹必须重算：内容不同就不该共用同一次「看过」。
  preview.hash = fingerprint(preview);
  return { ok: true, preview, reason: checkpoint.reason, manifestId: checkpoint.manifestId };
}

export async function loadCheckpoint(storage) {
  const got = await storage.get([CHECKPOINT_KEY]);
  return (got && got[CHECKPOINT_KEY]) || null;
}

export async function saveCheckpoint(storage, checkpoint) {
  const clean = stripSecretFields(checkpoint);
  assertSecretFree(clean, "unfollow checkpoint");
  await storage.set({ [CHECKPOINT_KEY]: clean });
  return clean;
}

export async function clearCheckpoint(storage) {
  await storage.remove([CHECKPOINT_KEY]);
}

// --- 护栏 f：清单落盘 + 一键重新关注 -----------------------------------------

export async function writeManifest(storage, { previewHash, items, createdAt }) {
  const manifests = await loadManifests(storage);
  const id = "mf" + Number(createdAt).toString(36);
  const manifest = {
    id,
    createdAt,
    previewHash: previewHash || null,
    items: (Array.isArray(items) ? items : []).map((it) => ({ ...it, nickname: safeNickname(it.nickname || "") })),
    outcomes: [],
  };
  await guardSave(storage, { [MANIFESTS_KEY]: [...manifests, manifest].slice(-MANIFEST_KEEP) }, "unfollow manifest");
  return manifest;
}

export async function loadManifests(storage) {
  const got = await storage.get([MANIFESTS_KEY]);
  const list = got && got[MANIFESTS_KEY];
  return Array.isArray(list) ? list : [];
}

export async function latestManifest(storage) {
  const list = await loadManifests(storage);
  return list.length ? list[list.length - 1] : null;
}

async function updateManifestItem(storage, manifestId, mid, patch) {
  const list = await loadManifests(storage);
  const target = list.find((m) => m.id === manifestId);
  if (!target) return null;
  const row = (target.items || []).find((it) => String(it.mid) === String(mid));
  if (row) Object.assign(row, patch);
  await guardSave(storage, { [MANIFESTS_KEY]: list }, "unfollow manifest outcome");
  return row;
}

/** 落盘清单的文本形态（与取关候选清单同样口径：mid <TAB> 昵称）。 */
export function toManifestText(manifest) {
  const lines = [
    "# bili-clean-follow · 本次将取关清单（执行前落盘，不可撤销）",
    "# 批次 batch: " + (manifest.id || "") + "  生成时间 created: " + new Date(manifest.createdAt).toISOString(),
    "# 预览指纹 preview: " + (manifest.previewHash || ""),
    "# 每行 format: mid <TAB> 昵称 nickname <TAB> 结果 result",
  ];
  for (const it of manifest.items || []) {
    const result = it.ok === true ? "OK" : it.ok === false ? "FAILED" : "PLANNED";
    lines.push([it.mid, it.nickname || "", result].join("\t"));
  }
  return lines.join("\n");
}

/**
 * 一键重新关注（护栏 f 的补救面）。只准补「这一批里我们真的取关成功的人」：
 * 不在清单里的一律不加（否则等于给用户凭空加关注）。
 */
export async function restoreUnfollowed({
  storage, manifestId, confirmation = {}, transport, write = null,
  limit = DEFAULT_BATCH_LIMIT, intervalMs = MIN_ITEM_INTERVAL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random, now = () => Date.now(), onProgress = () => {}, aborted = () => false,
}) {
  if (typeof transport !== "function") {
    throw new UnfollowGuardError({ kind: "no_transport", label: GUARD_LABEL_ZH.no_transport });
  }
  const state = write || (await loadWriteSwitch(storage));
  if (!state || !state.enabled) throw new UnfollowGuardError({ kind: "write_disabled", label: GUARD_LABEL_ZH.write_disabled });
  const list = await loadManifests(storage);
  const manifest = manifestId ? list.find((m) => m.id === manifestId) : list[list.length - 1];
  if (!manifest) throw new UnfollowGuardError({ kind: "restore_unknown_manifest", label: GUARD_LABEL_ZH.restore_unknown_manifest });
  const targets = (manifest.items || []).filter((it) => it.ok === true).map((it) => String(it.mid));
  if (!targets.length) throw new UnfollowGuardError({ kind: "restore_nothing_done", label: GUARD_LABEL_ZH.restore_nothing_done });
  const limitCheck = resolveLimit(limit);
  if (!limitCheck.ok) throw new UnfollowGuardError(limitCheck);
  if (targets.length > limitCheck.limit) {
    throw new UnfollowGuardError({
      kind: "batch_limit_exceeded",
      label: GUARD_LABEL_ZH.batch_limit_exceeded + "（" + targets.length + " > " + limitCheck.limit + "）",
    });
  }
  const token = String(confirmation.token === undefined ? "" : confirmation.token).trim();
  if (token !== RESTORE_TOKEN && !(confirmation.confirmed === true && token === CONFIRM_TOKEN)) {
    throw new UnfollowGuardError({ kind: "restore_token_required", label: GUARD_LABEL_ZH.restore_token_required });
  }
  const interval = resolveIntervalMs(intervalMs);
  const restored = [];
  for (let i = 0; i < targets.length; i += 1) {
    if (aborted()) break;
    const mid = targets[i];
    await sleep(jitteredDelay(interval, random));
    let response = null;
    let verdict = null;
    try {
      response = await transport({ op: "add", mid });
      verdict = classifyResponse({
        httpStatus: response && response.httpStatus,
        payload: response && response.payload,
        rawText: response && response.rawText,
      });
    } catch (err) {
      verdict = { ok: false, kind: KIND.TRANSPORT, message: redactSecrets(String(err && err.message || err)) };
    }
    const entry = {
      at: now(), action: "refollow", manifestId: manifest.id, mid,
      ok: !!(verdict && verdict.ok), kind: verdict ? verdict.kind : KIND.UNKNOWN,
      code: verdict && verdict.code !== undefined ? verdict.code : null,
      httpStatus: response && response.httpStatus ? response.httpStatus : null,
    };
    restored.push(entry);
    await appendAudit(storage, entry);
    onProgress({ index: i + 1, total: targets.length, mid, ok: entry.ok });
    if (CIRCUIT_BREAK_KINDS.includes(entry.kind)) {
      await appendAudit(storage, { at: now(), action: "circuit_break", manifestId: manifest.id, mid, kind: entry.kind, remaining: targets.length - i - 1 });
      break;
    }
  }
  return { ok: true, manifestId: manifest.id, attempted: targets.length, ok_count: restored.filter((r) => r.ok).length, trail: restored };
}

// --- 护栏 g：审计与 CSV 导出 -------------------------------------------------

export async function appendAudit(storage, entry) {
  const clean = stripSecretFields({ ...entry, nickname: safeNickname(entry.nickname || "") });
  assertSecretFree(clean, "unfollow audit log");
  const log = await loadAudit(storage);
  log.push(clean);
  await guardSave(storage, { [AUDIT_KEY]: log.slice(-AUDIT_KEEP) }, "unfollow audit log");
  return log.length;
}

export async function loadAudit(storage) {
  const got = await storage.get([AUDIT_KEY]);
  const log = got && got[AUDIT_KEY];
  return Array.isArray(log) ? log : [];
}

export const AUDIT_CSV_FIELDS = [
  "time", "action", "batch", "mid", "nickname", "category", "result", "code", "http", "kind", "preview",
];

/** 审计日志 -> CSV（带 BOM，Excel / WPS 双击不乱码，与 CLI 口径一致）。 */
export function toAuditCsv(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const head = AUDIT_CSV_FIELDS.join(",");
  const lines = rows.map((e) => [
    new Date(e.at || Date.now()).toISOString(),
    e.action || "",
    e.manifestId || "",
    e.mid || "",
    csvCell(safeNickname(e.nickname || "")),
    e.category || "",
    e.ok === true ? "ok" : e.ok === false ? "failed" : "info",
    e.code === null || e.code === undefined ? "" : String(e.code),
    e.httpStatus === null || e.httpStatus === undefined ? "" : String(e.httpStatus),
    e.kind || "",
    e.previewHash || "",
  ].join(","));
  return CSV_BOM + [head, ...lines].join("\r\n") + "\r\n";
}

function safeNickname(value) {
  // 昵称是用户可控文本：先遮凭据形态，再截断，保证清单/审计/导出不会被昵称里的怪东西污染。
  return String(redactSecrets(String(value || ""))).replace(/[\r\n\t]+/g, " ").slice(0, 48);
}

async function guardSave(storage, payload, where) {
  const clean = stripSecretFields(payload);
  assertSecretFree(clean, where);
  await storage.set(clean);
  return clean;
}

export function guardrailSummary() {
  return {
    writeDefault: "off",
    confirmToken: CONFIRM_TOKEN,
    batchDefault: DEFAULT_BATCH_LIMIT,
    batchHardCap: HARD_BATCH_LIMIT,
    minIntervalMs: MIN_ITEM_INTERVAL_MS,
    circuitBreakKinds: CIRCUIT_BREAK_KINDS,
    keepNeverCandidate: true,
    unsureNeverCandidate: true,
    manifestBeforeWrite: true,
    restoreEndpoint: "x/relation/add",
    auditCsv: true,
  };
}

export { categoryName };