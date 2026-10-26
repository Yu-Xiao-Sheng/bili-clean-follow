// track_b_policy.mjs —— B 轨（真实登录态只读取证）的安全策略，纯函数。
//
// 为什么单独一个文件：B 轨要在**真实账号**上跑。一旦 (a) 取证过程发出写请求，代价是真人账号
// 被改关注关系；一旦 (b) 落盘快照多带一个字段，代价是凭据或原始响应体进 git。这两件事都不能
// 等真跑的时候靠人肉盯，所以判据放在这里，由 tests/e2e/track_b_policy.test.mjs 在**没有浏览器、
// 没有账号**的 CI 里钉死。取证脚本 track_b_real_readonly.mjs 只负责执行，判据以本文件为准。

/** 只读白名单：与 extension/biliApi.js 的 READ 端点逐条对齐（写端点一个都不许进）。 */
export const READ_ENDPOINTS = Object.freeze([
  "/x/web-interface/nav",        // 登录态自检（B 轨开跑前先确认这是真实会话）
  "/x/relation/followings",      // 分页读关注列表（FOR-63 主路径）
  "/x/relation/stat",            // 关注/粉丝计数（B1 对账用）
  "/x/web-interface/card",       // 单条补信号（FOR-40 口径）
  "/x/space/top/arc",            // 单条最近投稿（FOR-40 口径）
]);

/**
 * 明确禁止的写端点。单独列一份，是为了让拒绝理由能区分「不在白名单里」（可能是产品新增了只读
 * 端点，需要人来加白名单）和「这是写操作」（无论什么方法都永远拒）。
 * /x/relation/block、/x/relation/tag 是 FOR-63 里就写死的「永远不做」，也列进来。
 */
export const WRITE_ENDPOINTS = Object.freeze([
  "/x/relation/delete",   // 取关：FOR-65 的写路径，B 轨永远不许发
  "/x/relation/add",      // 一键重新关注（补救），同样是写
  "/x/relation/block",
  "/x/relation/blacklist",
  "/x/relation/tag",
  "/x/relation/tags",     // 分组写操作（POST 建组）
]);

/** 允许出网的宿主；其余一律拒绝，B 轨不读第三方域。 */
export const ALLOWED_HOSTS = Object.freeze([
  "api.bilibili.com",
  "www.bilibili.com",
  "space.bilibili.com",
]);

/** 凭据形态：证据文件里出现任何一个键名命中，整份文件判红。 */
export const SECRET_KEY_RE = /(cookie|sessdata|bili_jct|dedeuserid|csrf|access[_-]?key|api[_-]?key|authorization|bearer|token|secret|password|fingerprint)/i;

/**
 * 一条请求该不该放行。只做静态判断，不看响应。
 * @param {{method?: string, url?: string, hasPostData?: boolean}} req
 * @returns {{allowed: boolean, kind: "read"|"write"|"method"|"body"|"host"|"path", reason: string, host: string, path: string}}
 */
export function decideRequest(req = {}) {
  const method = String(req.method || "GET").toUpperCase();
  let parsed;
  try {
    parsed = new URL(String(req.url || ""));
  } catch {
    return { allowed: false, kind: "path", reason: "url_unparseable", host: "", path: "" };
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (WRITE_ENDPOINTS.includes(path)) {
    return { allowed: false, kind: "write", reason: "write_operation_never_allowed_on_real_session", host, path };
  }
  if (!ALLOWED_HOSTS.includes(host)) {
    return { allowed: false, kind: "host", reason: "offsite_host", host, path };
  }
  if (method !== "GET") {
    return { allowed: false, kind: "method", reason: "non_get_method", host, path };
  }
  if (req.hasPostData) {
    return { allowed: false, kind: "body", reason: "request_body_not_allowed", host, path };
  }
  if (!READ_ENDPOINTS.includes(path)) {
    return { allowed: false, kind: "path", reason: "not_in_read_allowlist", host, path };
  }
  return { allowed: true, kind: "read", reason: "read_allowlist", host, path };
}

/** 落盘快照的字段白名单（与 docs/qa-evidence/README.md 一字不差）。 */
export const ITEM_FIELDS = Object.freeze(["mid", "name", "category", "confidence"]);

/**
 * 把扩展内部的一条条目（含 face / sign / official / reason / source / rawCategory 等）
 * 收成快照四列。多余字段一律丢掉：原始响应体不进 git。
 */
export function publicItem(raw = {}) {
  const confidence = Number(raw.confidence);
  return {
    mid: String(raw.mid ?? ""),
    // 扩展内部条目叫 nickname，快照列叫 name：谁有值取谁（空串不能把有值的那一侧顶掉）
    name: String([raw.name, raw.nickname].find((v) => String(v ?? "").trim()) ?? ""),
    category: String(raw.category ?? ""),
    confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(2)) : 0,
  };
}

/** 递归找凭据形态的键名，返回命中路径（空数组 = 干净）。 */
export function findSecretKeys(value, trail = [], hits = []) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const here = trail.concat(k);
      if (SECRET_KEY_RE.test(k)) hits.push(here.join("."));
      findSecretKeys(v, here, hits);
    }
  }
  return hits;
}

/**
 * 快照自证：契约来自 docs/qa-evidence/README.md，CI 的
 * tests/test_release_hygiene.py::test_qa_evidence_scan_items_snapshot_matches_the_report 同口径。
 * @param {unknown} items
 * @param {{followTotal?: number, counts?: Record<string, number>}} expected
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateScanItems(items, expected = {}) {
  const problems = [];
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, problems: ["快照必须是非空数组"] };
  }
  const seen = new Set();
  const counts = new Map();
  items.forEach((it, i) => {
    if (!it || typeof it !== "object") { problems.push(`#${i} 不是对象`); return; }
    const keys = Object.keys(it).sort();
    const want = ITEM_FIELDS.slice().sort();
    if (keys.length !== want.length || keys.some((k, j) => k !== want[j])) {
      problems.push(`#${i} 字段必须是 mid/name/category/confidence，实际 ${JSON.stringify(keys)}`);
    }
    if (!String(it.mid ?? "")) problems.push(`#${i} mid 为空`);
    if (seen.has(String(it.mid))) problems.push(`#${i} mid 重复：${it.mid}`);
    seen.add(String(it.mid));
    if (!String(it.name ?? "").trim()) problems.push(`#${i} 昵称为空（逐条镜头会拍成空白）`);
    if (!String(it.category ?? "")) problems.push(`#${i} category 为空`);
    const conf = it.confidence;
    if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 1) {
      problems.push(`#${i} confidence 不在 0..1：${JSON.stringify(conf)}`);
    }
    counts.set(String(it.category), (counts.get(String(it.category)) || 0) + 1);
  });

  const secretHits = findSecretKeys(items);
  if (secretHits.length) problems.push("快照里出现凭据形态的键：" + secretHits.join(", "));

  if (expected.followTotal !== undefined && items.length !== Number(expected.followTotal)) {
    problems.push(`len(items)=${items.length} != follow_total=${expected.followTotal}`);
  }
  if (expected.counts) {
    for (const [cat, n] of Object.entries(expected.counts)) {
      if (Number(n) === 0) continue;
      if ((counts.get(cat) || 0) !== Number(n)) problems.push(`类目 ${cat} 条数 ${counts.get(cat) || 0} != cls.counts ${n}`);
    }
    for (const [cat, n] of counts) {
      if (!(cat in expected.counts)) problems.push(`类目 ${cat} 有 ${n} 条但报告 cls.counts 里没有它`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 请求日志的落盘形状：只有 method / host / path / allowed，永不带 header、cookie、响应体。 */
export function publicRequestLog(records = []) {
  return records.map((r) => {
    const d = decideRequest(r);
    return { method: String(r.method || "GET").toUpperCase(), host: d.host, path: d.path, allowed: d.allowed, kind: d.kind };
  });
}