// biliApi.js —— 全插件唯一的 B站接口层（v2-spec §1.2 + §2.2）。
//
// 为什么只准这一处调接口：v2-spec §1.2 的可达性结论是**实测**出来的，不是猜的：
//   x/relation/followings  匿名 code=-101（账号未登录）→ 主抓取路径，必须在登录态里调
//   x/relation/followers   匿名 code=-352（风控）        → 禁用，不作为主路径
//   x/space/wbi/acc/info   code=-352（风控校验失败）      → 禁用
//   x/relation/stat        code=0                        → 匿名可用（authority 信号）
//   x/web-interface/card   code=0                        → 匿名可用（简介/认证/粉丝数）
//   x/space/arc/search、x/polymer/web-dynamic/v1/feed/space → HTTP 412（需 wbi 签名）→ 不依赖
//   x/relation/delete / x/relation/add                   → 写接口：FOR-63 一条都不调；FOR-65 起
//     才允许调用，但只准经 unfollow.js 的七条护栏（默认关闭 + diff 预览 + 手输 UNFOLLOW
//     + 批量上限 + 速率下限 + 熔断断点 + 审计/补救），见 v2-spec §4
// 接口名散落到别处，下一次改版就会把 -352 那两个重新捡回来。所以这里既是实现也是门禁，
// FORBIDDEN_ENDPOINTS + tests/extension/bili_api_semantics.test.mjs 一起钉住。
//
// 本模块不碰 chrome.* / DOM，所以能被 node:test 直接 import 做离线单测。

import { redactSecrets } from "./privacy.js";

export const API_ORIGIN = "https://api.bilibili.com";

// 允许调用的只读接口（v2-spec §1.2 的 v2 用法列）。
export const ENDPOINTS = {
  nav: API_ORIGIN + "/x/web-interface/nav",
  followings: API_ORIGIN + "/x/relation/followings",
  relationStat: API_ORIGIN + "/x/relation/stat",
  card: API_ORIGIN + "/x/web-interface/card",
  spaceTopArc: API_ORIGIN + "/x/space/top/arc",
};

// 实测不可用，或语义上永远不该做的接口。代码里出现即测试失败。
export const FORBIDDEN_ENDPOINTS = [
  "/x/relation/followers", // 实测 -352 风控
  "/x/space/wbi/acc/info", // 实测 -352 风控
  "/x/relation/block", // 拉黑不是「清理关注」，永远不做
  "/x/relation/blacklist", // 同上
  "/x/relation/tag", // 关注分组写操作：本版不做
  "/x/space/arc/search", // 实测 HTTP 412
  "/x/polymer/web-dynamic/v1/feed/space", // 实测 HTTP 412
];

/**
 * 写接口（FOR-65，v2-spec §4）：v1 的 report-only 支柱改写成
 * 「默认只报告，写操作要显式武装」。这两个接口在本扩展里只准出现在这一处，
 * 调用面只有 unfollow.js（带七条护栏）与 background.js（唯一有 fetch 的地方）；
 * 别的模块出现接口名字符串 = tests/extension/write_endpoint_boundary.test.mjs 直接红。
 */
export const WRITE_ENDPOINTS = {
  unfollow: API_ORIGIN + "/x/relation/delete", // 取关
  addFollow: API_ORIGIN + "/x/relation/add", // 一键重新关注（补救）
};

/** 写接口的表单体：B站要 form fid + csrf。csrf = bili_jct，只在内存里存在：
 *  不进 storage、不进审计、不进日志（privacy.js 会拦，本函数的调用方也不许把它传出去）。
 *  拿不到 csrf 就抛 —— 没有 csrf 的写请求一律不发。 */
export function buildWriteForm({ mid, csrf }) {
  const fid = String(mid === undefined || mid === null ? "" : mid).trim();
  if (!/^\d+$/.test(fid)) throw new Error("fid 必须是纯数字 mid，收到 " + JSON.stringify(String(fid).slice(0, 24)));
  const token = String(csrf === undefined || csrf === null ? "" : csrf).trim();
  if (!token) throw new Error("csrf 为空：拿不到 bili_jct 就不发起写操作（多半是没登录）");
  const params = new URLSearchParams();
  params.set("fid", fid);
  params.set("csrf", token);
  return params.toString();
}

// ps=20 是实测可用的分页粒度（更大的 ps 会被截断），别顺手改成 50。
export const PAGE_SIZE = 20;
export const ORDER = "desc";
export const ORDER_FIELD = "ptime"; // 按关注时间排序，抓全后再翻页不会漏项
export const MIN_INTERVAL_MS = 450; // 只读抓取的自我限速下限
export const MAX_RETRIES = 3; // 同一页连续失败次数上限（不含退避次数）
export const MAX_PAGES = 400; // 8000 条的关注数上限保护，防死循环
export const TOTAL_CAP = 2000; // B站对关注数展示的上限；撞上要显式提示，不得静默
export const TOTAL_DRIFT_NOTE =
  "已取条数超过 B站给出的关注数（翻页期间列表发生漂移）：建议重抓一次核对，" +
  "读全门禁按 fetched >= total 判定。";

export const TOTAL_CAP_NOTE =
  "total=" + TOTAL_CAP + "：B站关注数展示有上限，请用关注页显示的关注数核对，" +
  "fetched==total 门禁在 2000+ 关注时可能永远不成立。";

export const CODES = {
  OK: 0,
  NOT_LOGGED_IN: -101,
  RISK_CONTROL: -352,
  SIGNED_REQUIRED: 412,
};

// 错误语义（v2-spec §1.2 实施要求）：返回码到「用户能听懂的状态」的唯一映射。
export const KIND = {
  OK: "ok",
  NOT_LOGGED_IN: "not_logged_in",
  RISK_CONTROL: "risk_control",
  SIGNED_REQUIRED: "needs_signature",
  TRANSPORT: "transport_error",
  MALFORMED: "malformed_response",
  UNKNOWN: "unknown_error",
};

export const KIND_LABEL_ZH = {
  ok: "正常",
  not_logged_in: "未登录（code -101）：请先在浏览器登录 B站再重试",
  risk_control: "B站风控（code -352）：已保存断点，歇一会儿点「继续抓取」",
  needs_signature: "需要 wbi 签名（HTTP 412）：换用网页上下文重试",
  transport_error: "网络请求失败：重试或换用网页抓取兜底",
  malformed_response: "响应不是预期 JSON：换用网页抓取兜底",
  unknown_error: "未知错误：已保存断点",
};

const HTTP_KIND = {
  400: KIND.UNKNOWN,
  401: KIND.NOT_LOGGED_IN,
  403: KIND.RISK_CONTROL,
  405: KIND.UNKNOWN,
  412: KIND.SIGNED_REQUIRED,
  414: KIND.SIGNED_REQUIRED,
  422: KIND.UNKNOWN,
  429: KIND.RISK_CONTROL,
};

const CODE_KIND = {
  [CODES.OK]: KIND.OK,
  [CODES.NOT_LOGGED_IN]: KIND.NOT_LOGGED_IN,
  [CODES.RISK_CONTROL]: KIND.RISK_CONTROL,
  [CODES.SIGNED_REQUIRED]: KIND.SIGNED_REQUIRED,
  [-403]: KIND.NOT_LOGGED_IN, // 无权限访问：通常也是没登录
};

/**
 * 返回码 → 错误语义。body 里的 code 优先（B站 -101/-352 都发生在 HTTP 200），
 * 没有 code 才看 HTTP 状态码。单测覆盖 0 / -101 / -352 / 412 四档。
 */
export function classifyResponse({ httpStatus, payload, rawText } = {}) {
  const code = payload && typeof payload.code === "number" ? payload.code : null;
  if (code !== null) {
    const kind = CODE_KIND[code] || KIND.UNKNOWN;
    return {
      kind,
      code,
      ok: code === CODES.OK,
      message: redactSecrets(String((payload && payload.message) || "")),
      httpStatus: httpStatus ?? null,
    };
  }
  const status = Number(httpStatus) || 0;
  if (status >= 200 && status < 300) {
    // HTTP 成功但解不出 code：多半被风控换成 HTML 或被扩展页拦了。
    return { kind: KIND.MALFORMED, code: null, ok: false,
      message: "响应里没有 code 字段（可能被风控改写或返回 HTML）", httpStatus: status };
  }
  const kind = HTTP_KIND[status] || (status >= 500 ? KIND.TRANSPORT : KIND.UNKNOWN);
  const hint = rawText ? String(rawText).slice(0, 80) : "";
  return { kind, code: null, ok: false, message: "HTTP " + status + (hint ? " " + hint : ""),
    httpStatus: status || null };
}

/** 这类错误换一条传输路径（网页上下文 / DOM 兜底）才有意义。 */
export function shouldSwitchTransport(kind) {
  return kind === KIND.RISK_CONTROL || kind === KIND.SIGNED_REQUIRED ||
    kind === KIND.TRANSPORT || kind === KIND.MALFORMED;
}

/** 这类错误重试同一页没有意义（未登录要用户先登录）。 */
export function shouldStopForKind(kind) {
  return kind === KIND.NOT_LOGGED_IN;
}

export function buildFollowingsUrl({ vmid, pn = 1, ps = PAGE_SIZE } = {}) {
  if (vmid === undefined || vmid === null || vmid === "") {
    throw new Error("buildFollowingsUrl: vmid 不能为空（自己的 mid 从 x/web-interface/nav 取）");
  }
  const page = Math.max(1, Math.floor(Number(pn) || 1));
  const size = Math.min(Math.max(1, Math.floor(Number(ps) || PAGE_SIZE)), PAGE_SIZE);
  const params = new URLSearchParams({
    vmid: String(vmid), pn: String(page), ps: String(size),
    order: ORDER, order_field: ORDER_FIELD, platform: "web", web_location: "333.999",
  });
  return ENDPOINTS.followings + "?" + params.toString();
}

/** 解析关注页响应；昵称认 uname/name（CLI loaders.py 同一口径），简介认 sign。 */
export function parseFollowingsPayload(payload, extra = {}) {
  const verdict = classifyResponse({ httpStatus: extra.httpStatus, payload, rawText: extra.rawText });
  if (!verdict.ok) {
    return { ...verdict, total: null, items: [] };
  }
  const data = (payload && payload.data) || {};
  const rawList = data.list || data.follower || data.records || data.item || [];
  const totalRaw = data.total ?? data.count ?? data.total_count;
  const total = Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : null;
  const items = (Array.isArray(rawList) ? rawList : [])
    .map((row) => normalizeFollowItem(row, verdict.kind))
    .filter(Boolean);
  return { ...verdict, total, items };
}

/** 单条关注记录 → 内部形状（mid 缺失直接丢，去重全靠 mid）。 */
export function normalizeFollowItem(row, source = "api") {
  if (!row || typeof row !== "object") return null;
  const mid = firstDefined(row.mid, row.follower_id, row.fmid, row.id);
  if (mid === null || String(mid).trim() === "" || !/^\d+$/.test(String(mid))) return null;
  const nickname = cleanText(firstDefined(row.uname, row.name, row.title, row.nick_name)) || "";
  const bio = cleanText(firstDefined(row.sign, row.info, row.official_reason)) || "";
  const followTs = toNumber(firstDefined(row.mtime, row.ptime, row.gtime, row.ctime));
  const official = row.official && typeof row.official === "object"
    ? cleanText(firstDefined(row.official.title, row.official.role, row.official.department)) || ""
    : "";
  const verified = !!((row.official_verify && Number(row.official_verify.type) >= 0) ||
    (row.official && (Number(row.official.type) >= 0 || row.official.verified)));
  return {
    mid: String(mid),
    nickname,
    bio,
    followTs,
    official,
    verified,
    vip: row.vip && typeof row.vip === "object" ? !!row.vip.status : false,
    tags: Array.isArray(row.tags) ? row.tags.map((t) => cleanText(t && t.name) || "").filter(Boolean) : [],
    source,
  };
}

/** 合并两批关注：mid 去重（先到者胜），缺字段用后到的一路补齐。 */
export function mergeFollowItems(existing, incoming) {
  const map = new Map();
  for (const it of dedupeFollowItems(existing)) map.set(it.mid, it);
  for (const it of dedupeFollowItems(incoming)) {
    const prev = map.get(it.mid);
    if (!prev) {
      map.set(it.mid, it);
      continue;
    }
    map.set(it.mid, {
      ...prev,
      nickname: prev.nickname || it.nickname,
      bio: prev.bio || it.bio,
      official: prev.official || it.official,
      verified: prev.verified || it.verified,
      followTs: prev.followTs ?? it.followTs,
      tags: prev.tags && prev.tags.length ? prev.tags : it.tags,
      source: prev.source || it.source,
    });
  }
  return [...map.values()];
}

export function dedupeFollowItems(items) {
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.mid) continue;
    if (!out.has(it.mid)) out.set(it.mid, it);
  }
  return [...out.values()];
}

/**
 * 抓取循环（v2-spec §3.1 硬性前置）：一直翻到 fetched == total。
 *
 * fetchPage(pn) 由调用方提供（插件里是「service worker fetch → 网页上下文 fetch →
 * content script 抓 DOM」三级降级；单测里是假分页），返回：
 *   { ok, kind, code, message, total, items }
 * 完成条件只有一个：去重后的 fetched == total。页数用完/风控/中止都只算 incomplete，
 * 数据保留并记下断点页（resumeFromPn），「开始分类」按钮在 complete 之前保持 disabled。
 */
export async function scanAllFollowings({
  fetchPage,
  startPn = 1,
  initialItems = [],
  initialTotal = null,
  ps = PAGE_SIZE,
  onProgress = null,
  shouldAbort = () => false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = MIN_INTERVAL_MS,
  maxRetries = MAX_RETRIES,
  maxPages = MAX_PAGES,
} = {}) {
  if (typeof fetchPage !== "function") throw new Error("scanAllFollowings: fetchPage 必填");
  const pageSize = Math.max(1, Math.floor(Number(ps) || PAGE_SIZE));
  let items = dedupeFollowItems(initialItems);
  let total = toTotal(initialTotal);
  let pn = Math.max(1, Math.floor(Number(startPn) || 1));
  let pagesFetched = 0;
  let retries = 0;
  let transportSwitches = 0;
  const errors = [];

  const snapshot = (status, incompleteReason = null, lastKind = null) => ({
    status,
    items,
    fetched: items.length,
    total,
    pages: pagesFetched,
    ps: pageSize,
    lastPn: pn,
    resumeFromPn: status === "complete" ? null : pn,
    incompleteReason,
    lastKind,
    lastError: errors.length ? errors[errors.length - 1] : null,
    errors,
    transportSwitches,
    totalCapped: total !== null && total >= TOTAL_CAP,
    overCount: total !== null && items.length > total,
  });

  for (;;) {
    if (shouldAbort()) return snapshot("incomplete", "aborted");
    if (pagesFetched >= maxPages) return snapshot("incomplete", "page_cap");

    let res;
    try {
      res = await fetchPage(pn);
    } catch (err) {
      res = { ok: false, kind: KIND.TRANSPORT, message: redactSecrets(err && err.message) };
    }
    pagesFetched += 1;
    const kind = (res && res.kind) || KIND.UNKNOWN;

    if (res && res.ok) {
      retries = 0;
      const nextPageTotal = toTotal(res.total);
      if (nextPageTotal !== null) total = nextPageTotal;
      items = mergeFollowItems(items, res.items || []);
      if (typeof onProgress === "function") onProgress(snapshot("scanning"));

      const fetched = items.length;
      if (total === 0) return snapshot("incomplete", "empty_list");
      if (total !== null && fetched >= total) return snapshot("complete");
      if (total !== null && pn >= Math.ceil(total / pageSize)) {
        return snapshot(fetched >= total ? "complete" : "incomplete",
          fetched >= total ? null : "pages_exhausted", fetched >= total ? null : KIND.UNKNOWN);
      }
      if (total === null && (res.items || []).length === 0) {
        // 没有 total 就无法证明读全，按 incomplete 处理（v2-spec：不得静默继续）。
        return snapshot("incomplete", "total_unknown");
      }
      pn += 1;
      await sleep(withJitter(intervalMs));
      continue;
    }

    const message = redactSecrets((res && res.message) || "unknown error");
    errors.push({ pn, kind, message, code: res && res.code !== undefined ? res.code : null });
    if (shouldStopForKind(kind)) return snapshot("incomplete", kind, kind);

    retries += 1;
    if (shouldSwitchTransport(kind)) {
      transportSwitches += 1;
      await sleep(withJitter(intervalMs * 2 * retries));
      if (retries > maxRetries) return snapshot("incomplete", kind, kind);
      continue; // 重试同一页：换传输路径由 fetchPage 内部决定
    }
    if (retries > maxRetries) return snapshot("incomplete", kind, kind);
    await sleep(withJitter(intervalMs * 2 * retries));
  }
}

/** 唯一的完成判据（v2-spec §3.1：fetched == total 才允许分类）。 */
export function isReadComplete(state) {
  if (!state) return false;
  const total = Number(state.total);
  const fetched = Number(state.fetched);
  if (!Number.isFinite(total) || !Number.isFinite(fetched)) return false;
  if (total <= 0) return false;
  if (fetched < total) return false; // 漂移导致多取不算破门禁，少取才是没读全
  return state.status ? state.status === "complete" : true;
}

export function canClassify(state) {
  return isReadComplete(state);
}

/** 侧栏进度文案。未完成必须写清「已取 x/total」，这是验收项，不是可选文案。
 *  withPages=false 给出验收口径的紧凑版：还没读全（已取 431/812）。 */
export function progressLabel(state, { withPages = true } = {}) {
  const total = Number(state && state.total);
  const fetched = Number((state && state.fetched) || 0);
  const pages = Number((state && state.pages) || 0);
  const totalText = Number.isFinite(total) && total > 0 ? String(total) : "未知";
  const pageText = withPages ? "，第 " + pages + " 页" : "";
  if (isReadComplete(state)) {
    return "已读全（已取 " + fetched + "/" + totalText + pageText + "）";
  }
  return "还没读全（已取 " + fetched + "/" + totalText + pageText + "）";
}

/** 未读全时给用户的下一步动作。 */
export function incompleteHint(state) {
  const reason = state && state.incompleteReason;
  if (!reason) return "";
  if (reason === KIND.NOT_LOGGED_IN) return KIND_LABEL_ZH.not_logged_in;
  if (reason === KIND.RISK_CONTROL) return KIND_LABEL_ZH.risk_control;
  if (reason === KIND.SIGNED_REQUIRED) return KIND_LABEL_ZH.needs_signature;
  if (reason === "aborted") return "已按你的要求停止，数据保留，点「继续抓取」接着翻页。";
  if (reason === "pages_exhausted") {
    return "接口页数已用尽但仍没读全（fetched=" + (state.fetched || 0) +
      "，total=" + (state.total === null ? "未知" : state.total) + "）：改用网页抓取兜底再试。";
  }
  if (reason === "page_cap") return "已到达 " + MAX_PAGES + " 页上限，停止抓取以免死循环；请用网页抓取兜底核对。";
  if (reason === "empty_list") return "关注数为 0：这个账号没有关注，没有可抓取的内容。";
  if (reason === "total_unknown") return "B站没给出关注数（total 未知），无法证明读全，先按 incomplete 处理。";
  return KIND_LABEL_ZH[reason] || KIND_LABEL_ZH.unknown_error;
}

function withJitter(ms) {
  const base = Math.max(0, Number(ms) || 0);
  return Math.round(base + Math.random() * base * 0.3);
}

function toTotal(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return null;
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\r\n\t]+/g, " ").trim();
  return s ? s : null;
}

/** 解析 x/web-interface/nav：拿自己的 mid（抓关注列表的 vmid 只能是本人 mid）。 */
export function parseNavPayload(payload, extra = {}) {
  const verdict = classifyResponse({ httpStatus: extra.httpStatus, payload, rawText: extra.rawText });
  const data = (payload && payload.data) || {};
  const mid = /^\d+$/.test(String(data.mid ?? "")) ? String(data.mid) : null;
  return {
    ...verdict,
    mid,
    nickname: cleanText(data.uname) || "",
    vip: !!(data.vip && data.vip.status),
    login: !!data.isLogin && !!mid,
  };
}
