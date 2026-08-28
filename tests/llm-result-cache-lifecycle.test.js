import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  registerGatewayShutdown,
  startModelPreparationAfterLifecycle,
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
  it("reports lifecycle capability absence and never starts model preparation without shutdown ownership", async () => {
    let starts = 0;
    const warnings = [];
    const api = { logger: { warn: (message) => warnings.push(message) } };

    assert.equal(registerGatewayShutdown(api, makeDependencies()), false);
    assert.equal(startModelPreparationAfterLifecycle(api, {
      lifecycleRegistered: false,
      coordinator: { async start() { starts += 1; } },
    }), false);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(starts, 0);
    assert.match(warnings.join("\n"), /model preparation.*gateway lifecycle capability (?:is )?unavailable/i);
  });

  it("starts model preparation once only after lifecycle ownership is registered", async () => {
    let starts = 0;
    const api = { logger: {} };
    assert.equal(startModelPreparationAfterLifecycle(api, {
      lifecycleRegistered: true,
      coordinator: {
        async start() {
          starts += 1;
          return { state: "ready", model: "fixture/model", dimensions: 384 };
        },
      },
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 1);
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
      embeddings: { shutdown: failing("embeddings") },
      reranker: { shutdown: failing("reranker") },
      modelPreparationCoordinator: { shutdown: failing("model-preparation") },
      reembeddingCoordinator: { shutdown: failing("reembedding") },
    });
    await harness.getRegistration().handler();

    assert.equal(calls.length, 10);
    assert.deepStrictEqual(calls.toSorted(), ["model-preparation", "reembedding", "adapter", "pool", "shared", "routes", "metrics", "cache", "embeddings", "reranker"].toSorted());
    assert.deepStrictEqual(warnings.toSorted(), [
      "memory-lancedb-namespaced: model preparation shutdown failed: model-preparation broke",
      "memory-lancedb-namespaced: reembedding coordinator shutdown failed: reembedding broke",
      "memory-lancedb-namespaced: adapter shutdown failed: adapter broke",
      "memory-lancedb-namespaced: pool shutdown failed: pool broke",
      "memory-lancedb-namespaced: shared pool shutdown failed: shared broke",
      "memory-lancedb-namespaced: turn route shutdown failed: routes broke",
      "metrics flush failed: metrics broke",
      "memory-lancedb-namespaced: LLM result cache shutdown failed: cache broke",
      "memory-lancedb-namespaced: embedding provider shutdown failed: embeddings broke",
      "memory-lancedb-namespaced: reranker shutdown failed: reranker broke",
    ].toSorted());
  });

  it("wires the real plugin dependencies into the shutdown boundary", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.match(source, /registerGatewayShutdown\(api,\s*\{\s*memoryDbAdapter,\s*pool:\s*\{\s*shutdown:\s*async\s*\(\)\s*=>\s*\{\s*legacyMigrationShutdown\.abort\(\);\s*await pool\.shutdown\(\);\s*\},\s*\},\s*sharedMemoryPool,\s*clearTurnRoutes:\s*clearInitializedTurnRoutes,\s*flushMetrics,\s*llmResultCache,\s*embeddings,\s*reranker,\s*modelPreparationCoordinator,\s*reembeddingCoordinator,\s*localModelGeneration,?\s*\}\);/s);
  });

  it("starts optional model preparation only after shutdown ownership and hook registration", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    const shutdownOwnership = source.indexOf("registerGatewayShutdown(api,");
    const finalPromptHook = source.lastIndexOf('api.on("before_prompt_build"');
    const preparationStart = source.lastIndexOf("startModelPreparationAfterLifecycle(api,");

    assert.ok(shutdownOwnership >= 0);
    assert.ok(shutdownOwnership > finalPromptHook);
    assert.ok(preparationStart > shutdownOwnership);
  });
});
