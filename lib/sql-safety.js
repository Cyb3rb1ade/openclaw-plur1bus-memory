/**
 * lib/sql-safety.js — Defense-in-depth Helpers für LanceDB-SQL-Strings.
 *
 * LanceDB akzeptiert keine prepared statements (.where/.delete nimmt nur
 * Strings). Daher MÜSSEN alle Stellen, die User-Input in SQL interpolieren,
 * diese Helpers nutzen. Helpers wirft auf invalid input statt silent skip.
 */

import { appendFileSync, existsSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_AGENT_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validiert eine UUID strikt. Wirft bei invalid (Type, Länge, Format).
 * @returns {string} Die validierte UUID (case-preserved)
 */
export function safeUuid(id) {
  if (typeof id !== "string" || id.length !== 36 || !UUID_RE.test(id)) {
    const display = id === undefined ? "undefined" : id === null ? "null" : JSON.stringify(id).slice(0, 80);
    throw new Error(`Invalid memory ID format: ${display}`);
  }
  return id;
}

/**
 * Filtert eine Liste von IDs zu einem SQL-IN-Clause-String.
 * @returns {string|null} z.B. "'id1','id2'" oder null wenn keine valid IDs.
 */
export function safeUuidList(ids, maxItems = 100) {
  if (!Array.isArray(ids)) throw new Error("safeUuidList: not an array");
  const valid = ids.filter(id => typeof id === "string" && id.length === 36 && UUID_RE.test(id));
  if (valid.length === 0) return null;
  return valid.slice(0, maxItems).map(id => `'${id}'`).join(",");
}

/**
 * Validiert einen Agent-ID-String für Dateisystem-Pfade.
 * Wirft bei invalid (Type, Länge, Format, Path-Traversal-Zeichen).
 */
export function safeAgentId(id) {
  if (typeof id !== "string" || !SAFE_AGENT_RE.test(id)) {
    throw new Error(`Invalid agent ID: ${JSON.stringify(id).slice(0, 80)}`);
  }
  return id;
}

/**
 * Validiert einen Timestamp (Date.now()-output). Wirft bei NaN, Infinity,
 * negativ oder unrealistisch groß (>1e15 ≈ Jahr 33658).
 */
export function safeTimestamp(n) {
  if (!Number.isFinite(n) || n < 0 || n > 1e15) {
    throw new Error(`Invalid timestamp: ${n}`);
  }
  return Math.floor(n);
}

/**
 * Escaped einen String für SQL-Literals (LanceDB .where).
 * Ersetzt einfache Quotes durch doppelte Quotes.
 */
export function sqlString(value) {
  if (typeof value !== "string") return "''";
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/**
 * Resolves a path and ensures it stays inside baseDir.
 * Handles non-existent target paths (for new files) by resolving the parent
 * directory and validating the basename.
 *
 * @param {string} baseDir — must exist
 * @param {...string} parts — path segments
 * @returns {string} resolved absolute path
 * @throws if resolved path escapes baseDir or contains unsafe components
 */
export function resolveInside(baseDir, ...parts) {
  if (!baseDir || typeof baseDir !== "string") {
    throw new Error("resolveInside: baseDir must be a non-empty string");
  }
  const realBase = realpathSync(baseDir);
  const target = resolve(realBase, ...parts);

  // For existing paths: check directly
  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(realBase + "/") && realTarget !== realBase) {
      throw new Error(`Path traversal blocked: ${target}`);
    }
    return realTarget;
  }

  // For non-existent paths (new files): resolve parent + validate basename
  const parent = dirname(target);
  const name = basename(target);
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid basename in path: ${target}`);
  }
  const realParent = existsSync(parent) ? realpathSync(parent) : resolve(realBase, dirname(join(...parts)));
  if (!realParent.startsWith(realBase + "/") && realParent !== realBase) {
    throw new Error(`Path traversal blocked (parent): ${target}`);
  }
  return resolve(realParent, name);
}

/**
 * Enum validator for memory status values.
 */
const ALLOWED_STATUSES = new Set(["active", "superseded", "archived", "deleted"]);
export function safeStatus(value) {
  const v = String(value || "").trim();
  if (!ALLOWED_STATUSES.has(v)) {
    throw new Error(`Invalid status: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return v;
}

/**
 * Enum validator for memory type values.
 */
const ALLOWED_TYPES = new Set([
  "", "person", "beziehung", "geburtstag", "geld_konto", "gesundheit",
  "zugang_passwort", "critical", "insight", "task", "project", "note",
  "event", "preference", "goal", "habit", "learning", "decision",
]);
export function safeType(value) {
  const v = String(value || "").trim();
  if (!ALLOWED_TYPES.has(v)) {
    throw new Error(`Invalid type: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return v;
}

/**
 * Audit-Log für destruktive DB-Operationen. Non-blocking, schluckt eigene
 * Fehler — nie Memory-Ops blockieren wenn das Log nicht schreibbar ist.
 */
export function appendDestructiveOpLog(workspaceDir, entry) {
  if (!workspaceDir) return;
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "destructive-ops.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    // Non-blocking but visible — audit-log gaps must not be silent
    console.warn(`[memory-lancedb-namespaced] destructive-ops log write failed: ${e?.message}`);
  }
}
