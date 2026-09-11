// Phase 7 - Memory Dynamics Maintenance.
// Processes retrieval ledger events and applies daily decay.

import { applyRetrievalReinforcement, applyDailyDecay, isCoreMemory } from "../memory-dynamics.js";
import { safeUuid } from "../sql-safety.js";
import { withTimeout, TimeoutError } from "../with-timeout.js";

const DEFAULT_LOGGER = { info() {}, warn() {}, error() {} };
const LEDGER_TAIL_LIMIT = 50_000;

function withJobTimeout(promise, label, timeoutMs, logger = DEFAULT_LOGGER) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return withTimeout(promise, timeoutMs, label).catch((err) => {
    if (err instanceof TimeoutError) {
      logger.warn?.(`${label}: timed out after ${timeoutMs}ms`);
      throw err;
    }
    throw err;
  });
}

function isValidMemoryId(id) {
  try {
    safeUuid(id);
    return true;
  } catch {
    return false;
  }
}

async function processRetrievalLedgerWork(db, neoStore, opts) {
  const {
    agentId = null,
    workspaceKey = null,
    batchSize = 100,
    maxUpdates = Infinity,
    logger = DEFAULT_LOGGER,
    dryRun = false,
  } = opts;

  const state = readRunState(neoStore);
  const stateKey = ledgerStateKey(agentId, workspaceKey);
  const priorWatermark = getLedgerWatermarkFromState(state, stateKey);
  const priorPendingEntry = getPendingLedgerEntryFromState(state, stateKey);
  const ledger = await neoStore.readRetrievalLedger(LEDGER_TAIL_LIMIT);
  const entries = (Array.isArray(ledger) ? ledger : [])
    .filter((entry) => matchesLedgerScope(entry, agentId, workspaceKey))
    .filter((entry) => ledgerTimestamp(entry) > priorWatermark)
    .sort((a, b) => ledgerTimestamp(a) - ledgerTimestamp(b))
    .slice(0, batchSize);

  let processed = 0;
  let failed = 0;
  let skippedInvalidIds = 0;
  let updated = 0;
  let truncated = false;
  const maxValidUpdates = Number.isFinite(Number(maxUpdates))
    ? Math.max(0, Math.floor(Number(maxUpdates)))
    : Infinity;
  let maxProcessedTimestamp = priorWatermark;
  let pendingEntry = priorPendingEntry;
  let progressChanged = false;

  entries:
  for (const entry of entries) {
    const timestamp = ledgerTimestamp(entry);
    const entryKey = ledgerEntryKey(entry);
    const selectedIds = Array.isArray(entry.selectedIds) ? entry.selectedIds.filter(Boolean) : [];
    const startIndex = pendingEntry?.entryKey === entryKey && pendingEntry?.timestamp === timestamp
      ? Math.min(Math.max(0, Number(pendingEntry.nextSelectedIndex) || 0), selectedIds.length)
      : 0;
    let entryFailed = false;
    let entryTruncated = false;
    let nextSelectedIndex = startIndex;

    for (let index = startIndex; index < selectedIds.length; index++) {
      const memoryId = selectedIds[index];
      if (!isValidMemoryId(memoryId)) {
        skippedInvalidIds++;
        nextSelectedIndex = index + 1;
        continue;
      }
      if (updated >= maxValidUpdates) {
        truncated = true;
        entryTruncated = true;
        nextSelectedIndex = index;
        break;
      }
      try {
        const row = await db.getById(memoryId);
        if (!row) {
          logger?.warn?.(`[dynamics] memory ${memoryId} missing for ledger entry ${entry.id}`);
          nextSelectedIndex = index + 1;
          continue;
        }
        const status = row.status || "active";
        if (status !== "active") {
          logger?.info?.(`[dynamics] memory ${memoryId} is ${status}, skipping reinforcement`);
          nextSelectedIndex = index + 1;
          continue;
        }
        if (!dryRun) {
          await db.update(memoryId, applyRetrievalReinforcement(row, timestamp || Date.now()));
        }
        updated++;
        nextSelectedIndex = index + 1;
        if (updated >= maxValidUpdates && nextSelectedIndex < selectedIds.length) {
          truncated = true;
          entryTruncated = true;
          break;
        }
      } catch (err) {
        entryFailed = true;
        logger?.warn?.(`[dynamics] failed to reinforce memory ${memoryId}: ${err.message}`);
        break;
      }
    }

    if (entryFailed) {
      failed++;
      break;
    } else if (entryTruncated) {
      pendingEntry = { entryKey, timestamp, nextSelectedIndex };
      progressChanged = true;
      break entries;
    } else {
      processed++;
      maxProcessedTimestamp = Math.max(maxProcessedTimestamp, timestamp);
      if (pendingEntry) {
        pendingEntry = null;
        progressChanged = true;
      }
    }
  }

  if (!dryRun && (maxProcessedTimestamp > priorWatermark || progressChanged)) {
    writeLedgerProgress(neoStore, state, stateKey, {
      watermark: maxProcessedTimestamp,
      pendingEntry,
    });
  }

  return {
    processed,
    failed,
    skippedInvalidIds,
    updated,
    truncated,
    watermark: maxProcessedTimestamp,
    pendingLedgerEntry: pendingEntry || undefined,
    dryRun,
  };
}

export async function processRetrievalLedger(db, neoStore, opts = {}) {
  const {
    agentId = null,
    workspaceKey = null,
    logger = DEFAULT_LOGGER,
    timeoutMs = null,
  } = opts;

  if (!db || typeof db.getById !== "function" || typeof db.update !== "function") {
    return { processed: 0, failed: 0, watermark: getLedgerWatermark(neoStore, agentId, workspaceKey), skipped: true, reason: "missing_db_api" };
  }
  if (!neoStore || typeof neoStore.readRetrievalLedger !== "function") {
    return { processed: 0, failed: 0, watermark: 0, skipped: true, reason: "missing_neo_store" };
  }

  try {
    return await withJobTimeout(
      processRetrievalLedgerWork(db, neoStore, opts),
      "processRetrievalLedger",
      timeoutMs,
      logger,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      return { processed: 0, failed: 0, watermark: 0, skipped: true, reason: "timeout", timeoutMs };
    }
    throw err;
  }
}

function normalizeDecayPartition(partition) {
  if (!partition || typeof partition !== "object") return null;
  const scope = partition.scope || "agent-private";
  if (!["agent-private", "workspace", "user"].includes(scope)) return null;
  const agentId = partition.agentId ? String(partition.agentId) : "";
  const workspaceIdentity = partition.workspaceIdentity ? String(partition.workspaceIdentity) : "";
  const ownerUserId = partition.ownerUserId ? String(partition.ownerUserId) : "";
  if (scope === "agent-private" && !agentId) return null;
  if (scope === "workspace" && !workspaceIdentity) return null;
  if (scope === "user" && !ownerUserId) return null;
  return { scope, agentId, workspaceIdentity, ownerUserId };
}

async function readTableFields(table) {
  if (typeof table?.schema !== "function") return null;
  try {
    const schema = await table.schema();
    return Array.isArray(schema?.fields) ? schema.fields.map((field) => field?.name).filter(Boolean) : null;
  } catch (_) {
    return null;
  }
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Spiegelt buildCompactionWhere (memory-compaction.js): Scope plus Besitzer-
// Praedikat. Ohne Schema-Information werden alle Spalten angenommen.
function decayPartitionWhere(partition, fields) {
  const has = (name) => !Array.isArray(fields) || fields.includes(name);
  const clauses = [];
  if (has("scope")) clauses.push(`scope = ${sqlLiteral(partition.scope)}`);
  if (partition.scope === "agent-private") {
    const predicates = [];
    if (has("agentId")) predicates.push(`agentId = ${sqlLiteral(partition.agentId)}`);
    if (has("storedBy")) predicates.push(`storedBy = ${sqlLiteral(partition.agentId)}`);
    if (predicates.length > 0) clauses.push(`(${predicates.join(" OR ")})`);
  } else if (partition.scope === "workspace") {
    const predicates = [];
    if (has("workspaceId")) predicates.push(`workspaceId = ${sqlLiteral(partition.workspaceIdentity)}`);
    if (has("workspaceKey")) predicates.push(`workspaceKey = ${sqlLiteral(partition.workspaceIdentity)}`);
    if (predicates.length > 0) clauses.push(`(${predicates.join(" OR ")})`);
  } else if (partition.scope === "user" && has("ownerUserId")) {
    clauses.push(`ownerUserId = ${sqlLiteral(partition.ownerUserId)}`);
  }
  return clauses.join(" AND ");
}

// Wie isLegacyCompactionRow (memory-compaction.js): eine agent-private Zeile
// ohne Besitzer gehoert der Tabelle des Agenten (Legacy-Zeilen vor dem ACL-
// Stempel). Die Where-Klausel bleibt strikt; hinter einem Guard erreichen
// solche Zeilen den Filter ohnehin nicht.
function rowInDecayPartition(row, partition) {
  const scope = row?.scope || "agent-private";
  if (scope !== partition.scope) return false;
  if (scope === "agent-private") {
    const owner = row.agentId || row.storedBy || "";
    return owner === "" || owner === partition.agentId;
  }
  if (scope === "workspace") return (row.workspaceId || row.workspaceKey || "") === partition.workspaceIdentity;
  return (row.ownerUserId || "") === partition.ownerUserId;
}

export async function applyDailyDecayToAll(db, opts = {}) {
  const {
    batchSize = 100,
    maxRows = Infinity,
    logger = DEFAULT_LOGGER,
    dryRun = false,
  } = opts;

  if (!db?.table?.query || typeof db.update !== "function") {
    return { decayed: 0, errors: 0, skipped: true, reason: "missing_db_api", dryRun };
  }
  // 7.12.29: Der Scan blieb bisher ungefiltert (ganze Tabelle). Hinter einem
  // partitionsgebundenen Guard fiel er bei der ersten Fremd-Scope-Zeile
  // (Traeume im user-Scope, alte workspace-Zeilen) mit "ACL denied for query"
  // komplett aus — bei allen Agenten, taeglich. Jetzt wird die Partition als
  // Where-Klausel gepusht und zusaetzlich je Zeile geprueft.
  const partition = normalizeDecayPartition(opts.partition);
  const fields = await readTableFields(db.table);
  const whereClause = partition ? decayPartitionWhere(partition, fields) : "";
  let useWhere = Boolean(whereClause);

  let decayed = 0;
  let errors = 0;
  let skippedInvalidIds = 0;
  let truncated = false;
  let deadlineHit = false;
  let nextCursorId = null;
  const cursorId = typeof opts.cursorId === "string" ? opts.cursorId : null;
  // 7.12.46: Zeitbudget — jedes Update kostet live 1-2 s, 300 Zeilen duerfen
  // die Konsolidierung nicht sprengen. Nach Ablauf bleibt der Cursor auf der
  // letzten verarbeiteten Zeile, der Rest folgt in der naechsten Nacht.
  const deadlineAt = Number.isFinite(Number(opts.deadlineMs)) && Number(opts.deadlineMs) > 0 ? Date.now() + Number(opts.deadlineMs) : null;
  const maxValidUpdates = Number.isFinite(Number(maxRows))
    ? Math.max(0, Math.floor(Number(maxRows)))
    : Infinity;
  const now = Date.now();

  try {
    const eligibleRows = [];
    const afterCursorRows = [];
    const wrapRows = [];
    const useBoundedSelection = Number.isFinite(maxValidUpdates);
    let eligibleCount = 0;
    let offset = 0;
    while (true) {
      let query = db.table.query().limit(batchSize);
      if (useWhere && typeof query.where === "function") query = query.where(whereClause);
      if (offset > 0) {
        if (typeof query.offset !== "function") break;
        query = query.offset(offset);
      }
      let rows;
      try {
        rows = await query.toArray();
      } catch (queryError) {
        // Ein Where, das die Tabelle nicht versteht, faellt auf den JS-Filter
        // zurueck; eine ACL-Ablehnung ist dagegen endgueltig.
        if (useWhere && offset === 0 && queryError?.code !== "PLUR1BUS_ACL_DENIED") {
          logger?.debug?.(`[dynamics] decay where clause rejected, scanning without pushdown: ${queryError?.message || queryError}`);
          useWhere = false;
          continue;
        }
        throw queryError;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        if (row.id === "__schema__") continue;
        if (partition && !rowInDecayPartition(row, partition)) continue;
        if (!isValidMemoryId(row.id)) {
          skippedInvalidIds++;
          continue;
        }
        const status = row.status || "active";
        if (status !== "active") continue;
        if (isCoreMemory(row)) continue;
        eligibleCount++;
        if (useBoundedSelection) {
          const rowId = String(row.id);
          if (cursorId && rowId <= cursorId) {
            insertSmallestById(wrapRows, row, maxValidUpdates);
          } else {
            insertSmallestById(afterCursorRows, row, maxValidUpdates);
          }
        } else {
          eligibleRows.push(row);
        }
      }

      if (rows.length < batchSize) break;
      offset += rows.length;
    }

    const decayRows = useBoundedSelection
      ? [...afterCursorRows, ...wrapRows].slice(0, maxValidUpdates)
      : eligibleRows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const startIndex = !useBoundedSelection && cursorId
      ? Math.max(0, decayRows.findIndex((row) => String(row.id) > cursorId))
      : 0;
    const normalizedStartIndex = startIndex === -1 ? 0 : startIndex;
    const maxAttempts = Math.min(maxValidUpdates, decayRows.length);
    truncated = maxAttempts < eligibleCount;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (deadlineAt !== null && Date.now() >= deadlineAt) {
        truncated = true;
        deadlineHit = true;
        break;
      }
      const row = decayRows[(normalizedStartIndex + attempt) % decayRows.length];

      try {
        const patch = applyDailyDecay(row, now);
        if (!dryRun) await db.update(row.id, patch);
        decayed++;
      } catch (err) {
        errors++;
        logger?.warn?.(`[dynamics] failed to decay memory ${row.id}: ${err.message}`);
      }
      nextCursorId = row.id;
    }
  } catch (err) {
    errors++;
    logger?.error?.(`[dynamics] failed to fetch rows for decay: ${err.message}`);
  }

  return { decayed, errors, skippedInvalidIds, truncated, deadlineHit, cursorId, nextCursorId, dryRun };
}

/**
 * 7.12.47: Decay als EIN Update-Statement statt je Zeile.
 *
 * Bis 7.12.46 lief der Decay Zeile fuer Zeile (`db.update(id, patch)` = ein
 * LanceDB-Commit je Zeile, live 0,6-1,5 s): mit Deckel 300 und 120 s Budget
 * schaffte main ~80 Zeilen je Nacht, ein Durchgang ueber 9385 Zeilen haette
 * vier Monate gedauert. LanceDB kann `update({ where, valuesSql })` mit
 * SQL-Ausdruecken — dieselbe Vergessenskurve S = S0 * 0.5^(elapsed/halfLife)
 * in einem Commit. Ohne CASE (in Lance nicht erlaubt): GREATEST(0, elapsed)
 * laesst Zeilen mit Zeitstempel in der Zukunft unveraendert (0.5^0 = 1),
 * COALESCE(..., now) faengt fehlende Zeitstempel ab. Ausgeschlossen wie im
 * Zeilenpfad: fremde Partition, nicht-aktive, Kern-Erinnerungen (memoryClass
 * core / neverForget), Nicht-UUID-IDs (Dokument-Fakten mit Hash-IDs).
 */
export function buildBatchDecaySql({ partition = null, fields = null, now = Date.now() } = {}) {
  const has = (name) => !fields || fields.has(name);
  const nowMs = Math.floor(Number(now));
  // Alles explizit DOUBLE: gemischte Int64/Float64-Vergleiche (NULLIF, =)
  // lehnt DataFusion ab, SIGN/CASE kennt Lance nicht. Juengster gueltiger
  // Zeitstempel = Maximum der drei Spalten (lastDynamicsAt ≥ lastStrengthenedAt
  // ≥ createdAt, wenn gesetzt). Sind alle 0/NULL, ist der Abstand riesig und
  // die Staerke faellt auf 0,01 — genau wie im Zeilenpfad (firstValidTimestamp
  // liefert 0). Zeitstempel in der Zukunft: GREATEST(0, …) → unveraendert.
  const dbl = (column) => `CAST(COALESCE(${column}, 0) AS DOUBLE)`;
  const tsColumns = ["lastDynamicsAt", "lastStrengthenedAt", "createdAt"].filter(has).map(dbl);
  const ts = tsColumns.length > 1 ? `GREATEST(${tsColumns.join(", ")})` : (tsColumns[0] || "0.0");
  const elapsed = `GREATEST(0.0, ${nowMs}.0 - ${ts})`;
  const halfLife = has("halfLifeDays") ? "GREATEST(1.0, CAST(COALESCE(halfLifeDays, 30) AS DOUBLE))" : "30.0";
  const s0 = has("memoryStrength") ? "LEAST(1.0, GREATEST(0.01, CAST(COALESCE(memoryStrength, 1.0) AS DOUBLE)))" : "1.0";
  const strength = `LEAST(1.0, GREATEST(0.01, ${s0} * power(0.5, ${elapsed} / (${halfLife} * 86400000.0))))`;

  const normalized = normalizeDecayPartition(partition);
  const clauses = [];
  const partitionWhere = normalized ? decayPartitionWhere(normalized, fields) : "";
  if (partitionWhere) clauses.push(`(${partitionWhere})`);
  if (has("status")) clauses.push("(status IS NULL OR status = 'active')");
  if (has("memoryClass")) clauses.push("(memoryClass IS NULL OR memoryClass <> 'core')");
  if (has("neverForget")) {
    // Spaltentyp entscheidet ueber das Literal: Int64 (live) vs. Boolean —
    // ein Boolean-Literal auf einer Zahlenspalte lehnt DataFusion ab.
    const type = fields instanceof Map ? String(fields.get("neverForget") || "") : "";
    clauses.push(/bool/i.test(type) ? "(neverForget IS NULL OR neverForget = false)" : "(neverForget IS NULL OR neverForget = 0)");
  }
  clauses.push("id LIKE '________-____-____-____-____________'");
  clauses.push("id <> '__schema__'");
  return {
    where: clauses.join(" AND "),
    valuesSql: { memoryStrength: strength, lastDynamicsAt: String(nowMs) },
    now: nowMs,
  };
}

const BATCH_DECAY_ACL_COLUMNS = ["id", "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId", "status"];

/**
 * Fuehrt den Batch-Decay aus. Wirft bei jedem Fehler — der Aufrufer faellt
 * dann auf den Zeilenpfad (applyDailyDecayToAll) zurueck.
 * @returns {Promise<{mode:"batch", decayed:number, errors:number, ms:number, dryRun:boolean, where:string}>}
 */
export async function applyDailyDecayBatch(db, opts = {}) {
  const { logger = DEFAULT_LOGGER, dryRun = false, now = Date.now() } = opts;
  if (!db?.table?.query || typeof db.table.update !== "function") {
    throw new Error("batch decay unavailable: table.update missing");
  }
  let fields = null;
  try {
    const schema = typeof db.table.schema === "function" ? await db.table.schema() : null;
    // Map Name → Typ (String), damit buildBatchDecaySql Literale typgerecht waehlt.
    if (schema?.fields) fields = new Map(schema.fields.map((f) => [f.name, String(f.type?.toString?.() ?? f.type ?? "")]));
  } catch (_) {
    fields = null;
  }
  const partition = normalizeDecayPartition(opts.partition);
  const sql = buildBatchDecaySql({ partition, fields, now });
  if (partition && !decayPartitionWhere(partition, fields)) {
    throw new Error("batch decay unavailable: partition not expressible as where clause");
  }
  const startedAt = Date.now();
  // Zaehlen ueber die ACL-Spalten: der Guard prueft jede gelesene Zeile,
  // braucht dafuer aber weder Text noch Vektor.
  const columns = fields ? BATCH_DECAY_ACL_COLUMNS.filter((c) => fields.has(c)) : BATCH_DECAY_ACL_COLUMNS;
  let countQuery = db.table.query().where(sql.where);
  if (typeof countQuery.select === "function") countQuery = countQuery.select(columns);
  const matching = await countQuery.limit(1_000_000).toArray();
  const decayed = Array.isArray(matching) ? matching.length : 0;
  if (!dryRun && decayed > 0) {
    // Zwei Statements, bewusst: Lance wertet mehrere valuesSql-Zuweisungen
    // nacheinander in unbestimmter Reihenfolge aus (HashMap) — stand
    // lastDynamicsAt zuerst, sah die Staerke schon den neuen Zeitstempel und
    // blieb unveraendert (reproduziert 11.09.2026: mal 0,3969, mal 1,0).
    await db.table.update({ where: sql.where, valuesSql: { memoryStrength: sql.valuesSql.memoryStrength } });
    await db.table.update({ where: sql.where, valuesSql: { lastDynamicsAt: sql.valuesSql.lastDynamicsAt } });
  }
  const ms = Date.now() - startedAt;
  logger?.info?.(`[dynamics] batch decay ${dryRun ? "(dry-run) " : ""}rows=${decayed} ms=${ms}`);
  return { mode: "batch", decayed, errors: 0, skippedInvalidIds: 0, truncated: false, deadlineHit: false, ms, dryRun, where: sql.where };
}

function insertSmallestById(rows, row, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return;
  rows.push(row);
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (rows.length > limit) rows.pop();
}

function matchesLedgerScope(entry, agentId, workspaceKey) {
  if (agentId && entry.agentId !== agentId) return false;
  if (workspaceKey && entry.workspaceKey !== workspaceKey) return false;
  return true;
}

function ledgerTimestamp(entry) {
  const direct = Number(entry?.timestamp);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Number(new Date(entry?.createdAt || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function ledgerEntryKey(entry) {
  if (entry?.id) return String(entry.id);
  const selectedIds = Array.isArray(entry?.selectedIds) ? entry.selectedIds.join(",") : "";
  return `${ledgerTimestamp(entry)}:${selectedIds}`;
}

function ledgerStateKey(agentId, workspaceKey) {
  return `${agentId || "all"}:${workspaceKey || "all"}`;
}

function readRunState(neoStore) {
  if (!neoStore || typeof neoStore.readRunState !== "function") return {};
  try {
    return neoStore.readRunState() || {};
  } catch {
    return {};
  }
}

function getLedgerWatermark(neoStore, agentId, workspaceKey) {
  return getLedgerWatermarkFromState(readRunState(neoStore), ledgerStateKey(agentId, workspaceKey));
}

function getLedgerWatermarkFromState(state, stateKey) {
  return Number(state?.memoryDynamics?.[stateKey]?.lastRetrievalLedgerProcessedAt || 0);
}

function getPendingLedgerEntryFromState(state, stateKey) {
  const pending = state?.memoryDynamics?.[stateKey]?.pendingRetrievalLedgerEntry;
  if (!pending || typeof pending !== "object") return null;
  const entryKey = String(pending.entryKey || "");
  const timestamp = Number(pending.timestamp || 0);
  const nextSelectedIndex = Number(pending.nextSelectedIndex || 0);
  if (!entryKey || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return {
    entryKey,
    timestamp,
    nextSelectedIndex: Number.isFinite(nextSelectedIndex) && nextSelectedIndex > 0
      ? Math.floor(nextSelectedIndex)
      : 0,
  };
}

function writeLedgerProgress(neoStore, state, stateKey, { watermark, pendingEntry }) {
  if (!neoStore || typeof neoStore.writeRunState !== "function") return;
  const previous = state.memoryDynamics?.[stateKey] || {};
  const nextEntry = {
    ...previous,
    lastRetrievalLedgerProcessedAt: watermark,
  };
  if (pendingEntry) {
    nextEntry.pendingRetrievalLedgerEntry = pendingEntry;
  } else {
    delete nextEntry.pendingRetrievalLedgerEntry;
  }
  neoStore.writeRunState({
    ...state,
    memoryDynamics: {
      ...(state.memoryDynamics || {}),
      [stateKey]: nextEntry,
    },
  });
}
