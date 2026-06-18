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
});
