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

function coordinatorWithProvider({ stateRoot, backend = fakeBackend(), createTargetProvider }) {
  const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
  const coordinator = createReembeddingCoordinator({
    stateStore,
    backend,
    createTargetProvider,
    plannerDependencies: {
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 8),
      statDisk: async () => ({ freeBytes: 1_000_000 }),
      probeTargetProvider: async () => [0, 1, 2, 3],
    },
    runValidationProbes: async () => ({ semanticRecall: true }),
  });
  return { backend, coordinator };
}

async function expiredProviderRotation({ stateRoot, shutdownFirstProvider, closeBackend = async () => {} }) {
  let clock = 1_000;
  const backend = fakeBackend([sourceRows[0]]);
  const generations = new Set();
  backend.createQuarantinedGeneration = async ({ generation }) => {
    if (generations.has(generation)) throw new Error("target generation already exists");
    generations.add(generation);
  };
  backend.describeGeneration = async (generation) => (
    generations.has(generation) ? { generation, dimensions: 4 } : null
  );
  backend.close = closeBackend;
  const factoryModels = [];
  const providerEvents = [];
  const stateStore = createMigrationStateStore({ stateRoot, now: () => clock });
  const coordinator = createReembeddingCoordinator({
    stateStore,
    backend,
    createTargetProvider: async ({ fingerprint }) => {
      factoryModels.push(fingerprint.model);
      return {
        async embedBatch(texts) {
          providerEvents.push(`embed:${fingerprint.model}`);
          return texts.map((text) => [text.length, 1, 2, 3]);
        },
        async shutdown() {
          providerEvents.push(`shutdown:${fingerprint.model}`);
          if (fingerprint.model === "target-model") await shutdownFirstProvider();
        },
      };
    },
    plannerDependencies: {
      now: () => clock,
      randomBytes: () => Buffer.alloc(32, 8),
      statDisk: async () => ({ freeBytes: 1_000_000 }),
      probeTargetProvider: async () => [0, 1, 2, 3],
    },
    runValidationProbes: async () => ({ semanticRecall: true }),
  });
  const first = await coordinator.plan({
    id: "migration-provider-first",
    targetGeneration: "generation-target",
    target: { fingerprint: targetFingerprint },
    confirmationTtlMs: 1_000,
  });
  await coordinator.apply({ id: first.record.id, token: first.confirmation.token });
  clock = 2_000;
  const replacementFingerprint = normalizeEmbeddingFingerprint({
    provider: "openai",
    model: "target-replacement-model",
    dimensions: 4,
  }, []);
  const replacement = await coordinator.plan({
    id: "migration-provider-replacement",
    targetGeneration: "generation-replacement",
    target: { fingerprint: replacementFingerprint },
  });
  return { coordinator, factoryModels, providerEvents, replacement };
}

describe("resumable reembedding coordinator", () => {
  let stateRoot;
  beforeEach(() => { stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-reembedding-coordinator-")); });
  afterEach(() => { rmSync(stateRoot, { recursive: true, force: true }); });

  it("keeps each default CPU inference operation to one Gateway-safe batch", async () => {
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
    assert.equal(applied.state, "running");
    assert.equal(applied.cursor.completedRows, 8);
    assert.deepStrictEqual(observedBatchSizes, [8]);
    const resumed = await coordinator.resume({ id: planned.record.id, token: planned.confirmation.token });
    assert.equal(resumed.state, "running");
    assert.equal(resumed.cursor.completedRows, 16);
    assert.deepStrictEqual(observedBatchSizes, [8, 8]);
    const copied = await coordinator.resume({ id: planned.record.id, token: planned.confirmation.token });
    assert.equal(copied.state, "validating");
    assert.equal(copied.cursor.completedRows, rows.length);
    assert.deepStrictEqual(observedBatchSizes, [8, 8, 1]);
    await coordinator.shutdown();
  });

  it("rejects a configured operator budget above one durable batch", () => {
    assert.throws(() => createReembeddingCoordinator({
      stateStore: { create() {}, transition() {} },
      backend: { inventoryActiveGeneration() {} },
      createTargetProvider() {},
      runValidationProbes() {},
      limits: { maxBatchesPerOperation: 2 },
    }), /invalid reembedding limit: maxBatchesPerOperation/);
  });

  it("bounds one operator request and persists a resumable cursor before the Gateway deadline", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text: `bounded migration row ${index + 1}`,
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
      id: "migration-request-bound",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
    });

    const partial = await coordinator.apply({ id: planned.record.id, token: planned.confirmation.token });
    assert.equal(partial.state, "running");
    assert.equal(partial.cursor.completedRows, 8);
    assert.deepStrictEqual(observedBatchSizes, [8]);

    let copied = partial;
    for (const expectedRows of [16, 24, 32, 40]) {
      const providerCallsBeforeResume = observedBatchSizes.length;
      copied = await coordinator.resume({ id: planned.record.id, token: planned.confirmation.token });
      assert.equal(copied.cursor.completedRows, expectedRows);
      assert.equal(observedBatchSizes.length, providerCallsBeforeResume + 1);
    }
    assert.equal(copied.state, "validating");
    assert.equal(copied.cursor.completedRows, rows.length);
    assert.equal(backend.target.size, rows.length);
    assert.deepStrictEqual(observedBatchSizes, [8, 8, 8, 8, 8]);
    await assert.rejects(
      coordinator.resume({ id: planned.record.id, token: "reemb_v1_invalid" }),
      /invalid or expired reembedding confirmation/,
    );
    const recovered = await coordinator.resume({ id: planned.record.id, token: planned.confirmation.token });
    assert.equal(recovered.state, "validating");
    assert.deepStrictEqual(observedBatchSizes, [8, 8, 8, 8, 8]);
    assert.equal((await coordinator.validate({ id: planned.record.id })).state, "ready_to_switch");
    await coordinator.shutdown();
  });

  it("uses expiry only for the first apply and keeps later operations bound to the same token", async () => {
    let clock = 1_000;
    const rows = Array.from({ length: 17 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text: `expiring confirmation row ${index + 1}`,
      status: "active",
      vector: [1, 0, 0],
    }));
    const backend = fakeBackend(rows);
    const stateStore = createMigrationStateStore({ stateRoot, now: () => clock });
    const providerCalls = [];
    const coordinator = createReembeddingCoordinator({
      stateStore,
      backend,
      createTargetProvider: async () => ({
        async embedBatch(texts) {
          providerCalls.push([...texts]);
          return texts.map((text) => [text.length, 1, 2, 3]);
        },
        async shutdown() {},
      }),
      plannerDependencies: {
        now: () => clock,
        randomBytes: () => Buffer.alloc(32, 8),
        statDisk: async () => ({ freeBytes: 1_000_000 }),
        probeTargetProvider: async () => [0, 1, 2, 3],
      },
      runValidationProbes: async () => ({ semanticRecall: true }),
    });
    const planned = await coordinator.plan({
      id: "migration-expiring",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
      confirmationTtlMs: 1_000,
    });

    clock = 1_999;
    const applied = await coordinator.apply({ id: planned.record.id, token: planned.confirmation.token });
    assert.equal(applied.state, "running");
    assert.equal(applied.cursor.completedRows, 8);

    clock = 2_000;
    const continued = await coordinator.apply({ id: planned.record.id, token: planned.confirmation.token });
    assert.equal(continued.state, "running");
    assert.equal(continued.cursor.completedRows, 16);
    const copied = await coordinator.resume({ id: planned.record.id, token: planned.confirmation.token });
    assert.equal(copied.state, "validating");
    assert.equal(copied.cursor.completedRows, rows.length);
    assert.equal(providerCalls.length, 3);
    assert.equal((await coordinator.resume({ id: planned.record.id, token: planned.confirmation.token })).state, "validating");
    assert.equal(providerCalls.length, 3);

    const wrongToken = `${planned.confirmation.token.slice(0, -1)}${planned.confirmation.token.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      coordinator.resume({ id: planned.record.id, token: wrongToken }),
      /invalid or expired reembedding confirmation/,
    );
    await coordinator.shutdown();
  });

  it("rejects an expired confirmation while the migration is still planned", async () => {
    let clock = 1_000;
    const backend = fakeBackend();
    const stateStore = createMigrationStateStore({ stateRoot, now: () => clock });
    const coordinator = createReembeddingCoordinator({
      stateStore,
      backend,
      createTargetProvider: async () => ({
        async embedBatch(texts) { return texts.map(() => [0, 1, 2, 3]); },
        async shutdown() {},
      }),
      plannerDependencies: {
        now: () => clock,
        randomBytes: () => Buffer.alloc(32, 8),
        statDisk: async () => ({ freeBytes: 1_000_000 }),
        probeTargetProvider: async () => [0, 1, 2, 3],
      },
      runValidationProbes: async () => ({ semanticRecall: true }),
    });
    const planned = await coordinator.plan({
      id: "migration-expired-before-apply",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
      confirmationTtlMs: 1_000,
    });

    clock = 2_000;
    await assert.rejects(
      coordinator.apply({ id: planned.record.id, token: planned.confirmation.token }),
      /invalid or expired reembedding confirmation/,
    );
    assert.equal((await coordinator.status(planned.record.id)).state, "planned");
    assert.equal(backend.target.size, 0);
    await coordinator.shutdown();
  });

  it("atomically supersedes an expired idle migration and rotates its target provider", async () => {
    let clock = 1_000;
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text: `superseded migration row ${index + 1}`,
      status: "active",
      vector: [1, 0, 0],
    }));
    const backend = fakeBackend(rows);
    const generations = new Set();
    backend.createQuarantinedGeneration = async ({ generation }) => {
      if (generations.has(generation)) throw new Error("target generation already exists");
      generations.add(generation);
    };
    backend.describeGeneration = async (generation) => (
      generations.has(generation) ? { generation, dimensions: 4 } : null
    );
    const stateStore = createMigrationStateStore({ stateRoot, now: () => clock });
    const providerEvents = [];
    const coordinator = createReembeddingCoordinator({
      stateStore,
      backend,
      createTargetProvider: async ({ fingerprint }) => ({
        async embedBatch(texts) {
          providerEvents.push(`embed:${fingerprint.model}`);
          return texts.map((text) => [text.length, 1, 2, 3]);
        },
        async shutdown() { providerEvents.push(`shutdown:${fingerprint.model}`); },
      }),
      plannerDependencies: {
        now: () => clock,
        randomBytes: () => Buffer.alloc(32, 8),
        statDisk: async () => ({ freeBytes: 1_000_000 }),
        probeTargetProvider: async () => [0, 1, 2, 3],
      },
      runValidationProbes: async () => ({ semanticRecall: true }),
    });
    const first = await coordinator.plan({
      id: "migration-expired-idle",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
      confirmationTtlMs: 1_000,
    });
    assert.equal((await coordinator.apply({ id: first.record.id, token: first.confirmation.token })).state, "running");
    assert.deepStrictEqual(providerEvents, ["embed:target-model"]);

    clock = 2_000;
    const replacementFingerprint = normalizeEmbeddingFingerprint({
      provider: "openai",
      model: "target-replacement-model",
      dimensions: 4,
    }, []);
    const replacement = await coordinator.plan({
      id: "migration-new-plan",
      targetGeneration: "generation-replacement",
      target: { fingerprint: replacementFingerprint },
    });

    const retired = await coordinator.status(first.record.id);
    assert.equal(retired.state, "failed");
    assert.deepStrictEqual(retired.error, { code: "expired_migration_superseded" });
    assert.equal(retired.cursor.completedRows, 8);
    assert.equal(retired.target.generation, "generation-target");
    assert.equal(replacement.record.state, "planned");
    assert.equal(replacement.record.target.generation, "generation-replacement");
    assert.equal((await coordinator.apply({ id: replacement.record.id, token: replacement.confirmation.token })).state, "running");
    assert.deepStrictEqual(providerEvents, [
      "embed:target-model",
      "shutdown:target-model",
      "embed:target-replacement-model",
    ]);
    await coordinator.shutdown();
    assert.deepStrictEqual(providerEvents, [
      "embed:target-model",
      "shutdown:target-model",
      "embed:target-replacement-model",
      "shutdown:target-replacement-model",
    ]);
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

    const resumed = await coordinator.resume({ id: "migration-0001", token: planned.confirmation.token });
    assert.equal(resumed.state, "running");
    assert.equal(resumed.cursor.completedRows, 2);
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

  it("closes an invalid resource-owning provider candidate exactly once", async () => {
    let candidateShutdowns = 0;
    const { coordinator } = coordinatorWithProvider({
      stateRoot,
      createTargetProvider: async () => ({
        async shutdown() { candidateShutdowns += 1; },
      }),
    });
    const planned = await coordinator.plan({
      id: "migration-invalid-provider",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
    });

    await assert.rejects(
      coordinator.apply({ id: planned.record.id, token: planned.confirmation.token }),
      /target embedding provider is invalid/,
    );
    assert.equal(candidateShutdowns, 1);
    await coordinator.shutdown();
    assert.equal(candidateShutdowns, 1);
  });

  it("preserves an invalid-provider error when candidate shutdown also fails", async () => {
    let candidateShutdowns = 0;
    const { coordinator } = coordinatorWithProvider({
      stateRoot,
      createTargetProvider: async () => ({
        async shutdown() {
          candidateShutdowns += 1;
          throw new Error("invalid candidate shutdown failed");
        },
      }),
    });
    const planned = await coordinator.plan({
      id: "migration-invalid-provider-cleanup",
      targetGeneration: "generation-target",
      target: { fingerprint: targetFingerprint },
    });

    await assert.rejects(
      coordinator.apply({ id: planned.record.id, token: planned.confirmation.token }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepStrictEqual(error.errors.map((failure) => failure.message), [
          "target embedding provider is invalid",
          "invalid candidate shutdown failed",
        ]);
        return true;
      },
    );
    assert.equal(candidateShutdowns, 1);
    await coordinator.shutdown();
    assert.equal(candidateShutdowns, 1);
  });

  it("retains a stale provider after shutdown failure and retries it before creating a replacement", async () => {
    let staleShutdowns = 0;
    const { coordinator, factoryModels, providerEvents, replacement } = await expiredProviderRotation({
      stateRoot,
      shutdownFirstProvider: async () => {
        staleShutdowns += 1;
        if (staleShutdowns === 1) throw new Error("stale provider shutdown failed");
      },
    });

    await assert.rejects(
      coordinator.apply({ id: replacement.record.id, token: replacement.confirmation.token }),
      /stale provider shutdown failed/,
    );
    assert.equal(staleShutdowns, 1);
    assert.deepStrictEqual(factoryModels, ["target-model"]);

    const resumed = await coordinator.resume({ id: replacement.record.id, token: replacement.confirmation.token });
    assert.equal(resumed.state, "validating");
    assert.equal(staleShutdowns, 2);
    assert.deepStrictEqual(factoryModels, ["target-model", "target-replacement-model"]);
    assert.deepStrictEqual(providerEvents, [
      "embed:target-model",
      "shutdown:target-model",
      "shutdown:target-model",
      "embed:target-replacement-model",
    ]);
    await coordinator.shutdown();
    assert.deepStrictEqual(providerEvents, [
      "embed:target-model",
      "shutdown:target-model",
      "shutdown:target-model",
      "embed:target-replacement-model",
      "shutdown:target-replacement-model",
    ]);
  });

  it("aggregates a retained stale-provider failure with final backend shutdown", async () => {
    let staleShutdowns = 0;
    const { coordinator, factoryModels, replacement } = await expiredProviderRotation({
      stateRoot,
      shutdownFirstProvider: async () => {
        staleShutdowns += 1;
        throw new Error("stale provider shutdown failed");
      },
      closeBackend: async () => { throw new Error("backend shutdown failed"); },
    });

    await assert.rejects(
      coordinator.apply({ id: replacement.record.id, token: replacement.confirmation.token }),
      /stale provider shutdown failed/,
    );
    await assert.rejects(coordinator.shutdown(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepStrictEqual(error.errors.map((failure) => failure.message), [
        "stale provider shutdown failed",
        "backend shutdown failed",
      ]);
      return true;
    });
    assert.equal(staleShutdowns, 2);
    assert.deepStrictEqual(factoryModels, ["target-model"]);
  });
});
