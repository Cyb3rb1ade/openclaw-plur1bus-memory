// Phase 7 - Memory Dynamics Maintenance.
// Processes retrieval ledger events and applies daily decay.

import { applyRetrievalReinforcement, applyDailyDecay, isCoreMemory } from "../memory-dynamics.js";

const DEFAULT_LOGGER = { info() {}, warn() {}, error() {} };
const LEDGER_TAIL_LIMIT = 50_000;

export async function processRetrievalLedger(db, neoStore, opts = {}) {
  const {
    agentId = null,
    workspaceKey = null,
    batchSize = 100,
    logger = DEFAULT_LOGGER,
    dryRun = false,
  } = opts;

  if (!db || typeof db.getById !== "function" || typeof db.update !== "function") {
    return { processed: 0, failed: 0, watermark: getLedgerWatermark(neoStore, agentId, workspaceKey), skipped: true, reason: "missing_db_api" };
  }
  if (!neoStore || typeof neoStore.readRetrievalLedger !== "function") {
    return { processed: 0, failed: 0, watermark: 0, skipped: true, reason: "missing_neo_store" };
  }

  const state = readRunState(neoStore);
  const stateKey = ledgerStateKey(agentId, workspaceKey);
  const priorWatermark = getLedgerWatermarkFromState(state, stateKey);
  const ledger = await neoStore.readRetrievalLedger(LEDGER_TAIL_LIMIT);
  const entries = (Array.isArray(ledger) ? ledger : [])
    .filter((entry) => matchesLedgerScope(entry, agentId, workspaceKey))
    .filter((entry) => ledgerTimestamp(entry) > priorWatermark)
    .sort((a, b) => ledgerTimestamp(a) - ledgerTimestamp(b))
    .slice(0, batchSize);

  let processed = 0;
  let failed = 0;
  let maxProcessedTimestamp = priorWatermark;

  for (const entry of entries) {
    const timestamp = ledgerTimestamp(entry);
    const selectedIds = Array.isArray(entry.selectedIds) ? entry.selectedIds.filter(Boolean) : [];
    let entryFailed = false;

    for (const memoryId of selectedIds) {
      try {
        const row = await db.getById(memoryId);
        if (!row) {
          logger?.warn?.(`[dynamics] memory ${memoryId} missing for ledger entry ${entry.id}`);
          continue;
        }
        const status = row.status || "active";
        if (status !== "active") {
          logger?.info?.(`[dynamics] memory ${memoryId} is ${status}, skipping reinforcement`);
          continue;
        }
        if (!dryRun) {
          await db.update(memoryId, applyRetrievalReinforcement(row, timestamp || Date.now()));
        }
      } catch (err) {
        entryFailed = true;
        logger?.warn?.(`[dynamics] failed to reinforce memory ${memoryId}: ${err.message}`);
      }
    }

    if (entryFailed) {
      failed++;
    } else {
      processed++;
      maxProcessedTimestamp = Math.max(maxProcessedTimestamp, timestamp);
    }
  }

  if (!dryRun && failed === 0 && maxProcessedTimestamp > priorWatermark) {
    writeLedgerWatermark(neoStore, state, stateKey, maxProcessedTimestamp);
  }

  return {
    processed,
    failed,
    watermark: failed === 0 ? maxProcessedTimestamp : priorWatermark,
    dryRun,
  };
}

export async function applyDailyDecayToAll(db, opts = {}) {
  const {
    batchSize = 100,
    logger = DEFAULT_LOGGER,
    dryRun = false,
  } = opts;

  if (!db?.table?.query || typeof db.update !== "function") {
    return { decayed: 0, errors: 0, skipped: true, reason: "missing_db_api", dryRun };
  }

  let decayed = 0;
  let errors = 0;
  const now = Date.now();

  try {
    const rows = await db.table.query().limit(batchSize).toArray();
    for (const row of rows) {
      if (row.id === "__schema__") continue;
      const status = row.status || "active";
      if (status !== "active") continue;
      if (isCoreMemory(row)) continue;

      try {
        const patch = applyDailyDecay(row, now);
        if (!dryRun) await db.update(row.id, patch);
        decayed++;
      } catch (err) {
        errors++;
        logger?.warn?.(`[dynamics] failed to decay memory ${row.id}: ${err.message}`);
      }
    }
  } catch (err) {
    errors++;
    logger?.error?.(`[dynamics] failed to fetch rows for decay: ${err.message}`);
  }

  return { decayed, errors, dryRun };
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

function writeLedgerWatermark(neoStore, state, stateKey, watermark) {
  if (!neoStore || typeof neoStore.writeRunState !== "function") return;
  neoStore.writeRunState({
    ...state,
    memoryDynamics: {
      ...(state.memoryDynamics || {}),
      [stateKey]: {
        ...(state.memoryDynamics?.[stateKey] || {}),
        lastRetrievalLedgerProcessedAt: watermark,
      },
    },
  });
}
