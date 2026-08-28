import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as runtimeShutdown from "../lib/runtime-shutdown.js";

const { registerGatewayShutdown } = runtimeShutdown;

function trackedDependencies(calls, releaseEmbedding = null) {
  return {
    memoryDbAdapter: { async shutdown() { calls.push("adapter"); } },
    pool: { async shutdown() { calls.push("pool"); } },
    sharedMemoryPool: { async shutdown() { calls.push("shared"); } },
    clearTurnRoutes: async () => { calls.push("routes"); },
    flushMetrics: async () => { calls.push("metrics"); },
    llmResultCache: { async close() { calls.push("cache"); } },
    embeddings: {
      async shutdown() {
        calls.push("embeddings");
        if (releaseEmbedding) await releaseEmbedding;
      },
    },
    reranker: { async shutdown() { calls.push("reranker"); } },
    modelPreparationCoordinator: { async shutdown() { calls.push("preparation"); } },
    reembeddingCoordinator: { async shutdown() { calls.push("reembedding"); } },
  };
}

describe("OpenClaw runtime cleanup lifecycle", () => {
  it("starts model disposal even when an earlier coordinator drain is blocked", async () => {
    const calls = [];
    let lifecycle;
    let releasePreparation;
    const blockedPreparation = new Promise((resolve) => { releasePreparation = resolve; });
    const api = {
      logger: { warn() {} },
      lifecycle: {
        registerRuntimeLifecycle(registration) { lifecycle = registration; },
      },
      on() {},
    };
    const dependencies = trackedDependencies(calls);
    dependencies.modelPreparationCoordinator.shutdown = async () => {
      calls.push("preparation");
      await blockedPreparation;
    };

    registerGatewayShutdown(api, dependencies);
    const cleanup = lifecycle.cleanup({ reason: "restart" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.includes("embeddings"), true);
    assert.equal(calls.includes("reranker"), true);
    releasePreparation();
    await cleanup;
  });

  it("blocks a new Beta-3 generation from acquiring a local model until the replaced generation releases it", async () => {
    assert.equal(typeof runtimeShutdown.createLocalModelGenerationLifecycle, "function");
    const oldGeneration = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    const nextGeneration = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    const oldCalls = [];
    const nextCalls = [];
    let oldLifecycle;
    let nextLifecycle;
    let releaseOldModel;
    const oldModelReleased = new Promise((resolve) => { releaseOldModel = resolve; });
    const oldDependencies = trackedDependencies(oldCalls);
    const nextDependencies = trackedDependencies(nextCalls);
    const oldApi = {
      logger: { warn() {} },
      lifecycle: { registerRuntimeLifecycle(registration) { oldLifecycle = registration; } },
      on() {},
    };
    const nextApi = {
      logger: { warn() {} },
      lifecycle: { registerRuntimeLifecycle(registration) { nextLifecycle = registration; } },
      on() {},
    };

    oldGeneration.registerResource({
      async shutdown() {
        oldCalls.push("old-local-model");
        await oldModelReleased;
      },
    }, "old-local-model");
    registerGatewayShutdown(oldApi, { ...oldDependencies, localModelGeneration: oldGeneration });
    await oldGeneration.beforeAcquire();
    registerGatewayShutdown(nextApi, { ...nextDependencies, localModelGeneration: nextGeneration });

    let acquired = false;
    const acquisition = nextGeneration.beforeAcquire().then(() => { acquired = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acquired, false, "new registry activation must not overlap the old local model");

    const oldCleanup = oldLifecycle.cleanup({ reason: "restart" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acquired, false, "acquisition must wait for actual model disposal");
    releaseOldModel();
    await oldCleanup;
    await acquisition;
    assert.equal(acquired, true);

    await nextLifecycle.cleanup({ reason: "disable" });
  });

  it("keeps a third generation behind every unreleased predecessor when the middle generation never loads a model", async () => {
    const first = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    const middle = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    const third = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    let releaseFirst;
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
    first.registerResource({ async shutdown() { await firstReleased; } }, "first-model");
    await first.beforeAcquire();

    let middleLifecycle;
    registerGatewayShutdown({
      logger: { warn() {} },
      lifecycle: { registerRuntimeLifecycle(value) { middleLifecycle = value; } },
      on() {},
    }, { ...trackedDependencies([]), localModelGeneration: middle });
    await middleLifecycle.cleanup({ reason: "restart" });

    let thirdLifecycle;
    registerGatewayShutdown({
      logger: { warn() {} },
      lifecycle: { registerRuntimeLifecycle(value) { thirdLifecycle = value; } },
      on() {},
    }, { ...trackedDependencies([]), localModelGeneration: third });
    let thirdAcquired = false;
    const acquisition = third.beforeAcquire().then(() => { thirdAcquired = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(thirdAcquired, false);

    const firstCleanup = first.releaseModels();
    releaseFirst();
    await firstCleanup;
    await acquisition;
    assert.equal(thirdAcquired, true);
    await thirdLifecycle.cleanup({ reason: "disable" });
  });

  it("keeps a third active generation behind an unreleased first generation after the middle generation closes", async () => {
    const first = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    const middle = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    const third = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 1_000 });
    let releaseFirst;
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
    first.registerResource({ async shutdown() { await firstReleased; } }, "first-active-model");
    await first.beforeAcquire();

    let middleAcquired = false;
    const middleAcquisition = middle.beforeAcquire().then(() => { middleAcquired = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(middleAcquired, false);

    const middleCleanup = middle.releaseModels();
    await middleCleanup;
    let thirdAcquired = false;
    const thirdAcquisition = third.beforeAcquire().then(() => { thirdAcquired = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(thirdAcquired, false, "closing the middle generation must not bypass its predecessor");

    const firstCleanup = first.releaseModels();
    releaseFirst();
    await firstCleanup;
    await assert.rejects(middleAcquisition, /closing/i);
    await thirdAcquisition;
    assert.equal(thirdAcquired, true);
    await third.releaseModels();
  });

  it("unregisters an explicitly closed local-model resource before generation cleanup", async () => {
    const generation = runtimeShutdown.createLocalModelGenerationLifecycle();
    let shutdownCalls = 0;
    const unregister = generation.registerResource({
      async shutdown() { shutdownCalls += 1; },
    }, "short-lived-target");

    assert.equal(typeof unregister, "function");
    assert.equal(unregister(), true);
    assert.equal(unregister(), false);
    await generation.releaseModels();
    assert.equal(shutdownCalls, 0);
  });

  it("does not let a discarded staged registry poison later model acquisition", async () => {
    const discarded = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 25 });
    registerGatewayShutdown({
      logger: { warn() {} },
      lifecycle: { registerRuntimeLifecycle() {} },
      on() {},
    }, { ...trackedDependencies([]), localModelGeneration: discarded });

    const committed = runtimeShutdown.createLocalModelGenerationLifecycle({ waitTimeoutMs: 25 });
    let committedLifecycle;
    registerGatewayShutdown({
      logger: { warn() {} },
      lifecycle: { registerRuntimeLifecycle(value) { committedLifecycle = value; } },
      on() {},
    }, { ...trackedDependencies([]), localModelGeneration: committed });

    await committed.beforeAcquire();
    await committedLifecycle.cleanup({ reason: "disable" });
  });

  it("coalesces concurrent local-model generation cleanup", async () => {
    const generation = runtimeShutdown.createLocalModelGenerationLifecycle();
    let shutdownCalls = 0;
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    generation.registerResource({
      async shutdown() {
        shutdownCalls += 1;
        await blocked;
      },
    }, "coalesced-model");

    const first = generation.releaseModels();
    const second = generation.releaseModels();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(shutdownCalls, 1);
  });

  it("awaits the Beta-3 runtime cleanup hook on hot restart and shuts resources once", async () => {
    const calls = [];
    let lifecycle;
    let gatewayStop;
    let release;
    const releaseEmbedding = new Promise((resolve) => { release = resolve; });
    const api = {
      logger: { warn() {} },
      lifecycle: {
        registerRuntimeLifecycle(registration) { lifecycle = registration; },
      },
      on(event, handler) {
        if (event === "gateway_stop") gatewayStop = handler;
      },
    };

    assert.equal(registerGatewayShutdown(api, trackedDependencies(calls, releaseEmbedding)), true);
    assert.equal(lifecycle.id, "plur1bus-runtime-resources");
    assert.equal(typeof lifecycle.cleanup, "function");
    assert.equal(typeof gatewayStop, "function");

    let settled = false;
    const cleanup = lifecycle.cleanup({ reason: "restart" }).then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "hot-reload cleanup must await provider disposal");
    release();
    await cleanup;
    await gatewayStop();

    assert.equal(calls.length, 10);
    assert.deepEqual(calls.toSorted(), [
      "preparation",
      "reembedding",
      "adapter",
      "pool",
      "shared",
      "routes",
      "metrics",
      "cache",
      "embeddings",
      "reranker",
    ].toSorted());
  });

  it("falls back to the typed gateway_stop hook when runtime lifecycle is absent", async () => {
    const calls = [];
    let gatewayStop;
    const api = {
      logger: { warn() {} },
      on(event, handler) {
        if (event === "gateway_stop") gatewayStop = handler;
      },
    };

    assert.equal(registerGatewayShutdown(api, trackedDependencies(calls)), true);
    await gatewayStop();
    assert.equal(calls.filter((entry) => entry === "embeddings").length, 1);
  });
});
