// sidepanel.js —— 主 UI：进度、读全门禁、只读导出。
//
// 验收口径钉在这里：读全之前「开始分类」必须 disabled，并且旁边写明
// 「还没读全（已取 431/812）」。判据是 biliApi.isReadComplete（fetched == total），
// 不是「抓到东西了」。中断不清空：状态 incomplete + 已取数据保留 + 「继续抓取」。

import { KIND_LABEL_ZH, TOTAL_DRIFT_NOTE, canClassify, incompleteHint, isReadComplete, progressLabel } from "./biliApi.js";
import { createStore } from "./store.js";
import { toCsv, toMarkdown, toResultRows, toUnfollowList } from "./report.js";

const store = createStore();

const el = (id) => document.getElementById(id);
const pill = el("status-pill");
const bar = el("progress-bar");
const statFetched = el("stat-fetched");
const statTotal = el("stat-total");
const statPages = el("stat-pages");
const progressLine = el("progress-line");
const hintLine = el("hint-line");
const lock = el("classify-lock");
const btnStart = el("btn-start");
const btnResume = el("btn-resume");
const btnStop = el("btn-stop");
const btnLogin = el("btn-login");
const btnClassify = el("btn-classify");
const btnMd = el("btn-export-md");
const btnCsv = el("btn-export-csv");
const btnUnfollow = el("btn-export-unfollow");
const auditList = el("audit-list");

const STATUS_ZH = { idle: "未开始", scanning: "抓取中", incomplete: "中断（数据已保留）", complete: "已读全" };

let lastItems = [];

async function render() {
  const state = await store.getState();
  lastItems = await store.loadItems();
  const total = state.total === null || state.total === undefined ? null : state.total;
  const fetched = Math.max(Number(state.fetched) || 0, lastItems.length);

  pill.textContent = STATUS_ZH[state.status] || state.status;
  pill.className = "pill " + state.status;
  bar.style.width = total ? Math.min(100, Math.round((fetched / total) * 100)) + "%" : "0%";
  statFetched.textContent = String(fetched);
  statTotal.textContent = total === null ? "-" : String(total);
  statPages.textContent = String(state.pages || 0);
  progressLine.textContent = state.status === "idle"
    ? "还没开始抓取。"
    : progressLabel({ ...state, fetched }, { withPages: true });

  const hint = state.incompleteReason
    ? (incompleteHint({ ...state, fetched }) || "已保留已取数据，点「继续抓取」。")
    : (state.totalCapped
      ? "total 撞上 B站展示上限 2000：请用关注页显示的关注数人工核对一次。"
      : (state.overCount ? TOTAL_DRIFT_NOTE : ""));
  hintLine.textContent = hint;

  const done = canClassify({ ...state, fetched });
  btnClassify.disabled = !done;
  btnClassify.title = done ? "分类将在 FOR-64 接入（本预览版尚未实现）" : "读全后才解锁";
  lock.textContent = done ? "已读全，可以进入分类（本预览版尚未接入）"
    : progressLabel({ ...state, fetched }, { withPages: false });

  btnResume.hidden = !(state.status === "incomplete" && fetched > 0);
  btnStop.hidden = state.status !== "scanning";
  btnStart.disabled = state.status === "scanning";
  btnStart.textContent = state.status === "scanning" ? "抓取中…" : "读全我的关注列表";

  const hasData = lastItems.length > 0;
  btnMd.disabled = !hasData;
  btnCsv.disabled = !hasData;
  btnUnfollow.disabled = !hasData;

  const audit = (await store.loadAudit()).slice(-8).reverse();
  auditList.textContent = "";
  for (const item of audit) {
    const li = document.createElement("li");
    li.textContent = formatAudit(item);
    auditList.appendChild(li);
  }
}

function formatAudit(entry) {
  const when = new Date(entry.ts || Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
  const bits = [entry.event];
  if (entry.fetched !== undefined) bits.push("已取 " + entry.fetched);
  if (entry.total !== undefined) bits.push("total " + entry.total);
  if (entry.pages !== undefined) bits.push("页数 " + entry.pages);
  if (entry.transport) bits.push("通道 " + entry.transport);
  if (entry.reason) bits.push("原因 " + (KIND_LABEL_ZH[entry.reason] || entry.reason));
  return when + " · " + bits.join(" · ");
}

function send(type) {
  chrome.runtime.sendMessage({ type }, () => {
    if (chrome.runtime.lastError) return;
  });
}

btnStart.addEventListener("click", () => send("START_SCAN"));
btnResume.addEventListener("click", () => send("RESUME_SCAN"));
btnStop.addEventListener("click", () => send("ABORT_SCAN"));
btnLogin.addEventListener("click", () => {
  btnLogin.disabled = true;
  chrome.runtime.sendMessage({ type: "CHECK_LOGIN" }, (resp) => {
    btnLogin.disabled = false;
    hintLine.textContent = resp && resp.ok
      ? "已登录：mid " + resp.mid
      : "未登录或接口被风控：" + (KIND_LABEL_ZH[resp && resp.kind] || (resp && resp.message) || "未知");
  });
});
btnClassify.addEventListener("click", () => {
  hintLine.textContent = "分类与自然语言指令在 FOR-64 接入；本预览版只做「抓全 + 只读报告」。";
});

async function exportRows() {
  const state = await store.getState();
  const items = lastItems.length ? lastItems : await store.loadItems();
  return { rows: toResultRows(items, state), state };
}

btnMd.addEventListener("click", async () => {
  const { rows, state } = await exportRows();
  download("report.md", toMarkdown(rows, { state }));
  await store.appendAudit({ event: "export_markdown", rows: rows.length });
});
btnCsv.addEventListener("click", async () => {
  const { rows, state } = await exportRows();
  download("report.csv", toCsv(rows));
  await store.appendAudit({ event: "export_csv", rows: rows.length });
});
btnUnfollow.addEventListener("click", async () => {
  const { rows } = await exportRows();
  download("to-unfollow.txt", toUnfollowList(rows));
  await store.appendAudit({ event: "export_unfollow_list", rows: rows.length });
});

function download(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let timer = null;
function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(render, 250); // 分块写会连发 onChanged，去抖一次
}

render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") scheduleRender();
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === "PROGRESS" || msg.type === "SCAN_DONE")) scheduleRender();
});
