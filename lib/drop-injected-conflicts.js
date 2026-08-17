/**
 * lib/drop-injected-conflicts.js — bulk-demote injected behavior conflicts.
 */

import { createHash } from "node:crypto";
import { isInjectedContextText, transitionRecordStatus } from "./neo-arch.js";

export const DROP_INJECTED_SCAN_LIMIT = 10_000;

function hasRequester(requester = {}) {
  return Boolean(
    requester.requesterAgentId
    || requester.agentId
    || requester.requesterWorkspaceKey
    || requester.workspaceIdentity
    || requester.requesterOwnerId
    || requester.ownerUserId,
  );
}

function requesterScope(requester = {}) {
  return {
    agentId: requester.requesterAgentId || requester.agentId || "",
    workspaceKey: requester.requesterWorkspaceKey || requester.workspaceIdentity || "",
    ownerId: requester.requesterOwnerId || requester.ownerUserId || "",
  };
}

function inRequesterScope(record, requester) {
  const scope = requesterScope(requester);
  if (!scope.agentId && !scope.workspaceKey && !scope.ownerId) return false;
  const owner = record.ownerId || record.ownerUserId || record.visibility?.ownerUserId || "";
  if (!record.agentId && !record.workspaceKey && !owner) return false;
  if (record.agentId && scope.agentId && record.agentId !== scope.agentId) return false;
  if (record.workspaceKey && scope.workspaceKey && record.workspaceKey !== scope.workspaceKey) return false;
  if (owner && scope.ownerId && owner !== scope.ownerId) return false;
  return true;
}

function injectedText(record) {
  return String(record?.statement || record?.content || record?.text || record?.summary || "");
}

function fingerprint(scope, ids) {
  return createHash("sha256")
    .update(JSON.stringify({
      scope,
      count: ids.length,
      ids,
    }))
    .digest("hex");
}

/**
 * Preview newest behavior conflicts that are injected context in the requester scope.
 * @param {object} store
 * @param {object} requester
 * @returns {{ok: boolean, reason?: string, count?: number, ids?: string[], hash?: string, examples?: object[]}}
 */
export function previewDropInjected(store, requester = {}) {
  if (!hasRequester(requester)) return { ok: false, reason: "unauthorized" };
  if (typeof store.readBehaviorCards !== "function") return { ok: false, reason: "incomplete_scan" };
  const rows = store.readBehaviorCards(DROP_INJECTED_SCAN_LIMIT);
  if (!Array.isArray(rows) || rows.length >= DROP_INJECTED_SCAN_LIMIT) {
    return { ok: false, reason: "incomplete_scan" };
  }
  const hits = rows.filter((row) =>
    row?.status === "conflict"
    && isInjectedContextText(injectedText(row))
    && inRequesterScope(row, requester),
  );
  const ids = hits.map((row) => String(row.id)).sort();
  return {
    ok: true,
    count: ids.length,
    ids,
    hash: fingerprint(requesterScope(requester), ids),
    examples: hits.slice(0, 5).map((row) => ({
      id: row.id,
      statement: injectedText(row).slice(0, 160),
    })),
  };
}

/**
 * Demote the previewed injected conflicts. Aborts on hash/count drift.
 * @param {object} store
 * @param {{authorized?: boolean, requester?: object, expectedHash?: string, expectedCount?: number}} ctx
 * @returns {{ok: boolean, reason?: string, dropped?: number}}
 */
export function applyDropInjected(store, ctx = {}) {
  if (ctx.authorized !== true) return { ok: false, reason: "unauthorized" };
  const preview = previewDropInjected(store, ctx.requester);
  if (!preview.ok) return preview;
  if (preview.hash !== ctx.expectedHash || preview.count !== ctx.expectedCount) {
    return { ok: false, reason: "drift" };
  }
  if (preview.count === 0) return { ok: true, dropped: 0 };
  if (typeof store.appendBehaviorCards !== "function") return { ok: false, reason: "incomplete_scan" };
  const byId = new Map(store.readBehaviorCards(DROP_INJECTED_SCAN_LIMIT).map((row) => [row.id, row]));
  const updates = [];
  for (const id of preview.ids) {
    const record = byId.get(id);
    if (!record || record.status !== "conflict" || !isInjectedContextText(injectedText(record))) {
      return { ok: false, reason: "drift" };
    }
    updates.push(transitionRecordStatus(record, "demoted"));
  }
  const written = store.appendBehaviorCards(updates);
  if (Array.isArray(written) && written.length !== updates.length) {
    return { ok: false, reason: "incomplete_write" };
  }
  return { ok: true, dropped: updates.length };
}
