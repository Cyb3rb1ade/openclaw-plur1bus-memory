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

// Konsistent mit index.js
const DEFAULT_BASE_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const TABLE_NAME = "memories";

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
    memoryClass: row.memoryClass || "standard",
    neverForget: row.neverForget ?? 0,
    coreMemoryScore: row.coreMemoryScore ?? 0.0,
    coreMemoryReason: row.coreMemoryReason || "",
    scope: row.scope || "agent-private",
    agentId: row.agentId || "",
    workspaceId: row.workspaceId || "",
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
      const schema = await table.schema();
      const fieldNames = schema.fields.map((f) => f.name);
      // Pro Spalte isoliert: ein addColumns-Fehler blockiert nicht die restlichen Spalten
      const columns = [
        { name: "type", valueSql: "''" },
        // bool als 0/1 (Int) — LanceDB-addColumns mit valueSql geht so am robustesten
        { name: "confirmed", valueSql: "0" },
      ];
      let allOk = true;
      for (const col of columns) {
        if (fieldNames.includes(col.name)) continue;
        try {
          await table.addColumns([col]);
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
      const schema = await table.schema();
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
          await table.addColumns([col]);
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
      const schema = await table.schema();
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
          await table.addColumns([col]);
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
      const schema = await table.schema();
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
      ];
      for (const col of columns) {
        if (!fieldNames.includes(col.name)) {
          await table.addColumns([col]);
        }
      }
      schemaExtended.set(schemaKey, true);
    } catch (err) {
      logger.warn?.(`db-adapter: reminder schema extension failed for '${agent}': ${err.message}`);
    }
  }

  // Caller kann eine eigene getTable injecten (Tests). Sonst lazy via LanceDB.
  const resolveTable = opts.getTable || (async (agent) => {
    const safeAgent = safeAgentId(agent || "default");
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
        const db = await lancedbModule.connect(dbDir);
        const names = await db.tableNames();
        if (!names.includes(TABLE_NAME)) {
          tableCache.set(safeAgent, null);
          return null;
        }
        const table = await db.openTable(TABLE_NAME);
        await ensureClassificationColumns(agent, table);
        await ensureDynamicsColumns(agent, table);
        await ensureReconsolidationColumns(agent, table);
        await ensureReminderColumns(agent, table);
        tableCache.set(safeAgent, table);
        return table;
      } catch (err) {
        logger.warn?.(`db-adapter: konnte Tabelle für '${agent}' nicht öffnen: ${err.message}`);
        tableCache.set(safeAgent, null);
        return null;
      }
    } finally {
      tableCache.release(safeAgent);
    }
  });

  async function queryByTimeRange(agent, range) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const { from, to } = computeCutoff(range);
    try {
      const fromMs = Math.floor(from);
      const toMs = Math.floor(to);
      let rows = await table
        .query()
        .where(`createdAt >= ${fromMs}`)
        .limit(1000)
        .toArray();
      // Filtere Obergrenze in JS (DataFusion AND-Bug Workaround)
      rows = rows.filter(r => r.createdAt <= toMs).slice(0, 50);
      const cards = rows.map(rowToCard).filter(Boolean);
      cards.sort((a, b) => b.createdAt - a.createdAt);
      return cards;
    } catch (err) {
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
    const statusClause = "status = 'active' OR status IS NULL";
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
              ? await builder.where(combinedClause).limit(Math.max(limit * 3, limit)).toArray()
              : await builder.limit(Math.max(limit * 3, limit)).toArray();
          } catch (err) {
            safeWarn(logger, "searchByTopic.vectorSearch", err);
            rows = await table.vectorSearch(vector).limit(Math.max(limit * 3, limit)).toArray();
          }
          results = rows
            .filter((r) => !r.status || r.status === "active")
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
        const rows = await query.limit(200).toArray();
        const needle = topic.toLowerCase();
        results = rows
          .filter((r) => !r.status || r.status === "active")
          .map(rowToCard)
          .filter((c) => c && (c.text.toLowerCase().includes(needle) || c.summary.toLowerCase().includes(needle)))
          .slice(0, limit)
          .map((c) => ({ ...c, score: 0.5 }));
      } catch (err) {
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
      const rows = await table.query().where(`id = "${safe}"`).limit(1).toArray();
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
    await table.delete(`id = "${safe}"`);
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
    const rows = await table.query().where(`id = "${safe}"`).limit(1).toArray();
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

    // 3a. Alte Row als superseded markieren
    await table.update({
      where: `id = "${safe}"`,
      values: {
        status: "superseded",
        supersededBy: newId,
        updatedAt: now,
      },
    });

    // 3b. Neue Version speichern
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
      await table.add([updated]);
      return { ok: true, id: newId, previousId: safe };
    } catch (insertErr) {
      throw new Error(`db-adapter: updateCard insert failed: ${insertErr.message}`);
    }
  }

  // ─── Cron-Job Wiring (Task 6.3) ──────────────────────────────────────────

  async function findRecentUnclassified(agent, { sinceMinutes = 30 } = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const cutoffMs = Date.now() - sinceMinutes * 60_000;
    try {
      const rows = await table
        .query()
        .where(`createdAt >= ${cutoffMs}`)
        .limit(50)
        .toArray();
      // Filtere lokal: type leer oder fehlend
      return rows
        .filter((r) => !r.type || r.type === "")
        .map((r) => {
          const card = rowToCard(r);
          return card ? { ...card, content: r.text || r.summary || "" } : null;
        })
        .filter(Boolean);
    } catch (err) {
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
      await table.update({
        values: { type: safeType },
        where: `id = "${safeId}"`,
      });
      return { ok: true, id: safeId, type: safeType };
    } catch (err) {
      throw new Error(`db-adapter: updateCardType failed: ${err.message}`);
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
      const rows = await table
        .query()
        .where(`createdAt <= ${safeOlderThan}`)
        .limit(200)
        .toArray();
      return rows
        .filter((r) => CRITICAL.includes(r.type) && r.confirmed !== true && r.confirmed !== 1)
        .map((r) => {
          const card = rowToCard(r);
          return card ? { ...card, type: r.type } : null;
        })
        .filter(Boolean);
    } catch (err) {
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
      await table.update({
        values: { confirmed: 1 },
        where: `id = "${safeId}"`,
      });
      return { ok: true, id: safeId };
    } catch (err) {
      throw new Error(`db-adapter: markConfirmed failed: ${err.message}`);
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
    const entries = Array.from(tableCache.entries());
    for (const [, table] of entries) {
      try {
        if (table && typeof table.close === "function") await table.close();
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
    updateCard,
    findRecentUnclassified,
    updateCardType,
    findUnconfirmedCritical,
    markConfirmed,
    isAvailable,
    shutdown,
    // Für Tests + Phase 5
    _resolveTable: resolveTable,
    _ensureClassificationColumns: ensureClassificationColumns,
    _ensureDynamicsColumns: ensureDynamicsColumns,
    _ensureReconsolidationColumns: ensureReconsolidationColumns,
  };
}
