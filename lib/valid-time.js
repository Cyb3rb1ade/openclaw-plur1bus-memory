/**
 * lib/valid-time.js — Bi-Temporal Memory (Phase 2).
 *
 * `validFrom`/`validUntil` describe the REAL-WORLD validity window of a
 * claim ("Firma A was true from X until Y"), independent of and orthogonal
 * to two existing, DO-NOT-CONFUSE fields:
 *   - createdAt/updatedAt — System Time: when PLUR1BUS captured/edited the
 *     row, never when the described fact became/stopped being true.
 *   - expiresAt — a hard TTL that REMOVES the row from recall once passed.
 *     validUntil is its semantic opposite: the row stays fully present and
 *     queryable, only the claim is understood to no longer hold after that
 *     point (see lib/recall-pipeline.js's isRecallEntryLive/isEntryValidAt).
 *
 * `0` on either field means "no known bound in that direction" — not the
 * Unix epoch. This mirrors expiresAt's own `0` = "no TTL" convention
 * already load-bearing in this codebase (see plan §1).
 *
 * Historical facts are NOT modeled as version-chain edits (safeUpdate's
 * supersede path) — they are independent, sibling rows, both status:
 * "active". Only the validAt window, evaluated at recall time, decides
 * which row a given query surfaces (see plan §0).
 */

import { safeDebug } from "./safe-logging.js";
import { validateInput } from "./input-limits.js";

const VALID_TIME_INPUT_MAX_LENGTH = 128;

/**
 * Applies the shared bounded-string contract to user-facing Valid-Time tool
 * parameters before any Date parsing, embedding, or database access.
 *
 * @param {object} input tool parameter object
 * @param {string[]} fieldNames Valid-Time field names to validate
 * @returns {{ok: boolean, error?: string}}
 */
export function validateValidTimeInputFields(input = {}, fieldNames = []) {
  for (const fieldName of fieldNames) {
    const result = validateInput(input?.[fieldName], {
      maxLength: VALID_TIME_INPUT_MAX_LENGTH,
      name: fieldName,
    });
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Whether `entry`'s validity window includes `validAt`.
 * Left-inclusive, right-exclusive: `validFrom <= validAt < validUntil`.
 * A `validAt` of `null`/`undefined` means "no temporal query" -> no
 * filtering at all (every entry passes) — this is the mechanism behind
 * "absent validAt => zero validity filtering" (plan §5b).
 *
 * @param {object} entry projected recall entry (or any object carrying validFrom/validUntil)
 * @param {number|bigint|null|undefined} validAt point in time to check, ms epoch
 * @returns {boolean}
 */
export function isEntryValidAt(entry, validAt) {
  if (validAt == null) return true;
  const point = toFiniteMs(validAt);
  if (point === null) return false;
  const { from, until } = knownWindow(entry);
  if (from !== null && point < from) return false;
  if (until !== null && point >= until) return false;
  return true;
}

/**
 * Normalizes a caller-supplied timestamp (ISO date string, ms number, or
 * unparseable/absent value) to a validated ms-epoch integer, or `0` if the
 * value is missing/unparseable. Never throws — this is optional, best-effort
 * provenance on an untrusted LLM tool call, not a SQL-bound identifier; a bad
 * value must degrade to "unknown", never abort the caller.
 *
 * Deliberately more lenient than lib/sql-safety.js's safeTimestamp() (which
 * throws) for exactly that reason.
 *
 * @param {*} value raw caller-supplied value (string/number/null/undefined)
 * @param {{logger?: object}} [opts]
 * @returns {number} ms epoch, or 0 if unknown/unparseable
 */
export function normalizeCapturedTimestamp(value, { logger } = {}) {
  if (value == null || value === "" || value === "unknown") return 0;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms) || ms <= 0 || ms > 1e15) {
    safeDebug(logger, "valid-time.normalizeCapturedTimestamp", new Error(`unparseable value: ${value}`));
    return 0;
  }
  return Math.floor(ms);
}

/**
 * Normalizes a caller-supplied validity window as one atomic value. Missing
 * or unparseable directions retain the existing `0` sentinel semantics. If
 * both bounds are known but do not form a non-empty forward interval, both
 * degrade to unknown so an impossible window is never persisted.
 *
 * @param {{validFrom?: *, validUntil?: *}} input raw caller-supplied bounds
 * @param {{logger?: object}} [opts]
 * @returns {{validFrom: number, validUntil: number}}
 */
export function normalizeCapturedValidityWindow(input = {}, { logger } = {}) {
  const validFrom = normalizeCapturedTimestamp(input?.validFrom, { logger });
  const validUntil = normalizeCapturedTimestamp(input?.validUntil, { logger });
  if (validFrom !== 0 && validUntil !== 0 && validFrom >= validUntil) {
    safeDebug(logger, "valid-time.normalizeCapturedValidityWindow", new Error("inverted or empty validity window; degrading both bounds to unknown"));
    return { validFrom: 0, validUntil: 0 };
  }
  return { validFrom, validUntil };
}

/**
 * Coerces a validFrom/validUntil field to a safe-integer Number, or null if it
 * isn't one. LanceDB returns int64 columns as native BigInt in JS (see
 * MemoryDB.getById/findMergeCandidate) — Number.isFinite(bigint) is ALWAYS
 * false, so a bare `Number.isFinite(entry.validFrom)` check silently treats
 * every real, non-zero, DB-backed validFrom/validUntil as "unknown". Coerce
 * first, then check finiteness on the coerced Number.
 *
 * @param {*} value
 * @returns {number|null}
 */
function toFiniteMs(value) {
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Resolves an entry's known validity bounds, mapping the `0` = "unknown"
 * sentinel to `null` for internal comparison purposes only (never exposed
 * to callers as a stored/serialized value).
 *
 * @param {object} entry
 * @returns {{from: number|null, until: number|null}}
 */
function knownWindow(entry) {
  const rawFrom = toFiniteMs(entry?.validFrom);
  const rawUntil = toFiniteMs(entry?.validUntil);
  const from = rawFrom !== null && rawFrom > 0 ? rawFrom : null;
  const until = rawUntil !== null && rawUntil > 0 ? rawUntil : null;
  return { from, until };
}

/**
 * True only when both sides have at least one known bound AND those known
 * bounds prove the windows cannot overlap. Never fires on "both silent" —
 * an unknown bound is not evidence of disjointness, only silence.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function hasDisjointValidityWindows(a, b) {
  const wa = knownWindow(a);
  const wb = knownWindow(b);
  if (wa.from === null && wa.until === null) return false;
  if (wb.from === null && wb.until === null) return false;
  if (wa.until !== null && wb.from !== null && wa.until <= wb.from) return true;
  if (wb.until !== null && wa.from !== null && wb.until <= wa.from) return true;
  return false;
}

/**
 * Conservative union of two merge-compatible validity windows. A missing
 * lower bound means the union remains unknown toward the past; a missing
 * upper bound means it remains open/unknown toward the future. A direction
 * is bounded only when both sources bound it.
 *
 * @param {object} a
 * @param {object} b
 * @returns {{validFrom: number, validUntil: number}}
 */
export function combineValidTimeForMerge(a, b) {
  const wa = knownWindow(a);
  const wb = knownWindow(b);
  return {
    validFrom: wa.from !== null && wb.from !== null ? Math.min(wa.from, wb.from) : 0,
    validUntil: wa.until !== null && wb.until !== null ? Math.max(wa.until, wb.until) : 0,
  };
}

/**
 * Pure, side-effect-free builder for closing an existing row's validity
 * window with a real, asserted boundary — NOT a version-chain edit (see
 * plan §0/§7a). Refuses an unknown (`0`) validUntil: the function that
 * closes a window cannot be called with "I don't know when", only with a
 * real value the caller asserts. Refuses an inverted interval.
 *
 * @param {object} record current record (must carry its existing validFrom, if any)
 * @param {{validUntil: *, actor: string, reason?: string, now?: number}} opts
 * @returns {{validUntil: number}}
 */
export function buildValidTimeClosePatch(record, { validUntil, actor, reason, now = Date.now() } = {}) {
  if (!actor || typeof actor !== "string") {
    throw new Error("valid-time: actor is required");
  }
  const parsed = normalizeCapturedTimestamp(validUntil);
  if (parsed === 0) {
    throw new Error("valid-time: validUntil must be a real, parseable timestamp — refuse to close with an unknown boundary");
  }
  const from = record?.validFrom || 0;
  if (from !== 0 && parsed <= from) {
    throw new Error(`valid-time: validUntil (${parsed}) must be after validFrom (${from})`);
  }
  return { validUntil: parsed };
}
