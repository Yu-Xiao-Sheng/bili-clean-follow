// mock_bilibili.mjs —— A 轨的 B站接口替身 + 分页夹具（FOR-67）。
//
// 为什么走网络层（--host-resolver-rules + 自签证书）而不是 Playwright route：
// 抓取主路径是 MV3 service worker 里的 fetch，Playwright 的 route 拦截覆盖不到
// service worker 的请求。把 bilibili 的域解析到本机端口，才能不分发起方地把夹具
// 喂给扩展，同时把每次请求（path / pn / 时间戳）记下来供断言使用。
//
// 夹具形状对齐验收清单 B1：3 页、跨页故意重复一条 mid（原始 63 行），
// 关注数 total = 去重后的 62；含 emoji 昵称、官方认证、空简介与整字段缺失简介。

import https from "node:https";
import selfsigned from "selfsigned";

export const SELF_MID = "77000001";
export const PAGE_SIZE = 20;

const BUCKETS = [
  "每天更新搞笑段子合集，投稿整活与整蛊",
  "影视解说，三分钟看完一部电影",
  "科技数码评测，聊芯片与手机",
  "游戏实况与攻略，主机游戏为主",
  "时事新闻速览，每日更新",
  "美食探店与家常菜教程",
  "财经宏观分析，聊政策与市场",
  "校园学习类，考研与英语",
];

/** counts 是每页行数，例如 [20, 20, 22] => 原始 63 行，去重后 62 条。 */
export function buildPages(counts = [20, 20, 22]) {
  const pages = [];
  let idx = 0;
  for (const n of counts) {
    const rows = [];
    for (let k = 0; k < n; k++) {
      idx += 1;
      const row = {
        mid: Number(900000 + idx),
        uname: "UP主" + idx + (idx % 5 === 0 ? "🍅" : ""),
        sign: idx % 4 === 0 ? "" : BUCKETS[idx % BUCKETS.length],
        ptime: 1_700_000_000 - idx * 3600,
        mtime: 1_700_000_000 - idx * 3600,
        vip: { status: idx % 9 === 0 ? 1 : 0 },
        tags: [],
      };
      if (idx % 11 === 0) delete row.sign; // 整字段缺失（不是空串）：真实列表里也有这种
      if (idx % 7 === 0) {
        row.official = { title: "bilibili 知名游戏UP主", type: 1 };
        row.official_verify = { type: 1, desc: "bilibili 知名游戏UP主" };
      }
      rows.push(row);
    }
    pages.push(rows);
  }
  if (pages.length > 1) pages[1].unshift({ ...pages[0][0] }); // 跨页重复，去重必须吃掉它
  return pages;
}

export function uniqueMids(pages) {
  return new Set(pages.flat().map((r) => String(r.mid)));
}

/** riskOnPage: 第几页返回 code=-352（B3 风控续抓用），null 表示不注入。 */
export async function startMockServer({ pages, total = null, riskOnPage = null }) {
  // total 是「关注页显示的关注数」：夹具故意跨页重复一条，所以它不等于原始行数。
  const servedTotal = total ?? uniqueMids(pages).size;
  const requests = [];
  const keys = await selfsigned.generate([{ name: "commonName", value: "api.bilibili.com" }],
    { days: 2, keySize: 2048 });

  const server = https.createServer({ key: keys.private, cert: keys.cert }, (req, res) => {
    const url = new URL(req.url, "https://api.bilibili.com");
    const pn = url.searchParams.has("pn") ? Number(url.searchParams.get("pn")) : null;
    requests.push({ path: url.pathname, pn, at: Date.now() });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    let body;
    if (url.pathname === "/x/web-interface/nav") {
      body = { code: 0, message: "0", ttl: 1,
        data: { isLogin: true, mobileVerify: true, face: "", level_info: { current_level: 6 },
          mid: Number(SELF_MID), mobile: "", name: "mock-user", uname: "取证账号",
          portrait: "https://static.hdslb.com/images/member/noface.gif",
          vip: { status: 0, type: 0 }, faning: false,
          official_verify: { type: -1, desc: "" } } };
    } else if (url.pathname === "/x/relation/followings") {
      if (riskOnPage !== null && pn === riskOnPage) {
        body = { code: -352, message: "Risk control hit", ttl: 1, data: {} };
      } else {
        const list = pages[pn - 1] || [];
        body = { code: 0, message: "0", ttl: 1,
          data: { has_more: pn < pages.length ? 1 : 0, item: list,
            page: { pn: pn || 1, ps: PAGE_SIZE, total: servedTotal },
            total: servedTotal, list } };
      }
    } else if (url.pathname === "/x/relation/tag") {
      body = { code: 0, message: "0", ttl: 1, data: [] };
    } else if (url.pathname === "/x/relation/stat") {
      body = { code: 0, message: "0", ttl: 1,
        data: { following: servedTotal, follower: 12, dynamic_count: 3 } };
    } else {
      body = { code: 0, message: "0", ttl: 1, data: {} };
    }
    res.end(JSON.stringify(body));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        total: servedTotal,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on("error", reject);
  });
}

/** 给 chromium 的启动参数：把 bilibili 三个域解析到 mock 端口。 */
export function resolverArgs(port) {
  return "--host-resolver-rules=MAP api.bilibili.com 127.0.0.1:" + port +
    ", MAP www.bilibili.com 127.0.0.1:" + port + ", MAP space.bilibili.com 127.0.0.1:" + port;
}