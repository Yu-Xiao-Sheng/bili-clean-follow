// content/followpage.js —— space.bilibili.com/<mid>/relation/follow 的 content script。
//
// 两个职责：
//   1) 关注页内联按钮（v2-spec §2.2 与油猴脚本同一注入协议）：点一下就让 background 开抓。
//   2) DOM 兜底：API 三条路都不可用时，background 把本页导航到第 pn 页，再发消息来取
//      本页的 mid + 昵称 + 简介 + 关注数。翻到最后一页由 background 的 fetched == total
//      门禁判定，本文件不自己宣布「抓完了」。
//
// content script 不能 import ESM，所以这份是自包含经典脚本（选择器一律多路兜底：
// B站关注页改版过一次，只钉一套 class 就会在下次改版时静默抓到 0 条）。

(function () {
  "use strict";

  var MID_RE = /space\.bilibili\.com\/(\d+)/;

  function selfMid() {
    var m = location.pathname.match(/\/(\d+)\/relation\/follow/);
    return m ? m[1] : null;
  }

  function textOf(root, selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var el = root.querySelector(selectors[i]);
      if (el) {
        var t = (el.textContent || "").replace(/[\r\n\t]+/g, " ").trim();
        if (t) return t;
      }
    }
    return "";
  }

  function cardElements() {
    var groups = [
      ".card-list .list-item",
      ".section-content .list-item",
      ".relation-list .list-item",
      ".follow-main .list-item",
      ".fans-module .item",
      "[mod-name=bili-userHome] .list-item",
    ];
    var seen = [];
    for (var i = 0; i < groups.length; i += 1) {
      var found = Array.prototype.slice.call(document.querySelectorAll(groups[i]));
      if (!found.length) continue;
      found.forEach(function (node) {
        if (seen.indexOf(node) === -1) seen.push(node);
      });
    }
    if (!seen.length) {
      // 最后一道：任何指向某个 space 页的卡片根节点。
      var links = Array.prototype.slice.call(document.querySelectorAll("a[href*='space.bilibili.com/']"));
      links.forEach(function (a) {
        var card = a.closest("li, .list-item, .card, .item") || a.parentNode;
        if (card && seen.indexOf(card) === -1) seen.push(card);
      });
    }
    return seen;
  }

  function scrapeItems() {
    var mine = selfMid();
    var out = [];
    cardElements().forEach(function (card) {
      var mid = null;
      var link = card.matches && card.matches("a[href*='space.bilibili.com/']")
        ? card : card.querySelector("a[href*='space.bilibili.com/']");
      if (link) {
        var m = (link.getAttribute("href") || "").match(MID_RE);
        if (m) mid = m[1];
      }
      if (!mid || mid === mine) return;
      var nickname = textOf(card, [
        ".title-area .name", ".name", ".title-area a", ".user-info .name",
        ".info-item .name", "a[mod-name='space.click_topuser']", ".title a",
      ]) || (link ? (link.textContent || "").trim() : "");
      var bio = textOf(card, [".info-content .desc", ".desc", ".signature", ".info-area .text", ".text"]);
      var tag = textOf(card, [".tag-area .tag", ".tags .tag", ".label-item span"]);
      nickname = nickname.replace(/[\r\n\t]+/g, " ").trim();
      if (!nickname) return;
      out.push({
        mid: mid,
        nickname: nickname,
        bio: bio,
        tags: tag ? [tag] : [],
        official: /认证| Official/i.test(textOf(card, [".official-badge", ".official-reason", ".name .badge"])) ? textOf(card, [".official-badge", ".official-reason", ".name .badge"]) : "",
        source: "dom_scrape",
      });
    });
    return out;
  }

  function scrapeTotal() {
    var state = window.__INITIAL_STATE__;
    if (state) {
      var candidates = [state.total, state.data && state.data.total,
        state.relation && state.relation.total, state.pageInfo && state.pageInfo.total];
      for (var i = 0; i < candidates.length; i += 1) {
        var n = Number(candidates[i]);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    var texts = document.body ? document.body.innerText : "";
    var m = texts.match(/(?:全部关注|共)\s*([0-9]{1,6})\s*(?:人|个|条)?/);
    if (m) return Number(m[1]);
    var el = document.querySelector(".total-count, .count, .title-info .total");
    if (el) {
      var n2 = Number((el.textContent || "").replace(/[^0-9]/g, ""));
      if (Number.isFinite(n2) && n2 >= 0) return n2;
    }
    return null;
  }

  function scrape() {
    var items = scrapeItems();
    var total = scrapeTotal();
    var pn = Number(new URL(location.href).searchParams.get("pn")) || 1;
    var marker = pn + ":" + items.length + ":" + (items.length ? items[0].mid : "-") +
      ":" + (items.length ? items[items.length - 1].mid : "-");
    return {
      ok: items.length > 0 || total !== null,
      kind: items.length || total !== null ? "ok" : "malformed_response",
      total: total,
      items: items,
      pn: pn,
      domCount: items.length,
      marker: marker,
      message: items.length || total !== null ? "" : "关注页没解析出任何卡片（可能改版或需登录）",
    };
  }

  // 非浏览器环境（node:test 只检查这份脚本能解析）不碰 window / document。
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // 暴露给 background 的 executeScript 补注入路径（content_scripts 没生效时）。
  window.__BCF_FOLLOW_SCRAPE__ = scrape;

  function mountButton() {
    if (window.__BCF_BUTTON_MOUNTED__) return;
    var host = document.querySelector(".relation-header, .section-header, .follow-main, .fans-module, #app");
    if (!host) return;
    window.__BCF_BUTTON_MOUNTED__ = true;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "用 Bili Clean Follow 读全关注列表";
    btn.setAttribute("style", "margin:8px 12px;padding:6px 12px;border-radius:6px;" +
      "border:1px solid #fb7299;color:#fb7299;background:transparent;cursor:pointer;");
    btn.addEventListener("click", function () {
      try {
        chrome.runtime.sendMessage({ type: "START_SCAN" }, function () {
          btn.textContent = "已开始抓取，进度看插件侧栏";
        });
      } catch (err) {
        btn.textContent = "扩展未连接";
      }
    });
    host.appendChild(btn);
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (msg && msg.type === "SCRAPE_FOLLOW_PAGE") {
        sendResponse(scrape());
        return false;
      }
      return false;
    });
    if (/\/relation\/follow/.test(location.pathname)) mountButton();
  }

  return scrape();
})();
