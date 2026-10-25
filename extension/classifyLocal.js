// classifyLocal.js —— 离线规则分类（零外发降级，v2-spec §3.3 第一条）。
//
// 定位要说实话：这是「粗分类」，不是 AI 分类。
//   * 只用已经在内存里的东西：昵称、简介、官方认证、关注时间。零网络。
//   * 置信度有硬上限 LOCAL_MAX_CONFIDENCE = 0.60：单条命中大多落在 0.55 以下，
//     于是会进「待确认」桶 —— 这是刻意的，离线路径不装出 AI 的把握。
//   * 关注时间只当弱信号（±0.03，且写进 reason），单独靠它不给类别。
//
// 本文件不得出现 fetch / XMLHttpRequest / WebSocket：测试会钉住（验收「离线降级路径无网络请求」）。

import {
  LOW_CONFIDENCE,
  OTHER_CATEGORY,
  UNSURE_CATEGORY,
  matchKeywords,
  officialCategory,
} from "./taxonomy.js";

export const LOCAL_SOURCE = "local";
export const LOCAL_LABEL = "离线粗分类";
export const LOCAL_MAX_CONFIDENCE = 0.68; // 离线上限：再像也不给 0.9，那是 AI 的口径
export const REASON_MAX = 40; // 验收：reason <= 40 字中文
const DAY_MS = 86400000;
const STALE_FOLLOW_DAYS = 730; // 关注两年以上：只能算「老关注」，不足以定类别
const HIT_BASE = 0.42; // 一个词命中一次 -> 0.53：低于阈值进待确认，这是刻意的
const PER_DISTINCT = 0.11; // 多一个不同关键词
const PER_EXTRA_OCCURRENCE = 0.07; // 同一个词在昵称与简介里都出现
const OFFICIAL_BASE = 0.6;
const NICKNAME_BASE = 0.48; // 昵称里的方向提示：弱一档，不能冒充「官方认证」
const AGREEMENT_BONUS = 0.14; // 认证/昵称方向与关键词命中同向：两个独立信号
const OFFICIAL_AGREEMENT = 0.04;
const RUNNER_UP_PENALTY = 0.06;

/**
 * 单条离线分类。只用已在内存里的字段：零网络。
 * @returns {{category: string, confidence: number, reason: string, source: string}}
 */
export function classifyLocally(item, taxonomy, { now = Date.now() } = {}) {
  const nickname = text(item && item.nickname);
  const bio = text(item && item.bio);
  const official = text(item && (item.official || item.official_title));
  const verified = Boolean(item && item.verified);

  const scored = matchKeywords(taxonomy, [official, nickname, bio]);
  // 认证文案与昵称分开算：昵称里有「影视」只是提示，不是认证。
  const officialHit = official ? officialCategory(official, verified) : null;
  const nicknameHit = officialHit ? null : officialCategory(nickname, false);

  let best = null;
  let confidence = 0;
  const reasons = [];

  if (officialHit) {
    best = officialHit;
    confidence = OFFICIAL_BASE;
    reasons.push("认证" + official.slice(0, 12));
  } else if (nicknameHit) {
    best = nicknameHit;
    confidence = NICKNAME_BASE;
    reasons.push("昵称给出内容方向");
  } else if (scored.length) {
    best = scored[0].id;
    confidence = HIT_BASE + PER_DISTINCT * scored[0].words.length +
      PER_EXTRA_OCCURRENCE * (scored[0].occurrences - scored[0].words.length);
  }

  if (best) {
    const same = scored.find((s) => s.id === best);
    if (same) {
    if (officialHit || nicknameHit) {
      // 只有「认证/昵称方向」与「关键词命中」互相印证才加成：
      // 单个关键词自己印证自己不叫信号，那叫巧合（所以不加成）。
      confidence += officialHit ? OFFICIAL_AGREEMENT : AGREEMENT_BONUS;
    }
      reasons.push("命中" + same.words.slice(0, 2).join("/"));
    }
  }

  // 关注时间：弱信号，只能微调，不能单独定类。
  const followAgeDays = followAge(item, now);
  if (best && followAgeDays !== null) {
    if (followAgeDays > STALE_FOLLOW_DAYS) confidence -= 0.02;
    reasons.push("关注于 " + Math.round(followAgeDays / 30) + " 个月前");
  }

  if (!best) {
    return {
      category: OTHER_CATEGORY,
      confidence: 0.2,
      reason: capReason("昵称与简介都没有可用信号，无法判断内容方向"),
      source: LOCAL_SOURCE,
      label: LOCAL_LABEL,
      unsent: true,
    };
  }

  const bestEntry = scored.find((s) => s.id === best) || scored[0];
  const runnerUp = scored.find((s) => s.id !== best);
  if (runnerUp && bestEntry && runnerUp.weight >= 0.8 * bestEntry.weight) {
    confidence -= RUNNER_UP_PENALTY; // 两个方向几乎并列：别装确定
  }

  confidence = clamp(confidence, 0, LOCAL_MAX_CONFIDENCE);

  return {
    category: confidence < LOW_CONFIDENCE ? UNSURE_CATEGORY : best,
    confidence: Number(confidence.toFixed(2)),
    reason: capReason(reasons.join("，") + (runnerUp ? "，与" + runnerUp.words[0] + "有重叠" : "")),
    source: LOCAL_SOURCE,
    label: LOCAL_LABEL,
    rawCategory: best, // 低置信会被挪进「待确认」，但本来像哪一类要留痕
    matched: scored[0] ? scored[0].words.slice(0, 3) : [],
  };
}

/**
 * 批量离线分类。零网络是这条路径的卖点，所以这里连 fetch 都不接。
 */
export function classifyLocalBatch(items, taxonomy, opts = {}) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const one = classifyLocally(it, taxonomy, opts);
    return { mid: String(it.mid), ...one };
  });
}

/** 低置信归桶（v2-spec §3.2：不硬塞）。LLM 与离线路径共用这一条判据。 */
export function bucketByConfidence(result) {
  const conf = Number(result && result.confidence);
  if (!Number.isFinite(conf) || conf < LOW_CONFIDENCE) return UNSURE_CATEGORY;
  return result.category;
}

export function localConfidenceCap() {
  return LOCAL_MAX_CONFIDENCE;
}

function followAge(item, now) {
  const ts = Number(item && (item.followTs ?? item.follow_ts ?? item.mtime));
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const ms = ts > 1e11 ? ts : ts * 1000; // B站给秒或毫秒都见过
  const age = (now - ms) / DAY_MS;
  return age >= 0 ? age : null;
}

function capReason(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= REASON_MAX) return clean;
  return clean.slice(0, REASON_MAX - 1) + "…";
}

function text(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}