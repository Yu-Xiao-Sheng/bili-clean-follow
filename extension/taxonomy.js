// taxonomy.js —— 分类体系：预置 12 类 + 用户可增删改名（v2-spec §3.2，FOR-64 验收 1）。
//
// 三条设计约束（别在别处另写一份）：
//   1) 类别主键是稳定 id，不是名字：用户改名之后，已落库的分类结果不会变孤儿。
//   2) 「其他」是兜底类，不许删；「待确认」不是类别，是低置信桶（v2-spec §3.2）。
//   3) 用户自定义类只参与匹配与展示，不放宽任何门禁：低置信照样进待确认。

export const TAXONOMY_KEY = "taxonomy.v1";
export const OTHER_CATEGORY = "other";
export const UNSURE_CATEGORY = "unsure";
export const LOW_CONFIDENCE = 0.55; // < 0.55 进「待确认」，不硬塞
export const NAME_MAX = 24;

export const CATEGORY_LABEL_ZH = {
  [OTHER_CATEGORY]: "其他",
  [UNSURE_CATEGORY]: "待确认",
};

// 关键词只用于离线粗分类（classifyLocal.js）。命中越多置信越高，
// 但离线路径的置信度有上限（见 classifyLocal.LOCAL_MAX），装不出「AI 的把握」。
export const PRESET_TAXONOMY = [
  { id: "tech", name: "科技数码", aliases: ["科技", "数码", "3C"],
    keywords: ["科技", "数码", "手机", "笔记本", "电脑", "硬件", "评测", "极客", "程序员", "软件", "开源", "编程", "相机", "无人机", "芯片", "人工智能", "AI"] },
  { id: "game", name: "游戏电竞", aliases: ["游戏", "电竞", "游戏区"],
    keywords: ["游戏", "电竞", "攻略", "通关", "实况", "单机", "主机", "网游", "手游", "Steam", "PS5", "Switch", "原神", "英雄联盟", "王者", "我的世界", "Minecraft"] },
  { id: "film", name: "影视综艺", aliases: ["影视", "电影", "综艺", "影视解说"],
    keywords: ["影视", "电影", "剧集", "电视剧", "综艺", "影评", "解说", "追剧", "纪录片", "短片", "动画电影", "票房"] },
  { id: "knowledge", name: "知识教育", aliases: ["知识", "教育", "学习"],
    keywords: ["知识", "教育", "课程", "学习", "讲师", "教授", "老师", "科普", "大学", "学院", "学者", "导师", "科学", "历史", "法律", "刑法", "经济", "读书", "图书", "考研", "考试", "数学", "物理"] },
  { id: "food", name: "美食", aliases: ["美食", "料理"],
    keywords: ["美食", "料理", "烹饪", "做饭", "菜谱", "吃播", "探店", "厨师", "烘焙", "小吃", "餐厅", "家常菜"] },
  { id: "life", name: "生活日常", aliases: ["生活", "日常", "生活区"],
    keywords: ["生活", "日常", "vlog", "记录生活", "家居", "装修", "宠物", "养猫", "养狗", "旅行", "露营", "自驾", "手工", "园艺"] },
  { id: "funny", name: "搞笑段子", aliases: ["搞笑", "段子", "幽默"],
    keywords: ["搞笑", "段子", "整活", "沙雕", "幽默", "脱口秀", "相声", "小品", "恶搞", "趣图", "吐槽", "喜剧"] },
  { id: "music", name: "音乐", aliases: ["音乐", "歌曲"],
    keywords: ["音乐", "歌曲", "翻唱", "编曲", "作曲", "吉他", "钢琴", "唱歌", "乐队", "演奏", "说唱", "嘻哈", "古典乐", "MV"] },
  { id: "anime", name: "动漫二次元", aliases: ["动漫", "二次元", "动画", "漫画"],
    keywords: ["动漫", "动画", "漫画", "二次元", "手办", "周边", "同人", "配音", "声优", "国创", "Galgame", "cos", "Cosplay"] },
  { id: "sports", name: "体育", aliases: ["体育", "运动", "赛事"],
    keywords: ["体育", "篮球", "足球", "健身", "运动", "比赛", "赛事", "NBA", "CBA", "羽毛球", "乒乓球", "网球", "跑步", "骑行", "游泳", "武术"] },
  { id: "beauty", name: "时尚美妆", aliases: ["时尚", "美妆", "穿搭"],
    keywords: ["美妆", "化妆", "彩妆", "护肤", "穿搭", "时尚", "造型", "服饰", "美甲", "发型", "潮流", "球鞋"] },
  { id: "news", name: "资讯时事", aliases: ["资讯", "时事", "新闻", "媒体"],
    keywords: ["资讯", "新闻", "时事", "热点", "报道", "记者", "媒体", "日报", "晚报", "电视台", "发布", "播报", "评论员"] },
  { id: OTHER_CATEGORY, name: "其他", aliases: [], keywords: [], builtin: true },
];

// B站官方认证文案 -> 类别。verified 是比简介更强的信号（离线路径给最高权重）。
export const OFFICIAL_HINTS = [
  { pattern: /(电视台|日报|晚报|新闻|媒体|通讯社|融媒体|政务|官方账号)/i, category: "news" },
  { pattern: /(大学|学院|学校|教授|讲师|研究|学者|教育)/i, category: "knowledge" },
  { pattern: /(医院|医生|医师|药师|健康)/i, category: "knowledge" },
  { pattern: /(知名科技|科技媒体|数码)/i, category: "tech" },
  { pattern: /(游戏区|电竞|知名游戏)/i, category: "game" },
  { pattern: /(美食|厨师|料理)/i, category: "food" },
  { pattern: /(音乐|歌手|演奏|作曲)/i, category: "music" },
  { pattern: /(影视|电影|导演|知名UP主.*影视)/i, category: "film" },
  { pattern: /(体育|运动员|教练)/i, category: "sports" },
  { pattern: /(时尚|美妆|造型师|设计师)/i, category: "beauty" },
  { pattern: /(动画|漫画|声优|二次元)/i, category: "anime" },
  { pattern: /(搞笑|娱乐|脱口秀)/i, category: "funny" },
  { pattern: /(生活|旅行|家居)/i, category: "life" },
];

export function defaultTaxonomy() {
  return PRESET_TAXONOMY.map((c) => ({ ...c, keywords: [...(c.keywords || [])], aliases: [...(c.aliases || [])] }));
}

/** 读出来的体系与预置合并：预置类别保留稳定 id（用户改了名/关键词就用用户的），自定义类追加。 */
export function normalizeTaxonomy(raw) {
  const base = defaultTaxonomy();
  if (!Array.isArray(raw)) return base;
  const byId = new Map(base.map((c) => [c.id, c]));
  const seenNames = new Set(base.map((c) => c.name));
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id || "").trim();
    // removed 先处理：用户删掉的预置类要真的消失（不要求它还带名字）。
    if (entry.removed === true && id && !BUILTIN_LOCKED.includes(id)) byId.delete(id);
    if (entry.removed === true) continue;
    const name = cleanName(entry.name).slice(0, NAME_MAX);
    if (!name) continue;
    const keywords = cleanList(entry.keywords);
    const aliases = cleanList(entry.aliases);
    if (id && byId.has(id)) {
      const prev = byId.get(id);
      if (name !== prev.name) {
        if (seenNames.has(name)) continue; // 名字撞车：保留旧的，别造两个同名类
        seenNames.delete(prev.name);
        seenNames.add(name);
        prev.name = name;
      }
      if (entry.keywords !== undefined) prev.keywords = keywords;
      if (entry.aliases !== undefined) prev.aliases = aliases;
      continue;
    }
    if (seenNames.has(name)) continue;
    const key = id || uniqueId(byId, name);
    if (!key) continue;
    seenNames.add(name);
    byId.set(key, { id: key, name, keywords, aliases, custom: true });
  }
  const out = [...byId.values()];
  if (!out.some((c) => c.id === OTHER_CATEGORY)) {
    out.push(defaultTaxonomy().find((c) => c.id === OTHER_CATEGORY));
  }
  return out;
}

// 「其他」是兜底类，删了之后没落点，所以钉住不许删。
export const BUILTIN_LOCKED = [OTHER_CATEGORY];

export function addCategory(taxonomy, { name, keywords = [], aliases = [] } = {}) {
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: "类别名不能为空" };
  if (clean.length > NAME_MAX) return { ok: false, error: "类别名最长 " + NAME_MAX + " 字" };
  if (taxonomy.some((c) => c.name === clean)) return { ok: false, error: "已有同名类别：" + clean };
  const id = "custom." + Date.now().toString(36) + "." + Math.random().toString(36).slice(2, 6);
  taxonomy.push({ id, name: clean, keywords: cleanList(keywords), aliases: cleanList(aliases), custom: true });
  return { ok: true, category: find(taxonomy, id) };
}

export function renameCategory(taxonomy, id, name) {
  const cat = find(taxonomy, id);
  if (!cat) return { ok: false, error: "类别不存在：" + id };
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: "类别名不能为空" };
  if (clean.length > NAME_MAX) return { ok: false, error: "类别名最长 " + NAME_MAX + " 字" };
  const clash = taxonomy.find((c) => c.name === clean && c.id !== id);
  if (clash) return { ok: false, error: "已有同名类别：" + clean };
  cat.name = clean;
  return { ok: true, category: cat };
}

export function removeCategory(taxonomy, id) {
  if (BUILTIN_LOCKED.includes(id)) return { ok: false, error: "「其他」是兜底类，不能删除" };
  if (id === UNSURE_CATEGORY) return { ok: false, error: "「待确认」不是类别，是低置信桶，不能删除" };
  const idx = taxonomy.findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, error: "类别不存在：" + id };
  const [gone] = taxonomy.splice(idx, 1);
  return { ok: true, removed: gone };
}

export function setCategoryKeywords(taxonomy, id, keywords) {
  const cat = find(taxonomy, id);
  if (!cat) return { ok: false, error: "类别不存在：" + id };
  cat.keywords = cleanList(keywords);
  return { ok: true, category: cat };
}

export function find(taxonomy, id) {
  return taxonomy.find((c) => c.id === id) || null;
}

export function categoryName(taxonomy, id) {
  if (id === UNSURE_CATEGORY) return CATEGORY_LABEL_ZH[UNSURE_CATEGORY];
  if (id === OTHER_CATEGORY) return CATEGORY_LABEL_ZH[OTHER_CATEGORY];
  return (find(taxonomy, id) || {}).name || id;
}

export function isKnownCategory(taxonomy, id) {
  return Boolean(find(taxonomy, id)) || id === UNSURE_CATEGORY;
}

/** 用户/模型给的是类名（可能有别名、错别字、多余空白），解析成稳定 id。 */
export function resolveCategoryRef(taxonomy, ref) {
  const text = String(ref || "").trim();
  if (!text) return null;
  if (text === UNSURE_CATEGORY || text === CATEGORY_LABEL_ZH[UNSURE_CATEGORY]) return UNSURE_CATEGORY;
  const exactId = find(taxonomy, text);
  if (exactId) return exactId.id;
  const byName = taxonomy.find((c) => c.name === text);
  if (byName) return byName.id;
  const byAlias = taxonomy.find((c) => (c.aliases || []).some((a) => String(a).trim() === text));
  if (byAlias) return byAlias.id;
  const folded = text.toLowerCase();
  const loose = taxonomy.find((c) => {
    const names = [c.name, ...(c.aliases || [])].map((s) => String(s).toLowerCase());
    return names.some((n) => n && (folded.includes(n) || n.includes(folded)));
  });
  return loose ? loose.id : null;
}

/** 类名列表 -> 稳定 id 列表（去重、丢掉解析不出的），给 FOR-65 的意图 DSL 复用。 */
export function resolveCategoryRefs(taxonomy, refs) {
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const id = resolveCategoryRef(taxonomy, ref);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// fields 的顺序是调用方约定的 [认证文案, 昵称, 简介]；权重按字段分档：
// 认证文案最硬，简介次之，昵称最软（昵称里一个「老师」不该压过简介里的「科技」）。
// 字段下标按调用方给的位置算，空字段不参与但不下标错位。
export function matchKeywords(taxonomy, input, { textWeight = 2, fieldWeights = [1.5, 1, 1.4] } = {}) {
  const raw = (Array.isArray(input) ? input : [input]).map(
    (v) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().toLowerCase());
  if (!raw.some((f) => f)) return [];
  const scored = [];
  for (const cat of taxonomy) {
    if (cat.id === OTHER_CATEGORY) continue;
    // 关键词与别名去重：同一个词在 keywords 和 aliases 里各写一次，
    // 不能算两次命中（否则「生活」这类常见词会把置信度自己抬上去）。
    const words = [...new Map(
      [...(cat.keywords || []), ...(cat.aliases || [])]
        .map((k) => String(k).trim())
        .filter(Boolean)
        .map((w) => [w.toLowerCase(), w]),
    ).values()];
    const hits = [];
    let occurrences = 0;
    for (const word of words) {
      const w = word.toLowerCase();
      if (!w) continue;
      const where = [];
      for (let i = 0; i < raw.length; i += 1) {
        if (raw[i] && raw[i].includes(w)) where.push(i);
      }
      if (!where.length) continue;
      hits.push({ word, fields: where });
      occurrences += where.length;
    }
    if (!hits.length) continue;
    hits.sort((a, b) => b.fields.length - a.fields.length);
    const weight = hits.reduce(
      (sum, h) => sum + (h.word.length >= 3 ? textWeight + 1 : textWeight) *
        h.fields.reduce((acc, i) => acc + (fieldWeights[i] === undefined ? 1 : fieldWeights[i]), 0),
      0);
    scored.push({ id: cat.id, hits, words: hits.map((h) => h.word), occurrences, weight: Number(weight.toFixed(2)) });
  }
  scored.sort((a, b) => b.weight - a.weight || b.occurrences - a.occurrences || a.id.localeCompare(b.id));
  return scored;
}

export function officialCategory(officialText, verified) {
  const text = String(officialText || "").trim();
  if (!text && !verified) return null;
  for (const { pattern, category } of OFFICIAL_HINTS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

function cleanName(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function uniqueId(byId, name) {
  const slug = String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "") || "cat";
  let candidate = "custom." + slug;
  let n = 2;
  while (byId.has(candidate)) candidate = "custom." + slug + "." + n++;
  return candidate;
}

function cleanList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const text = String(item === undefined || item === null ? "" : item).replace(/\s+/g, " ").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 60);
}