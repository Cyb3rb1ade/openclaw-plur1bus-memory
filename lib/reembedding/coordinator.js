import { performance } from "node:perf_hooks";

import { stableNonVectorRowHash } from "./lance-backend.js";
import { createReembeddingPlan } from "./planner.js";
import { verifyMigrationConfirmation } from "./confirmation.js";

const DEFAULT_LIMITS = Object.freeze({
  // CPU-backed Transformers inference runs on the Gateway event loop. Keep a
  // single batch below OpenClaw's liveness window so status polling and the
  // operator WebSocket remain responsive during a migration.
  batchSize: 8,
  concurrency: 1,
  // Bound each operator RPC to a small number of durable batches. Large
  // migrations advance through explicit resume calls instead of holding one
  // OpenClaw Gateway request beyond its fixed deadline.
  maxBatchesPerOperation: 4,
  maxCalls: 100_000,
  maxBytes: 4 * 1024 * 1024 * 1024,
  deadlineMs: 60 * 60 * 1000,
});

function normalizeLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, maximum] of [
    ["batchSize", 1_000],
    ["concurrency", 8],
    ["maxBatchesPerOperation", 1_000],
    ["maxCalls", 1_000_000],
    ["maxBytes", Number.MAX_SAFE_INTEGER],
    ["deadlineMs", 24 * 60 * 60 * 1000],
  ]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > maximum) {
      throw new Error(`invalid reembedding limit: ${name}`);
    }
  }
  return Object.freeze(limits);
}

function cursorFor(record) {
  const cursor = record.cursor || {};
  return {
    tableIndex: Number.isSafeInteger(cursor.tableIndex) ? cursor.tableIndex : 0,
    offset: Number.isSafeInteger(cursor.offset) ? cursor.offset : 0,
    completedRows: Number.isSafeInteger(cursor.completedRows) ? cursor.completedRows : 0,
    providerCalls: Number.isSafeInteger(cursor.providerCalls) ? cursor.providerCalls : 0,
    bytes: Number.isSafeInteger(cursor.bytes) ? cursor.bytes : 0,
  };
}

function vectorValue(row) {
  if (Array.isArray(row?.vector)) return row.vector;
  if (ArrayBuffer.isView(row?.vector)) return Array.from(row.vector);
  if (row?.vector && typeof row.vector.toArray === "function") return Array.from(row.vector.toArray());
  return row?.vector;
}

function compareReadBack(sourceRows, targetRows, dimensions) {
  if (sourceRows.length !== targetRows.length) throw new Error("target readback row count mismatch");
  const targets = new Map(targetRows.map((row) => [row.id, row]));
  for (const source of sourceRows) {
    const target = targets.get(source.id);
    if (!target) throw new Error(`target readback missing row: ${source.id}`);
    if (stableNonVectorRowHash(source) !== stableNonVectorRowHash(target)) {
      throw new Error(`target readback metadata mismatch: ${source.id}`);
    }
    const vector = vectorValue(target);
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`target readback vector mismatch: ${source.id}`);
    }
  }
}

function policySnapshotId(value) {
  return value === undefined ? null : JSON.stringify(value);
}

/** Coordinate bounded, durable copy/readback/validation work. */
export function createReembeddingCoordinator({
  stateStore,
  backend,
  createTargetProvider,
  plannerDependencies = {},
  readPolicySnapshot,
  afterTargetWrite,
  runValidationProbes,
  limits: rawLimits,
} = {}) {
  if (!stateStore || typeof stateStore.create !== "function" || typeof stateStore.transition !== "function") {
    throw new Error("reembedding state store is required");
  }
  if (!backend || typeof backend.inventoryActiveGeneration !== "function") throw new Error("reembedding backend is required");
  if (typeof createTargetProvider !== "function") throw new Error("target embedding provider factory is required");
  if (typeof runValidationProbes !== "function") throw new Error("reembedding validation probe capability is required");
  const limits = normalizeLimits(rawLimits);
  const now = typeof plannerDependencies.now === "function" ? plannerDependencies.now : Date.now;
  const monotonicNow = typeof plannerDependencies.monotonicNow === "function" ? plannerDependencies.monotonicNow : () => performance.now();
  let activeOperation = null;
  let shuttingDown = false;
  let provider = null;

  const exclusive = async (operation) => {
    if (shuttingDown) throw new Error("reembedding coordinator is shutting down");
    if (activeOperation) throw new Error("another reembedding coordinator operation is active");
    const promise = Promise.resolve().then(operation);
    activeOperation = promise;
    try {
      return await promise;
    } finally {
      if (activeOperation === promise) activeOperation = null;
    }
  };

  const assertSourceVersions = async (record) => {
    const inventory = await backend.inventoryActiveGeneration();
    if (!Array.isArray(inventory) || inventory.length !== 1 || inventory[0].generation !== record.source.generation) {
      throw new Error("reembedding source generation drift");
    }
    if ((inventory[0].configRevision ?? null) !== (record.source.configRevision ?? null)) {
      throw new Error("reembedding source config revision drift");
    }
    const actual = new Map(inventory[0].tables.map((table) => [table.tableId, String(table.version)]));
    for (const table of record.source.tables) {
      if (actual.get(table.tableId) !== String(table.version)) {
        throw new Error(`reembedding source version drift: ${table.tableId}`);
      }
    }
    if (typeof readPolicySnapshot === "function") {
      const current = policySnapshotId(await readPolicySnapshot());
      if (current !== (record.policyRevision ?? null)) throw new Error("reembedding workspace policy changed; explicit resume required");
    }
  };

  const targetProvider = async (record) => {
    provider ??= await createTargetProvider({
      fingerprint: record.target.fingerprint,
      secretRef: record.target.secretRef,
    });
    if (!provider || (typeof provider.embedBatch !== "function" && typeof provider.embedPassage !== "function" && typeof provider.embed !== "function")) {
      throw new Error("target embedding provider is invalid");
    }
    return provider;
  };

  const embedRows = async (record, rows) => {
    const currentProvider = await targetProvider(record);
    const texts = rows.map((row) => {
      if (typeof row.text !== "string") throw new Error(`source row text is invalid: ${row.id}`);
      return row.text;
    });
    let vectors;
    if (typeof currentProvider.embedBatch === "function") {
      vectors = await currentProvider.embedBatch(texts, 3, { purpose: "reembedding" });
    } else {
      vectors = await Promise.all(texts.map((text) => (
        typeof currentProvider.embedPassage === "function"
          ? currentProvider.embedPassage(text, { purpose: "reembedding" })
          : currentProvider.embed(text, { purpose: "reembedding" })
      )));
    }
    if (!Array.isArray(vectors) || vectors.length !== rows.length) throw new Error("target embedding batch result mismatch");
    return rows.map((row, index) => ({ ...row, vector: vectorValue({ vector: vectors[index] }) }));
  };

  const ensureTarget = async (record) => {
    if (record.receipts?.targetCreated === true) return record;
    try {
      await backend.createQuarantinedGeneration({
        generation: record.target.generation,
        fingerprintId: record.target.fingerprintId,
        dimensions: record.target.fingerprint.dimensions,
        tables: record.source.tables,
      });
    } catch (error) {
      if (!/already exists/i.test(String(error?.message)) || typeof backend.describeGeneration !== "function") throw error;
      const existing = await backend.describeGeneration(record.target.generation);
      if (
        !existing
        || existing.generation !== record.target.generation
        || existing.dimensions !== record.target.fingerprint.dimensions
        || (existing.fingerprintId && existing.fingerprintId !== record.target.fingerprintId)
      ) throw new Error("existing target generation does not match the migration plan");
    }
    return stateStore.update(record.id, {
      expectedRevision: record.revision,
      expectedState: "running",
      patch: { receipts: { ...(record.receipts || {}), targetCreated: true } },
    });
  };

  const runBatches = async (initialRecord, token) => {
    if (!verifyMigrationConfirmation(token, initialRecord.confirmation, now())) {
      throw new Error("invalid or expired reembedding confirmation");
    }
    let record = initialRecord;
    await assertSourceVersions(record);
    record = await ensureTarget(record);
    const startedAt = monotonicNow();
    let cursor = cursorFor(record);
    let completedBatches = 0;
    for (let tableIndex = cursor.tableIndex; tableIndex < record.source.tables.length; tableIndex += 1) {
      const table = record.source.tables[tableIndex];
      let offset = tableIndex === cursor.tableIndex ? cursor.offset : 0;
      while (offset < table.rowCount) {
        if (monotonicNow() - startedAt > limits.deadlineMs) throw new Error("reembedding deadline exceeded");
        await assertSourceVersions(record);
        const rows = await backend.readSourceBatch(table.tableId, { offset, limit: limits.batchSize });
        if (!Array.isArray(rows) || rows.length === 0) throw new Error(`source batch ended before inventory count: ${table.tableId}`);
        if (cursor.providerCalls + 1 > limits.maxCalls) throw new Error("reembedding provider call budget exceeded");
        const batchBytes = Buffer.byteLength(JSON.stringify(rows));
        if (cursor.bytes + batchBytes > limits.maxBytes) throw new Error("reembedding byte budget exceeded");
        const migratedRows = await embedRows(record, rows);
        await backend.writeTargetBatch(record.target.generation, table.tableId, migratedRows);
        await afterTargetWrite?.({ record, table, rows: migratedRows });
        const readBack = await backend.readBackTargetRows(
          record.target.generation,
          table.tableId,
          rows.map((row) => row.id),
        );
        compareReadBack(rows, readBack, record.target.fingerprint.dimensions);
        offset += rows.length;
        cursor = {
          tableIndex,
          offset,
          completedRows: cursor.completedRows + rows.length,
          providerCalls: cursor.providerCalls + 1,
          bytes: cursor.bytes + batchBytes,
        };
        if (offset >= table.rowCount) cursor = { ...cursor, tableIndex: tableIndex + 1, offset: 0 };
        record = await stateStore.update(record.id, {
          expectedRevision: record.revision,
          expectedState: "running",
          patch: { cursor },
        });
        completedBatches += 1;
        if (
          completedBatches >= limits.maxBatchesPerOperation
          && cursor.tableIndex < record.source.tables.length
        ) return record;
      }
    }
    return stateStore.transition(record.id, "running", "validating", {
      expectedRevision: record.revision,
      patch: { cursor },
    });
  };

  const plan = (request) => exclusive(async () => {
    const result = await createReembeddingPlan(request, {
      ...plannerDependencies,
      inventoryActiveGeneration: backend.inventoryActiveGeneration,
    });
    const policyRevision = typeof readPolicySnapshot === "function"
      ? policySnapshotId(await readPolicySnapshot())
      : null;
    const record = await stateStore.create({
      id: result.plan.id,
      state: "planned",
      planDigest: result.planDigest,
      confirmation: result.confirmation.persisted,
      source: result.plan.source,
      target: result.plan.target,
      cursor: cursorFor({}),
      receipts: { targetCreated: false },
      policyRevision,
    });
    return { ...result, record };
  });

  const apply = ({ id, token } = {}) => exclusive(async () => {
    let record = stateStore.get(id);
    if (!record) throw new Error("reembedding migration not found");
    if (!verifyMigrationConfirmation(token, record.confirmation, now())) throw new Error("invalid or expired reembedding confirmation");
    if (record.state === "planned") {
      record = await stateStore.transition(id, "planned", "confirmed", { expectedRevision: record.revision });
    }
    if (record.state === "confirmed") {
      record = await stateStore.transition(id, "confirmed", "running", {
        expectedRevision: record.revision,
        patch: { cursor: cursorFor(record), receipts: { ...(record.receipts || {}), targetCreated: false } },
      });
    }
    if (record.state !== "running") throw new Error(`reembedding apply requires planned, confirmed, or running state; found ${record.state}`);
    return runBatches(record, token);
  });

  const resume = ({ id, token } = {}) => exclusive(async () => {
    const record = stateStore.get(id);
    if (!record) throw new Error("reembedding migration not found");
    if (!verifyMigrationConfirmation(token, record.confirmation, now())) {
      throw new Error("invalid or expired reembedding confirmation");
    }
    if (record.state === "validating") return record;
    if (record.state !== "running") throw new Error(`reembedding resume requires running state; found ${record.state}`);
    return runBatches(record, token);
  });

  const validate = ({ id } = {}) => exclusive(async () => {
    let record = stateStore.get(id);
    if (!record) throw new Error("reembedding migration not found");
    if (record.state !== "validating") throw new Error(`reembedding validate requires validating state; found ${record.state}`);
    await assertSourceVersions(record);
    const generation = await backend.validateGeneration(record.target.generation);
    const probes = await runValidationProbes({ record, backend, provider: await targetProvider(record) });
    if (!probes || probes.semanticRecall !== true) throw new Error("reembedding semantic recall validation failed");
    record = await stateStore.transition(id, "validating", "ready_to_switch", {
      expectedRevision: record.revision,
      patch: {
        receipts: {
          ...(record.receipts || {}),
          validation: { ...generation, ...probes },
        },
      },
    });
    return record;
  });

  const status = async (id) => stateStore.get(id);
  const shutdown = async () => {
    const errors = [];
    if (shuttingDown && !activeOperation && !provider) return;
    shuttingDown = true;
    if (activeOperation) {
      try { await activeOperation; } catch (error) { errors.push(error); }
    }
    try { await provider?.shutdown?.(); } catch (error) { errors.push(error); }
    try { await backend.close?.(); } catch (error) { errors.push(error); }
    provider = null;
    if (errors.length) throw new AggregateError(errors, "reembedding coordinator shutdown failed");
  };

  return Object.freeze({ plan, apply, resume, validate, status, shutdown });
}
