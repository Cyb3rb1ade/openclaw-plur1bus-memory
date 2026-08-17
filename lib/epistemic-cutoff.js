/**
 * lib/epistemic-cutoff.js — restore-safe cutoff for explicit epistemic writes.
 *
 * Files live next to the tombstone registry, as siblings of baseDbPath:
 *   {dirname(baseDbPath)}/_epistemic/explicit-write-since.json
 *   {dirname(baseDbPath)}/_epistemic/EXPLICIT_WRITES_ENABLED
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonFsync, writeTextFsync } from "./fsync-atomic.js";
import { safeWarn } from "./safe-logging.js";

export const EPISTEMIC_MARKER_DIRNAME = "_epistemic";
export const CUTOFF_FILENAME = "explicit-write-since.json";
export const ENABLED_FILENAME = "EXPLICIT_WRITES_ENABLED";

/**
 * Directory that survives a LanceDB-tree restore.
 * @param {string} baseDbPath
 * @returns {string}
 */
export function epistemicCutoffDir(baseDbPath) {
  return join(dirname(String(baseDbPath || "")), EPISTEMIC_MARKER_DIRNAME);
}

/**
 * @param {string} baseDbPath
 * @returns {string}
 */
export function epistemicCutoffPath(baseDbPath) {
  return join(epistemicCutoffDir(baseDbPath), CUTOFF_FILENAME);
}

/**
 * @param {string} baseDbPath
 * @returns {string}
 */
export function epistemicEnabledPath(baseDbPath) {
  return join(epistemicCutoffDir(baseDbPath), ENABLED_FILENAME);
}

/**
 * Coerce LanceDB int64/BigInt timestamps the same way valid-time does.
 * @param {*} value
 * @returns {number|null}
 */
export function toFiniteMs(value) {
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function parseCutoffFile(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const since = toFiniteMs(raw?.since);
  if (since == null || since <= 0) throw new Error("invalid epistemic cutoff payload");
  return { since, createdAt: toFiniteMs(raw?.createdAt) || since };
}

/**
 * Read the cutoff without creating one.
 * @param {string} baseDbPath
 * @returns {{ok: boolean, since: number, enabled: boolean, legacyOpen: boolean, reason: string}}
 */
export function readEpistemicCutoff(baseDbPath) {
  const cutoffFile = epistemicCutoffPath(baseDbPath);
  const enabledFile = epistemicEnabledPath(baseDbPath);
  const enabled = existsSync(enabledFile);
  try {
    if (!existsSync(cutoffFile)) {
      return {
        ok: false,
        since: 0,
        enabled,
        legacyOpen: false,
        reason: enabled ? "cutoff_missing_after_upgrade" : "cutoff_absent",
      };
    }
    const parsed = parseCutoffFile(cutoffFile);
    return { ok: true, since: parsed.since, enabled, legacyOpen: true, reason: "ok" };
  } catch (error) {
    safeWarn(null, "epistemic-cutoff.read", error);
    return { ok: false, since: 0, enabled, legacyOpen: false, reason: "cutoff_read_error" };
  }
}

/**
 * Create the cutoff only when both marker files are absent. Earliest since wins.
 * @param {string} baseDbPath
 * @param {number} [now]
 * @returns {{ok: boolean, since: number, enabled: boolean, legacyOpen: boolean, reason: string}}
 */
export function ensureEpistemicCutoff(baseDbPath, now = Date.now()) {
  const existing = readEpistemicCutoff(baseDbPath);
  if (existing.ok) return existing;
  if (existing.reason === "cutoff_missing_after_upgrade" || existing.enabled) {
    return { ...existing, legacyOpen: false };
  }
  if (existing.reason === "cutoff_read_error") {
    return { ...existing, legacyOpen: false };
  }
  const since = toFiniteMs(now) || Date.now();
  try {
    const cutoffFile = epistemicCutoffPath(baseDbPath);
    if (existsSync(cutoffFile)) {
      const raced = readEpistemicCutoff(baseDbPath);
      if (raced.ok) return raced;
    }
    writeJsonFsync(cutoffFile, { since, createdAt: since });
    writeTextFsync(epistemicEnabledPath(baseDbPath), "1\n");
    return { ok: true, since, enabled: true, legacyOpen: true, reason: "created" };
  } catch (error) {
    safeWarn(null, "epistemic-cutoff.write", error);
    return { ok: false, since: 0, enabled: false, legacyOpen: false, reason: "cutoff_write_error" };
  }
}

/**
 * Whether createdAt is strictly before the cutoff (legacy window).
 * @param {*} createdAt
 * @param {number} since
 * @returns {boolean}
 */
export function isCreatedAtBeforeCutoff(createdAt, since) {
  const ts = toFiniteMs(createdAt);
  const cut = toFiniteMs(since);
  if (ts == null || cut == null || ts <= 0 || cut <= 0) return false;
  return ts < cut;
}

/**
 * Whether createdAt is at or after the cutoff (post-cutoff empty is illegal).
 * @param {*} createdAt
 * @param {number} since
 * @returns {boolean}
 */
export function isCreatedAtOnOrAfterCutoff(createdAt, since) {
  const ts = toFiniteMs(createdAt);
  const cut = toFiniteMs(since);
  if (ts == null || cut == null || ts <= 0 || cut <= 0) return false;
  return ts >= cut;
}
