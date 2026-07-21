import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

function errorTreeIncludes(error, expected) {
  if (error === expected) return true;
  if (error?.cause && errorTreeIncludes(error.cause, expected)) return true;
  return error instanceof AggregateError
    && error.errors.some((nested) => errorTreeIncludes(nested, expected));
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

  it("creates a missing writable base safely and blocks an existing outside agent symlink", (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-agent-route-root-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-agent-route-outside-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.after(() => rmSync(outside, { recursive: true, force: true }));

    const basePath = join(root, "active");
    const pool = new pluginModule.AgentDbPool(basePath, VECTOR_DIM);
    assert.equal(pool.getDb("agent-a").dbPath, join(basePath, "agent-a"));
    assert.equal(existsSync(basePath), true);
    symlinkSync(outside, join(basePath, "agent-outside"));
    assert.throws(() => pool.getDb("agent-outside"), /traversal/i);
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

  it("finishes terminal cleanup and preserves DB plus logger failures when shutdown logging throws", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b12-agent-shutdown-logger-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const firstCloseError = new Error("injected first shutdown close failure");
    const secondCloseError = new Error("injected second shutdown close failure");
    const loggerError = new Error("injected shutdown logger failure");
    const pool = new pluginModule.AgentDbPool(baseDbPath, VECTOR_DIM, {
      warn() { throw loggerError; },
    });
    const firstDb = pool.getDb("agent-shutdown-a");
    const secondDb = pool.getDb("agent-shutdown-b");
    const agentCapabilities = [firstDb.directoryCapability, secondDb.directoryCapability];
    const baseCapability = pool.baseDirectoryCapability;
    firstDb.table = { close: async () => { throw firstCloseError; } };
    firstDb.db = { close: async () => {} };
    secondDb.table = { close: async () => { throw secondCloseError; } };
    secondDb.db = { close: async () => {} };

    await assert.rejects(pool.shutdown(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(errorTreeIncludes(error, firstCloseError), "the first DB failure remains observable");
      assert.ok(errorTreeIncludes(error, secondCloseError), "the second DB failure remains observable");
      assert.ok(errorTreeIncludes(error, loggerError), "the logger failure remains observable");
      return true;
    });
    assert.deepEqual(agentCapabilities.map((capability) => capability.closed), [true, true]);
    assert.equal(baseCapability.closed, true, "terminal shutdown still closes the base capability");
    assert.equal(pool.baseDirectoryCapability, null);
    assert.equal(pool.dbs.entries().length, 0, "terminal shutdown clears cached DB references");
    await assert.doesNotReject(() => pool.shutdown(), "terminal retry remains an idempotent no-op");
  });

  it("clears cached DBs and preserves DB plus logger failures when clear logging throws", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b12-agent-clear-logger-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const closeError = new Error("injected clear close failure");
    const loggerError = new Error("injected clear logger failure");
    const pool = new pluginModule.AgentDbPool(baseDbPath, VECTOR_DIM, {
      warn() { throw loggerError; },
    });
    const db = pool.getDb("agent-clear");
    const agentCapability = db.directoryCapability;
    const baseCapability = pool.baseDirectoryCapability;
    db.table = { close: async () => { throw closeError; } };
    db.db = { close: async () => {} };

    await assert.rejects(pool.clear(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(errorTreeIncludes(error, closeError), "the DB failure remains observable");
      assert.ok(errorTreeIncludes(error, loggerError), "the logger failure remains observable");
      return true;
    });
    assert.equal(agentCapability.closed, true);
    assert.equal(baseCapability.closed, false, "a reusable clear retains the base capability");
    assert.equal(pool.dbs.entries().length, 0, "clear removes the failed DB from the cache");

    const replacement = pool.getDb("agent-clear");
    assert.notEqual(replacement, db, "the reusable pool creates a fresh DB after clear");
    await pool.shutdown();
  });

  it("keeps eviction and logger failures observable without retaining the evicted DB", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b12-agent-eviction-logger-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const closeError = new Error("injected eviction close failure");
    const loggerError = new Error("injected eviction logger failure");
    const pool = new pluginModule.AgentDbPool(baseDbPath, VECTOR_DIM, {
      warn() { throw loggerError; },
    });
    const evictedDb = pool.getDb("agent-00");
    const evictedCapability = evictedDb.directoryCapability;
    evictedDb.table = { close: async () => { throw closeError; } };
    evictedDb.db = { close: async () => {} };

    for (let index = 1; index <= 50; index++) {
      pool.getDb(`agent-${String(index).padStart(2, "0")}`);
    }

    await assert.rejects(pool.dbs.awaitPendingEvictions(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(errorTreeIncludes(error, closeError), "the eviction failure remains observable");
      assert.ok(errorTreeIncludes(error, loggerError), "the eviction logger failure remains observable");
      return true;
    });
    assert.equal(evictedCapability.closed, true);
    assert.equal(pool.dbs.has("agent-00"), false, "the failed eviction does not retain its cache entry");
    await pool.shutdown();
  });

  it("settles a late-operation lease when warning delivery throws and reports it during shutdown", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b12-agent-late-logger-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const lateError = new Error("injected late operation failure");
    const loggerError = new Error("injected late logger failure");
    const rawSettlement = deferred();
    let warningCalls = 0;
    const pool = new pluginModule.AgentDbPool(baseDbPath, VECTOR_DIM, {
      warn() {
        warningCalls++;
        if (warningCalls === 1) throw loggerError;
      },
    });
    const timeoutError = new TimeoutError("MemoryDB.store", 15, rawSettlement.promise);
    let baseCapability;

    const operation = pool.withDb("agent-late", async (db) => {
      baseCapability = pool.baseDirectoryCapability;
      db.shutdown = async () => { db.directoryCapability.close(); };
      throw timeoutError;
    });
    await assert.rejects(operation, (error) => error === timeoutError);
    const [lease] = [...pool.activeOperations];
    assert.ok(lease, "the late raw settlement remains tracked after the public timeout");

    rawSettlement.reject(lateError);
    await assert.doesNotReject(lease, "warning delivery must not reject the lifecycle lease");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pool.activeOperations.size, 0);

    await assert.rejects(pool.shutdown(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(errorTreeIncludes(error, loggerError), "the deferred logger failure remains observable");
      return true;
    });
    assert.equal(baseCapability.closed, true, "shutdown still closes the base capability");
    assert.equal(pool.dbs.entries().length, 0);
  });
});
