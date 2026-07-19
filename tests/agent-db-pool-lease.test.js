import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, * as pluginModule from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { TimeoutError } from "../lib/with-timeout.js";

const VECTOR_DIM = 3;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeApi(baseDbPath) {
  const shutdownHandlers = [];
  const warnings = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      emotion: { t3: { enabled: false } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      retroactiveInterference: { enabled: false },
      featureCronSetup: { auto: false },
    },
    logger: {
      info: noop,
      warn: (...args) => warnings.push(args.map(String).join(" ")),
      error: noop,
      debug: noop,
    },
    resolvePath: (value) => value,
    registerCommand: noop,
    registerTool(factory) { this._toolFactory = factory; },
    registerService: noop,
    on(event, handler) {
      if (event === "gateway_stop") shutdownHandlers.push(handler);
    },
    _shutdownHandlers: shutdownHandlers,
    _warnings: warnings,
  };
}

function installDbStubs(t, options = {}) {
  const originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  const originalFindSimilar = pluginModule.MemoryDB.prototype.findSimilar;
  const originalStore = pluginModule.MemoryDB.prototype.store;
  const originalShutdown = pluginModule.MemoryDB.prototype.shutdown;
  const operationStarted = deferred();
  const operationGate = deferred();
  const seenByAgent = new Map();
  const shutdownPaths = [];
  let blockedOnce = false;

  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => [0.1, 0.2, 0.3];
  pluginModule.MemoryDB.prototype.findSimilar = async function findSimilarStub() {
    const agentId = this.dbPath.split(/[/\\]/).pop();
    if (!seenByAgent.has(agentId)) seenByAgent.set(agentId, []);
    seenByAgent.get(agentId).push(this);
    if (agentId === options.blockedAgentId && !blockedOnce) {
      blockedOnce = true;
      operationStarted.resolve();
      await operationGate.promise;
    }
    return [];
  };
  pluginModule.MemoryDB.prototype.store = async function storeStub() {};
  pluginModule.MemoryDB.prototype.shutdown = async function shutdownStub() {
    shutdownPaths.push(this.dbPath);
    if (options.shutdownError) throw options.shutdownError;
  };

  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    pluginModule.MemoryDB.prototype.findSimilar = originalFindSimilar;
    pluginModule.MemoryDB.prototype.store = originalStore;
    pluginModule.MemoryDB.prototype.shutdown = originalShutdown;
    operationGate.resolve();
  });

  return { operationStarted, operationGate, seenByAgent, shutdownPaths };
}

function toolsFor(api, agentId, workspaceDir) {
  return api._toolFactory({ agentId, workspaceDir, workspaceKey: "workspace-b7", userId: "owner-b7" });
}

async function storeFor(api, agentId, workspaceDir) {
  const tool = toolsFor(api, agentId, workspaceDir).find((candidate) => candidate.name === "memory_store");
  const result = await tool.execute(`store-${agentId}`, { text: `lease fixture for ${agentId}`, category: "fact" });
  assert.equal(result.details?.action, "stored", JSON.stringify(result));
  return result;
}

async function stopApi(api) {
  await Promise.all(api._shutdownHandlers.map((handler) => handler()));
}

describe("AgentDbPool operation leases", { concurrency: false }, () => {
  it("exposes the callback-scoped withDb contract", () => {
    assert.equal(typeof pluginModule.AgentDbPool, "function", "AgentDbPool must be exported for lifecycle verification");
    assert.equal(typeof pluginModule.AgentDbPool?.prototype?.withDb, "function", "AgentDbPool.withDb is required");
  });

  it("keeps a timed-out operation leased until its attached raw settlement", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b3-agent-pool-timeout-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const pool = new pluginModule.AgentDbPool(baseDbPath, VECTOR_DIM, {
      info() {}, warn() {}, error() {}, debug() {},
    });
    const rawSettlement = deferred();
    const timeoutError = new TimeoutError("MemoryDB.store", 15);
    timeoutError.settlement = rawSettlement.promise;
    let shutdownCalls = 0;

    const operation = pool.withDb("agent-timeout", async (db) => {
      db.shutdown = async () => { shutdownCalls += 1; };
      throw timeoutError;
    });
    await assert.rejects(operation, (error) => error === timeoutError);

    const shutdown = pool.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCalls, 0, "the DB must remain leased after the public timeout");

    rawSettlement.resolve("late-write-settled");
    await shutdown;
    assert.equal(shutdownCalls, 1, "shutdown may close the DB only after raw mutation settlement");
  });

  it("keeps the oldest of 51 agent DBs open until its operation settles", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b7-agent-pool-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b7-agent-pool-ws-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

    const firstAgent = "lease-agent-00";
    const state = installDbStubs(t, { blockedAgentId: firstAgent });
    const api = makeApi(baseDbPath);
    plugin.register(api);
    const firstPath = join(baseDbPath, firstAgent);
    const firstOperation = storeFor(api, firstAgent, workspaceDir);
    await state.operationStarted.promise;

    try {
      for (let index = 1; index <= 50; index++) {
        const agentId = `lease-agent-${String(index).padStart(2, "0")}`;
        await storeFor(api, agentId, workspaceDir);
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        state.shutdownPaths.includes(firstPath),
        false,
        "adding the 51st agent must not close the oldest DB while its callback is active",
      );

      const reusedAgent = "lease-agent-50";
      await storeFor(api, reusedAgent, workspaceDir);
      const reusedInstances = state.seenByAgent.get(reusedAgent);
      assert.equal(reusedInstances.length, 2);
      assert.equal(reusedInstances[0], reusedInstances[1], "the same cached agent must reuse one DB instance");
      assert.notEqual(
        state.seenByAgent.get(firstAgent)[0],
        reusedInstances[0],
        "different agents must never share a DB instance",
      );
      assert.equal(state.seenByAgent.get(firstAgent)[0].dbPath, firstPath);
      assert.equal(reusedInstances[0].dbPath, join(baseDbPath, reusedAgent));
    } finally {
      state.operationGate.resolve();
      await firstOperation;
    }

    await storeFor(api, "lease-agent-51", workspaceDir);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      state.shutdownPaths.includes(firstPath),
      true,
      "after the callback settles, a later insertion must resume normal LRU eviction",
    );
    await stopApi(api);
  });

  it("waits for active work and logs contextual shutdown failures", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b7-agent-shutdown-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b7-agent-shutdown-ws-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

    const agentId = "lease-shutdown-agent";
    const closeError = new Error("injected agent DB close failure");
    const state = installDbStubs(t, { blockedAgentId: agentId, shutdownError: closeError });
    const api = makeApi(baseDbPath);
    plugin.register(api);
    const activeOperation = storeFor(api, agentId, workspaceDir);
    await state.operationStarted.promise;

    const shutdown = stopApi(api);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.shutdownPaths.length, 0, "pool shutdown must wait before closing an actively leased DB");

    state.operationGate.resolve();
    await activeOperation;
    await shutdown;

    assert.ok(
      api._warnings.some((line) => line.includes(agentId) && line.includes(closeError.message)),
      `expected agent/namespace shutdown context, got: ${JSON.stringify(api._warnings)}`,
    );
  });
});
