import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createReembeddingCoordinator } from "../lib/reembedding/coordinator.js";
import { normalizeEmbeddingFingerprint } from "../lib/reembedding/fingerprint.js";
import { createMigrationStateStore } from "../lib/reembedding/state-store.js";
import { stableNonVectorRowHash } from "../lib/reembedding/lance-backend.js";

const sourceFingerprint = normalizeEmbeddingFingerprint({
  provider: "local-transformers",
  model: "source-model",
  revision: "source-revision",
  dimensions: 3,
}, []);
const targetFingerprint = normalizeEmbeddingFingerprint({
  provider: "openai",
  model: "target-model",
  dimensions: 4,
}, []);
const sourceRows = [
  { id: "11111111-1111-4111-8111-111111111111", text: "alpha", status: "active", vector: [1, 0, 0] },
  { id: "22222222-2222-4222-8222-222222222222", text: "beta", status: "archived", vector: [0, 1, 0] },
  { id: "33333333-3333-4333-8333-333333333333", text: "gamma", status: "active", vector: [0, 0, 1] },
];

function fakeBackend(rows = sourceRows) {
  const target = new Map();
  let version = "source-version-1";
  let generationCreated = false;
  let closed = false;
  return {
    target,
    setVersion(value) { version = value; },
    async inventoryActiveGeneration() {
      return [{
        generation: "generation-active",
        configRevision: "config-a",
        fingerprint: sourceFingerprint,
        tables: [{
          tableId: "agent-a/memories",
          version,
          rowCount: rows.length,
          estimatedBytes: 1_000,
          dimensions: 3,
        }],
      }];
    },
    async createQuarantinedGeneration() {
      if (generationCreated) throw new Error("target generation already exists");
      generationCreated = true;
    },
    async describeGeneration() {
      return generationCreated ? { generation: "generation-target", dimensions: 4 } : null;
    },
    async readSourceBatch(_tableId, { offset, limit }) { return rows.slice(offset, offset + limit); },
    async writeTargetBatch(_generation, _tableId, rows) {
      let added = 0;
      for (const row of rows) {
        const prior = target.get(row.id);
        if (prior) {
          assert.equal(stableNonVectorRowHash(prior), stableNonVectorRowHash(row));
          assert.deepStrictEqual(prior.vector, row.vector);
        } else {
          target.set(row.id, structuredClone(row));
          added += 1;
        }
      }
      return { added, existing: rows.length - added };
    },
    async readBackTargetRows(_generation, _tableId, ids) { return ids.flatMap((id) => target.has(id) ? [structuredClone(target.get(id))] : []); },
    async validateGeneration() {
      if (target.size !== rows.length) throw new Error("wrong target count");
      return { tables: 1, rows: target.size, dimensions: 4 };
    },
    async close() { closed = true; },
    get closed() { return closed; },
  };
}

describe("resumable reembedding coordinator", () => {
  let stateRoot;
  beforeEach(() => { stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-reembedding-coordinator-")); });
  afterEach(() => { rmSync(stateRoot, { recursive: true, force: true }); });

  it("keeps default CPU inference batches small enough for Gateway liveness", async () => {
    const rows = Array.from({ length: 17 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text: `synthetic row ${index + 1}`,
      status: "active",
      vector: [1, 0, 0],
    }));
    const backend = fakeBackend(rows);
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const observedBatchSizes = [];
    const coordinator = createReembeddingCoordinator({
      stateStore,
      backend,
      createTargetProvider: async () => ({
        async embedBatch(texts) {
          observedBatchSizes.push(texts.length);
          return texts.map((text) => [text.length, 1, 2, 3]);
        },
        async shutdown() {},
      }),
      plannerDependencies: {
        now: () => 1_000,
        randomBytes: () => Buffer.alloc(32, 8),
        statDisk: async () => ({ freeBytes: 1_000_000 }),
        probeTargetProvider: async () => [0, 1, 2, 3],
      },
      runValidationProbes: async () => ({ semanticRecall: true }),
    });
    const planned = await coordinator.plan({
      id: "migration-liveness",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
    });

    const applied = await coordinator.apply({ id: planned.record.id, token: planned.confirmation.token });

    assert.equal(applied.cursor.completedRows, rows.length);
    assert.deepStrictEqual(observedBatchSizes, [8, 8, 1]);
    await coordinator.shutdown();
  });

  it("does not advance a cursor until target readback and resumes idempotently after a crash", async () => {
    const backend = fakeBackend();
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    let crashOnce = true;
    const provider = {
      async embedBatch(texts) { return texts.map((text) => [text.length, 1, 2, 3]); },
      async shutdown() {},
    };
    const coordinator = createReembeddingCoordinator({
      stateStore,
      backend,
      createTargetProvider: async () => provider,
      plannerDependencies: {
        now: () => 1_000,
        randomBytes: () => Buffer.alloc(32, 8),
        statDisk: async () => ({ freeBytes: 1_000_000 }),
        probeTargetProvider: async () => [0, 1, 2, 3],
      },
      afterTargetWrite: async () => {
        if (crashOnce) { crashOnce = false; throw new Error("injected crash after target write"); }
      },
      runValidationProbes: async () => ({ deterministicSamples: 2, semanticRecall: true }),
      limits: { batchSize: 2, concurrency: 1, maxCalls: 10, maxBytes: 1_000_000, deadlineMs: 60_000 },
    });
    const planned = await coordinator.plan({
      id: "migration-0001",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
    });

    await assert.rejects(coordinator.apply({ id: "migration-0001", token: planned.confirmation.token }), /injected crash/);
    assert.equal((await coordinator.status("migration-0001")).cursor.completedRows, 0);
    assert.equal(backend.target.size, 2, "write happened but unverified cursor did not advance");

    const applied = await coordinator.resume({ id: "migration-0001", token: planned.confirmation.token });
    assert.equal(applied.state, "validating");
    assert.equal(applied.cursor.completedRows, sourceRows.length);
    assert.equal(backend.target.size, sourceRows.length);
    const validated = await coordinator.validate({ id: "migration-0001" });
    assert.equal(validated.state, "ready_to_switch");
    assert.equal(validated.receipts.validation.semanticRecall, true);
    await coordinator.shutdown();
    assert.equal(backend.closed, true);
  });

  it("fails closed on source-version drift before writing the next batch", async () => {
    const backend = fakeBackend();
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const coordinator = createReembeddingCoordinator({
      stateStore,
      backend,
      createTargetProvider: async () => ({
        async embedBatch(texts) { return texts.map(() => [0, 1, 2, 3]); },
        async shutdown() {},
      }),
      plannerDependencies: {
        now: () => 1_000,
        randomBytes: () => Buffer.alloc(32, 8),
        statDisk: async () => ({ freeBytes: 1_000_000 }),
        probeTargetProvider: async () => [0, 1, 2, 3],
      },
      runValidationProbes: async () => ({ semanticRecall: true }),
    });
    const planned = await coordinator.plan({
      id: "migration-0001",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
    });
    backend.setVersion("source-version-drifted");
    await assert.rejects(
      coordinator.apply({ id: "migration-0001", token: planned.confirmation.token }),
      /source version drift/,
    );
    assert.equal(backend.target.size, 0);
    await coordinator.shutdown();
  });
});
