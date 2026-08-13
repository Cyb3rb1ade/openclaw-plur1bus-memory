/**
 * lib/tombstone.js — kanonischer Tombstone-Vertrag für PLUR1BUS.
 *
 * Ein `/forget` entfernt eine Erinnerung NICHT physisch. Stattdessen wird die
 * LanceDB-Zeile soft-deleted (`status="deleted"`, `epistemicStatus="invalidated"`)
 * und ein dauerhafter, versionierter Tombstone persistiert:
 *
 *   - in-place als `tombstone`-JSON-Spalte auf der gelöschten Zeile, und
 *   - zusätzlich in einer append-only JSONL-Registry (überlebt Restore,
 *     Migration und Re-Embedding und ist per Content-Fingerprint abfragbar).
 *
 * Der Tombstone dupliziert niemals sensible Inhalte — er speichert nur
 * normalisierte Fingerprints statt Klartext.
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeAgentId, safeUuid } from "./sql-safety.js";

export const TOMBSTONE_SCHEMA_VERSION = 1;

export const TOMBSTONE_SOURCE_OPS = Object.freeze([
  "forget",
  "memory_forget",
  "obsidian_tombstone",
  "neo_tombstone",
  "migration_reconstruction",
  "restore",
]);

export const TOMBSTONE_STATUSES = Object.freeze(["attempted", "committed", "failed"]);

/**
 * Normalisiert Text für einen stabilen Content-Fingerprint. Konservativ:
 * nur NFKC + lowercase + Whitespace-Kollaps — erlaubt exakte, normalisierte
 * Übereinstimmung ohne semantische Aggressivität.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeContentForFingerprint(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * SHA-256-Fingerprint des normalisierten Inhalts.
 *
 * @param {string} text
 * @returns {string} 64-stelliger Hex-String.
 */
export function contentFingerprint(text) {
  return createHash("sha256").update(normalizeContentForFingerprint(text)).digest("hex");
}

/**
 * Stabile kanonische Ursprungs-ID einer Karte.
 *
 * @param {object} card
 * @returns {string}
 */
export function resolveCanonicalOriginId(card = {}) {
  return String(card?.canonicalOriginId || card?.id || "");
}

/**
 * Baut einen kanonischen Tombstone aus einer Karte + Löschkontext.
 * Speichert ausschließlich Fingerprints, nie Klartext.
 *
 * @param {object} args
 * @returns {object}
 */
export function buildTombstone({
  card,
  agentId,
  actor,
  actorType = "human",
  reason = "",
  sourceOp = "forget",
  archiveRef = "",
  previousVersion = "",
  refs = {},
  deletedAt = new Date().toISOString(),
}) {
  const safeAgent = safeAgentId(agentId || "default");
  const memoryId = safeUuid(card?.id);
  const content = String(card?.text || card?.summary || "");
  return {
    schemaVersion: TOMBSTONE_SCHEMA_VERSION,
    tombstoneId: randomUUID(),
    memoryId,
    canonicalOriginId: resolveCanonicalOriginId(card),
    agentId: safeAgent,
    scope: String(card?.scope || "agent-private"),
    workspaceId: String(card?.workspaceId || card?.workspaceKey || ""),
    workspaceKey: String(card?.workspaceKey || ""),
    ownerUserId: String(card?.ownerUserId || ""),
    storedBy: String(card?.storedBy || ""),
    deletedAt,
    actor: String(actor || ""),
    actorType: String(actorType || "human"),
    reason: String(reason || "").slice(0, 500),
    sourceOp,
    archiveRef: String(archiveRef || ""),
    previousVersion: String(previousVersion || ""),
    contentFingerprint: content ? contentFingerprint(content) : "",
    sourceFingerprint: String(card?.sourceTurnId || card?.evidenceQuote || "")
      ? createHash("sha256").update(String(card?.sourceTurnId || card?.evidenceQuote || "")).digest("hex")
      : "",
    refs: refs && typeof refs === "object" ? refs : {},
    status: "committed",
  };
}

/**
 * Prüft, ob ein Tombstone die Speicherung einer gleichlautenden Erinnerung im
 * selben autorisierten Scope blockiert. Scope-gebunden: ein Tombstone aus
 * Agent A / Workspace W / User U blockiert nur genau diesen Scope.
 *
 * @param {object} tombstone
 * @param {object} ctx — { agentId, scope, workspaceIdentity, ownerUserId }
 * @returns {boolean}
 */
export function tombstoneBlocksCapture(tombstone = {}, ctx = {}) {
  if (!tombstone || tombstone.status === "failed") return false;
  if (String(tombstone.agentId || "") !== String(ctx?.agentId || "")) return false;
  const scope = String(tombstone.scope || "agent-private");
  if (scope === "agent-private") return true;
  if (scope === "workspace") {
    const tombWorkspace = tombstone.workspaceId || tombstone.workspaceKey || "";
    const ctxWorkspace = ctx?.workspaceIdentity || ctx?.workspaceKey || "";
    return Boolean(tombWorkspace) && tombWorkspace === ctxWorkspace;
  }
  if (scope === "user") {
    const tombUser = tombstone.ownerUserId || "";
    const ctxUser = ctx?.ownerUserId || ctx?.userPrincipal || "";
    return Boolean(tombUser) && tombUser === ctxUser;
  }
  // Unbekannter Scope → fail-closed blockieren (konservativ).
  return true;
}

/**
 * Prüft die Tombstone-Registry auf einen committed Tombstone, der eine
 * gleichlautende Neuerfassung im selben Scope blockiert.
 *
 * @param {string} baseDbPath
 * @param {object} opts — { agentId, text, scope, workspaceIdentity, ownerUserId }
 * @returns {object|null} Blockierender Tombstone oder null.
 */
export function findBlockingTombstoneForCapture(baseDbPath, opts = {}) {
  const text = String(opts?.text || "");
  if (!text) return null;
  const fingerprint = contentFingerprint(text);
  const tombstone = findTombstoneByFingerprint(baseDbPath, opts?.agentId, fingerprint);
  if (!tombstone) return null;
  return tombstoneBlocksCapture(tombstone, opts) ? tombstone : null;
}

// ─── Append-only Registry ──────────────────────────────────────────────────

/**
 * Registry-Verzeichnis: Geschwister des LanceDB-Stammverzeichnisses, damit ein
 * Snapshot-Restore (rm+cp des lancedb-namespaced) die Registry nicht löscht.
 *
 * @param {string} baseDbPath
 * @returns {string}
 */
export function tombstoneRegistryDir(baseDbPath) {
  return join(dirname(String(baseDbPath || "")), "_tombstones");
}

function registryFile(baseDbPath, agentId) {
  const safeAgent = safeAgentId(agentId);
  return join(tombstoneRegistryDir(baseDbPath), `${safeAgent}.jsonl`);
}

/**
 * Hängt einen Tombstone atomar an die append-only Registry an.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {object} tombstone
 * @returns {string} Pfad der Registry-Datei.
 */
export function appendTombstoneToRegistry(baseDbPath, agentId, tombstone) {
  const dir = tombstoneRegistryDir(baseDbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = registryFile(baseDbPath, agentId);
  // O_APPEND-Schreibweise: für gleichzeitige Appends einzelner JSON-Zeilen sicher.
  appendFileSync(file, `${JSON.stringify(tombstone)}\n`, "utf8");
  return file;
}

/**
 * Liest alle Tombstones eines Agents aus der Registry (idempotent, ohne Dedup).
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {Array<object>}
 */
export function readTombstonesFromRegistry(baseDbPath, agentId) {
  const file = registryFile(baseDbPath, agentId);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.schemaVersion) out.push(parsed);
      } catch { /* skip corrupt line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Findet den neuesten committed Tombstone für eine kanonische Ursprungs-ID.
 * Nur "committed" blockiert Capture — "attempted" ohne Commit ist keine Löschung.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {string} originId
 * @returns {object|null}
 */
export function findTombstoneByOriginId(baseDbPath, agentId, originId) {
  const list = readTombstonesFromRegistry(baseDbPath, agentId)
    .filter((t) => t.status === "committed");
  const matches = list.filter((t) => t.canonicalOriginId === originId || t.memoryId === originId);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Findet den neuesten committed Tombstone für einen Content-Fingerprint.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {string} fingerprint
 * @returns {object|null}
 */
export function findTombstoneByFingerprint(baseDbPath, agentId, fingerprint) {
  const list = readTombstonesFromRegistry(baseDbPath, agentId)
    .filter((t) => t.status === "committed");
  const matches = list.filter((t) => t.contentFingerprint && t.contentFingerprint === fingerprint);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}
