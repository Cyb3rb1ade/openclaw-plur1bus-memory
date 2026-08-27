import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { withTimeout } from "../lib/with-timeout.js";

const VECTOR_DIM = 384;

function makeVector(offset = 0) {
  const vec = Array(VECTOR_DIM).fill(0.1);
  vec[0] = 0.1 + offset;
  return vec;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMockApi(baseDbPath, overrides = {}) {
  const handlers = {};
  const services = [];
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      duplicateThreshold: 0.9,
      obsidianBridge: { enabled: false },
      autoCapture: true,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      ...overrides,
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: (p) => p,
    registerCommand() {},
    registerTool() {},
    on(event, fn) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(fn);
    },
    async emit(event, ...args) {
      const results = [];
      for (const fn of handlers[event] || []) {
        results.push(await fn(...args));
      }
      return results;
    },
    registerService(service) {
      services.push(service);
    },
    async shutdown() {
      await this.emit("gateway_stop");
      await Promise.all(services.map((service) => service?.stop?.()));
    },
  };
}

function trackApi(t, api) {
  t.after(async () => {
    await api.shutdown();
  });
  return api;
}

function emptyQueryTable() {
  const builder = {
    where() { return builder; },
    limit() { return builder; },
    async toArray() { return []; },
  };
  return { query: () => builder };
}

async function loadFreshPlugin() {
  // Frische Modulinstanz für jeden Test, damit register() isoliert läuft.
  const { default: plugin } = await import(`../index.js?test=${Date.now()}`);
  return plugin;
}

async function loadFreshPluginModule() {
  return import(`../index.js?b3-test=${Date.now()}`);
}

describe("auto-capture uses embedBatch when available", () => {
  let basePath;
  let openclawHome;
  let originalOpenClawHome;
  let originalEmbedBatch;
  let originalEmbed;

  before(() => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-auto-capture-batch-"));
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_HOME = openclawHome;
    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive");
    mkdirSync(archiveDir, { recursive: true });
    originalEmbedBatch = LocalTransformersEmbeddingProvider.prototype.embedBatch;
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embed;
  });

  after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedBatch = originalEmbedBatch;
    LocalTransformersEmbeddingProvider.prototype.embed = originalEmbed;
    try { rmSync(basePath, { recursive: true, force: true }); } catch {}
    try { rmSync(openclawHome, { recursive: true, force: true }); } catch {}
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
  });

  it("calls embedBatch with captured texts", async (t) => {
    const batchCalls = [];
    const individualCalls = [];

    LocalTransformersEmbeddingProvider.prototype.embedBatch = async function mockedEmbedBatch(texts) {
      batchCalls.push(texts);
      return texts.map((_, i) => makeVector(i * 0.01));
    };
    LocalTransformersEmbeddingProvider.prototype.embed = async function mockedEmbed(text) {
      individualCalls.push(text);
      return makeVector(0.99);
    };

    const plugin = await loadFreshPlugin();
    const api = trackApi(t, makeMockApi(basePath));
    plugin.register(api);

    const event = {
      success: true,
      turnId: "turn-1",
      sessionKey: "agent:main:main",
      messages: [
        { role: "user", content: "I prefer dark mode and two spaces indentation." },
        { role: "assistant", content: "Noted, I will remember that preference." },
      ],
    };
    const ctx = { agentId: "main", workspaceDir: basePath };

    await api.emit("agent_end", event, ctx);

    assert.ok(batchCalls.length > 0, "embedBatch should have been called during auto-capture");
    const firstBatch = batchCalls[0];
    assert.ok(firstBatch.some((t) => t.includes("dark mode")), "batch should include captured user text");
    assert.strictEqual(individualCalls.length, 0, "individual embed should not be needed when embedBatch succeeds");
  });

  it("falls back to individual embed when embedBatch is not available", async (t) => {
    const individualCalls = [];

    LocalTransformersEmbeddingProvider.prototype.embedBatch = undefined;
    LocalTransformersEmbeddingProvider.prototype.embed = async function mockedEmbed(text) {
      individualCalls.push(text);
      return makeVector(0.99);
    };

    const plugin = await loadFreshPlugin();
    const api = trackApi(t, makeMockApi(basePath));
    plugin.register(api);

    const event = {
      success: true,
      turnId: "turn-2",
      sessionKey: "agent:main:main",
      messages: [
        { role: "user", content: "My favorite color is blue." },
      ],
    };
    const ctx = { agentId: "main", workspaceDir: basePath };

    await api.emit("agent_end", event, ctx);

    assert.ok(individualCalls.length > 0, "individual embed should be used as fallback");
    assert.ok(individualCalls.some((t) => t.includes("blue")), "individual embed should include captured text");
  });

  it("checks abort after a late batch embed and performs no durable capture write", async (t) => {
    const batchStarted = deferred();
    const batchGate = deferred();
    LocalTransformersEmbeddingProvider.prototype.embedBatch = async function slowBatch(texts) {
      batchStarted.resolve();
      await batchGate.promise;
      return texts.map((_, index) => makeVector(index * 0.01));
    };

    const pluginModule = await loadFreshPluginModule();
    const originalStore = pluginModule.MemoryDB.prototype.store;
    let storeCalls = 0;
    pluginModule.MemoryDB.prototype.store = async function trackedStore(...args) {
      storeCalls += 1;
      return originalStore.apply(this, args);
    };
    t.after(() => {
      batchGate.resolve();
      pluginModule.MemoryDB.prototype.store = originalStore;
    });

    const api = trackApi(t, makeMockApi(basePath, {
      runtime: { captureTimeoutMs: 20, maxConcurrentCapturePerAgent: 1 },
    }));
    pluginModule.default.register(api);
    const event = {
      success: true,
      turnId: "turn-b3-abort",
      sessionKey: "agent:abort-agent:main",
      messages: [{ role: "user", content: "Remember this delayed batch capture must stop after timeout." }],
    };

    const emitted = api.emit("agent_end", event, { agentId: "abort-agent", workspaceDir: basePath });
    await batchStarted.promise;
    const results = await emitted;
    assert.equal(results[0]?.timedOut, true, "the hook should preserve its prompt timeout result");

    batchGate.resolve();
    await sleep(100);
    assert.equal(storeCalls, 0, "an abort observed after embedding must stop before the durable store boundary");
  });

  it("retains the same-agent capture slot until a timed-out store really settles", async (t) => {
    LocalTransformersEmbeddingProvider.prototype.embedBatch = async function mockedEmbedBatch(texts) {
      return texts.map((_, index) => makeVector(index * 0.01));
    };

    const firstStoreGate = deferred();
    const secondStoreGate = deferred();
    const firstStoreStarted = deferred();
    const secondStoreStarted = deferred();
    const pluginModule = await loadFreshPluginModule();
    const originalStore = pluginModule.MemoryDB.prototype.store;
    const originalSearch = pluginModule.MemoryDB.prototype.search;
    let firstStoreCalls = 0;
    let secondStoreCalls = 0;
    let rawActive = 0;
    let rawMaxActive = 0;
    let firstRun;
    let secondRun;

    pluginModule.MemoryDB.prototype.store = function controlledTimedStore(entry) {
      const firstTurn = entry?.sourceTurnId === "turn-b3-store-timeout-1";
      const secondTurn = entry?.sourceTurnId === "turn-b3-store-timeout-2";
      if (!firstTurn && !secondTurn) throw new Error("unexpected capture turn in settlement test");
      if (firstTurn) firstStoreCalls += 1;
      if (secondTurn) secondStoreCalls += 1;
      const gate = firstTurn ? firstStoreGate : secondStoreGate;
      const started = firstTurn ? firstStoreStarted : secondStoreStarted;
      const rawStore = (async () => {
        rawActive += 1;
        rawMaxActive = Math.max(rawMaxActive, rawActive);
        started.resolve();
        try {
          await gate.promise;
        } finally {
          rawActive -= 1;
        }
      })();
      return firstTurn ? withTimeout(rawStore, 20, "MemoryDB.store") : rawStore;
    };
    pluginModule.MemoryDB.prototype.search = async function emptyDedupSearch() {
      return [];
    };
    t.after(async () => {
      firstStoreGate.resolve();
      secondStoreGate.resolve();
      await Promise.allSettled([firstRun, secondRun].filter(Boolean));
      pluginModule.MemoryDB.prototype.store = originalStore;
      pluginModule.MemoryDB.prototype.search = originalSearch;
    });

    const api = trackApi(t, makeMockApi(basePath, {
      runtime: { captureTimeoutMs: 500, maxConcurrentCapturePerAgent: 1 },
    }));
    pluginModule.default.register(api);
    const ctx = { agentId: "capture-settlement-agent", workspaceDir: basePath };
    firstRun = api.emit("agent_end", {
      success: true,
      turnId: "turn-b3-store-timeout-1",
      sessionKey: "agent:capture-settlement-agent:main",
      messages: [{ role: "user", content: "Remember this first capture while its raw store remains deliberately active." }],
    }, ctx);
    await firstStoreStarted.promise;

    secondRun = api.emit("agent_end", {
      success: true,
      turnId: "turn-b3-store-timeout-2",
      sessionKey: "agent:capture-settlement-agent:main",
      messages: [{ role: "user", content: "Remember this second capture only after the first raw store has settled." }],
    }, ctx);

    const firstResults = await firstRun;
    const secondStartedBeforeSettlement = await Promise.race([
      secondStoreStarted.promise.then(() => true),
      sleep(250).then(() => false),
    ]);
    assert.equal(secondStartedBeforeSettlement, false, "the second capture must not reach its store before first settlement");
    assert.equal(firstStoreCalls, 1, "the first turn must have exactly one active raw store");
    assert.equal(secondStoreCalls, 0, "a second same-agent capture must remain queued while the first raw store is active");
    assert.equal(rawActive, 1);
    assert.equal(rawMaxActive, 1);
    assert.equal(firstResults[0]?.timedOut, true, "the scheduler should still return its prompt timeout");

    firstStoreGate.resolve();
    await secondStoreStarted.promise;
    assert.equal(rawMaxActive, 1, "same-agent raw capture mutations must never overlap");
    secondStoreGate.resolve();
    const secondResults = await secondRun;
    assert.equal(secondResults[0]?.ok, true, "the queued capture should run normally after settlement");
  });

  it("retains the same-agent capture slot through a timed-out reminder store", async (t) => {
    LocalTransformersEmbeddingProvider.prototype.embedBatch = async function mockedEmbedBatch(texts) {
      return texts.map((_, index) => makeVector(index * 0.01));
    };
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function mockedEmbedQuery() {
      return makeVector(0.2);
    };

    const reminderGate = deferred();
    const secondStoreGate = deferred();
    const reminderStarted = deferred();
    const secondStoreStarted = deferred();
    const pluginModule = await loadFreshPluginModule();
    const originalStore = pluginModule.MemoryDB.prototype.store;
    const originalSearch = pluginModule.MemoryDB.prototype.search;
    let firstNormalStoreCalls = 0;
    let secondStoreCalls = 0;
    let trackedActive = 0;
    let trackedMaxActive = 0;
    let firstRun;
    let secondRun;

    pluginModule.MemoryDB.prototype.store = function controlledReminderStore(entry) {
      if (entry?.sourceTurnId === "turn-b3-reminder-timeout-2") {
        secondStoreCalls += 1;
        const rawSecondStore = (async () => {
          trackedActive += 1;
          trackedMaxActive = Math.max(trackedMaxActive, trackedActive);
          secondStoreStarted.resolve();
          try {
            await secondStoreGate.promise;
          } finally {
            trackedActive -= 1;
          }
        })();
        return rawSecondStore;
      }

      if (entry?.memoryKind !== "reminder") {
        if (entry?.sourceTurnId !== "turn-b3-reminder-timeout-1") {
          throw new Error("unexpected capture turn in reminder settlement test");
        }
        firstNormalStoreCalls += 1;
        this.table = emptyQueryTable();
        return Promise.resolve();
      }

      const rawReminderStore = (async () => {
        trackedActive += 1;
        trackedMaxActive = Math.max(trackedMaxActive, trackedActive);
        reminderStarted.resolve();
        try {
          await reminderGate.promise;
        } finally {
          trackedActive -= 1;
        }
      })();
      return withTimeout(rawReminderStore, 20, "MemoryDB.store:reminder");
    };
    pluginModule.MemoryDB.prototype.search = async function emptyDedupSearch() {
      return [];
    };
    t.after(async () => {
      reminderGate.resolve();
      secondStoreGate.resolve();
      await Promise.allSettled([firstRun, secondRun].filter(Boolean));
      pluginModule.MemoryDB.prototype.store = originalStore;
      pluginModule.MemoryDB.prototype.search = originalSearch;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    });

    const api = trackApi(t, makeMockApi(basePath, {
      runtime: { captureTimeoutMs: 500, maxConcurrentCapturePerAgent: 1 },
    }));
    pluginModule.default.register(api);
    const ctx = { agentId: "reminder-settlement-agent", workspaceDir: basePath };
    firstRun = api.emit("agent_end", {
      success: true,
      turnId: "turn-b3-reminder-timeout-1",
      sessionKey: "agent:reminder-settlement-agent:main",
      messages: [{ role: "user", content: "Let's check in 30 minutes after reviewing this reminder timeout boundary." }],
    }, ctx);
    await reminderStarted.promise;

    secondRun = api.emit("agent_end", {
      success: true,
      turnId: "turn-b3-reminder-timeout-2",
      sessionKey: "agent:reminder-settlement-agent:main",
      messages: [{ role: "user", content: "Remember this next capture only after the reminder write has settled." }],
    }, ctx);

    const firstResults = await firstRun;
    const secondStartedBeforeSettlement = await Promise.race([
      secondStoreStarted.promise.then(() => true),
      sleep(250).then(() => false),
    ]);
    assert.equal(secondStartedBeforeSettlement, false, "the next capture must not reach its store before reminder settlement");
    assert.ok(firstNormalStoreCalls >= 1, "the first turn must reach its normal memory store before the reminder");
    assert.equal(secondStoreCalls, 0, "the next same-agent capture must remain queued behind the reminder mutation");
    assert.equal(trackedActive, 1);
    assert.equal(trackedMaxActive, 1);
    assert.equal(firstResults[0]?.timedOut, true, "a pending reminder mutation should preserve prompt timeout behavior");

    reminderGate.resolve();
    await secondStoreStarted.promise;
    assert.equal(trackedMaxActive, 1, "a reminder write must not overlap the next capture mutation");
    secondStoreGate.resolve();
    const secondResults = await secondRun;
    assert.equal(secondResults[0]?.ok, true);
  });
});
