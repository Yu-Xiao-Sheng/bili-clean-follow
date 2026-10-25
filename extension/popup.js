// popup.js —— 入口：一键「分析我的关注列表」，同时打开 Side Panel 看进度。

import { createStore } from "./store.js";
import { isReadComplete } from "./biliApi.js";

const store = createStore();

const stateEl = document.getElementById("popup-state");
const hintEl = document.getElementById("popup-hint");
const btnAnalyze = document.getElementById("btn-analyze");
const btnResume = document.getElementById("btn-resume");

async function render() {
  const state = await store.getState();
  stateEl.textContent = state.status === "complete"
    ? "已读全：" + state.fetched + "/" + state.total + " 条"
    : "还没读全（已取 " + (state.fetched || 0) + "/" +
      (state.total === null ? "未知" : state.total) + "，第 " + (state.pages || 0) + " 页）";
  btnResume.hidden = !(state.status === "incomplete" && (state.fetched || 0) > 0);
  hintEl.textContent = state.incompleteReason
    ? "上次中断原因：" + state.incompleteReason
    : "";
  btnAnalyze.disabled = state.status === "scanning";
  btnAnalyze.textContent = state.status === "scanning" ? "抓取中…" : "分析我的关注列表";
}

async function openSidePanel() {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
}

btnAnalyze.addEventListener("click", async () => {
  await openSidePanel();
  chrome.runtime.sendMessage({ type: "START_SCAN" });
  btnAnalyze.disabled = true;
  btnAnalyze.textContent = "抓取中…";
});

btnResume.addEventListener("click", async () => {
  await openSidePanel();
  chrome.runtime.sendMessage({ type: "RESUME_SCAN" });
});

render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") render();
});

export { isReadComplete };
