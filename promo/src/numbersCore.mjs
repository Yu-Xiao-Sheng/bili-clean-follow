// 取数契约与占位符替换的单一实现（无依赖 .mjs）
// 消费方有两个：promo/tools/fill_numbers.mjs（渲染前校验 + 生成）与
// promo/src/numbers.ts（渲染时取值替换）。测试直接 import 本文件。
export const PAGE_SIZE = 20;      // B 站 x/relation/followings 每页 20 条
export const BATCH_SIZE = 40;     // extension/classifyLlm.js BATCH_SIZE
export const TRACK_NAMES = ["A", "B", "C"];
export const TRACK_KINDS = ["mock", "real", "offline"];
export const NOT_FILLED =
  "片内数字未注入：先跑 `npm run fill -- --from=docs/qa-report-v2.json`（取数来源是 FOR-67 的取证报告）。" +
  "报告没落地之前不许渲染两支 v2 影片——这是 FOR-70 的硬门禁，不是警告。";

// 类目稳定 id -> 中文名，取自 extension/taxonomy.js 的 12 类预置体系（只放标签，不放数量）。
export const CATEGORY_NAMES = {
  game: "游戏电竞",
  tech: "科技数码",
  film: "影视综艺",
  knowledge: "知识教育",
  food: "美食",
  life: "生活日常",
  funny: "搞笑段子",
  music: "音乐",
  anime: "动漫二次元",
  sports: "体育",
  beauty: "时尚美妆",
  news: "资讯时事",
  other: "其他",
};
export const categoryName = (id) => CATEGORY_NAMES[id] || id;

// FOR-67 冻结的机器可读契约：follow_total / pages / cls.counts / diff.n /
// unfollow.done / tracks.A|B|C / env{os,chrome,node,playwright,python} / generated_at
export function validateReport(r) {
  const bad = (m) => ({ ok: false, error: m });
  if (!r || typeof r !== "object") return bad("报告不是对象");
  for (const k of ["follow_total", "pages", "diff", "unfollow", "cls", "tracks", "env", "generated_at"]) {
    if (r[k] === undefined || r[k] === null) return bad("契约缺字段：" + k);
  }
  const posInt = (v) => Number.isInteger(v) && v > 0;
  if (!posInt(r.follow_total)) return bad("follow_total 必须是正整数，实得 " + JSON.stringify(r.follow_total));
  if (!posInt(r.pages)) return bad("pages 必须是正整数，实得 " + JSON.stringify(r.pages));
  if (!r.cls || typeof r.cls.counts !== "object" || r.cls.counts === null)
    return bad("cls.counts 必须是 { 类目 id: 条数 } 映射");
  for (const [k, v] of Object.entries(r.cls.counts)) {
    if (!Number.isInteger(v) || v < 0) return bad("cls.counts[" + k + "] 必须是非负整数，实得 " + JSON.stringify(v));
  }
  const sum = Object.values(r.cls.counts).reduce((a, b) => a + b, 0);
  if (sum !== r.follow_total)
    return bad("sum(cls.counts)=" + sum + " 与 follow_total=" + r.follow_total + " 不等：分类没覆盖全列表，数字不能用");
  if (!posInt(r.diff.n)) return bad("diff.n 必须是正整数");
  if (!Number.isInteger(r.unfollow.done) || r.unfollow.done < 0) return bad("unfollow.done 必须是非负整数");
  if (r.diff.n < r.unfollow.done)
    return bad("diff.n(" + r.diff.n + ") < unfollow.done(" + r.unfollow.done + ")：预览条数不会少于实际执行数");
  for (const t of TRACK_NAMES) {
    if (!TRACK_KINDS.includes(r.tracks[t]))
      return bad("tracks." + t + " 必须是 " + TRACK_KINDS.join("/") + "，实得 " + JSON.stringify(r.tracks[t]));
  }
  for (const k of ["os", "chrome", "node", "playwright", "python"]) {
    if (typeof r.env[k] !== "string" || !r.env[k]) return bad("env." + k + " 缺失（报告必须记环境版本）");
  }
  if (Number.isInteger(r.unfollow.hard_limit) && r.unfollow.hard_limit < r.unfollow.done)
    return bad("unfollow.hard_limit 小于实际执行数，报告自相矛盾");
  if (Number.isNaN(Date.parse(r.generated_at))) return bad("generated_at 不是可解析时间");
  return { ok: true };
}

// 派生量不是新数字，而是从已取证数字按插件里的真实常量推出来的：
//   partial_fetched = follow_total - 2 页（演示「没读全」的中断样本）
//   batch_total = ceil(follow_total / BATCH_SIZE)
export function deriveValues(r) {
  const categories = Object.entries(r.cls.counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, n]) => ({ id, n, pct: Math.round((n / r.follow_total) * 1000) / 10 }));
  const batchTotal = Math.ceil(r.follow_total / BATCH_SIZE);
  return {
    followTotal: r.follow_total,
    pages: r.pages,
    pageSize: PAGE_SIZE,
    diffN: r.diff.n,
    unfollowDone: r.unfollow.done,
    partialFetched: r.follow_total - PAGE_SIZE * 2,
    batchTotal,
    batchCurrent: Math.min(batchTotal, Math.max(1, Math.round(batchTotal * 0.72))),
    categories,
  };
}

export function buildTable(v) {
  const t = {
    follow_total: String(v.followTotal),
    pages: String(v.pages),
    page_size: String(v.pageSize),
    "diff.n": String(v.diffN),
    "unfollow.done": String(v.unfollowDone),
    partial_fetched: String(v.partialFetched),
    "batch.cur": String(v.batchCurrent),
    "batch.total": String(v.batchTotal),
    "cls.total": String(v.categories.reduce((a, c) => a + c.n, 0)),
    "cls.kinds": String(v.categories.length),
    "cls.top.name": categoryName(v.categories[0].id),
    "cls.top.n": String(v.categories[0].n),
    "cls.top.pct": String(v.categories[0].pct),
    "cls.counts": v.categories.map((c) => categoryName(c.id) + " " + c.n).join(" 路"),
  };
  for (const c of v.categories) {
    t["cls.count." + c.id] = String(c.n);
    t["cls.pct." + c.id] = String(c.pct);
    t["cls.name." + c.id] = categoryName(c.id);
  }
  return t;
}

export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function placeholdersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(PLACEHOLDER_RE)) out.push(m[1]);
  return out;
}

export function fmtWith(text, values) {
  const t = buildTable(values);
  return String(text).replace(PLACEHOLDER_RE, (_all, key) => {
    const val = t[key];
    if (val === undefined) {
      throw new Error(
        "占位符 {{" + key + "}} 没有取数来源（docs/qa-report-v2.json 里没有这个量）。可用键：" +
        Object.keys(t).sort().join(", ")
      );
    }
    return val;
  });
}

export function resolveValues(raw) {
  if (!raw || raw.filled !== true) throw new Error(NOT_FILLED);
  const v = raw.values;
  if (!v || !Array.isArray(v.categories) || v.categories.length === 0) throw new Error(NOT_FILLED + " 缺 values.categories");
  const sum = v.categories.reduce((a, c) => a + c.n, 0);
  if (sum !== v.followTotal)
    throw new Error("分类计数合计 " + sum + " != follow_total " + v.followTotal + "：取数不自洽，不出片");
  if (v.unfollowDone > v.diffN) throw new Error("unfollow.done > diff.n：取数不自洽，不出片");
  return v;
}