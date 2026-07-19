import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

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
    registerService() {},
  };
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

  it("calls embedBatch with captured texts", async () => {
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
    const api = makeMockApi(basePath);
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
    const ctx = { agentId: "main" };

    await api.emit("agent_end", event, ctx);

    assert.ok(batchCalls.length > 0, "embedBatch should have been called during auto-capture");
    const firstBatch = batchCalls[0];
    assert.ok(firstBatch.some((t) => t.includes("dark mode")), "batch should include captured user text");
    assert.strictEqual(individualCalls.length, 0, "individual embed should not be needed when embedBatch succeeds");
  });

  it("falls back to individual embed when embedBatch is not available", async () => {
    const individualCalls = [];

    LocalTransformersEmbeddingProvider.prototype.embedBatch = undefined;
    LocalTransformersEmbeddingProvider.prototype.embed = async function mockedEmbed(text) {
      individualCalls.push(text);
      return makeVector(0.99);
    };

    const plugin = await loadFreshPlugin();
    const api = makeMockApi(basePath);
    plugin.register(api);

    const event = {
      success: true,
      turnId: "turn-2",
      sessionKey: "agent:main:main",
      messages: [
        { role: "user", content: "My favorite color is blue." },
      ],
    };
    const ctx = { agentId: "main" };

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

    const api = makeMockApi(basePath, {
      runtime: { captureTimeoutMs: 20, maxConcurrentCapturePerAgent: 1 },
    });
    pluginModule.default.register(api);
    const event = {
      success: true,
      turnId: "turn-b3-abort",
      sessionKey: "agent:abort-agent:main",
      messages: [{ role: "user", content: "Remember this delayed batch capture must stop after timeout." }],
    };

    const emitted = api.emit("agent_end", event, { agentId: "abort-agent" });
    await batchStarted.promise;
    const results = await emitted;
    assert.equal(results[0]?.timedOut, true, "the hook should preserve its prompt timeout result");

    batchGate.resolve();
    await sleep(100);
    assert.equal(storeCalls, 0, "an abort observed after embedding must stop before the durable store boundary");
  });
});
