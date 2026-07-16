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

  let decayed = 0;
  let errors = 0;
  let skippedInvalidIds = 0;
  let truncated = false;
  let nextCursorId = null;
  const cursorId = typeof opts.cursorId === "string" ? opts.cursorId : null;
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
      if (offset > 0) {
        if (typeof query.offset !== "function") break;
        query = query.offset(offset);
      }
      const rows = await query.toArray();
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        if (row.id === "__schema__") continue;
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

  return { decayed, errors, skippedInvalidIds, truncated, cursorId, nextCursorId, dryRun };
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
