import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerGatewayShutdown } from "../lib/runtime-shutdown.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeDependencies(overrides = {}) {
  return {
    memoryDbAdapter: { shutdown: async () => {} },
    pool: { shutdown: async () => {} },
    sharedMemoryPool: { shutdown: async () => {} },
    clearTurnRoutes: async () => {},
    flushMetrics: async () => {},
    llmResultCache: { close: async () => {} },
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
    });
    await harness.getRegistration().handler();

    assert.deepStrictEqual(calls, ["adapter", "pool", "shared", "routes", "metrics", "cache"]);
    assert.deepStrictEqual(warnings, [
      "memory-lancedb-namespaced: adapter shutdown failed: adapter broke",
      "memory-lancedb-namespaced: pool shutdown failed: pool broke",
      "memory-lancedb-namespaced: shared pool shutdown failed: shared broke",
      "memory-lancedb-namespaced: turn route shutdown failed: routes broke",
      "metrics flush failed: metrics broke",
      "memory-lancedb-namespaced: LLM result cache shutdown failed: cache broke",
    ]);
  });

  it("wires the real plugin dependencies into the shutdown boundary", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.match(source, /registerGatewayShutdown\(api,\s*\{\s*memoryDbAdapter,\s*pool,\s*sharedMemoryPool,\s*clearTurnRoutes:\s*clearInitializedTurnRoutes,\s*flushMetrics,\s*llmResultCache,?\s*\}\);/s);
  });
});
