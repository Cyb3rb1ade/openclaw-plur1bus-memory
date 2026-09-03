/**
 * lib/epistemic-status.js — Explicit Trust State (Phase 1).
 *
 * `epistemicStatus` is a claim-level judgment ("given the evidence we have,
 * how much should this record be trusted right now"), independent of and
 * orthogonal to two existing, DO-NOT-CONFUSE fields:
 *   - origin.trustLevel (lib/neo-arch.js, NEO_TRUST_LEVELS) — WHO asserted the
 *     record (user/assistant/tool/curator). Provenance, set once at capture.
 *   - confidence (origin.confidence, 0-1) — numeric certainty, independent of
 *     epistemic status: a disputed record can have confidence 0.9, a trusted
 *     one can have confidence 0.4.
 *
 * Values: untrusted, observed, corroborated, trusted, disputed, invalidated.
 * See the Phase 1 plan for the full transition matrix and rationale.
 */

export const EPISTEMIC_STATUSES = Object.freeze([
  "untrusted",
  "observed",
  "corroborated",
  "trusted",
  "disputed",
  "invalidated",
]);

/**
 * Ladder used only for a merge's "lower position wins" rule (§7 of the plan).
 * `disputed`/`invalidated` are deliberately excluded — they are handled by
 * dedicated sticky/exclusion rules elsewhere, not by ladder position.
 */
const EPISTEMIC_LADDER = Object.freeze(["untrusted", "observed", "corroborated", "trusted"]);

/**
 * Legal (from, to) transitions and the actor tier(s) allowed to perform them.
 * "human" — an explicitly authorized reviewer (isAuthorized() + checkAccess()).
 * "system:tombstone-cascade" — inherits authorization from an already-gated
 *   destructive operation (e.g. /forget); never independently decides.
 */
const HUMAN = "human";
const CASCADE = "system:tombstone-cascade";
// A skill approval applied through OpenClaw's Skill Workshop is an operator
// decision that the gateway carries out; the event names the gateway as actor,
// so the human tier would misstate who acted. This tier exists for that one
// mirror step and may only corroborate the evidence a mined skill cites.
const WORKSHOP = "system:skill-workshop";

/**
 * Normalizes a raw stored value to a real epistemic status for LEGALITY and
 * LABELING purposes. Any unrecognized or missing value resolves to
 * "untrusted" — never a silent pass-through, never "trusted". Mirrors
 * normalizeNeoStatus()/safeStatus() elsewhere in this repo.
 *
 * @param {*} value
 * @returns {string} one of EPISTEMIC_STATUSES
 */
export function normalizeEpistemicStatus(value) {
  return EPISTEMIC_STATUSES.includes(value) ? value : "untrusted";
}

/**
 * Scoring-only lookup (NOT legality/labeling — use normalizeEpistemicStatus
 * for that). A genuinely absent/empty value scores 0 (neutral, matches
 * pre-feature behavior for legacy rows); only a value a human/system actually
 * wrote gets a directional boost or penalty.
 *
 * @param {*} rawValue raw, un-normalized stored value
 * @returns {number}
 */
export function epistemicScoreBoost(rawValue) {
  const EPISTEMIC_SCORE_BOOST = {
    trusted: 0.25,
    corroborated: 0.15,
    observed: 0,
    untrusted: -0.15,
    disputed: -0.4,
  };
  return EPISTEMIC_SCORE_BOOST[rawValue] ?? 0;
}

/**
 * Whether `nextStatus` is a legal transition target from `fromStatus` for the
 * given actor tier. Both inputs are normalized internally.
 *
 * @param {string} fromStatus
 * @param {string} nextStatus
 * @param {"human"|"system:tombstone-cascade"|"system:skill-workshop"} actorTier
 * @returns {boolean}
 */
export function isLegalEpistemicTransition(fromStatus, nextStatus, actorTier) {
  const from = normalizeEpistemicStatus(fromStatus);
  const to = normalizeEpistemicStatus(nextStatus);
  if (actorTier !== HUMAN && actorTier !== CASCADE && actorTier !== WORKSHOP) return false;
  if (actorTier === CASCADE) {
    // The cascade tier may only ever move a record TO invalidated (or leave
    // it there as a no-op) — it never decides anything else.
    return to === "invalidated";
  }
  if (actorTier === WORKSHOP) {
    // The skill-workshop tier may only ever move a record TO corroborated. It
    // can never grant "trusted", never invalidate, and never pull a record
    // back down; an invalidated record stays out of its reach entirely.
    return to === "corroborated" && from !== "invalidated";
  }
  // actorTier === HUMAN: permissive by design (see plan §3) — every target is
  // legal EXCEPT the four non-self exits from "invalidated". An invalidated
  // record must re-enter at "untrusted" and re-earn its way up; it can never
  // jump straight back to observed/corroborated/trusted/disputed.
  if (from === "invalidated" && to !== "invalidated" && to !== "untrusted") return false;
  return true;
}

/**
 * Pure, side-effect-free trust-state transition builder.
 *
 * Does NOT persist anything — callers use one of the thin persistence
 * adapters (LanceDB: MemoryDB.update(); NEO: the store's append path) to
 * actually write the returned patch. Does NOT call checkAccess() itself
 * either; callers must have already authorized the requester against the
 * target record (checkAccess(ctx, record)) before calling this — see the
 * plan's Authorization section for why this stays a pure function.
 *
 * @param {object} record current record (must carry its existing epistemicStatus, if any)
 * @param {string} nextStatus target status — one of EPISTEMIC_STATUSES
 * @param {object} opts
 * @param {string} opts.actor identity string of the requester (or the cascading destructive op's identity)
 * @param {"human"|"system:tombstone-cascade"|"system:skill-workshop"} [opts.actorTier="human"]
 * @param {string} [opts.reason] human-readable reason
 * @param {string} [opts.evidence] provenance/evidence pointer (e.g. a contradiction id, a memoryId)
 * @param {boolean} [opts.authorized=false] must be true for targets "trusted"/"invalidated" — asserted, not derived
 * @param {number} [opts.now]
 * @returns {{epistemicStatus: string, previousEpistemicStatus: string, epistemicStatusUpdatedAt: number, epistemicStatusActor: string, epistemicStatusReason: string}}
 */
export function transitionEpistemicStatus(record, nextStatus, opts = {}) {
  const actorTier = opts.actorTier || HUMAN;
  const from = normalizeEpistemicStatus(record?.epistemicStatus);
  const to = normalizeEpistemicStatus(nextStatus);

  if (!isLegalEpistemicTransition(from, to, actorTier)) {
    throw new Error(`epistemic-status: illegal transition ${from} -> ${to} for actor tier "${actorTier}"`);
  }
  if ((to === "trusted" || to === "invalidated") && opts.authorized !== true) {
    throw new Error(`epistemic-status: transition to "${to}" requires opts.authorized === true`);
  }
  if (!opts.actor || typeof opts.actor !== "string") {
    throw new Error("epistemic-status: opts.actor is required");
  }

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  return {
    epistemicStatus: to,
    previousEpistemicStatus: from,
    epistemicStatusUpdatedAt: now,
    epistemicStatusActor: opts.actor,
    epistemicStatusReason: opts.reason || "",
  };
}

/**
 * Version-boundary inheritance rule for `lib/safe-update.js`'s
 * `buildUpdateEntry()`. Applies ONLY when the underlying text/summary is
 * actually changing (buildUpdateEntry is only ever called in that case).
 *
 * - disputed/invalidated inherit forward unconditionally (security direction:
 *   an edited invalidated/disputed record must not get a clean slate).
 * - trusted/corroborated collapse to observed (a reworded claim has not
 *   itself been vetted).
 * - untrusted/observed are unaffected.
 *
 * `changed` is deliberately keyed on the NORMALIZED value actually moving —
 * not on whether a raw value was stored. That is what keeps a legacy row
 * (no stored epistemicStatus at all) a true no-op: normalizeEpistemicStatus
 * resolves its absence to "untrusted", and "untrusted" never collapses to
 * anything else, so `changed` is false and the caller must carry the RAW old
 * value forward unchanged (i.e. leave the field absent, not materialize an
 * explicit "untrusted"). This matters because epistemicScoreBoost() treats
 * "absent" (0, neutral) very differently from an explicit "untrusted"
 * (-0.15) — materializing the field on every edit would silently downgrade a
 * legacy memory's recall score the moment someone edits it, breaking that
 * distinction (see plan §4e/§6b, and the review's Auflage A).
 *
 * @param {object} oldRow
 * @returns {{changed: boolean, epistemicStatus: string}} `epistemicStatus` is
 *   only meaningful when `changed` is true; when `changed` is false, callers
 *   must copy the RAW `oldRow.epistemicStatus` forward as-is (do not write
 *   epistemicStatusActor/Reason/UpdatedAt either).
 */
export function collapseEpistemicStatusOnContentChange(oldRow) {
  const current = normalizeEpistemicStatus(oldRow?.epistemicStatus);
  let next = current;
  if (current === "trusted" || current === "corroborated") next = "observed";
  // disputed/invalidated: next stays current (sticky-forward, unconditional)
  // untrusted/observed: next stays current (nothing to collapse)
  return { changed: next !== current, epistemicStatus: next };
}

/**
 * Merge/consolidation rule for `lib/jobs/memory-compaction.js`'s merge action
 * (plan §7b): when two memories are combined into one, the merged record's
 * epistemicStatus is the MORE CONSERVATIVE of the two inputs — never the
 * higher one (a merge must not let a weakly-trusted memory "launder" its way
 * to a higher trust tier just by being combined with a better-trusted one).
 *
 * - invalidated is sticky: if either input is invalidated, the merge result
 *   is invalidated. (Defensive only — loadCompactionCandidates already
 *   excludes invalidated rows from ever reaching a merge action; this is a
 *   second, independent guard against exactly the "explicit
 *   normalizeEpistemicStatus() != raw check" class of bug from Blocker 1.)
 * - disputed is sticky next: if either input is disputed (and neither is
 *   invalidated), the merge result is disputed — an active dispute must not
 *   be quietly resolved by merging it into an undisputed memory.
 * - Otherwise: the lower EPISTEMIC_LADDER position wins (untrusted <
 *   observed < corroborated < trusted).
 *
 * @param {*} rawA raw stored epistemicStatus of the first merge input
 * @param {*} rawB raw stored epistemicStatus of the second merge input
 * @returns {string} one of EPISTEMIC_STATUSES
 */
export function combineEpistemicStatusForMerge(rawA, rawB) {
  const a = normalizeEpistemicStatus(rawA);
  const b = normalizeEpistemicStatus(rawB);
  if (a === "invalidated" || b === "invalidated") return "invalidated";
  if (a === "disputed" || b === "disputed") return "disputed";
  const idxA = EPISTEMIC_LADDER.indexOf(a);
  const idxB = EPISTEMIC_LADDER.indexOf(b);
  return EPISTEMIC_LADDER[Math.min(idxA, idxB)];
}
