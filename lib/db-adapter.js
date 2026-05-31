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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  const tableCache = new Map();
  // Pro-Agent: hat die Schema-Erweiterung (type, confirmed) schon stattgefunden?
  const schemaExtended = new Map();

  /**
   * Stellt sicher, dass die memories-Tabelle die Spalten `type` und `confirmed`
   * besitzt. Idempotent. Nutzt LanceDBs addColumns, das auf alten Tabellen-
   * Versionen scheitern kann — Fehler werden geloggt, aber nicht propagiert.
   */
  async function ensureClassificationColumns(agent, table) {
    if (!table) return;
    if (schemaExtended.get(agent)) return;
    try {
      const schema = await table.schema();
      const fieldNames = schema.fields.map((f) => f.name);
      if (!fieldNames.includes("type")) {
        await table.addColumns([{ name: "type", valueSql: "''" }]);
      }
      if (!fieldNames.includes("confirmed")) {
        // bool als 0/1 (Int) — LanceDB-addColumns mit valueSql geht so am robustesten
        await table.addColumns([{ name: "confirmed", valueSql: "0" }]);
      }
      schemaExtended.set(agent, true);
    } catch (err) {
      logger.warn?.(`db-adapter: schema-erweiterung (type/confirmed) für '${agent}' fehlgeschlagen: ${err.message}`);
      // markiere trotzdem als "versucht", um Endlos-Retry zu vermeiden
      schemaExtended.set(agent, true);
    }
  }

  // Caller kann eine eigene getTable injecten (Tests). Sonst lazy via LanceDB.
  const resolveTable = opts.getTable || (async (agent) => {
    if (tableCache.has(agent)) return tableCache.get(agent);
    const dbDir = join(basePath, agent || "default");
    if (!existsSync(dbDir)) {
      tableCache.set(agent, null);
      return null;
    }
    try {
      if (!lancedbModule) lancedbModule = await import("@lancedb/lancedb");
      const db = await lancedbModule.connect(dbDir);
      const names = await db.tableNames();
      if (!names.includes(TABLE_NAME)) {
        tableCache.set(agent, null);
        return null;
      }
      const table = await db.openTable(TABLE_NAME);
      tableCache.set(agent, table);
      return table;
    } catch (err) {
      logger.warn?.(`db-adapter: konnte Tabelle für '${agent}' nicht öffnen: ${err.message}`);
      tableCache.set(agent, null);
      return null;
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
      logger.warn?.(`db-adapter: queryByTimeRange fehlgeschlagen für '${agent}': ${err.message}`);
      return [];
    }
  }

  async function searchByTopic(agent, topic, searchOpts = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    const limit = searchOpts.limit || 10;
    // Wenn Embedding-Funktion vorhanden: Vektorsuche. Sonst Text-Fallback.
    if (getEmbedding) {
      try {
        const vector = await getEmbedding(topic);
        if (vector && vector.length > 0) {
          const rows = await table.vectorSearch(vector).limit(limit).toArray();
          return rows
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
        logger.warn?.(`db-adapter: vector-search fehlgeschlagen, fallback auf text: ${err.message}`);
      }
    }
    // Text-Fallback: holt einige Rows, filtert lokal nach String-Match.
    try {
      const rows = await table.query().limit(200).toArray();
      const needle = topic.toLowerCase();
      const matches = rows
        .map(rowToCard)
        .filter((c) => c && (c.text.toLowerCase().includes(needle) || c.summary.toLowerCase().includes(needle)))
        .slice(0, limit)
        .map((c) => ({ ...c, score: 0.5 }));
      return matches;
    } catch (err) {
      logger.warn?.(`db-adapter: text-search fehlgeschlagen für '${agent}': ${err.message}`);
      return [];
    }
  }

  async function getCard(agent, id) {
    const table = await resolveTable(agent);
    if (!table) return null;
    try {
      const safe = String(id).replace(/[^a-zA-Z0-9\-]/g, "");
      if (!safe) return null;
      const rows = await table.query().where(`id = "${safe}"`).limit(1).toArray();
      return rows.length > 0 ? rowToCard(rows[0]) : null;
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
    const safe = String(id).replace(/[^a-zA-Z0-9\-]/g, "");
    if (!safe) throw new Error(`db-adapter: ungültige Card-ID '${id}'`);
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
    const safe = String(id).replace(/[^a-zA-Z0-9\-]/g, "");
    if (!safe) throw new Error(`db-adapter: ungültige Card-ID '${id}'`);

    // 1. Bestehende Row holen, damit wir alle Felder beim Re-Insert beibehalten
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

    // 3. Atomar: delete + add mit identischer ID + neuem text+vector
    //    LanceDB hat kein echtes Transaction-API hier; wir machen es so:
    //    delete zuerst, dann add. Bei Fehler nach delete: Rollback via Re-Add
    //    der alten Row (best-effort).
    await table.delete(`id = "${safe}"`);
    try {
      const updated = {
        ...existing,
        // existing.vector ist ggf. ein TypedArray — Array.from für Sicherheit
        vector,
        text: newContent,
        // summary wird vom Memory-Card-Writer in der Pipeline gepflegt;
        // hier ohne Re-Summarize lassen wir summary unverändert, oder leeren
        // ihn, damit /memory nicht stale rendert. Konservativ: text als summary
        // Fallback wenn nicht vorhanden.
        summary: existing.summary || newContent.split("\n")[0].slice(0, 200),
      };
      // FixedSizeList<Float32> aus Object.create-Row → bei add() neu wrappen
      // tolerieren manche LanceDB-Versionen nicht. Wir zwingen vector als Array.
      if (updated.vector && typeof updated.vector !== "object") {
        updated.vector = Array.from(updated.vector);
      } else if (updated.vector && !Array.isArray(updated.vector)) {
        updated.vector = Array.from(updated.vector);
      }
      await table.add([updated]);
    } catch (insertErr) {
      // Rollback-Versuch — die alte Row aus `existing` rein
      try {
        const rollback = { ...existing };
        if (rollback.vector && !Array.isArray(rollback.vector)) {
          rollback.vector = Array.from(rollback.vector);
        }
        await table.add([rollback]);
      } catch (_) {
        // ignore rollback failure
      }
      throw new Error(`db-adapter: updateCard insert failed: ${insertErr.message}`);
    }
    return { ok: true, id: safe };
  }

  // ─── Cron-Job Wiring (Task 6.3) ──────────────────────────────────────────

  async function findRecentUnclassified(agent, { sinceMinutes = 30 } = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    await ensureClassificationColumns(agent, table);
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
    await ensureClassificationColumns(agent, table);
    const safeId = String(id).replace(/[^a-zA-Z0-9\-]/g, "");
    const safeType = String(type || "").replace(/[^a-zA-Z0-9_]/g, "");
    if (!safeId) throw new Error(`db-adapter: ungültige Card-ID '${id}'`);
    if (!safeType) throw new Error(`db-adapter: ungültiger type '${type}'`);
    try {
      await table.update({
        values: { type: safeType },
        where: `id = '${safeId}'`,
      });
      return { ok: true, id: safeId, type: safeType };
    } catch (err) {
      throw new Error(`db-adapter: updateCardType failed: ${err.message}`);
    }
  }

  async function findUnconfirmedCritical(agent, { olderThan = 0 } = {}) {
    const table = await resolveTable(agent);
    if (!table) return [];
    await ensureClassificationColumns(agent, table);
    const CRITICAL = [
      "person",
      "beziehung",
      "geburtstag",
      "geld_konto",
      "gesundheit",
      "zugang_passwort",
    ];
    try {
      const rows = await table
        .query()
        .where(`createdAt <= ${olderThan}`)
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
    await ensureClassificationColumns(agent, table);
    const safeId = String(id).replace(/[^a-zA-Z0-9\-]/g, "");
    if (!safeId) throw new Error(`db-adapter: ungültige Card-ID '${id}'`);
    try {
      // confirmed als Int (1) — addColumns nutzt 0 als Default
      await table.update({
        values: { confirmed: 1 },
        where: `id = '${safeId}'`,
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
    // Für Tests + Phase 5
    _resolveTable: resolveTable,
    _ensureClassificationColumns: ensureClassificationColumns,
  };
}
