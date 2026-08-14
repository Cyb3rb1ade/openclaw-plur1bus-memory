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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, appendFileSync, truncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeAgentId, safeUuid } from "./sql-safety.js";
import { withRegistryLock } from "./registry-lock.js";

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
    contentFingerprint: contentFingerprint(content),
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
  const ctxScope = String(ctx?.scope || "agent-private");
  if (scope === "agent-private") {
    // Exakte Scope-Typ-Bindung: agent-private blockiert NUR agent-private.
    return ctxScope === "agent-private";
  }
  if (scope === "workspace") {
    if (ctxScope !== "workspace") return false;
    const tombWorkspace = tombstone.workspaceId || tombstone.workspaceKey || "";
    const ctxWorkspace = ctx?.workspaceIdentity || ctx?.workspaceKey || "";
    return Boolean(tombWorkspace) && tombWorkspace === ctxWorkspace;
  }
  if (scope === "user") {
    if (ctxScope !== "user") return false;
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
 * Fail-closed: Lesefehler oder beschädigte JSONL-Zeilen werden NICHT als
 * „kein Tombstone vorhanden" interpretiert, sondern blockieren konservativ
 * (die Referenz wird mit `_blockReason` diagnostiziert zurückgegeben).
 *
 * Es werden ALLE committed Tombstones mit passendem Fingerprint geprüft,
 * nicht nur der global neueste — ein Workspace-Tombstone darf nicht durch einen
 * späteren agent-private-Tombstone „verdeckt" werden.
 *
 * @param {string} baseDbPath
 * @param {object} opts — { agentId, text, scope, workspaceIdentity, ownerUserId }
 * @returns {object|null} Blockierender Tombstone oder null.
 */
export function findBlockingTombstoneForCapture(baseDbPath, opts = {}) {
  const text = String(opts?.text || "");
  if (!text) return null;
  const agentId = opts?.agentId || "";
  const result = readTombstoneRegistry(baseDbPath, agentId);
  if (!result.ok) {
    return {
      schemaVersion: TOMBSTONE_SCHEMA_VERSION,
      memoryId: "",
      canonicalOriginId: "",
      agentId,
      scope: "agent-private",
      status: "committed",
      contentFingerprint: "",
      _blockReason: "registry_read_error",
      _diagnostic: result.readError,
    };
  }
  if (result.corruptLines > 0) {
    return {
      schemaVersion: TOMBSTONE_SCHEMA_VERSION,
      memoryId: "",
      canonicalOriginId: "",
      agentId,
      scope: "agent-private",
      status: "committed",
      contentFingerprint: "",
      _blockReason: "registry_corrupt_lines",
      // Aufgeschlüsselt, damit ein künftiger Schema-Bump (vollständiges JSON,
      // das die Validierung nicht besteht) an einer Logzeile erkennbar ist und
      // nicht wie eine kaputte Datei aussieht.
      _diagnostic: `corrupt lines: ${result.corruptLines}`
        + ` (unparseable: ${result.corruptDetail?.unparseable ?? 0},`
        + ` invalid: ${result.corruptDetail?.invalid ?? 0})`,
    };
  }
  const fingerprint = contentFingerprint(text);
  const matches = result.tombstones.filter(
    (t) => t.status === "committed" && t.contentFingerprint && t.contentFingerprint === fingerprint,
  );
  for (const tombstone of matches) {
    if (tombstoneBlocksCapture(tombstone, opts)) return tombstone;
  }
  return null;
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
 * Ablage für beweissicher ausgelagerte Fragmente abgebrochener Appends.
 *
 * Endet BEWUSST nicht auf `.jsonl`: `reapply-tombstones.mjs` leitet die
 * Agent-Liste aus den Dateinamen im Registry-Verzeichnis ab und würde sonst
 * einen Phantom-Agenten `<agent>.corrupt` erfinden und das Restore
 * fail-closed abbrechen.
 *
 * @param {string} registryPath Pfad der zugehörigen `<agent>.jsonl`.
 * @returns {string}
 */
export function quarantineFileForRegistry(registryPath) {
  return `${String(registryPath).slice(0, -".jsonl".length)}.corrupt.log`;
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
  // Unter demselben Lock wie die Torn-Tail-Reparatur: endet die Datei auf einem
  // abgebrochenen Append, würde ein blindes O_APPEND die neue Zeile an das
  // Fragment kleben und damit aus einem reparierbaren Rest echte Korruption
  // machen. Erst auslagern, dann anhängen.
  withRegistryLock(`${file}.lock`, () => {
    if (existsSync(file)) repairTornTailLocked(file, safeAgentId(agentId));
    appendFileSync(file, `${JSON.stringify(tombstone)}\n`, "utf8");
  });
  return file;
}

/**
 * Liest alle Tombstones eines Agents aus der Registry.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {Array<object>}
 * @throws {Error} bei Lesefehler (fail-closed — Caller dürfen dies nicht als
 *   „leere Registry" interpretieren).
 */
export function readTombstonesFromRegistry(baseDbPath, agentId, opts = {}) {
  const result = readTombstoneRegistry(baseDbPath, agentId, opts);
  if (!result.ok) {
    throw new Error(`tombstone registry read failed for agent '${agentId}': ${result.readError}`);
  }
  if (result.corruptLines > 0) {
    throw new Error(`tombstone registry has ${result.corruptLines} corrupt line(s) for agent '${agentId}'`);
  }
  return result.tombstones;
}

/**
 * Strukturiertes Lesen der Tombstone-Registry. Unterscheidet explizit zwischen
 * „leer/ok", „Lesefehler" und „beschädigte Zeilen" — damit sicherheitsrelevante
 * Pfade konservativ blockieren statt still „kein Tombstone" anzunehmen.
 *
 * ACHTUNG: schreibt im Normalfall. Ein echter abgebrochener Append am Dateiende
 * wird ausgelagert und die Datei gekürzt (siehe repairTornTail). Read-only-
 * Aufrufer setzen `{ repairTornTail: false }` und bekommen den Tail stattdessen
 * als beschädigte Zeile gemeldet.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {{repairTornTail?: boolean}} [opts]
 * @returns {{ok: boolean, tombstones: Array<object>, corruptLines: number, corruptDetail?: object, readError: string|null}}
 */
export function readTombstoneRegistry(baseDbPath, agentId, opts = {}) {
  const file = registryFile(baseDbPath, agentId);
  if (!existsSync(file)) {
    return { ok: true, tombstones: [], corruptLines: 0, readError: null };
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, tombstones: [], corruptLines: 0, readError: err?.message || String(err) };
  }

  const classified = classifyRegistryText(text, agentId);
  if (!classified.tornTail) return toRegistryResult(classified);

  // Read-only-Aufrufer (z. B. der Dry-Run von reapply-tombstones.mjs) dürfen
  // die Registry nicht verändern — sie sehen den Tail als Korruption und
  // melden ihn, statt ihn stillschweigend zu reparieren.
  if (opts.repairTornTail === false) {
    return {
      ok: true,
      tombstones: classified.tombstones,
      corruptLines: classified.corruptLines + 1,
      corruptDetail: { ...classified.corruptDetail, tornTail: 1 },
      readError: null,
    };
  }

  // Echter abgebrochener Append: beweissicher quarantänieren, Registry kürzen,
  // danach vollständig neu validieren. Jeder Fehlschlag bleibt fail-closed.
  const repair = repairTornTail(file, agentId);
  if (!repair.ok) {
    return { ok: false, tombstones: [], corruptLines: 0, readError: `torn-tail repair failed: ${repair.error}` };
  }
  let repaired;
  try {
    repaired = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, tombstones: [], corruptLines: 0, readError: err?.message || String(err) };
  }
  const revalidated = classifyRegistryText(repaired, agentId);
  // Nach der Reparatur darf kein Rest bleiben — sonst konservativ blockieren.
  if (revalidated.tornTail) {
    return { ok: false, tombstones: [], corruptLines: 0, readError: "torn-tail persisted after repair" };
  }
  return toRegistryResult(revalidated);
}

function toRegistryResult(classified) {
  return {
    ok: true,
    tombstones: classified.tombstones,
    corruptLines: classified.corruptLines,
    corruptDetail: classified.corruptDetail,
    readError: null,
  };
}

/**
 * Zerlegt den Rohinhalt einer Registry-Datei in gültige Tombstones, beschädigte
 * Zeilen und — höchstens — einen abgebrochenen Append am Dateiende.
 *
 * Als `tornTail` gilt ausschließlich: die LETZTE physische Zeile, ohne
 * abschließendes `\n`, syntaktisch unvollständiges JSON, bei ansonsten
 * vollständig gültiger Datei. Eine syntaktisch vollständige, aber semantisch
 * ungültige letzte Zeile ist KEIN torn write (der Schreibvorgang war fertig) —
 * ebensowenig eine beschädigte Zeile mit abschließendem Newline.
 *
 * @param {string} text
 * @param {string} agentId
 * @returns {{tombstones: Array<object>, corruptLines: number, corruptDetail: object, tornTail: {fragment: string, validLength: number}|null}}
 */
function classifyRegistryText(text, agentId) {
  const endsWithNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (endsWithNewline) rawLines.pop();

  const tombstones = [];
  let corruptLines = 0;
  // Getrennt gezählt, damit ein künftiger Schema-Bump (vollständiges JSON, das
  // die Validierung nicht besteht) in einer Logzeile erkennbar ist statt als
  // Rätsel — er blockiert weiterhin, siehe isValidTombstone.
  const corruptDetail = { unparseable: 0, invalid: 0 };
  let tornTail = null;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    const isLast = i === rawLines.length - 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isLast && !endsWithNewline && corruptLines === 0) {
        tornTail = { fragment: line, validLength: Buffer.byteLength(text, "utf8") - Buffer.byteLength(line, "utf8") };
        continue;
      }
      corruptLines += 1;
      corruptDetail.unparseable += 1;
      continue;
    }
    if (isValidTombstone(parsed, agentId)) tombstones.push(parsed);
    else {
      corruptLines += 1;
      corruptDetail.invalid += 1;
    }
  }

  // Kein nachträgliches Entwerten nötig: `tornTail` wird nur in der letzten
  // Iteration und nur bei corruptLines === 0 gesetzt — eine beschädigte Zeile
  // weiter vorn verhindert die Tail-Toleranz also bereits an Ort und Stelle.
  return { tombstones, corruptLines, corruptDetail, tornTail };
}

/**
 * Quarantäniert einen abgebrochenen Append unter Lock: Fragment beweissicher
 * nach `<agent>.corrupt.jsonl`, dann die Registry auf die letzte gültige Länge
 * kürzen. Gekürzt wird per `truncate` (nicht rename) — der Inode bleibt
 * erhalten, damit ein paralleler O_APPEND-Deskriptor nicht ins Leere schreibt.
 *
 * Innerhalb des Locks wird frisch gelesen; ist der Tail inzwischen weg (anderer
 * Prozess war schneller, oder ein Append hat die Zeile vervollständigt), ist der
 * Aufruf ein No-op — dadurch ist die Reparatur idempotent.
 *
 * @returns {{ok: boolean, repaired?: boolean, error?: string}}
 */
function repairTornTail(file, agentId) {
  try {
    return withRegistryLock(`${file}.lock`, () => ({ ok: true, repaired: repairTornTailLocked(file, agentId) }));
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Kern der Reparatur — setzt voraus, dass der Registry-Lock bereits gehalten
 * wird. Wirft bei jedem Fehlschlag (der Aufrufer bleibt damit fail-closed).
 *
 * @returns {boolean} true, wenn tatsächlich ein Fragment ausgelagert wurde.
 */
function repairTornTailLocked(file, agentId) {
  const fresh = readFileSync(file, "utf8");
  const classified = classifyRegistryText(fresh, agentId);
  if (!classified.tornTail) return false;

  const { fragment, validLength } = classified.tornTail;
  const fd = openSync(quarantineFileForRegistry(file), "a");
  try {
    writeSync(fd, `${fragment}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  truncateSync(file, validLength);
  return true;
}

const VALID_SCOPES = new Set(["agent-private", "workspace", "user"]);
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Vollständige Schema-/Enum-/UUID-/Principal-Validierung einer Tombstone-Zeile.
 * Eine Zeile mit nur `schemaVersion` (ohne memoryId/agentId/scope/status) gilt
 * als beschädigt und wird nicht akzeptiert.
 *
 * @param {object} parsed
 * @param {string} [expectedAgentId] Der Agent der gelesenen Registry-Datei —
 *   `parsed.agentId` muss exakt übereinstimmen (Registry-Agent-Bindung).
 * @returns {boolean}
 */
export function isValidTombstone(parsed, expectedAgentId = null) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.schemaVersion !== TOMBSTONE_SCHEMA_VERSION) return false;
  if (typeof parsed.memoryId !== "string") return false;
  try { safeUuid(parsed.memoryId); } catch { return false; }
  if (typeof parsed.agentId !== "string") return false;
  try { safeAgentId(parsed.agentId); } catch { return false; }
  // Registry-Agent-Bindung: die Zeile gehört exakt zum Agenten der Datei.
  if (expectedAgentId !== null && parsed.agentId !== expectedAgentId) return false;
  if (!VALID_SCOPES.has(parsed.scope)) return false;
  // Principal-Bindung: getrimmter, nicht leerer STRING (kein Typ-/Whitespace-Bypass).
  if (parsed.scope === "workspace"
    && !nonEmptyString(parsed.workspaceId)
    && !nonEmptyString(parsed.workspaceKey)) {
    return false;
  }
  if (parsed.scope === "user" && !nonEmptyString(parsed.ownerUserId)) return false;
  if (!TOMBSTONE_STATUSES.includes(parsed.status)) return false;
  if (typeof parsed.contentFingerprint !== "string") return false;
  if (!FINGERPRINT_RE.test(parsed.contentFingerprint)) return false;
  return true;
}

/**
 * Findet den neuesten committed Tombstone für eine kanonische Ursprungs-ID.
 * Nur "committed" blockiert Capture — "attempted" ohne Commit ist keine Löschung.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {string} originId
 * @returns {object|null}
 * @throws {Error} bei Registry-Lesefehler.
 */
export function findTombstoneByOriginId(baseDbPath, agentId, originId, opts = {}) {
  const list = readTombstonesFromRegistry(baseDbPath, agentId, opts)
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
 * @throws {Error} bei Registry-Lesefehler.
 */
export function findTombstoneByFingerprint(baseDbPath, agentId, fingerprint) {
  const list = readTombstonesFromRegistry(baseDbPath, agentId)
    .filter((t) => t.status === "committed");
  const matches = list.filter((t) => t.contentFingerprint && t.contentFingerprint === fingerprint);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Stellt sicher, dass für eine bereits soft-deleted Karte ein committed Tombstone
 * existiert (Crash-Recovery/Idempotenz). Existiert bereits einer, wird nichts
 * angehängt; andernfalls wird ein committed Tombstone nachgetragen.
 *
 * @param {string} baseDbPath
 * @param {object} card
 * @param {object} args — { agentId, actor, actorType, reason, sourceOp, archiveRef, previousVersion }
 * @returns {{alreadyCommitted: boolean, tombstone: object}}
 * @throws {Error} bei Registry-Lesefehler (fail-closed).
 */
export function backfillCommittedTombstone(baseDbPath, card, args = {}) {
  const agentId = args.agentId || "default";
  const existing = findTombstoneByOriginId(baseDbPath, agentId, String(card?.id || ""));
  if (existing) return { alreadyCommitted: true, tombstone: existing };
  const tombstone = buildTombstone({
    card,
    agentId,
    actor: args.actor,
    actorType: args.actorType,
    reason: args.reason,
    sourceOp: args.sourceOp,
    archiveRef: args.archiveRef,
    previousVersion: args.previousVersion,
  });
  appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "committed" });
  return { alreadyCommitted: false, tombstone };
}
