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
export function resolveCurationRecord(store, id, action, ctx = {}) {
  if (ctx.authorized !== true) return { ok: false, reason: "unauthorized" };
  if (!id || (action !== "keep" && action !== "drop")) {
    return { ok: false, reason: "invalid_action" };
  }
  const records = typeof store.readCandidates === "function" ? store.readCandidates(500) : [];
  const record = records.find((row) => row.id === id);
  if (!record) return { ok: false, reason: "not_found" };
  const next = action === "keep" ? "promoted" : "demoted";
  const updated = transitionRecordStatus(record, next);
  store.appendCandidates([updated]);
  return { ok: true, status: updated.status };
}
