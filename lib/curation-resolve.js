/**
 * lib/curation-resolve.js — human keep/drop for neo conflict records.
 */

import { latestNeoRevisionById, transitionRecordStatus } from "./neo-arch.js";

/**
 * Schreibt die Entscheidung in den Store, aus dem der Record stammt
 * (behavior-cards.jsonl bzw. memory-candidates.jsonl) — frischer Stand und
 * Append unter dem Neo-Write-Lock (`store.reviseRecord`). Konflikt-Karten aus
 * behaviorCardsFromReactions liegen in behavior-cards.jsonl; eine Revision in
 * memory-candidates.jsonl wuerde dort aus dem Tail-Fenster fallen.
 *
 * @param {object} store neo store with reviseRecord (or, legacy: appendCandidates)
 * @param {object} recordOrId the conflict record as read via findNeoRecord
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
  if (typeof store.reviseRecord === "function") {
    const revised = store.reviseRecord(record, (current) => transitionRecordStatus(current, next));
    if (!revised) return { ok: false, reason: "not_found" };
    return { ok: true, status: revised.record.status };
  }
  // Stores ohne reviseRecord (Fremdimplementierungen): bisheriges Verhalten.
  const updated = transitionRecordStatus(record, next);
  store.appendCandidates([updated]);
  return { ok: true, status: updated.status };
}

/**
 * Liste fuer `/plur1bus curation <sub>`: Kandidaten und Behavior-Karten in der
 * jeweils JUENGSTEN Revision je id. Die Stores sind append-only; ohne diese
 * Reduktion bliebe eine aufgeloeste Konflikt-Karte mit ihrer alten
 * `conflict`-Zeile in der Liste.
 *
 * @param {object} store neo store (readCandidates / readBehaviorCards)
 * @param {string} sub "conflicts" | "stale" | "promoted" | anything else (open items)
 * @param {object} [requester] ACL requester
 * @returns {object[]}
 */
export function listCurationRecords(store, sub, requester) {
  const candidates = store.readCandidates(500, requester);
  const behavior = store.readBehaviorCards(200, requester);
  const records = latestNeoRevisionById([...candidates, ...behavior]);
  return sub === "conflicts" ? records.filter(r => r.status === "conflict")
    : sub === "stale" ? records.filter(r => r.embeddingStatus === "stale")
    : sub === "promoted" ? records.filter(r => r.status === "promoted")
    : records.filter(r => r.status === "candidate" || r.status === "active").slice(-50);
}
