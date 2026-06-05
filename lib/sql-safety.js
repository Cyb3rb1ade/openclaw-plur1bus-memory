/**
 * lib/sql-safety.js — Defense-in-depth Helpers für LanceDB-SQL-Strings.
 *
 * LanceDB akzeptiert keine prepared statements (.where/.delete nimmt nur
 * Strings). Daher MÜSSEN alle Stellen, die User-Input in SQL interpolieren,
 * diese Helpers nutzen. Helpers wirft auf invalid input statt silent skip.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validiert eine UUID strikt. Wirft bei invalid (Type, Länge, Format).
 * @returns {string} Die validierte UUID (case-preserved)
 */
export function safeUuid(id) {
  if (typeof id !== "string" || id.length !== 36 || !UUID_RE.test(id)) {
    throw new Error(`Invalid memory ID format: ${JSON.stringify(id).slice(0, 80)}`);
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
  return "'" + value.replace(/'/g, "''") + "'";
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
