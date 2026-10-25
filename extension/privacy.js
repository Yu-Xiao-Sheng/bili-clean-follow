// privacy.js —— 凭据边界（FOR-63 验收 7）。
//
// 规矩只有一条：任何要离开内存的东西（chrome.storage、console、下载出来的文件）
// 先过 redactSecrets()，再用 assertSecretFree() 兜一道。CLI 那边同样的口径钉在
// CI 的 credential leak scan（.github/workflows/ci.yml，FOR-27）里，插件侧必须在
// 运行时也钉住，否则用户在侧栏里看到 console 里躺着 SESSDATA。
//
// v2 §3.3 的隐私口径：凭据永不出本机；昵称与简介只发给用户自己填的模型端点。
// 本文件是这条口径的唯一实现处，别再各写一份。

// 值形态的凭据：只有「名字 + 分隔符 + 够长的值」才算命中，
// 否则 README / 报告正文里提到 SESSDATA 这个词会误伤。
export const SECRET_PATTERNS = [
  { label: "cookie_SESSDATA", re: /SESSDATA\s*[=:]\s*[A-Za-z0-9+_/=-]{8,}/gi },
  { label: "cookie_bili_jct", re: /bili_jct\s*[=:]\s*[A-Za-z0-9]{8,}/gi },
  { label: "cookie_DedeUserID", re: /DedeUserID(?:__ckMd5)?\s*[=:]\s*\d{4,}/gi },
  { label: "cookie_ticket", re: /bili_ticket(?:_ex)?\s*[=:]\s*[A-Za-z0-9]{8,}/gi },
  { label: "refresh_token", re: /refresh[_-]?token\s*[=:]\s*[A-Za-z0-9._-]{8,}/gi },
  { label: "auth_header", re: /Authorization\s*[=:]\s*(?:Bearer|Basic)\s*[A-Za-z0-9._+/=-]{12,}/gi },
  { label: "csrf", re: /\bcsrf\s*[=:]\s*[A-Za-z0-9]{16,}/gi },
  { label: "llm_key", re: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: "set_cookie_header", re: /Set-Cookie\s*[=:]\s*"[^"\n]{10,}/gi },
];

// B站 cookie 名清单：读登录态时只准回答「有没有」，永远不要把 value 落盘。
export const SECRET_COOKIE_NAMES = [
  "SESSDATA", "bili_jct", "sid", "DedeUserID", "DedeUserID__ckMd5",
  "bili_ticket", "bili_ticket_ex", "refresh_token", "buvid3", "buvid4",
];

// storage / 日志里出现这些字段名就整条丢掉（值形态之外的第二道闸）。
export const SECRET_FIELD_NAMES = [
  "cookie", "cookies", "set-cookie", "authorization", "csrf", "bili_jct",
  "sessdata", "dedeuserid", "key", "apikey", "api_key", "llmkey",
  "access_token", "refreshtoken", "token",
];

/** 命中第一条凭据时返回 {label, sample}，否则 null。sample 已截断，不外泄全值。 */
export function findSecret(value) {
  const text = typeof value === "string" ? value : safeStringify(value);
  if (!text) return null;
  for (const { label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) return { label, sample: m[0].slice(0, 24) + "…" };
  }
  return null;
}

/** 把凭据形态替换成 [redacted:<label>]，用于日志与导出文件的最后一道兜底。 */
export function redactSecrets(value) {
  let text = typeof value === "string" ? value : safeStringify(value);
  if (!text) return "";
  for (const { label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, "[redacted:" + label + "]");
  }
  return text;
}

/** 硬闸：内容里还有凭据形态就抛错，调用方不得继续写盘/下载/打日志。 */
export function assertSecretFree(value, where = "output") {
  const hit = findSecret(value);
  if (hit) {
    throw new Error(
      "refusing to write credentials to " + where +
      " (" + hit.label + " like " + hit.sample + ")");
  }
  return true;
}

/** 递归丢掉 cookie / token / key 形态的字段，只留可安全落盘的白名单数据。 */
export function stripSecretFields(value) {
  if (Array.isArray(value)) return value.map(stripSecretFields);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const name = String(k).toLowerCase().replace(/[_-]/g, "");
    if (SECRET_FIELD_NAMES.includes(name) || SECRET_FIELD_NAMES.includes(String(k).toLowerCase())) {
      continue;
    }
    out[k] = stripSecretFields(v);
  }
  return out;
}

/** 日志用：整条先剥凭据字段，再遮值形态，绝不打原始对象。 */
export function safeLog(...parts) {
  return parts.map((p) => redactSecrets(stripSecretFields(p))).join(" ");
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}
