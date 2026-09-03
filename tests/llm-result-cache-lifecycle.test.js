import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  registerGatewayShutdown,
  registerLocalModelOwnershipServiceAfterLifecycle,
  registerModelPreparationServiceAfterLifecycle,
  registerReembeddingRecoveryServiceAfterLifecycle,
} from "../lib/runtime-shutdown.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeDependencies(overrides = {}) {
  return {
    memoryDbAdapter: { shutdown: async () => {} },
    pool: { shutdown: async () => {} },
    sharedMemoryPool: { shutdown: async () => {} },
    clearTurnRoutes: async () => {},
    flushMetrics: async () => {},
    llmResultCache: { close: async () => {} },
    scopedEmbeddingServer: { shutdown: async () => {} },
    embeddings: { shutdown: async () => {} },
    reranker: { shutdown: async () => {} },
    modelPreparationCoordinator: { shutdown: async () => {} },
    reembeddingCoordinator: { shutdown: async () => {} },
    ...overrides,
  };
}

function captureGatewayStop(warnings = []) {
  let registration;
  return {
    api: {
      logger: { warn: (message) => warnings.push(message) },
      on(event, handler, options) {
        registration = { event, handler, options };
      },
    },
    getRegistration: () => registration,
  };
}

describe("LLM result cache lifecycle", () => {
  it("attaches full-runtime local-model ownership only after host service activation", async () => {
    let activations = 0;
    let shutdowns = 0;
    let service;
    const embeddings = {
      async activateSharedModelOwner() { activations += 1; return true; },
      async shutdown() { shutdowns += 1; },
    };
    const api = {
      logger: {},
      registerService(registration) { service = registration; },
    };

    assert.equal(registerLocalModelOwnershipServiceAfterLifecycle(api, {
      enabled: true,
      lifecycleRegistered: true,
      embeddings,
    }), true);
    assert.equal(activations, 0, "a staged registry must not claim active model ownership");
    assert.equal(service.id, "plur1bus-local-model-owner");
    await Promise.all([service.start(), service.start()]);
    assert.equal(activations, 1);
    await service.stop();
    assert.equal(shutdowns, 1);
  });

  it("surfaces owner-service activation failure and still runs bounded cleanup", async () => {
    let shutdowns = 0;
    let service;
    const api = {
      logger: {},
      registerService(registration) { service = registration; },
    };
    registerLocalModelOwnershipServiceAfterLifecycle(api, {
      enabled: true,
      lifecycleRegistered: true,
      embeddings: {
        async activateSharedModelOwner() { throw new Error("owner activation failed"); },
        async shutdown() { shutdowns += 1; },
      },
    });

    await assert.rejects(service.start(), /owner activation failed/);
    await assert.rejects(service.start(), /owner activation failed/);
    await service.stop();
    assert.equal(shutdowns, 1);
  });

  it("reports lifecycle capability absence and never starts model preparation without shutdown ownership", async () => {
    let starts = 0;
    const warnings = [];
    const api = { logger: { warn: (message) => warnings.push(message) } };

    assert.equal(registerGatewayShutdown(api, makeDependencies()), false);
    assert.equal(registerModelPreparationServiceAfterLifecycle(api, {
      lifecycleRegistered: false,
      coordinator: { async start() { starts += 1; } },
    }), false);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(starts, 0);
    assert.match(warnings.join("\n"), /model preparation.*gateway lifecycle capability (?:is )?unavailable/i);
  });

  it("registers model preparation as a service and starts it only after host activation", async () => {
    let starts = 0;
    let stops = 0;
    let service;
    const api = {
      logger: {},
      registerService(registration) { service = registration; },
    };
    assert.equal(registerModelPreparationServiceAfterLifecycle(api, {
      lifecycleRegistered: true,
      coordinator: {
        async start() {
          starts += 1;
          return { state: "ready", model: "fixture/model", dimensions: 384 };
        },
        async shutdown() { stops += 1; },
      },
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 0, "register() must not start work in a staged registry");
    assert.equal(service.id, "plur1bus-model-preparation");
    assert.equal(typeof service.start, "function");
    assert.equal(typeof service.stop, "function");

    await service.start();
    assert.equal(starts, 1);
    await service.stop();
    assert.equal(stops, 1);
  });

  it("fails closed when model preparation cannot be owned by an activated host service", async () => {
    let starts = 0;
    const warnings = [];
    const api = { logger: { warn: (message) => warnings.push(message) } };

    assert.equal(registerModelPreparationServiceAfterLifecycle(api, {
      lifecycleRegistered: true,
      coordinator: { async start() { starts += 1; } },
    }), false);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(starts, 0);
    assert.match(warnings.join("\n"), /model preparation.*plugin service capability.*unavailable/i);
  });

  it("starts reembedding recovery only as an activation-owned service", async () => {
    let starts = 0;
    let stops = 0;
    let service;
    const api = {
      logger: {},
      registerService(registration) { service = registration; },
    };
    assert.equal(registerReembeddingRecoveryServiceAfterLifecycle(api, {
      lifecycleRegistered: true,
      recovery: {
        async start() { starts += 1; return null; },
        async shutdown() { stops += 1; },
      },
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 0, "register() must not reconcile a staged registry");
    assert.equal(service.id, "plur1bus-reembedding-switch-recovery");
    await service.start();
    assert.equal(starts, 1);
    await service.stop();
    assert.equal(stops, 1);
  });

  it("calls and awaits register-local cache close exactly once on gateway_stop", async () => {
    let closeCalls = 0;
    let releaseClose;
    let signalCloseStarted;
    const closeStarted = new Promise((resolve) => { signalCloseStarted = resolve; });
    const closePromise = new Promise((resolve) => { releaseClose = resolve; });
    const harness = captureGatewayStop();

    registerGatewayShutdown(harness.api, makeDependencies({
      llmResultCache: {
        close() {
          closeCalls += 1;
          signalCloseStarted();
          return closePromise;
        },
      },
    }));
    const registration = harness.getRegistration();
    assert.strictEqual(registration.event, "gateway_stop");
    assert.deepStrictEqual(registration.options, { timeoutMs: 30_000 });

    let shutdownSettled = false;
    const shutdown = registration.handler().then(() => { shutdownSettled = true; });
    await closeStarted;

    assert.strictEqual(closeCalls, 1);
    assert.strictEqual(shutdownSettled, false, "gateway_stop must await cache.close()");

    releaseClose();
    await shutdown;
    assert.strictEqual(shutdownSettled, true);
  });

  it("isolates every shutdown failure and continues through shared pool and cache close", async () => {
    const calls = [];
    const warnings = [];
    const failing = (name) => async () => {
      calls.push(name);
      throw new Error(`${name} broke`);
    };
    const harness = captureGatewayStop(warnings);

    registerGatewayShutdown(harness.api, {
      memoryDbAdapter: { shutdown: failing("adapter") },
      pool: { shutdown: failing("pool") },
      sharedMemoryPool: { shutdown: failing("shared") },
      clearTurnRoutes: failing("routes"),
      flushMetrics: failing("metrics"),
      llmResultCache: { close: failing("cache") },
      scopedEmbeddingServer: { shutdown: failing("scoped-embedding-ipc") },
      embeddings: { shutdown: failing("embeddings") },
      reranker: { shutdown: failing("reranker") },
      modelPreparationCoordinator: { shutdown: failing("model-preparation") },
      reembeddingCoordinator: { shutdown: failing("reembedding") },
    });
    await harness.getRegistration().handler();

    assert.equal(calls.length, 11);
    assert.deepStrictEqual(calls.toSorted(), ["model-preparation", "reembedding", "adapter", "pool", "shared", "routes", "metrics", "cache", "scoped-embedding-ipc", "embeddings", "reranker"].toSorted());
    assert.deepStrictEqual(warnings.toSorted(), [
      "memory-lancedb-namespaced: model preparation shutdown failed: model-preparation broke",
      "memory-lancedb-namespaced: reembedding coordinator shutdown failed: reembedding broke",
      "memory-lancedb-namespaced: adapter shutdown failed: adapter broke",
      "memory-lancedb-namespaced: pool shutdown failed: pool broke",
      "memory-lancedb-namespaced: shared pool shutdown failed: shared broke",
      "memory-lancedb-namespaced: turn route shutdown failed: routes broke",
      "metrics flush failed: metrics broke",
      "memory-lancedb-namespaced: LLM result cache shutdown failed: cache broke",
      "memory-lancedb-namespaced: scoped embedding IPC shutdown failed: scoped-embedding-ipc broke",
      "memory-lancedb-namespaced: embedding provider shutdown failed: embeddings broke",
      "memory-lancedb-namespaced: reranker shutdown failed: reranker broke",
    ].toSorted());
  });

  it("wires the real plugin dependencies into the shutdown boundary", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.match(source, /registerGatewayShutdown\(api,\s*\{\s*memoryDbAdapter,\s*pool:\s*\{\s*shutdown:\s*async\s*\(\)\s*=>\s*\{\s*legacyMigrationShutdown\.abort\(\);\s*await pool\.shutdown\(\);\s*\},\s*\},\s*sharedMemoryPool,\s*clearTurnRoutes:\s*clearInitializedTurnRoutes,\s*flushMetrics,\s*llmResultCache,\s*scopedEmbeddingServer,\s*embeddings,\s*reranker,\s*modelPreparationCoordinator,\s*reembeddingCoordinator,\s*localModelGeneration,?\s*\}\);/s);
  });

  it("starts optional model preparation only after shutdown ownership and hook registration", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    const shutdownOwnership = source.indexOf("registerGatewayShutdown(api,");
    const finalPromptHook = source.lastIndexOf('api.on("before_prompt_build"');
    const preparationStart = source.lastIndexOf("registerModelPreparationServiceAfterLifecycle(api,");

    assert.ok(shutdownOwnership >= 0);
    assert.ok(shutdownOwnership > finalPromptHook);
    assert.ok(preparationStart > shutdownOwnership);
  });

  it("routes scoped local providers through activation-owned private IPC", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.match(source, /requiresActiveSharedModelOwner\s*=\s*typeof api\.registrationMode === "string"\s*&&\s*api\.registrationMode !== "full"/s);
    assert.match(source, /requiresActiveSharedModelOwner[\s\S]*?new ReloadSafeIpcScopedEmbeddingProvider\(\{[\s\S]*?stateRoot:\s*baseDbPath/s);
    assert.match(
      source,
      /createScopedEmbeddingIpcServer\(\{\s*stateRoot:\s*baseDbPath,\s*embeddings,\s*fingerprintId:\s*activeEmbeddingFingerprintId,\s*logger:\s*api\.logger/s,
    );
    assert.match(source, /registerScopedEmbeddingIpcServiceAfterLifecycle\(\{\s*api,\s*server:\s*scopedEmbeddingServer,\s*enabled:\s*Boolean\(scopedEmbeddingServer\),\s*lifecycleRegistered:\s*gatewayShutdownRegistered/s);
    assert.match(source, /sharedModelPool:\s*sharesActiveLocalModel,\s*sharedModelOwner:\s*coordinatesLocalModelGeneration,\s*sharedModelRequireOwner:\s*requiresActiveSharedModelOwner,\s*sharedModelActivationManaged:\s*coordinatesLocalModelGeneration/s);
    assert.match(source, /createTargetEmbeddingProvider[\s\S]*?sharedModelPool:\s*requiresActiveSharedModelOwner,\s*sharedModelOwner:\s*false,\s*sharedModelRequireOwner:\s*requiresActiveSharedModelOwner/s);
  });

  it("closes private scoped embedding IPC before its local model", async () => {
    const calls = [];
    const harness = captureGatewayStop();
    registerGatewayShutdown(harness.api, makeDependencies({
      scopedEmbeddingServer: { async shutdown() { calls.push("ipc"); } },
      embeddings: { async shutdown() { calls.push("embedding"); } },
    }));

    await harness.getRegistration().handler();
    assert.deepEqual(calls, ["ipc", "embedding"]);
  });
});
