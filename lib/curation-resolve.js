/**
 * lib/curation-resolve.js — human keep/drop for neo conflict records.
 */

import { transitionRecordStatus } from "./neo-arch.js";

/**
 * @param {object} store neo store with appendCandidates / readCandidates
 * @param {string} id
 * @param {"keep"|"drop"} action
 * @param {{authorized?: boolean}} [ctx]
 * @returns {{ok: boolean, reason?: string, status?: string}}
 */
export function resolveCurationRecord(store, recordOrId, action, ctx = {}) {
  if (ctx.authorized !== true) return { ok: false, reason: "unauthorized" };
  if (action !== "keep" && action !== "drop") {
    return { ok: false, reason: "invalid_action" };
  }
  const record = recordOrId && typeof recordOrId === "object"
    ? recordOrId
    : null;
  if (!record || !record.id) return { ok: false, reason: "not_found" };
  const next = action === "keep" ? "promoted" : "demoted";
  const updated = transitionRecordStatus(record, next);
  store.appendCandidates([updated]);
  return { ok: true, status: updated.status };
}
