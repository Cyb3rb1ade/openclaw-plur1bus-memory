/**
 * lib/db-adapter.js — dünner Wrapper um LanceDB für Telegram-Commands.
 *
 * Stellt eine kleine API für Memory-Inspektion und -Korrektur bereit:
 *   - queryByTimeRange(agent, range) → Array<{title, source, date, id}>
 *   - searchByTopic(agent, topic, opts) → Array<{id, title, score, ...}>
 *   - getCard(agent, id) → Card | null
 *   - deleteCard(agent, id) → { ok, id }
 *   - updateCard(agent, id, newContent) → { ok, id }
 *
 * Hinweis: Diese Operationen greifen auf die bestehende "memories"-Tabelle
 * (LanceDB) zu, die in MemoryDB (siehe index.js) verwaltet wird. Ein
 * separates "memory-cards"-Schema gibt es noch nicht — Phase 4.7 baut die
 * Card-Tabelle. Bis dahin werden die "memories"-Rows als Karten interpretiert,
 * indem `text`/`summary` → title gemappt wird.
 *
 * Wenn die Tabelle nicht erreichbar ist (Embedder fehlt / Plugin disabled),
 * geben Read-Operationen `[]` zurück. Schreib-Operationen werfen einen
 * descriptiven Error — der Caller fängt ihn und gibt eine User-Nachricht aus.
 */

import { buildWhereClause } from "./filter-parser.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeUuid, safeUuidList, safeAgentId, safeStatus, safeType as validateType, safeTimestamp } from "./sql-safety.js";
import { safeWarn } from "./safe-logging.js";
import { makeBoundedCache } from "./bounded-cache.js";
import { checkAccess, logAclViolation } from "./acl-middleware.js";
import { withTimeout, TimeoutError } from "./with-timeout.js";
import { normalizeEpistemicStatus } from "./epistemic-status.js";

// Re-export for callers/tests that want to distinguish timeout errors.
export { TimeoutError };

// Konsistent mit index.js
const DEFAULT_BASE_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const TABLE_NAME = "memories";

// Konservative Operation-Level-Timeouts (P0 Performance-Audit K3).
// Read-Ops (query/vectorSearch/countRows) bekommen 30s (2026-08-03: von 10s
// erhöht — findRecentUnclassified/classify-recent lief unter LanceDB-Last
// wiederkehrend in den 10s-Timeout, siehe db-adapter.findRecentUnclassified
// Fehler "timed out after 10000ms" in main/bernhardine-Cron-Logs 2026-08-02).
// Write-Ops (add/delete/update) bekommen 25s — 15s reichten unter LanceDB-Last
// nicht, memory_store lief regelmäßig in den Timeout.
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_TIMEOUT_MS = 25_000;

/**
 * Berechnet ISO-Cutoff-Timestamp (ms) für eine Range-Beschreibung.
 *
 * Unterstützte Ranges:
 *   - "today" → Anfang heute (00:00 lokal)
 *   - "yesterday" → Anfang gestern bis Anfang heute
 *   - "this_week" → letzte 7 Tage rollend
 *   - "this_month" → letzte 30 Tage rollend
 *   - "month:Januar" / "month:Mai" → Anfang des benannten Monats im aktuellen Jahr
 */
export function computeCutoff(range, now = Date.now()) {
  const d = new Date(now);
  if (range === "today") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { from: start, to: now };
  }
  if (range === "yesterday") {
    const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { from: startToday - 86400000, to: startToday };
  }
  if (range === "this_week") {
    return { from: now - 7 * 86400000, to: now };
  }
  if (range === "this_month") {
    return { from: now - 30 * 86400000, to: now };
  }
  if (range && range.startsWith("month:")) {
    const monthName = range.slice("month:".length).toLowerCase();
    const months = {
      januar: 0, februar: 1, märz: 2, maerz: 2, april: 3, mai: 4, juni: 5,
      juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11,
    };
    const idx = months[monthName];
    if (idx === undefined) return { from: 0, to: now };
    const year = d.getFullYear();
    const start = new Date(year, idx, 1).getTime();
    const end = new Date(year, idx + 1, 1).getTime();
    return { from: start, to: Math.min(end, now) };
  }
  // Default: letzte 7 Tage
  return { from: now - 7 * 86400000, to: now };
}

/**
 * Mappt einen LanceDB-Row aus der `memories`-Tabelle auf ein Card-ähnliches
 * Objekt, das die Telegram-Commands erwarten.
 */
function rowToCard(row) {
  if (!row) return null;
  const agentId = row.agentId || "";
  const workspaceId = row.workspaceId || "";
  const ownerUserId = row.ownerUserId || "";
  const created = row.createdAt
    ? new Date(Number(row.createdAt)).toISOString().slice(0, 10)
    : "";
  const summary = row.summary || row.text || "";
  const title = (summary || "").split("\n")[0].slice(0, 80) || "(ohne Titel)";
  const sourceMap = {
    dm: "konversation",
    group: "gruppe",
    voice: "sprachnotiz",
    note: "notiz",
  };
  const source = sourceMap[row.origin] || row.origin || "notiz";
  return {
    id: row.id,
    title,
    source,
    date: created,
    text: row.text || "",
    summary: row.summary || "",
    createdAt: row.createdAt || 0,
    origin: row.origin || "dm",
    category: row.category || "other",
    type: row.type || "",
    memoryClass: row.memoryClass || "standard",
    neverForget: row.neverForget ?? 0,
    importance: row.importance ?? 0,
    coreMemoryScore: row.coreMemoryScore ?? 0.0,
    coreMemoryReason: row.coreMemoryReason || "",
    scope: row.scope || "agent-private",
    ownerUserId,
    agentId,
    workspaceId,
    storedBy: row.storedBy || "",
    workspaceKey: row.workspaceKey || "",
    sourceMessageRole: row.sourceMessageRole || "",
    epistemicStatus: row.epistemicStatus || "",
    validFrom: row.validFrom ?? 0,
    validUntil: row.validUntil ?? 0,
  };
}

/**
 * Erstellt einen DB-Adapter, optional mit injizierter `getTable(agent)`-Funktion.
 *
 * @param {object} [opts]
 * @param {string} [opts.basePath]   — Override für lancedb-namespaced root
 * @param {Function} [opts.getTable] — async (agent) → table | null; für Tests
 * @param {Function} [opts.getEmbedding] — async (text) → vector | null; optional
 * @param {object} [opts.embedder]   — { embed(text) → vector }; optional, ermöglicht updateCard mit Re-Embedding
 * @param {object} [opts.logger]     — { info(), warn() }
 */
export function createDbAdapter(opts = {}) {
  const basePath = opts.basePath || DEFAULT_BASE_DB_PATH;
  const getEmbedding = opts.getEmbedding || null;
  const embedder = opts.embedder || null;
  const logger = opts.logger || { info() {}, warn() {} };
  const readTimeoutMs = Number.isFinite(opts.readTimeoutMs) ? opts.readTimeoutMs : DEFAULT_READ_TIMEOUT_MS;
  const writeTimeoutMs = Number.isFinite(opts.writeTimeoutMs) ? opts.writeTimeoutMs : DEFAULT_WRITE_TIMEOUT_MS;

  const timedRead = (promise, label) => withTimeout(promise, readTimeoutMs, label);
  const timedWrite = (promise, label) => withTimeout(promise, writeTimeoutMs, label);

  function throwIfTimeout(err) {
    if (err instanceof TimeoutError) throw err;
  }

  let lancedbModule = null;
  const tableCache = makeBoundedCache(50);
  // Pro-Agent: hat die Schema-Erweiterung (type, confirmed) schon stattgefunden?
  const schemaExtended = makeBoundedCache(50);

  /**
   * Stellt sicher, dass die memories-Tabelle die Spalten `type` und `confirmed`
   * besitzt. Idempotent. Nutzt LanceDBs addColumns, das auf alten Tabellen-
   * Versionen scheitern kann — Fehler werden geloggt, aber nicht propagiert.
   */
  async function ensureClassificationColumns(agent, table) {
    if (!table) return;
    const schemaKey = `${basePath}:${agent}`;
    if (schemaExtended.get(schemaKey) === true) return;
    try {
      const schema = await timedRead(table.schema(), `db-adapter.schema:${agent}`);
      const fieldNames = schema.fields.map((f) => f.name);
      // Pro Spalte isoliert: ein addColumns-Fehler blockiert nicht die restlichen Spalten
      const columns = [
        { name: "type", valueSql: "''" },
        // bool als 0/1 (Int) — LanceDB-addColumns mit valueSql geht so am robustesten
        { name: "confirmed", valueSql: "0" },
        { name: "ownerUserId", valueSql: "''" },
      ];
      let allOk = true;
      for (const col of columns) {
        if (fieldNames.includes(col.name)) continue;
        try {
          await timedWrite(table.addColumns([col]), `db-adapter.addColumns:${agent}:${col.name}`);
        } catch (err) {
          allOk = false;
          logger.warn?.(`db-adapter: schema-erweiterung (${col.name}) für '${agent}' fehlgeschlagen: ${err.message}`);
        }
      }
      // Do NOT set schemaExtended on partial failure — retry next time
      if (allOk) schemaExtended.set(schemaKey, true);
    } catch (err) {
      logger.warn?.(`db-adapter: schema-erweiterung (type/confirmed) für '${agent}' fehlgeschlagen: ${err.message}`);
      // Do NOT set schemaExtended on failure — retry next time
    }
  }

  async function ensureDynamicsColumns(agent, table) {
    if (!table) return;
    const schemaKey = `${basePath}:${agent}:dynamics`;
    if (schemaExtended.get(schemaKey) === true) return;
    try {
      const schema = await timedRead(table.schema(), `db-adapter.dynamics-schema:${agent}`);
      const fieldNames = schema.fields.map((f) => f.name);
      const columns = [
        { name: 'replayCount', valueSql: '0' },
        { name: 'lastReplayed', valueSql: '0' },
        { name: 'retrievalCount', valueSql: '0' },
        { name: 'lastRetrievedAt', valueSql: '0' },
        { name: 'memoryStrength', valueSql: '1.0' },
        { name: 'halfLifeDays', valueSql: '30' },
        { name: 'lastStrengthenedAt', valueSql: '0' },
        { name: 'lastDynamicsAt', valueSql: '0' },
        { name: 'memoryClass', valueSql: "'standard'" },
        { name: 'neverForget', valueSql: '0' },
        { name: 'coreMemoryScore', valueSql: '0.0' },
        { name: 'coreMemoryReason', valueSql: "''" },
      ];
      for (const col of columns) {
        if (!fieldNames.includes(col.name)) {
          await timedWrite(table.addColumns([col]), `db-adapter.dynamics-addColumns:${agent}:${col.name}`);
        }
      }
      schemaExtended.set(schemaKey, true);
    } catch (err) {
      logger.warn?.(`db-adapter: dynamics schema extension failed for '${agent}': ${err.message}`);
      // Do NOT set schemaExtended on failure — retry next time
    }
  }

  async function ensureReconsolidationColumns(agent, table) {
    if (!table) return;
    const schemaKey = `${basePath}:${agent}:reconsolidation`;
    if (schemaExtended.get(schemaKey) === true) return;
    try {
      const schema = await timedRead(table.schema(), `db-adapter.reconsolidation-schema:${agent}`);
      const fieldNames = schema.fields.map((f) => f.name);
      const columns = [
        { name: 'versionNumber', valueSql: '1' },
        { name: 'previousVersion', valueSql: "''" },
        { name: 'supersededBy', valueSql: "''" },
        { name: 'updateSource', valueSql: "''" },
        { name: 'updateEvidence', valueSql: "''" },
        { name: 'reconsolidationConfidence', valueSql: '0.0' },
        { name: 'status', valueSql: "'active'" },
        { name: 'versionCreatedAt', valueSql: '0' },
        { name: 'updatedAt', valueSql: '0' },
      ];
      for (const col of columns) {
        if (!fieldNames.includes(col.name)) {
          await timedWrite(table.addColumns([col]), `db-adapter.reconsolidation-addColumns:${agent}:${col.name}`);
        }
      }
      schemaExtended.set(schemaKey, true);
    } catch (err) {
      logger.warn?.(`db-adapter: reconsolidation schema extension failed for '${agent}': ${err.message}`);
      // Do NOT set schemaExtended on failure — retry next time
    }
  }

  async function ensureReminderColumns(agent, table) {
    if (!table) return;
    const schemaKey = `${basePath}:${agent}:reminder`;
    if (schemaExtended.get(schemaKey) === true) return;
    try {
      const schema = await timedRead(table.schema(), `db-adapter.reminder-schema:${agent}`);
      const fieldNames = schema.fields.map((f) => f.name);
      const columns = [
        { name: 'memoryKind', valueSql: "'memory'" },
        { name: 'reminderStatus', valueSql: "''" },
        { name: 'remindAt', valueSql: '0' },
        { name: 'remindedAt', valueSql: '0' },
        { name: 'dispatchedAt', valueSql: '0' },
        { name: 'acknowledgedAt', valueSql: '0' },
        { name: 'cancelledAt', valueSql: '0' },
        { name: 'reminderKey', valueSql: "''" },
        { name: 'dispatchCount', valueSql: '0' },
        { name: 'lastDispatchAttemptAt', valueSql: '0' },
        { name: 'nextDispatchAttemptAt', valueSql: '0' },
        { name: 'workspaceKey', valueSql: "''" },
      ];
      for (const col of columns) {
        if (!fieldNames.includes(col.name)) {
          await timedWrite(table.addColumns([col]), `db-adapter.reminder-addColumns:${agent}:${col.name}`);
        }
      }
      schemaExtended.set(schemaKey, true);
    } catch (err) {
      logger.warn?.(`db-adapter: reminder schema extension failed for '${agent}': ${err.message}`);
    }
  }

  /**
   * Stellt sicher, dass die memories-Tabelle die Epistemic-Status-Spalten
   * besitzt (Phase 1 — Explicit Trust State). Idempotent, non-destruktiv,
   * folgt exakt dem Muster der übrigen ensureXColumns-Funktionen.
   */
  async function ensureEpistemicStatusColumns(agent, table) {
    if (!table) return;
    const schemaKey = `${basePath}:${agent}:epistemic`;
    if (schemaExtended.get(schemaKey) === true) return;
    try {
      const schema = await timedRead(table.schema(), `db-adapter.epistemic-schema:${agent}`);
      const fieldNames = schema.fields.map((f) => f.name);
      const columns = [
        { name: 'epistemicStatus', valueSql: "''" },
        { name: 'epistemicStatusUpdatedAt', valueSql: '0' },
        { name: 'epistemicStatusActor', valueSql: "''" },
        { name: 'epistemicStatusReason', valueSql: "''" },
        { name: 'previousEpistemicStatus', valueSql: "''" },
      ];
      for (const col of columns) {
        if (!fieldNames.includes(col.name)) {
          await timedWrite(table.addColumns([col]), `db-adapter.epistemic-addColumns:${agent}:${col.name}`);
        }
      }
      schemaExtended.set(schemaKey, true);
    } catch (err) {
      logger.warn?.(`db-adapter: epistemic-status schema extension failed for '${agent}': ${err.message}`);
    }
  }

  /**
   * Stellt sicher, dass die memories-Tabelle die Valid-Time-Spalten besitzt
   * (Phase 2 — Bi-Temporal Memory). Idempotent, non-destruktiv, folgt exakt
   * dem Muster der übrigen ensureXColumns-Funktionen. `0` = kein bekanntes
   * Bound (siehe lib/valid-time.js).
   *
   * @param {string} agent validated agent identifier used for cache/log keys
   * @param {object} table LanceDB table exposing schema() and addColumns()
   * @returns {Promise<void>}
   */
  async function ensureValidTimeColumns(agent, table) {
    if (!table) return;
    const schemaKey = `${basePath}:${agent}:validtime`;
    if (schemaExtended.get(schemaKey) === true) return;
    try {
      const schema = await timedRead(table.schema(), `db-adapter.validtime-schema:${agent}`);
      const fieldNames = schema.fields.map((f) => f.name);
      const columns = [
        { name: 'validFrom', valueSql: '0' },
        { name: 'validUntil', valueSql: '0' },
      ];
      for (const col of columns) {
        if (!fieldNames.includes(col.name)) {
          await timedWrite(table.addColumns([col]), `db-adapter.validtime-addColumns:${agent}:${col.name}`);
        }
      }
      schemaExtended.set(schemaKey, true);
    } catch (err) {
      logger.warn?.(`db-adapter: valid-time schema extension failed for '${agent}': ${err.message}`);
    }
  }

  // Caller kann eine eigene getTable injecten (Tests). Sonst lazy via LanceDB.
  const resolveRawTable = opts.getTable || (async (agent) => {
    const safeAgent = safeAgentId(agent);
    tableCache.acquire(safeAgent);
    try {
      const cached = tableCache.get(safeAgent);
      if (cached !== undefined) return cached;
      const dbDir = join(basePath, safeAgent);
      if (!existsSync(dbDir)) {
        tableCache.set(safeAgent, null);
        return null;
      }
      try {
        if (!lancedbModule) lancedbModule = await import("@lancedb/lancedb");
        const db = await timedWrite(lancedbModule.connect(dbDir), "lancedb.connect");
        const names = await timedRead(db.tableNames(), "lancedb.tableNames");
        if (!names.includes(TABLE_NAME)) {
          tableCache.set(safeAgent, null);
          return null;
        }
        const table = await timedWrite(db.openTable(TABLE_NAME), "lancedb.openTable");
        await ensureClassificationColumns(agent, table);
        await ensureDynamicsColumns(agent, table);
        await ensureReconsolidationColumns(agent, table);
        await ensureReminderColumns(agent, table);
        await ensureEpistemicStatusColumns(agent, table);
        await ensureValidTimeColumns(agent, table);
        tableCache.set(safeAgent, table);
        return table;
      } catch (err) {
        if (err instanceof TimeoutError) {
          logger.warn?.(`db-adapter: timeout opening table for '${agent}': ${err.message}`);
        } else {
          logger.warn?.(`db-adapter: konnte Tabelle für '${agent}' nicht öffnen: ${err.message}`);
        }
        tableCache.set(safeAgent, null);
        return null;
      }
    } finally {
      tableCache.release(safeAgent);
    }
  });

  const resolveTable = async (agent) => resolveRawTable(safeAgentId(agent));

  async function queryByTimeRange(agent, range, queryOpts = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const { from, to } = computeCutoff(range);
    try {
      const fromMs = Math.floor(from);
      const toMs = Math.floor(to);
      let rows = await timedRead(
        table
          .query()
          .where(`createdAt >= ${fromMs}`)
          .limit(1000)
          .toArray(),
        `db-adapter.queryByTimeRange:${agent}`,
      );
      // Filtere Obergrenze in JS (DataFusion AND-Bug Workaround)
      rows = rows.filter(r => r.createdAt <= toMs).slice(0, 50);
      let cards = rows.map(rowToCard).filter(Boolean);
      if (queryOpts.ctx) {
        cards = cards.filter((card) => {
          const acl = checkAccess(queryOpts.ctx, card);
          if (!acl.allowed) {
            logAclViolation(queryOpts.ctx, card, acl.reason);
            return false;
          }
          return true;
        });
      }
      cards.sort((a, b) => b.createdAt - a.createdAt);
      return cards;
    } catch (err) {
      throwIfTimeout(err);
      safeWarn(logger, "queryByTimeRange", err, { agent });
      return [];
    }
  }

  const MAX_TOPIC_LENGTH = 2000;

  async function searchByTopic(agent, topic, searchOpts = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const limit = searchOpts.limit || 10;
    if (typeof topic === "string" && topic.length > MAX_TOPIC_LENGTH) {
      logger.warn?.(`db-adapter: searchByTopic topic exceeds ${MAX_TOPIC_LENGTH} chars (${topic.length})`);
      return [];
    }

    const filterClause = buildWhereClause(searchOpts.filters);
    // (status = 'active' OR status IS NULL) parenthesized on its own — AND
    // binds tighter than OR in SQL, so appending the epistemicStatus clause
    // without parens here would let an invalidated row with status='active'
    // through. The JS-side filters below are the actual safety boundary
    // (they run regardless of which fetch path produced the rows); this
    // clause is a DB-side optimization on top of that boundary, not a
    // substitute for it.
    const statusClause = "(status = 'active' OR status IS NULL) AND epistemicStatus != 'invalidated'";
    const combinedClause = filterClause ? `(${statusClause}) AND (${filterClause})` : statusClause;

    let results;

    // Wenn Embedding-Funktion vorhanden: Vektorsuche. Sonst Text-Fallback.
    if (getEmbedding) {
      try {
        const vector = await getEmbedding(topic);
        if (vector && vector.length > 0) {
          let rows;
          try {
            const builder = table.vectorSearch(vector);
            rows = typeof builder.where === "function"
              ? await timedRead(builder.where(combinedClause).limit(Math.max(limit * 3, limit)).toArray(), `db-adapter.searchByTopic.vectorSearch:${agent}`)
              : await timedRead(builder.limit(Math.max(limit * 3, limit)).toArray(), `db-adapter.searchByTopic.vectorSearch:${agent}`);
          } catch (err) {
            throwIfTimeout(err);
            safeWarn(logger, "searchByTopic.vectorSearch", err);
            rows = await timedRead(table.vectorSearch(vector).limit(Math.max(limit * 3, limit)).toArray(), `db-adapter.searchByTopic.vectorSearch-fallback:${agent}`);
          }
          results = rows
            .filter((r) => (!r.status || r.status === "active") && normalizeEpistemicStatus(r.epistemicStatus) !== "invalidated")
            .slice(0, limit)
            .map((r) => {
              const card = rowToCard(r);
              if (!card) return null;
              card.score = typeof r._distance === "number"
                ? Math.max(0, 1 - r._distance)
                : 0.5;
              return card;
            })
            .filter(Boolean);
        }
      } catch (err) {
        throwIfTimeout(err);
        safeWarn(logger, "searchByTopic.embedding", err);
      }
    }

    // Text-Fallback: holt einige Rows, filtert lokal nach String-Match.
    if (results === undefined) {
      try {
        let query = table.query();
        if (filterClause) {
          query = query.where(filterClause);
        }
        const rows = await timedRead(query.limit(200).toArray(), `db-adapter.searchByTopic.text:${agent}`);
        const needle = topic.toLowerCase();
        results = rows
          .filter((r) => (!r.status || r.status === "active") && normalizeEpistemicStatus(r.epistemicStatus) !== "invalidated")
          .map(rowToCard)
          .filter((c) => c && (c.text.toLowerCase().includes(needle) || c.summary.toLowerCase().includes(needle)))
          .slice(0, limit)
          .map((c) => ({ ...c, score: 0.5 }));
      } catch (err) {
        throwIfTimeout(err);
        logger.warn?.(`db-adapter: text-search fehlgeschlagen für '${agent}': ${err.message}`);
        return [];
      }
    }

    if (searchOpts.ctx) {
      results = results.filter((card) => {
        const acl = checkAccess(searchOpts.ctx, card);
        if (!acl.allowed) {
          logAclViolation(searchOpts.ctx, card, acl.reason);
          return false;
        }
        return true;
      });
    }

    return results;
  }

  async function getCard(agent, id, opts = {}) {
    const table = await resolveTable(agent);
    if (!table) return null;
    try {
      const safe = safeUuid(id);
      const rows = await timedRead(table.query().where(`id = "${safe}"`).limit(1).toArray(), `db-adapter.getCard:${agent}/${safe}`);
      const card = rows.length > 0 ? rowToCard(rows[0]) : null;
      if (card && opts.ctx) {
        const acl = checkAccess(opts.ctx, card);
        if (!acl.allowed) {
          logAclViolation(opts.ctx, card, acl.reason);
          return null;
        }
      }
      return card;
    } catch (err) {
      throwIfTimeout(err);
      logger.warn?.(`db-adapter: getCard fehlgeschlagen für '${agent}/${id}': ${err.message}`);
      return null;
    }
  }

  async function deleteCard(agent, id) {
    const table = await resolveTable(agent);
    if (!table) {
      throw new Error(`db-adapter: keine Tabelle für agent='${agent}' — Lösch-Operation nicht möglich.`);
    }
    const safe = safeUuid(id);
    await timedWrite(table.delete(`id = "${safe}"`), `db-adapter.deleteCard:${agent}/${safe}`);
    return { ok: true, id: safe };
  }

  /**
   * Kanonischer Tombstone-Vorgang: soft-deleted die Zeile, statt sie physisch
   * zu löschen. Setzt `status="deleted"` und `epistemicStatus="invalidated"`
   * und lässt die Zeile (für Fingerprint/Audit) erhalten — sie ist damit aus
   * allen Active-Scans ausgeschlossen.
   *
   * Idempotent: eine bereits tombstoned Zeile liefert `alreadyTombstoned`.
   *
   * @param {string} agent
   * @param {string} id
   * @param {object} [values] zusätzliche (validierte) Spaltenwerte
   * @returns {Promise<{ok: boolean, id: string, alreadyTombstoned?: boolean, notFound?: boolean}>}
   */
  async function tombstoneCard(agent, id, values = {}) {
    const table = await resolveTable(agent);
    if (!table) {
      throw new Error(`db-adapter: keine Tabelle für agent='${agent}' — Tombstone-Operation nicht möglich.`);
    }
    const safe = safeUuid(id);
    const rows = await timedRead(
      table.query().where(`id = "${safe}"`).limit(1).toArray(),
      `db-adapter.tombstoneCard.query:${agent}/${safe}`,
    );
    if (rows.length === 0) {
      return { ok: false, notFound: true, id: safe };
    }
    if (String(rows[0].status || "") === "deleted") {
      return { ok: true, alreadyTombstoned: true, id: safe };
    }
    const patch = { ...(values || {}) };
    patch.status = safeStatus("deleted");
    patch.epistemicStatus = "invalidated";
    await timedWrite(table.update({
      where: `id = "${safe}"`,
      values: patch,
    }), `db-adapter.tombstoneCard:${agent}/${safe}`);
    return { ok: true, id: safe };
  }

  async function updateCard(agent, id, newContent) {
    const table = await resolveTable(agent);
    if (!table) {
      throw new Error(`db-adapter: keine Tabelle für agent='${agent}' — Update nicht möglich.`);
    }
    if (!newContent || typeof newContent !== "string") {
      throw new Error(`db-adapter: updateCard braucht string newContent`);
    }
    // Backwards-kompat: ohne embedder weiter hard-fail (alte Tests verlassen sich darauf).
    if (!embedder || typeof embedder.embed !== "function") {
      throw new Error(
        `db-adapter: updateCard braucht Embedder-Injection für Vektor-Re-Embedding. ` +
        `Workaround: /vergiss + neu speichern.`
      );
    }
    const safe = safeUuid(id);

    // 1. Bestehende Row holen
    const rows = await timedRead(table.query().where(`id = "${safe}"`).limit(1).toArray(), `db-adapter.updateCard.query:${agent}/${safe}`);
    if (rows.length === 0) {
      throw new Error(`db-adapter: Card '${safe}' nicht gefunden`);
    }
    const existing = rows[0];

    // 2. Neuer Embedding-Vektor
    const vector = await embedder.embed(newContent);
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`db-adapter: embedder lieferte ungültigen Vektor`);
    }

    // 3. Safe Update: Neue Version erstellen, alte als superseded markieren
    const { randomUUID } = await import("node:crypto");
    const newId = randomUUID();
    const now = Date.now();

    // 3a. Neue Version ZUERST durabel schreiben. Erst danach (3b) die alte Row
    // superseden. Reihenfolge ist kritisch: schlägt der Insert fehl oder stirbt
    // der Prozess dazwischen, bleibt die alte Row aktiv (kein Datenverlust). Bei
    // umgekehrter Reihenfolge wäre die alte Row versteckt und die neue nie
    // geschrieben → Memory unwiederbringlich verloren.
    try {
      const updated = {
        ...existing,
        id: newId,
        vector,
        text: newContent,
        summary: existing.summary || newContent.split("\n")[0].slice(0, 200),
        versionNumber: (existing.versionNumber ?? 1) + 1,
        previousVersion: existing.id,
        status: "active",
        supersededBy: "",
        updateSource: "user_correction",
        updateEvidence: `Telegram /korrigier: "${newContent.slice(0, 100)}"`,
        versionCreatedAt: now,
        updatedAt: now,
      };
      if (updated.vector && !Array.isArray(updated.vector)) {
        updated.vector = Array.from(updated.vector);
      }
      await timedWrite(table.add([updated]), `db-adapter.updateCard.add:${agent}/${newId}`);
    } catch (insertErr) {
      throw new Error(`db-adapter: updateCard insert failed: ${insertErr.message}`, { cause: insertErr });
    }

    // 3b. Alte Row als superseded markieren (neue Version existiert jetzt durabel).
    await timedWrite(table.update({
      where: `id = "${safe}"`,
      values: {
        status: "superseded",
        supersededBy: newId,
        updatedAt: now,
      },
    }), `db-adapter.updateCard.update:${agent}/${safe}`);

    return { ok: true, id: newId, previousId: safe };
  }

  // ─── Cron-Job Wiring (Task 6.3) ──────────────────────────────────────────

  /**
   * LanceDB-Fragment-Kompaktierung (table.optimize()).
   *
   * Hintergrund (2026-08-04): Jeder add()/update()-Lauf erzeugt neue Fragments.
   * Ohne Kompaktierung wachsen tausende Mini-Datafiles an (Beobachtung: ~6000
   * Files bei 9k Rows), Full-Scans wie findRecentUnclassified steigen von ~60ms
   * auf >13s und reissen unter Embedding-Drain-Last das Read-Timeout.
   * Diese Funktion ist fuer einen periodischen Maintenance-Job gedacht
   * (z.B. woechentlich). optimize() merged Fragments und pruned alte Versionen
   * (Default: aelter 7 Tage) —Rollback bleibt ueber LanceDB-Versions moeglich.
   *
   * Bewusst grosszuegiges Timeout (10min): optimize auf grossen Tabellen
   * dauert deutlich laenger als der normale Write-Timeout (25s).
   */
  async function optimizeTable(agent, optimizeOpts = {}) {
    const table = await resolveTable(agent);
    if (!table) return { ok: false, reason: "no-table" };
    try {
      const stats = await withTimeout(
        table.optimize(optimizeOpts),
        600_000,
        `db-adapter.optimize:${agent}`,
      );
      return { ok: true, stats };
    } catch (err) {
      throwIfTimeout(err);
      logger.warn?.(`db-adapter: optimizeTable fehlgeschlagen fuer '${agent}': ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  async function findRecentUnclassified(agent, { sinceMinutes = 30 } = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const cutoffMs = Date.now() - sinceMinutes * 60_000;
    try {
      // Effizienz-Fix (2026-08-04, Latenz-Timeout unter Last):
      // 1. select() ohne 'vector' — sonst materialisiert LanceDB pro gescannter
      //    Row den kompletten Embedding-Vektor (60 Spalten, davon vector 1536-dim).
      // 2. type-Filter in die WHERE-Clause pushen (Index/Scan filtert frueher,
      //    weniger Rows werden materialisiert). Der lokale Filter bleibt als
      //    Guard fuer Rows ohne type-Spalte (alte Schemas / injizierte Tabellen).
      // Spaltenliste kommt aus dem live-Schema, damit zukuenftige Schema-
      // Erweiterungen (ensureXColumns) nicht brechen.
      const schema = await timedRead(table.schema(), `db-adapter.findRecentUnclassified.schema:${agent}`);
      const columnNames = schema.fields.map((f) => f.name);
      const hasTypeColumn = columnNames.includes("type");
      const selectColumns = columnNames.filter((n) => n !== "vector");
      const whereClause = hasTypeColumn
        ? `createdAt >= ${cutoffMs} AND (type IS NULL OR type = '')`
        : `createdAt >= ${cutoffMs}`;
      let builder = table.query().where(whereClause);
      if (selectColumns.length > 0) {
        builder = builder.select(selectColumns);
      }
      const rows = await timedRead(
        builder.limit(50).toArray(),
        `db-adapter.findRecentUnclassified:${agent}`,
      );
      // Guard: type leer oder fehlend (bei altem Schema ohne type-Spalte
      // uebernimmt dieser Filter allein).
      return rows
        .filter((r) => !r.type || r.type === "")
        .map((r) => {
          const card = rowToCard(r);
          return card ? { ...card, content: r.text || r.summary || "" } : null;
        })
        .filter(Boolean);
    } catch (err) {
      throwIfTimeout(err);
      logger.warn?.(`db-adapter: findRecentUnclassified fehlgeschlagen für '${agent}': ${err.message}`);
      return [];
    }
  }

  async function updateCardType(agent, id, type) {
    const table = await resolveTable(agent);
    if (!table) {
      throw new Error(`db-adapter: keine Tabelle für agent='${agent}' — updateCardType nicht möglich.`);
    }
    const safeId = safeUuid(id);
    const safeType = validateType(type);
    try {
      await timedWrite(table.update({
        values: { type: safeType },
        where: `id = "${safeId}"`,
      }), `db-adapter.updateCardType:${agent}/${safeId}`);
      return { ok: true, id: safeId, type: safeType };
    } catch (err) {
      throwIfTimeout(err);
      throw new Error(`db-adapter: updateCardType failed: ${err.message}`, { cause: err });
    }
  }

  async function findUnconfirmedCritical(agent, { olderThan = 0 } = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const CRITICAL = [
      "person",
      "beziehung",
      "geburtstag",
      "geld_konto",
      "gesundheit",
      "zugang_passwort",
    ];
    try {
      const safeOlderThan = safeTimestamp(Number(olderThan) || 0);
      const rows = await timedRead(
        table
          .query()
          .where(`createdAt <= ${safeOlderThan}`)
          .limit(200)
          .toArray(),
        `db-adapter.findUnconfirmedCritical:${agent}`,
      );
      return rows
        .filter((r) => CRITICAL.includes(r.type) && r.confirmed !== true && r.confirmed !== 1)
        .map((r) => {
          const card = rowToCard(r);
          return card ? { ...card, type: r.type } : null;
        })
        .filter(Boolean);
    } catch (err) {
      throwIfTimeout(err);
      logger.warn?.(`db-adapter: findUnconfirmedCritical fehlgeschlagen für '${agent}': ${err.message}`);
      return [];
    }
  }

  async function markConfirmed(agent, id) {
    const table = await resolveTable(agent);
    if (!table) {
      throw new Error(`db-adapter: keine Tabelle für agent='${agent}' — markConfirmed nicht möglich.`);
    }
    const safeId = safeUuid(id);
    try {
      // confirmed als Int (1) — addColumns nutzt 0 als Default
      await timedWrite(table.update({
        values: { confirmed: 1 },
        where: `id = "${safeId}"`,
      }), `db-adapter.markConfirmed:${agent}/${safeId}`);
      return { ok: true, id: safeId };
    } catch (err) {
      throwIfTimeout(err);
      throw new Error(`db-adapter: markConfirmed failed: ${err.message}`, { cause: err });
    }
  }

  async function markCriticalAccepted(agent, id) {
    const table = await resolveTable(agent);
    if (!table) {
      throw new Error(`db-adapter: keine Tabelle für agent='${agent}' — markCriticalAccepted nicht möglich.`);
    }
    const safeId = safeUuid(id);
    try {
      await timedWrite(table.update({
        values: { confirmed: 1 },
        where: `id = "${safeId}"`,
      }), `db-adapter.markCriticalAccepted:${agent}/${safeId}`);
      return { ok: true, id: safeId, status: "accepted" };
    } catch (err) {
      throwIfTimeout(err);
      throw new Error(`db-adapter: markCriticalAccepted failed: ${err.message}`, { cause: err });
    }
  }

  /**
   * Nicht-destruktiv: verwirft nur die besondere Kennzeichnung. Die Karte
   * verbleibt im Speicher (kein Löschen/Archivieren), wird aber als gewöhnliche
   * Notiz deklassifiziert und aus dem Pending-Review-Ledger entfernt.
   */
  async function markCriticalRejected(agent, id) {
    const table = await resolveTable(agent);
    if (!table) {
      throw new Error(`db-adapter: keine Tabelle für agent='${agent}' — markCriticalRejected nicht möglich.`);
    }
    const safeId = safeUuid(id);
    try {
      await timedWrite(table.update({
        values: { confirmed: 1, type: "note" },
        where: `id = "${safeId}"`,
      }), `db-adapter.markCriticalRejected:${agent}/${safeId}`);
      return { ok: true, id: safeId, status: "rejected" };
    } catch (err) {
      throwIfTimeout(err);
      throw new Error(`db-adapter: markCriticalRejected failed: ${err.message}`, { cause: err });
    }
  }

  /**
   * Pending-Review-Ledger: alle unbestätigten Critical-Karten eines Agents.
   * Basis für die Kurzreferenz-Auflösung im autorisierten Scope.
   */
  async function findPendingCriticalReviews(agent) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const CRITICAL = [
      "person",
      "beziehung",
      "geburtstag",
      "geld_konto",
      "gesundheit",
      "zugang_passwort",
    ];
    try {
      const schema = await timedRead(table.schema(), `db-adapter.findPendingCriticalReviews.schema:${agent}`);
      const columnNames = schema.fields.map((f) => f.name);
      const selectColumns = columnNames.filter((n) => n !== "vector");
      let builder = table.query().limit(200);
      if (selectColumns.length > 0) builder = builder.select(selectColumns);
      const rows = await timedRead(
        builder.toArray(),
        `db-adapter.findPendingCriticalReviews:${agent}`,
      );
      return rows
        .filter((r) => CRITICAL.includes(r.type) && r.confirmed !== true && r.confirmed !== 1)
        .map((r) => {
          const card = rowToCard(r);
          return card ? { ...card, type: r.type } : null;
        })
        .filter(Boolean);
    } catch (err) {
      throwIfTimeout(err);
      logger.warn?.(`db-adapter: findPendingCriticalReviews fehlgeschlagen für '${agent}': ${err.message}`);
      return [];
    }
  }

  async function isAvailable(agent) {
    const table = await resolveTable(agent);
    return !!table;
  }

  let isShutdown = false;
  async function shutdown() {
    if (isShutdown) return;
    isShutdown = true;
    const tables = tableCache.values();
    for (const table of tables) {
      try {
        if (table && typeof table.close === "function") {
          await timedWrite(table.close(), "db-adapter.shutdown.close");
        }
      } catch (err) {
        logger.warn?.(`db-adapter: table close failed: ${err?.message}`);
      }
    }
    tableCache.clear();
    schemaExtended.clear();
  }

  return {
    queryByTimeRange,
    searchByTopic,
    getCard,
    deleteCard,
    tombstoneCard,
    updateCard,
    findRecentUnclassified,
    optimizeTable,
    updateCardType,
    findUnconfirmedCritical,
    markConfirmed,
    markCriticalAccepted,
    markCriticalRejected,
    findPendingCriticalReviews,
    isAvailable,
    shutdown,
    // Für Tests + Phase 5
    _resolveTable: resolveTable,
    _ensureClassificationColumns: ensureClassificationColumns,
    _ensureDynamicsColumns: ensureDynamicsColumns,
    _ensureReconsolidationColumns: ensureReconsolidationColumns,
    _ensureEpistemicStatusColumns: ensureEpistemicStatusColumns,
    _ensureValidTimeColumns: ensureValidTimeColumns,
  };
}
