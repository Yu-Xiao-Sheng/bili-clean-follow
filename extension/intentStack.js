// intentStack.js —— 意图操作栈 + 「回滚最近一步」（v2-spec §3.4 验收 4）。
//
// 栈里存的是「这一步改了什么 + 改之前是什么」，不是整份列表的副本：
//   decisions：只回滚这一步真正改过的类别（别把用户后来手工改的其它类别一起抹掉）；
//   moved：move 意图改过的单条结果，按 mid 还原成原来的类别。
// 栈落 chrome.storage.local，侧栏关掉再开也能继续「回滚最近一步」。

import { DECISION } from "./classify.js";

export const OP_STACK_KEY = "intent_ops.v1";
export const OP_STACK_MAX = 50; // 只留最近 50 步：812 人的列表也够回滚几十次，且不顶配额

export async function loadOps(store) {
  const got = await store.get([OP_STACK_KEY]);
  const ops = got && got[OP_STACK_KEY];
  return Array.isArray(ops) ? ops : [];
}

async function saveOps(store, ops) {
  await store.set({ [OP_STACK_KEY]: ops.slice(-OP_STACK_MAX) });
}

/** 一步意图应用完之后调用。before/after 来自 intent.applyIntents。 */
export async function pushOp(store, { intents, summary, before, after, previewHash, now = () => Date.now() }) {
  const ops = await loadOps(store);
  const entry = {
    id: "op" + now().toString(36) + ops.length,
    at: now(),
    ops: (Array.isArray(intents) ? intents : []).map((it) => ({
      op: it.op,
      categories: it.categories || [],
      keyword: it.keyword || null,
      target: it.target || null,
    })),
    summary: Array.isArray(summary) ? summary : [],
    before: {
      decisions: snapshot(before && before.decisions),
      moved: (before && before.moved ? before.moved : []).map((m) => ({ mid: String(m.mid), from: m.from, to: m.to })),
    },
    after: {
      decisions: snapshot(after && after.decisions),
      moved: (after && after.moved ? after.moved : []).map((m) => ({ mid: String(m.mid), from: m.from, to: m.to })),
    },
    previewHash: previewHash || null,
  };
  ops.push(entry);
  await saveOps(store, ops);
  return entry;
}

export async function clearOps(store) {
  await store.remove([OP_STACK_KEY]);
}

/**
 * 回滚最近一步。返回 {ok, kind, label, restored}。
 * 没栈时不是错误，是「可回滚 0 步」：kind = "empty_stack"，UI 把按钮禁用即可。
 */
export async function rollbackLast(store, { classifyStore, now = () => Date.now(), onAudit = null } = {}) {
  const ops = await loadOps(store);
  if (!ops.length) {
    return { ok: false, kind: "empty_stack", label: "没有可回滚的意图操作。", restored: null };
  }
  const last = ops[ops.length - 1];
  const map = await classifyStore.loadDecisions();

  // decisions：只回滚这一步改过的类别（before/after 值不同的那些）
  const before = (last.before && last.before.decisions) || {};
  const after = (last.after && last.after.decisions) || {};
  const touched = new Set([...Object.keys(before), ...Object.keys(after)]);
  const restoredDecisions = [];
  for (const id of touched) {
    if (Object.prototype.hasOwnProperty.call(before, id)) {
      if (before[id] && before[id] !== DECISION.UNDECIDED) map[id] = before[id];
      else delete map[id];
    } else {
      delete map[id]; // 这一步之前根本没这条：抹掉
    }
    restoredDecisions.push({ categoryId: id, decision: before[id] || DECISION.UNDECIDED });
  }
  await classifyStore.saveDecisions(map);

  // move：把改过的单条结果按 mid 还原
  let restoredMoved = [];
  const moved = (last.before && last.before.moved) || [];
  if (moved.length) {
    const revert = new Map(moved.map((m) => [String(m.mid), m.from]));
    const results = await classifyStore.loadResults();
    let changed = 0;
    for (const row of results) {
      const mid = String(row.mid);
      if (!revert.has(mid)) continue;
      row.category = revert.get(mid);
      row.overridden = false;
      changed += 1;
      restoredMoved.push({ mid, category: revert.get(mid) });
    }
    if (changed) await classifyStore.saveResults(results);
    restoredMoved = restoredMoved.slice(0, 20); // 回显用，前 20 条足够
  }

  await saveOps(store, ops.slice(0, -1));
  if (onAudit) {
    await onAudit({ event: "intent_rollback", opId: last.id, restoredDecisions: restoredDecisions.length, restoredMoved: moved.length, at: now() });
  }
  return {
    ok: true,
    kind: "rolled_back",
    label: "已回滚：" + ((last.summary || []).join("；") || "最近一步意图操作"),
    restored: { decisions: restoredDecisions, moved: restoredMoved },
    remainingOps: ops.length - 1,
  };
}

function snapshot(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) out[k] = v;
  return out;
}

/** 侧栏操作栈的显示行。 */
export function opStackLines(ops) {
  return (Array.isArray(ops) ? ops : []).map((op) => ({
    id: op.id,
    at: op.at,
    summary: (op.summary || []).join("；") || op.ops.map((o) => o.op).join(" / "),
    rollbackable: true,
  })).reverse(); // 最近一步排前面
}