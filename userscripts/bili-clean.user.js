// ==UserScript==
// @name         B站关注列表只读分析（Bili Clean Follow · 油猴只读版）
// @namespace    https://github.com/Yu-Xiao-Sheng/bili-clean-follow
// @version      2.0.0
// @description  在 B站关注页做「只读分析 + 候选清单」：读全关注列表 -> 离线粗分类 -> 导出 CSV / 候选清单 / Markdown 报告。本脚本不含取关：任何写接口都进不了请求构造器。
// @author       bili-clean-follow
// @match        https://space.bilibili.com/*/relation/follow*
// @run-at       document-idle
// @noframes
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/Yu-Xiao-Sheng/bili-clean-follow
// @downloadURL  https://github.com/Yu-Xiao-Sheng/bili-clean-follow/raw/main/userscripts/bili-clean.user.js
// @updateURL    https://github.com/Yu-Xiao-Sheng/bili-clean-follow/raw/main/userscripts/bili-clean.user.js
// ==/UserScript==

/*
 * userscripts/bili-clean.user.js —— 给「不方便装 Chrome/Edge 扩展」的用户（FOR-68 交付物 2）。
 *
 * 与插件的能力差（务必读这几行）：
 *   有：读全关注列表（fetched == total 才算读全）、离线粗分类、CSV / 候选清单 / Markdown 导出。
 *   没有：AI 分类（BYOK）、取关执行器、断点续抓、审计日志。油猴版**只读**，永远不发写请求。
 *   数据不出这台机器之外：只向 api.bilibili.com 发只读 GET；没有模型端点、没有遥测。
 *
 * 取数与分类口径与 extension/ 同源（biliApi.js / taxonomy.js / report.js）：
 * 分页粒度 ps=20、按 ptime 排序、mid 去重、读全门禁 fetched >= total、离线置信封顶 0.68、
 * < 0.55 进「待确认」。漂移与 2000 上限的处理也一致。漂移 = 翻页期间列表变了。
 *
 * 为什么能测：本文件末尾把纯函数挂到 __BCF_USERSCRIPT__，在没有 window/document 的环境里
 * （node:test + vm）只加载纯函数部分，tests/extension/userscript_readonly.test.mjs 直接断言
 * 「写接口在源码里只出现在禁用清单里」「分类漂移会被门禁拦」「导出带 BOM」。
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------- 常量（与 extension/biliApi.js 同口径）

  const API_ORIGIN = "https://api.bilibili.com";
  const READONLY_ENDPOINTS = {
    nav: API_ORIGIN + "/x/web-interface/nav",
    followings: API_ORIGIN + "/x/relation/followings",
    stat: API_ORIGIN + "/x/relation/stat",
  };

  // 油猴版一律拒绝。写接口在这里，别处出现即测试红（userscript_readonly.test.mjs）。
  const DENIED_ENDPOINTS = [
    "/x/relation/delete",
    "/x/relation/add",
    "/x/relation/block",
    "/x/relation/blacklist",
    "/x/relation/tag",
    "/x/relation/tag/create",
    "/x/relation/tag/del",
    "/x/relation/tag/update",
    "/x/relation/followers",
    "/x/space/wbi/acc/info",
    "/x/space/arc/search",
    "/x/polymer/web-dynamic/v1/feed/space",
  ];

  const PAGE_SIZE = 20;          // 实测可用的分页粒度，更大 ps 会被截断
  const ORDER = "desc";
  const ORDER_FIELD = "ptime";
  const MIN_INTERVAL_MS = 450;   // 只读抓取自我限速下限（含 jitter）
  const MAX_RETRIES = 3;
  const MAX_PAGES = 400;
  const TOTAL_CAP = 2000;        // B站关注数展示上限，撞上要显式提示
  const LOW_CONFIDENCE = 0.55;   // < 0.55 进「待确认」
  const LOCAL_MAX = 0.68;        // 离线粗分类的置信上限，不装 AI 的把握

  const TOTAL_CAP_NOTE =
    "total=" + TOTAL_CAP + "：B站关注数展示有上限，请用关注页显示的关注数核对，" +
    "fetched == total 门禁在 2000+ 关注时可能永远不成立。";
  const TOTAL_DRIFT_NOTE =
    "已取条数超过 B站给出的关注数（翻页期间列表发生漂移）：建议重抓一次核对，" +
    "读全门禁按 fetched >= total 判定。";

  const NOT_LOGGED_IN_NOTE = "未登录（code -101）：请先在浏览器登录 B站再重试。";
  const RISK_CONTROL_NOTE = "B站风控（code -352）：已停在当前页，歇几分钟再点「继续读全」。";

  // ---------------------------------------------------------------- 只读护栏

  /**
   * 唯一的请求构造器：非 GET、非白名单 origin、路径命中禁用清单 —— 三种情况直接抛。
   * 全脚本只有这一处发网络请求，所以「油猴版不会取关」是可静态验证的，不是口头承诺。
   */
  function buildReadonlyRequest(url, init) {
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method !== "GET") throw new Error("只读脚本只允许 GET，收到 " + method);
    if (init && init.body) throw new Error("只读脚本不允许请求体");
    const parsed = new URL(url, API_ORIGIN + "/");
    if (parsed.origin !== API_ORIGIN) throw new Error("只允许 api.bilibili.com，收到 " + parsed.origin);
    const path = parsed.pathname;
    if (!Object.values(READONLY_ENDPOINTS).some((u) => new URL(u).pathname === path)) {
      throw new Error("接口不在只读白名单：" + path);
    }
    for (const denied of DENIED_ENDPOINTS) {
      if (path === denied || path.startsWith(denied + "/")) {
        throw new Error("写接口 / 风控接口一律禁用：" + denied);
      }
    }
    if (/[?&](csrf|bili_jct|sessdata)=[^&]/i.test(parsed.search)) {
      throw new Error("只读 GET 不允许携带凭据形态的查询参数");
    }
    return { url: parsed.toString(), init: { method: "GET", credentials: "include",
      headers: { accept: "application/json" } } };
  }

  function fetchReadonly(url, init) {
    const req = buildReadonlyRequest(url, init);
    return fetch(req.url, req.init);
  }

  function buildFollowingsUrl({ vmid, pn = 1, ps = PAGE_SIZE }) {
    if (!vmid) throw new Error("vmid 不能为空（自己的 mid 从 x/web-interface/nav 取）");
    const page = Math.max(1, Math.floor(Number(pn) || 1));
    const size = Math.min(Math.max(1, Math.floor(Number(ps) || PAGE_SIZE)), PAGE_SIZE);
    const params = new URLSearchParams({
      vmid: String(vmid), pn: String(page), ps: String(size),
      order: ORDER, order_field: ORDER_FIELD, platform: "web", web_location: "333.999",
    });
    return READONLY_ENDPOINTS.followings + "?" + params.toString();
  }

  // ---------------------------------------------------------------- 解析与去重

  const cleanText = (value) => (value == null ? "" : String(value).replace(/[\r\n\t]+/g, " ").trim());
  const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");

  function normalizeItem(row, source = "api") {
    if (!row || typeof row !== "object") return null;
    const mid = firstDefined(row.mid, row.follower_id, row.fmid, row.id);
    if (mid === undefined || !/^\d+$/.test(String(mid))) return null;
    const officialObj = row.official && typeof row.official === "object" ? row.official : null;
    return {
      mid: String(mid),
      nickname: cleanText(firstDefined(row.uname, row.name, row.title, row.nick_name)),
      bio: cleanText(firstDefined(row.sign, row.info, row.official_reason)),
      official: officialObj ? cleanText(firstDefined(officialObj.title, officialObj.role, officialObj.department)) : "",
      verified: !!((row.official_verify && Number(row.official_verify.type) >= 0) ||
        (officialObj && (Number(officialObj.type) >= 0 || officialObj.verified))),
      followTs: Number(firstDefined(row.mtime, row.ptime, row.gtime, row.ctime)) || null,
      source,
    };
  }

  function parseFollowingsPayload(payload, extra = {}) {
    const code = payload && typeof payload.code === "number" ? payload.code : null;
    if (code !== 0) {
      const kind = code === -101 ? "not_logged_in" : code === -352 ? "risk_control" : "unknown_error";
      return { ok: false, kind, code, total: null, items: [],
        message: code === -101 ? NOT_LOGGED_IN_NOTE : code === -352 ? RISK_CONTROL_NOTE
          : "接口返回 code=" + code + " " + cleanText(payload && payload.message) };
    }
    const data = (payload && payload.data) || {};
    const rawList = data.list || data.follower || data.records || data.item || [];
    const totalRaw = firstDefined(data.total, data.count, data.total_count);
    return { ok: true, kind: "ok", code: 0,
      total: Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : null,
      items: (Array.isArray(rawList) ? rawList : []).map((row) => normalizeItem(row, extra.source || "api")).filter(Boolean) };
  }

  function dedupe(items) {
    const map = new Map();
    for (const it of Array.isArray(items) ? items : []) {
      if (it && it.mid && !map.has(it.mid)) map.set(it.mid, it);
    }
    return [...map.values()];
  }

  function mergeItems(existing, incoming) {
    const map = new Map();
    for (const it of dedupe(existing)) map.set(it.mid, it);
    for (const it of dedupe(incoming)) {
      const prev = map.get(it.mid);
      map.set(it.mid, prev ? {
        ...prev,
        nickname: prev.nickname || it.nickname,
        bio: prev.bio || it.bio,
        official: prev.official || it.official,
        verified: prev.verified || !!it.verified,
        followTs: prev.followTs ?? it.followTs ?? null,
      } : it);
    }
    return [...map.values()];
  }

  /** 读全门禁：去重后的条数 >= B站给出的 total 才算读全（2000 与漂移两种例外要显式提示）。 */
  function scanGate({ fetched, total }) {
    if (total === null || total === undefined || total === "" || !Number.isFinite(Number(total))) {
      return { complete: false, note: "拿不到 B站给出的关注数（total 缺失），不能宣布读全。" };
    }
    const t = Number(total);
    if (fetched < t) return { complete: false, note: "还没读全（已取 " + fetched + "/" + t + "）" };
    if (t >= TOTAL_CAP) return { complete: true, note: TOTAL_CAP_NOTE, warn: true };
    if (fetched > t) return { complete: true, note: TOTAL_DRIFT_NOTE, warn: true };
    return { complete: true, note: "" };
  }

  /** 抓取循环：与插件同一停止条件（只有 fetched >= total 才 complete）。 */
  async function scanAll({ vmid, fetchPage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
      onProgress = null, shouldAbort = () => false, intervalMs = MIN_INTERVAL_MS }) {
    const items = [];
    let total = null, pn = 1, kind = "ok", message = "", resumeFromPn = 1;
    const floor = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS);
    while (pn <= MAX_PAGES) {
      if (shouldAbort()) { kind = "aborted"; message = "已停止，数据保留。"; break; }
      const pageItems = [];
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const res = await fetchPage(pn);
        if (res.ok) { pageItems.push(...res.items); if (res.total !== null) total = res.total; break; }
        kind = res.kind; message = res.message;
        if (res.kind === "not_logged_in") { resumeFromPn = pn; pn = MAX_PAGES + 1; break; }
        if (res.kind === "risk_control") { resumeFromPn = pn; pn = MAX_PAGES + 1; break; }
        if (attempt >= MAX_RETRIES) { resumeFromPn = pn; pn = MAX_PAGES + 1; break; }
        await sleep(floor * attempt * 2);
      }
      if (pn > MAX_PAGES) break;
      for (const it of dedupe(pageItems)) {
        if (!items.some((x) => x.mid === it.mid)) items.push(it);
      }
      const gate = scanGate({ fetched: items.length, total });
      if (onProgress) onProgress({ pn, fetched: items.length, total, gate });
      if (gate.complete) return { complete: true, items, total, kind: "ok", message: gate.note, warn: !!gate.warn };
      resumeFromPn = pn + 1;
      pn += 1;
      await sleep(floor + Math.floor(Math.random() * 250));
    }
    return { complete: false, items, total, kind, message, resumeFromPn };
  }

  // ---------------------------------------------------------------- 离线粗分类（关键词与 taxonomy.js 同一份，漂移由测试拦）

  const PRESET_TAXONOMY = [
    { id: "tech", name: "科技数码", keywords: ["科技", "数码", "手机", "笔记本", "电脑", "硬件", "评测", "极客", "程序员", "软件", "开源", "编程", "相机", "无人机", "芯片", "人工智能", "AI"] },
    { id: "game", name: "游戏电竞", keywords: ["游戏", "电竞", "攻略", "通关", "实况", "单机", "主机", "网游", "手游", "Steam", "PS5", "Switch", "原神", "英雄联盟", "王者", "我的世界", "Minecraft"] },
    { id: "film", name: "影视综艺", keywords: ["影视", "电影", "剧集", "电视剧", "综艺", "影评", "解说", "追剧", "纪录片", "短片", "动画电影", "票房"] },
    { id: "knowledge", name: "知识教育", keywords: ["知识", "教育", "课程", "学习", "讲师", "教授", "老师", "科普", "大学", "学院", "学者", "导师", "科学", "历史", "法律", "刑法", "经济", "读书", "图书", "考研", "考试", "数学", "物理"] },
    { id: "food", name: "美食", keywords: ["美食", "料理", "烹饪", "做饭", "菜谱", "吃播", "探店", "厨师", "烘焙", "小吃", "餐厅", "家常菜"] },
    { id: "life", name: "生活日常", keywords: ["生活", "日常", "vlog", "记录生活", "家居", "装修", "宠物", "养猫", "养狗", "旅行", "露营", "自驾", "手工", "园艺"] },
    { id: "funny", name: "搞笑段子", keywords: ["搞笑", "段子", "整活", "沙雕", "幽默", "脱口秀", "相声", "小品", "恶搞", "趣图", "吐槽", "喜剧"] },
    { id: "music", name: "音乐", keywords: ["音乐", "歌曲", "翻唱", "编曲", "作曲", "吉他", "钢琴", "唱歌", "乐队", "演奏", "说唱", "嘻哈", "古典乐", "MV"] },
    { id: "anime", name: "动漫二次元", keywords: ["动漫", "动画", "漫画", "二次元", "手办", "周边", "同人", "配音", "声优", "国创", "Galgame", "cos", "Cosplay"] },
    { id: "sports", name: "体育", keywords: ["体育", "篮球", "足球", "健身", "运动", "比赛", "赛事", "NBA", "CBA", "羽毛球", "乒乓球", "网球", "跑步", "骑行", "游泳", "武术"] },
    { id: "beauty", name: "时尚美妆", keywords: ["美妆", "化妆", "彩妆", "护肤", "穿搭", "时尚", "造型", "服饰", "美甲", "发型", "潮流", "球鞋"] },
    { id: "news", name: "资讯时事", keywords: ["资讯", "新闻", "时事", "热点", "报道", "记者", "媒体", "日报", "晚报", "电视台", "发布", "播报", "评论员"] },
    { id: "other", name: "其他", keywords: [] },
  ];

  const OFFICIAL_HINTS = [
    [/(电视台|日报|晚报|新闻|媒体|通讯社|融媒体|政务|官方账号)/i, "news"],
    [/(大学|学院|学校|教授|讲师|研究|学者|教育)/i, "knowledge"],
    [/(医院|医生|医师|药师|健康)/i, "knowledge"],
    [/(知名科技|科技媒体|数码)/i, "tech"],
    [/(游戏区|电竞|知名游戏)/i, "game"],
    [/(美食|厨师|料理)/i, "food"],
    [/(音乐|歌手|演奏|作曲)/i, "music"],
    [/(影视|电影|导演)/i, "film"],
    [/(体育|运动员|教练)/i, "sports"],
    [/(时尚|美妆|造型师|设计师)/i, "beauty"],
    [/(动画|漫画|声优|二次元)/i, "anime"],
    [/(搞笑|娱乐|脱口秀)/i, "funny"],
    [/(生活|旅行|家居)/i, "life"],
  ];

  /** 单条离线粗分类：简介权重 > 昵称，认证文案最高；置信封顶 LOCAL_MAX。 */
  function classifyLocal(item) {
    const bio = String(item.bio || "").toLowerCase();
    const nick = String(item.nickname || "").toLowerCase();
    const officialText = String(item.official || "").toLowerCase();
    let best = { category: "other", score: 0, hits: [] };
    for (const cat of PRESET_TAXONOMY) {
      if (!cat.keywords.length) continue;
      let score = 0; const hits = [];
      for (const kw of cat.keywords) {
        const k = kw.toLowerCase();
        if (bio && bio.includes(k)) { score += 1.4; hits.push(kw); }
        else if (nick && nick.includes(k)) { score += 1.0; hits.push(kw); }
      }
      if (officialText) {
        for (const [re, cid] of OFFICIAL_HINTS) {
          if (cid === cat.id && re.test(officialText)) { score += 1.5; hits.push("认证"); break; }
        }
      }
      if (score > best.score) best = { category: cat.id, score, hits };
    }
    const confidence = best.category === "other" ? 0 : Math.min(LOCAL_MAX, Number((best.score / 3).toFixed(2)));
    const label = (PRESET_TAXONOMY.find((c) => c.id === best.category) || { name: "其他" }).name;
    if (confidence < LOW_CONFIDENCE) {
      return { category: "unsure", label: "待确认", confidence,
        rawCategory: best.category, rawLabel: label,
        reason: "离线只命中 " + (best.hits[0] || "无") + "，证据不足"};
    }
    return { category: best.category, label, confidence, rawCategory: best.category, rawLabel: label,
      reason: "离线命中 " + best.hits.slice(0, 3).join("、") };
  }

  function classifyAll(items) {
    return items.map((it) => ({ ...it, ...classifyLocal(it) }));
  }

  /** 候选清单：待确认与「其他」永不进候选（证据不足不清洗）。 */
  function candidateRows(classified) {
    return classified.filter((r) => r.category !== "unsure" && r.category !== "other");
  }

  // ---------------------------------------------------------------- 导出（CSV 带 BOM，与 CLI / 插件同口径）

  const CSV_BOM = "\ufeff";
  const CSV_FIELDS = ["mid", "nickname", "class", "confidence", "reason", "official", "bio", "follow_time"];
  const UNFOLLOW_NOTICE = [
    "# bili-clean-follow · 取关候选清单 (unfollow candidates)",
    "# 这份清单只用于人工核对，工具不会自动取关。Report-only: this tool never unfollows anything by itself.",
    "# 每行格式 format: mid <TAB> 昵称 nickname",
  ].join("\n");

  function csvCell(value) {
    let s = value === null || value === undefined ? "" : String(value);
    for (const ch of ["\r\n", "\r", "\n", "\t"]) s = s.split(ch).join(" ");
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows) {
    const out = [CSV_FIELDS.join(",")];
    for (const r of rows) {
      out.push(CSV_FIELDS.map((f) => csvCell(r[f] === undefined ? "" : r[f])).join(","));
    }
    return CSV_BOM + out.join("\n");
  }

  function toUnfollowList(rows) {
    const lines = [UNFOLLOW_NOTICE];
    for (const r of rows) lines.push(String(r.mid) + "\t" + (r.nickname || ""));
    return lines.join("\n");
  }

  function toMarkdown(rows, meta) {
    const byLabel = new Map();
    for (const r of rows) {
      const key = r.label || "其他";
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key).push(r);
    }
    const out = ["# B站关注列表只读分析报告", ""];
    out.push("- 读取时间：" + new Date().toISOString());
    out.push("- B站给出的关注数 total：" + meta.total + "；去重后已取：" + meta.fetched +
      "；读全：" + (meta.complete ? "是" : "否（不完整的报告不作为取关依据）"));
    out.push("- 工具：油猴脚本（只读，零写操作、零第三方外发）；分类：离线粗分类（置信封顶 " + LOCAL_MAX + "）");
    out.push("");
    out.push("| 类别 | 条数 | 占比 | 平均置信 |");
    out.push("|---|---|---|---|");
    for (const [label, list] of byLabel) {
      const avg = (list.reduce((s, r) => s + (r.confidence || 0), 0) / list.length).toFixed(2);
      out.push("| " + label + " | " + list.length + " | " +
        ((list.length / (rows.length || 1)) * 100).toFixed(1) + "% | " + avg + " |");
    }
    out.push("", "## 进候选（人工核对用，工具不会替你取关）", "");
    for (const r of candidateRows(rows).slice(0, 200)) {
      out.push("- " + r.nickname + "（mid " + r.mid + "，" + r.label + "，置信 " + r.confidence + "）");
    }
    return out.join("\n");
  }

  // ---------------------------------------------------------------- DOM 兜底（选择器与 content/followpage.js 同一套）

  function selfMid() {
    const m = location.pathname.match(/\/(\d+)\/relation\/follow/);
    return m ? m[1] : null;
  }

  function textOf(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) {
        const t = (el.textContent || "").replace(/[\r\n\t]+/g, " ").trim();
        if (t) return t;
      }
    }
    return "";
  }

  function scrapeDom() {
    const mine = selfMid();
    const groups = [".card-list .list-item", ".section-content .list-item", ".relation-list .list-item",
      ".follow-main .list-item", ".fans-module .item", "[mod-name=bili-userHome] .list-item"];
    let cards = [];
    for (const g of groups) {
      const found = [...document.querySelectorAll(g)];
      for (const node of found) if (!cards.includes(node)) cards.push(node);
      if (cards.length) break;
    }
    const items = [];
    for (const card of cards) {
      const link = card.matches && card.matches("a[href*='space.bilibili.com/']")
        ? card : card.querySelector("a[href*='space.bilibili.com/']");
      const m = link ? (link.getAttribute("href") || "").match(/space\.bilibili\.com\/(\d+)/) : null;
      if (!m || m[1] === mine) continue;
      items.push({
        mid: m[1],
        nickname: textOf(card, [".title-area .name", ".name", ".title-area a", ".user-info .name", ".info-item .name"]) ||
          (link ? (link.textContent || "").trim() : ""),
        bio: textOf(card, [".info-content .desc", ".desc", ".signature", ".info-area .text", ".text"]),
        official: textOf(card, [".official-badge", ".official-reason", ".name .badge"]),
        followTs: null, source: "dom_scrape",
      });
    }
    return items.filter((it) => it.nickname);
  }

  function scrapeTotalFromDom() {
    const texts = document.body ? document.body.innerText : "";
    const m = texts.match(/(?:全部关注|共)\s*([0-9]{1,6})\s*(?:人|个|条)?/);
    if (m) return Number(m[1]);
    const el = document.querySelector(".total-count, .count, .title-info .total");
    if (el) {
      const n = Number((el.textContent || "").replace(/[^0-9]/g, ""));
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  }

  // ---------------------------------------------------------------- UI

  function mount() {
    if (window.__BCF_USERSCRIPT_MOUNTED__) return;
    window.__BCF_USERSCRIPT_MOUNTED__ = true;
    const host = document.querySelector(".relation-header, .section-header, .follow-main, .fans-module, #app");
    if (!host) return;

    const state = { items: [], total: null, complete: false, classified: [], note: "", running: false };

    const box = document.createElement("div");
    box.setAttribute("style", "position:fixed;right:24px;bottom:24px;z-index:999999;font-size:13px;" +
      "background:#18191c;color:#e7e9eb;border:1px solid #fb7299;border-radius:10px;padding:10px 12px;" +
      "box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:360px;font-family:system-ui,sans-serif;");
    box.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;">Bili Clean Follow · 只读分析</div>' +
      '<div data-line style="color:#a3a6a9;line-height:1.5;">点「读全关注列表」：只发只读 GET，不取关、不外发第三方。</div>' +
      '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button data-run style="padding:6px 10px;border-radius:6px;border:1px solid #fb7299;background:#fb7299;color:#fff;cursor:pointer;">读全关注列表</button>' +
      '<button data-csv disabled style="padding:6px 10px;border-radius:6px;border:1px solid #61666d;background:transparent;color:#a3a6a9;cursor:not-allowed;">导出 CSV</button>' +
      '<button data-list disabled style="padding:6px 10px;border-radius:6px;border:1px solid #61666d;background:transparent;color:#a3a6a9;cursor:not-allowed;">导出候选清单</button>' +
      '<button data-md disabled style="padding:6px 10px;border-radius:6px;border:1px solid #61666d;background:transparent;color:#a3a6a9;cursor:not-allowed;">导出报告</button>' +
      "</div>";
    host.appendChild(box);

    const line = box.querySelector("[data-line]");
    const btns = { run: box.querySelector("[data-run]"), csv: box.querySelector("[data-csv]"),
      list: box.querySelector("[data-list]"), md: box.querySelector("[data-md]") };

    const enable = (btn, on) => {
      btn.disabled = !on;
      btn.style.cursor = on ? "pointer" : "not-allowed";
      btn.style.borderColor = on ? "#fb7299" : "#61666d";
      btn.style.color = on ? "#fb7299" : "#a3a6a9";
    };

    const setLine = (text) => { line.textContent = text; };

    async function getSelfMid() {
      const fromUrl = selfMid();
      const res = await fetchReadonly(READONLY_ENDPOINTS.nav);
      const payload = await res.json().catch(() => null);
      const mid = payload && payload.code === 0 && payload.data && payload.data.isLogin ? String(payload.data.mid) : null;
      if (!mid) throw new Error(NOT_LOGGED_IN_NOTE);
      if (fromUrl && fromUrl !== mid) setLine("注意：本页 mid 与登录账号不一致，按登录账号（" + mid + "）抓取。");
      return mid;
    }

    async function run() {
      if (state.running) return;
      state.running = true;
      btns.run.disabled = true;
      try {
        const vmid = await getSelfMid();
        const result = await scanAll({
          vmid,
          fetchPage: async (pn) => {
            try {
              const res = await fetchReadonly(buildFollowingsUrl({ vmid, pn }));
              const payload = await res.json().catch(() => null);
              if (!payload) throw new Error("响应不是 JSON（可能被风控改写）");
              const parsed = parseFollowingsPayload(payload, { source: "api" });
              if (parsed.ok && parsed.items.length === 0 && pn === 1 && parsed.total) {
                const domItems = scrapeDom();   // 接口空但关注页有卡片：走 DOM 兜底
                if (domItems.length) parsed.items = domItems;
              }
              return parsed;
            } catch (err) {
              const items = scrapeDom();
              if (items.length) {
                return { ok: true, kind: "ok", code: null, total: scrapeTotalFromDom(),
                  items: items.map((it) => normalizeItem({ ...it }, "dom_scrape")) };
              }
              return { ok: false, kind: "transport_error", code: null, total: null, items: [],
                message: "接口不可用（" + (err && err.message ? err.message : "unknown") + "）" };
            }
          },
          onProgress: ({ pn, fetched, total }) => setLine("已取 " + fetched + " / " + (total ?? "?") + "（第 " + pn + " 页）"),
        });
        state.items = dedupe(result.items);
        state.total = result.total;
        state.complete = result.complete;
        state.note = result.message || "";
        if (!result.complete) {
          setLine("未读全：" + (result.message || "中断") + "（已取 " + state.items.length +
            "）。分类与候选清单已锁定——没读全就不给结论。");
          return;
        }
        state.classified = classifyAll(state.items);
        const cand = candidateRows(state.classified);
        setLine("读全 " + state.items.length + " 条。离线粗分类完成，进候选 " + cand.length +
          " 条，待确认 " + state.classified.filter((r) => r.category === "unsure").length +
          " 条。" + (state.note ? " " + state.note : ""));
        for (const key of ["csv", "list", "md"]) enable(btns[key], true);
      } catch (err) {
        setLine("失败：" + (err && err.message ? err.message : String(err)));
      } finally {
        state.running = false;
        btns.run.disabled = false;
      }
    }

    const download = (name, text, mime) => {
      const blob = new Blob([text], { type: mime + ";charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    };

    btns.run.addEventListener("click", run);
    btns.csv.addEventListener("click", () => download("bili-clean-report.csv",
      toCsv(state.classified), "text/csv"));
    btns.list.addEventListener("click", () => download("to-unfollow.txt",
      toUnfollowList(candidateRows(state.classified)), "text/plain"));
    btns.md.addEventListener("click", () => download("report.md",
      toMarkdown(state.classified, { total: state.total, fetched: state.items.length, complete: state.complete }),
      "text/markdown"));
  }

  // ---------------------------------------------------------------- 入口与可测出口

  const api = {
    API_ORIGIN, READONLY_ENDPOINTS, DENIED_ENDPOINTS,
    PAGE_SIZE, MIN_INTERVAL_MS, MAX_PAGES, TOTAL_CAP, LOW_CONFIDENCE, LOCAL_MAX,
    CSV_BOM, CSV_FIELDS, UNFOLLOW_NOTICE, PRESET_TAXONOMY, OFFICIAL_HINTS,
    buildReadonlyRequest, buildFollowingsUrl, normalizeItem, parseFollowingsPayload,
    dedupe, mergeItems, scanGate, scanAll, classifyLocal, classifyAll, candidateRows,
    toCsv, toUnfollowList, toMarkdown, csvCell,
  };

  // 没有 DOM 的环境（node:test + vm）只导出纯函数，不碰 window / document。
  if (typeof window === "undefined" || typeof document === "undefined") {
    if (typeof globalThis !== "undefined") globalThis.__BCF_USERSCRIPT__ = api;
    return api;
  }

  if (/\/relation\/follow/.test(location.pathname)) mount();
  window.__BCF_USERSCRIPT__ = api;
})();