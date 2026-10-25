// sidepanel.js —— 主 UI：抓取进度、读全门禁、分类（离线 / BYOK AI）、只读导出。
//
// 验收口径钉在这里：
//   * 读全之前「开始分类」必须 disabled，旁边写明「还没读全（已取 431/812）」。
//   * AI 分类必须先弹告知（发几条、发到哪、不含什么），确认才落 consent；换端点重新确认。
//   * Key 只进它自己的存储键；配置对象、审计、导出文件里都不出现（privacy.js 会抛）。
//   * 每个类别卡片显示数量 + 占比 + 平均置信 + 来源，并有「保留 / 进候选」。

import { KIND_LABEL_ZH, TOTAL_DRIFT_NOTE, incompleteHint, progressLabel } from "./biliApi.js";
import { createStore, memoryStorage } from "./store.js";
import { toCsv, toMarkdown, toResultRows, toUnfollowList } from "./report.js";
import {
  DECISION,
  MODE,
  candidateMids,
  categorySummary,
  classificationBlurb,
  classificationGate,
  consentNotice,
  createClassifyStore,
  makeConsent,
  preflightGate,
  runClassification,
} from "./classify.js";
import {
  LOW_CONFIDENCE,
  OTHER_CATEGORY,
  UNSURE_CATEGORY,
  addCategory,
  categoryName,
  normalizeTaxonomy,
  removeCategory,
  renameCategory,
  setCategoryKeywords,
} from "./taxonomy.js";
import { LOCAL_LABEL } from "./classifyLocal.js";
import { LLM_ERROR_ZH, PROVIDER_PRESETS, validateEndpoint } from "./classifyLlm.js";

const store = createStore();
const classifyStore = createClassifyStore({ storage: storageBackend() });

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
const btnClassifyLocal = el("btn-classify-local");
const btnClassifyStop = el("btn-classify-stop");
const classifyLine = el("classify-line");
const classifySource = el("classify-source");
const categoryList = el("category-list");
const taxonomyList = el("taxonomy-list");
const taxLine = el("tax-line");
const llmPreset = el("llm-preset");
const llmBaseUrl = el("llm-baseurl");
const llmModel = el("llm-model");
const llmKey = el("llm-key");
const llmSendBio = el("llm-sendbio");
const llmLine = el("llm-line");
const consentDialog = el("consent-dialog");
const consentLines = el("consent-lines");
const consentSendBio = el("consent-sendbio");
const btnMd = el("btn-export-md");
const btnCsv = el("btn-export-csv");
const btnUnfollow = el("btn-export-unfollow");
const auditList = el("audit-list");

const STATUS_ZH = { idle: "未开始", scanning: "抓取中", incomplete: "中断（数据已保留）", complete: "已读全" };

let lastItems = [];
let lastResults = [];
let lastMeta = null;
let lastTaxonomy = normalizeTaxonomy(null);
let lastDecisions = {};
let classifyAbort = false;
let classifying = false;

function storageBackend() {
  return globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local
    ? globalThis.chrome.storage.local
    : memoryStorage();
}

async function render() {
  const state = await store.getState();
  lastItems = await store.loadItems();
  lastResults = await classifyStore.loadResults();
  lastMeta = await classifyStore.loadMeta();
  lastTaxonomy = await classifyStore.loadTaxonomy();
  lastDecisions = await classifyStore.loadDecisions();

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

  const gate = classificationGate({ state: { ...state, fetched }, items: lastItems });
  btnClassify.disabled = !gate.ok || classifying;
  btnClassifyLocal.disabled = !gate.ok || classifying;
  btnClassify.title = gate.ok ? "按当前 AI 配置分类（没配 Key 就走离线）" : "读全后才解锁";
  lock.textContent = gate.ok ? "已读全，分类已解锁" : gate.label;
  if (!classifying && !lastResults.length) {
    classifyLine.textContent = gate.ok
      ? "可以分类了。没填 API Key 就只用离线规则（零外发）；填了会先弹告知。"
      : gate.label;
  }

  btnResume.hidden = !(state.status === "incomplete" && fetched > 0);
  btnStop.hidden = state.status !== "scanning";
  btnStart.disabled = state.status === "scanning";
  btnStart.textContent = state.status === "scanning" ? "抓取中…" : "读全我的关注列表";

  const hasData = lastItems.length > 0;
  btnMd.disabled = !hasData;
  btnCsv.disabled = !hasData;
  btnUnfollow.disabled = !hasData;

  renderLlmLine();
  renderCategories();
  renderTaxonomy();

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
  if (entry.mode) bits.push("来源 " + (entry.mode === MODE.LLM ? "AI" : "离线"));
  if (entry.rows !== undefined) bits.push("条数 " + entry.rows);
  if (entry.reason) bits.push("原因 " + (KIND_LABEL_ZH[entry.reason] || entry.reason));
  return when + " · " + bits.join(" · ");
}

// --- 分类 ---------------------------------------------------------------

async function runClassify({ useLlm }) {
  if (classifying) return;
  const state = await store.getState();
  const gate = classificationGate({ state, items: lastItems });
  if (!gate.ok) {
    classifyLine.textContent = gate.label;
    return;
  }
  const config = readLlmForm();
  const apiKey = await classifyStore.loadApiKey();
  const consent = await classifyStore.loadConsent();

  if (useLlm) {
    const pre = preflightGate({ config, apiKey, consent });
    if (!pre.ok) {
      if (pre.kind === "consent_required" || pre.kind === "consent_stale") {
        openConsent({ count: lastItems.length, config, apiKey });
        return;
      }
      classifyLine.textContent = "AI 分类不可用：" + (LLM_ERROR_ZH[pre.kind] || pre.kind);
      return;
    }
    const perm = await ensureHostPermission(pre.origin);
    if (!perm.ok) {
      classifyLine.textContent = "没拿到访问 " + pre.origin + " 的权限：这次只用离线规则分类。";
      useLlm = false;
    }
  }

  classifying = true;
  classifyAbort = false;
  btnClassifyStop.hidden = false;
  btnClassify.disabled = true;
  btnClassifyLocal.disabled = true;
  classifyLine.textContent = useLlm ? "AI 分类中：每批 40 条…" : "离线分类中…";
  try {
    const res = await runClassification({
      scanStore: store,
      classifyStore,
      state,
      items: lastItems,
      taxonomy: lastTaxonomy,
      llm: useLlm,
      config,
      apiKey,
      consent,
      fetchImpl: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
      onProgress: (info) => {
        classifyLine.textContent = "已分类 " + info.done + " 条（第 " + ((info.index || 0) + 1) +
          "/" + info.total + " 批）" + (info.kind ? "，这批失败已降级" : "");
      },
      aborted: () => classifyAbort,
    });
    classifyLine.textContent = classificationBlurb(res.meta) +
      (res.meta.unsure ? "；待确认 " + res.meta.unsure + " 条" : "") +
      (res.meta.status === "partial" ? "（已停，未分类 " + res.meta.unclassified + " 条）" : "");
    await store.appendAudit({ event: "classify_shown", mode: res.meta.mode, rows: res.results.length });
  } catch (err) {
    classifyLine.textContent = "分类失败：" + (err && err.message ? err.message : String(err));
  } finally {
    classifying = false;
    classifyAbort = false;
    btnClassifyStop.hidden = true;
    await render();
  }
}

function openConsent({ count, config, apiKey }) {
  const notice = consentNotice({ count, baseUrl: config.baseUrl, model: config.model, sendBio: config.sendBio });
  consentDialog.dataset.baseUrl = config.baseUrl;
  consentDialog.dataset.model = config.model;
  consentLines.textContent = "";
  for (const line of notice.lines) {
    const li = document.createElement("li");
    li.textContent = line;
    consentLines.appendChild(li);
  }
  consentSendBio.checked = config.sendBio;
  el("consent-privacy").textContent = notice.privacyLine;
  el("consent-title").textContent = notice.title + "（" + notice.endpoint + "）";
  consentSendBio.onchange = () => {
    const again = consentNotice({ count, baseUrl: config.baseUrl, model: config.model, sendBio: consentSendBio.checked });
    consentLines.textContent = "";
    for (const line of again.lines) {
      const li = document.createElement("li");
      li.textContent = line;
      consentLines.appendChild(li);
    }
  };
  if (typeof consentDialog.showModal === "function") consentDialog.showModal();
  else consentDialog.setAttribute("open", "");
}

el("consent-accept").addEventListener("click", async () => {
  const baseUrl = consentDialog.dataset.baseUrl;
  const model = consentDialog.dataset.model;
  await classifyStore.saveLlmConfig({ ...readLlmForm(), baseUrl, model, sendBio: consentSendBio.checked });
  await classifyStore.saveConsent(makeConsent({
    baseUrl, sendBio: consentSendBio.checked, count: lastItems.length,
  }));
  if (typeof consentDialog.close === "function") consentDialog.close();
  await render();
  await runClassify({ useLlm: true });
});

el("consent-cancel").addEventListener("click", () => {
  if (typeof consentDialog.close === "function") consentDialog.close();
  classifyLine.textContent = "没确认告知就不外发：想分类请用「只用离线规则分类」。";
});

btnClassify.addEventListener("click", () => runClassify({ useLlm: true }));
btnClassifyLocal.addEventListener("click", () => runClassify({ useLlm: false }));
btnClassifyStop.addEventListener("click", () => {
  classifyAbort = true;
  classifyLine.textContent = "正在停止：已分类的结果会保留。";
});

/** 只在用户手势里调用：向用户自己填的 origin 申请 host 权限（装扩展时不预授）。 */
async function ensureHostPermission(origin) {
  if (!origin) return { ok: false };
  if (!globalThis.chrome || !chrome.permissions || !chrome.permissions.request) return { ok: true };
  const target = origin + "/*";
  const has = await new Promise((resolve) => chrome.permissions.contains({ origins: [target] }, (v) => resolve(Boolean(v))));
  if (has) return { ok: true };
  const granted = await new Promise((resolve) => {
    chrome.permissions.request({ origins: [target] }, (gr) => {
      if (chrome.runtime.lastError) resolve(false);
      else resolve(Boolean(gr));
    });
  });
  return { ok: granted };
}

// --- BYOK 配置 ----------------------------------------------------------

function renderLlmForm() {
  llmPreset.textContent = "";
  for (const preset of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.label;
    llmPreset.appendChild(opt);
  }
}

function readLlmForm() {
  return {
    preset: llmPreset.value || "custom",
    baseUrl: llmBaseUrl.value.trim(),
    model: llmModel.value.trim(),
    sendBio: llmSendBio.checked,
    enabled: Boolean(llmBaseUrl.value.trim()),
  };
}

async function renderLlmLine() {
  const config = await classifyStore.loadLlmConfig();
  if (llmBaseUrl.value.trim() !== config.baseUrl) llmBaseUrl.value = config.baseUrl || "";
  if (llmModel.value.trim() !== (config.model || "")) llmModel.value = config.model || "";
  llmSendBio.checked = config.sendBio !== false;
  if (config.preset) llmPreset.value = config.preset;
  const apiKey = await classifyStore.loadApiKey();
  const consent = await classifyStore.loadConsent();
  const check = validateEndpoint(config.baseUrl);
  const bits = [];
  bits.push(apiKey ? "已存 Key（只在本机扩展存储）" : "没填 Key：只用离线规则分类，零外发。");
  if (check.ok) bits.push("端点 " + check.url + (check.local ? "（本机，数据不出这台机器）" : ""));
  if (consent && consent.origin) {
    bits.push("外发确认：" + consent.origin + "（" + (consent.sendBio ? "昵称+简介" : "只发昵称") + "）");
  }
  llmLine.textContent = bits.join(" · ");
  const pre = preflightGate({ config, apiKey, consent });
  if (!pre.ok && apiKey && check.ok) llmLine.textContent += " · 还差一步：" + (LLM_ERROR_ZH[pre.kind] || pre.kind);
}

el("btn-llm-save").addEventListener("click", async () => {
  const config = readLlmForm();
  const check = validateEndpoint(config.baseUrl);
  if (config.baseUrl && !check.ok) {
    llmLine.textContent = LLM_ERROR_ZH[check.kind] || check.kind;
    return;
  }
  await classifyStore.saveLlmConfig(config);
  const raw = llmKey.value.trim();
  if (raw) {
    await classifyStore.saveApiKey(raw);
    llmKey.value = "";
  }
  await classifyStore.clearConsent(); // 配置变了，旧的外发确认作废
  llmLine.textContent = "已保存。外发确认已作废：下次点 AI 分类会重新弹告知。";
  await render();
});

el("btn-llm-clearkey").addEventListener("click", async () => {
  await classifyStore.saveApiKey("");
  await classifyStore.clearConsent();
  llmKey.value = "";
  llmLine.textContent = "Key 已清除；AI 分类不可用，只剩离线规则。";
});

el("btn-llm-clearconsent").addEventListener("click", async () => {
  await classifyStore.clearConsent();
  llmLine.textContent = "外发确认已撤回：下次 AI 分类会重新弹告知。";
});

llmPreset.addEventListener("change", () => {
  const preset = PROVIDER_PRESETS.find((p) => p.id === llmPreset.value);
  if (!preset || !preset.baseUrl) return;
  llmBaseUrl.value = preset.baseUrl;
  if (preset.model) llmModel.value = preset.model;
});

// --- 分类结果卡片 --------------------------------------------------------

function renderCategories() {
  categoryList.textContent = "";
  classifySource.textContent = lastMeta
    ? (lastMeta.mode === MODE.LLM ? (lastMeta.degradedBatches ? "AI + 部分降级" : "AI 分类") : LOCAL_LABEL)
    : "";
  el("classify-summary").textContent = lastMeta
    ? classificationBlurb(lastMeta) + " 共 " + lastMeta.total + " 条；阈值 " + LOW_CONFIDENCE + "。"
    : "还没分类。";
  if (!lastResults.length) return;
  for (const row of categorySummary(lastResults, lastTaxonomy)) {
    const li = document.createElement("li");
    const decision = lastDecisions[row.categoryId];
    li.className = "cat" + (decision === DECISION.KEEP ? " keep" : decision === DECISION.CANDIDATE ? " candidate" : "");
    li.dataset.id = row.categoryId;

    const head = document.createElement("div");
    head.className = "cat-head";
    const name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = row.name + (row.isUnsure ? "（置信 < " + LOW_CONFIDENCE + "）" : "");
    const count = document.createElement("span");
    count.className = "cat-count";
    count.textContent = row.count + " 条 · " + row.ratio + "%";
    head.append(name, count);

    const barEl = document.createElement("div");
    barEl.className = "cat-bar";
    const fill = document.createElement("div");
    fill.style.width = row.ratio + "%";
    barEl.appendChild(fill);

    const meta = document.createElement("div");
    meta.className = "cat-meta";
    const src = sourceOfCategory(lastResults, row.categoryId);
    meta.textContent = "平均置信 " + row.avgConfidence + " · 来源 " + src +
      (row.categoryId === UNSURE_CATEGORY && lastMeta && lastMeta.unclassified ? " · 另有未分类 " + lastMeta.unclassified + " 条" : "");

    const actions = document.createElement("div");
    actions.className = "cat-actions";
    const keepBtn = decisionButton("保留", decision === DECISION.KEEP);
    const candBtn = decisionButton("进候选", decision === DECISION.CANDIDATE);
    keepBtn.addEventListener("click", () => decide(row.categoryId, DECISION.KEEP));
    candBtn.addEventListener("click", () => decide(row.categoryId, DECISION.CANDIDATE));
    const sampleBtn = document.createElement("button");
    sampleBtn.className = "ghost";
    sampleBtn.textContent = "看样例";
    sampleBtn.addEventListener("click", () => toggleSamples(li, row.categoryId));
    actions.append(keepBtn, candBtn, sampleBtn);
    if (row.categoryId === UNSURE_CATEGORY || row.categoryId === OTHER_CATEGORY) {
      keepBtn.disabled = true;
      candBtn.disabled = true;
      keepBtn.title = candBtn.title = "「待确认/其他」不参与批量决策：先逐条核对或改分类体系";
    }

    li.append(head, barEl, meta, actions);
    categoryList.appendChild(li);
  }
}

function decisionButton(text, pressed) {
  const btn = document.createElement("button");
  btn.className = "ghost";
  btn.textContent = text;
  btn.setAttribute("aria-pressed", pressed ? "true" : "false");
  return btn;
}

function sourceOfCategory(results, categoryId) {
  const seen = new Set(results.filter((r) => r.category === categoryId).map((r) => r.label).filter(Boolean));
  return seen.size ? [...seen].join(" / ") : "未知";
}

async function decide(categoryId, decision) {
  const next = lastDecisions[categoryId] === decision ? DECISION.UNDECIDED : decision;
  await classifyStore.saveDecision(categoryId, next);
  await store.appendAudit({ event: "category_decision", categoryId, decision: next });
  lastDecisions = await classifyStore.loadDecisions();
  renderCategories();
}

function toggleSamples(li, categoryId) {
  const existing = li.querySelector(".cat-samples");
  if (existing) {
    existing.remove();
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "cat-samples";
  const byMid = new Map(lastItems.map((it) => [String(it.mid), it]));
  for (const r of lastResults.filter((x) => x.category === categoryId).slice(0, 5)) {
    const item = byMid.get(String(r.mid));
    const li2 = document.createElement("li");
    const nickname = (item && item.nickname) || r.mid;
    const from = r.movedToUnsure && r.rawCategory ? "（本来像" + categoryName(lastTaxonomy, r.rawCategory) + "）" : "";
    li2.textContent = nickname + " · " + r.confidence + from + " · " + (r.reason || "");
    ul.appendChild(li2);
  }
  li.appendChild(ul);
}

// --- 分类体系编辑（验收 1） ------------------------------------------------

function renderTaxonomy() {
  taxonomyList.textContent = "";
  for (const cat of lastTaxonomy) {
    const li = document.createElement("li");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = cat.name;
    nameInput.dataset.id = cat.id;
    nameInput.dataset.field = "name";
    const keywords = document.createElement("input");
    keywords.type = "text";
    keywords.value = (cat.keywords || []).join(",");
    keywords.dataset.id = cat.id;
    keywords.dataset.field = "keywords";
    keywords.placeholder = "关键词";
    const save = document.createElement("button");
    save.className = "ghost";
    save.textContent = "保存";
    save.addEventListener("click", () => saveTaxonomyEdit(cat.id, nameInput, keywords));
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "删除";
    del.disabled = cat.id === OTHER_CATEGORY;
    del.title = cat.id === OTHER_CATEGORY ? "「其他」是兜底类，不能删" : "删除后这类成员下次分类会重算";
    del.addEventListener("click", () => dropCategory(cat.id));
    li.append(nameInput, keywords, save, del);
    taxonomyList.appendChild(li);
  }
}

async function saveTaxonomyEdit(id, nameInput, keywordsInput) {
  const tax = normalizeTaxonomy(lastTaxonomy);
  const renamed = renameCategory(tax, id, nameInput.value);
  if (!renamed.ok) {
    taxLine.textContent = renamed.error;
    return;
  }
  setCategoryKeywords(tax, id, keywordsInput.value.split(/[,，、]/));
  lastTaxonomy = await classifyStore.saveTaxonomy(tax);
  taxLine.textContent = "已保存。「" + renamed.category.name + "」的关键词 " +
    (renamed.category.keywords.length || 0) + " 个；离线分类立即生效。";
  renderTaxonomy();
}

async function dropCategory(id) {
  const tax = normalizeTaxonomy(lastTaxonomy);
  const gone = removeCategory(tax, id);
  if (!gone.ok) {
    taxLine.textContent = gone.error;
    return;
  }
  lastTaxonomy = await classifyStore.saveTaxonomy(tax);
  await store.appendAudit({ event: "category_removed", categoryId: id });
  taxLine.textContent = "已删除；重跑一次分类，成员会落到其它类或「其他」。";
  await render();
}

el("btn-tax-add").addEventListener("click", async () => {
  const tax = normalizeTaxonomy(lastTaxonomy);
  const added = addCategory(tax, {
    name: el("tax-new-name").value,
    keywords: el("tax-new-keywords").value.split(/[,，、]/),
  });
  if (!added.ok) {
    taxLine.textContent = added.error;
    return;
  }
  lastTaxonomy = await classifyStore.saveTaxonomy(tax);
  el("tax-new-name").value = "";
  el("tax-new-keywords").value = "";
  taxLine.textContent = "已添加「" + added.category.name + "」；跑一次分类它就会出现。";
  await render();
});

// --- 抓取动作与导出 --------------------------------------------------------

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

/** 导出行带上分类结果（class/reason），沿用 FOR-63 与 CLI 的格式口径。 */
function exportRows() {
  const byMid = new Map(lastResults.map((r) => [String(r.mid), r]));
  const merged = lastItems.map((it) => {
    const r = byMid.get(String(it.mid));
    if (!r) return it;
    return {
      ...it,
      class: r.category === UNSURE_CATEGORY ? "unclassified" : categoryName(lastTaxonomy, r.category),
      reason: (r.label ? "[" + r.label + "] " : "") + (r.reason || ""),
      confidence: r.confidence,
    };
  });
  const state = { candidateMids: new Set(candidateMids(lastResults, lastDecisions)) };
  const rows = toResultRows(merged, state).map((row) => ({
    ...row,
    candidate: state.candidateMids.has(String(row.mid)),
  }));
  return { rows, state };
}

btnMd.addEventListener("click", async () => {
  const { rows, state } = exportRows();
  download("report.md", toMarkdown(rows, { state }));
  await store.appendAudit({ event: "export_markdown", rows: rows.length });
});
btnCsv.addEventListener("click", async () => {
  const { rows } = exportRows();
  download("report.csv", toCsv(rows));
  await store.appendAudit({ event: "export_csv", rows: rows.length });
});
btnUnfollow.addEventListener("click", async () => {
  const { rows } = exportRows();
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

renderLlmForm();
render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") scheduleRender();
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === "PROGRESS" || msg.type === "SCAN_DONE")) scheduleRender();
});