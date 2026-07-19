import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { withTimeout } from "../lib/with-timeout.js";

const VECTOR_DIM = 384;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeVector() {
  const vector = Array(VECTOR_DIM).fill(0.1);
  vector[0] = 0.5;
  return vector;
}

function makeMockApi(baseDbPath) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      merging: { enabled: false },
      obsidianBridge: { enabled: false },
      neo: { enabled: false },
      gc: { enabled: false },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (path) => path,
    registerCommand: noop,
    registerTool(factory) { this._toolFactory = factory; },
    registerService: noop,
    on: noop,
  };
}

describe("memory_forget late delete audit continuation", () => {
  let api;
  let baseDbPath;
  let openclawHome;
  let originalOpenClawHome;
  let originalDelete;
  let originalEmbedQuery;
  let sequence = 0;
  let workspaceDirs = [];

  function readDestructiveOps(workspaceDir) {
    const path = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function readMemory(agentId, memoryId) {
    const db = new MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
    await db.init();
    try {
      return await db.getById(memoryId);
    } finally {
      await db.shutdown();
    }
  }

  async function createCase() {
    sequence += 1;
    const agentId = `forgetagent${sequence}`;
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-forget-late-ws-"));
    workspaceDirs.push(workspaceDir);
    const memoryId = randomUUID();
    const text = `Unique forget target ${sequence} with enough detail for a semantic query.`;
    const db = new MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
    await db.init();
    await db.store({
      id: memoryId,
      text,
      summary: text,
      origin: "dm",
      vector: makeVector(),
      importance: 0.6,
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      workspaceKey: workspaceDir,
      scope: "agent-private",
      status: "active",
    });
    await db.shutdown();
    const tools = api._toolFactory({ agentId, workspaceDir });
    const forgetTool = tools.find((tool) => tool.name === "memory_forget");
    assert.ok(forgetTool, "memory_forget tool should be registered");
    return { agentId, workspaceDir, memoryId, text, forgetTool };
  }

  before(() => {
    baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-forget-late-db-"));
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-forget-late-home-"));
    process.env.OPENCLAW_HOME = openclawHome;
    originalDelete = MemoryDB.prototype.delete;
    originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function mockQueryEmbedding() {
      return makeVector();
    };
    api = makeMockApi(baseDbPath);
    plugin.register(api);
  });

  afterEach(() => {
    MemoryDB.prototype.delete = originalDelete;
  });

  after(() => {
    MemoryDB.prototype.delete = originalDelete;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    rmSync(baseDbPath, { recursive: true, force: true });
    for (const workspaceDir of workspaceDirs) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    rmSync(openclawHome, { recursive: true, force: true });
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
  });

  it("logs an ID delete exactly once when its timed-out mutation commits late", async (t) => {
    const testCase = await createCase();
    const deleteGate = deferred();
    const deleteStarted = deferred();
    let rawDelete;

    MemoryDB.prototype.delete = function timedOutIdDelete(id) {
      if (id !== testCase.memoryId) return originalDelete.call(this, id);
      rawDelete = (async () => {
        deleteStarted.resolve();
        await deleteGate.promise;
        return originalDelete.call(this, id);
      })();
      return withTimeout(rawDelete, 20, `MemoryDB.delete:${id}`);
    };
    t.after(async () => {
      deleteGate.resolve();
      await Promise.allSettled([rawDelete].filter(Boolean));
    });

    const execution = testCase.forgetTool.execute("forget-id-late", { memoryId: testCase.memoryId });
    await deleteStarted.promise;
    const result = await execution;
    assert.match(result.content[0].text, /Memory forget failed:.*timed out/i);
    assert.ok(await readMemory(testCase.agentId, testCase.memoryId), "the prompt timeout must occur before raw delete settlement");
    assert.equal(readDestructiveOps(testCase.workspaceDir).length, 0);

    deleteGate.resolve();
    await rawDelete;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await readMemory(testCase.agentId, testCase.memoryId), null);
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1, "the late committed ID delete must retain exactly one audit record");
    assert.equal(logs[0].source, "memory_forget");
    assert.equal(logs[0].via, "id");
    assert.equal(logs[0].memoryId, testCase.memoryId);
    assert.match(logs[0].idempotencyKey, /^sha256:/);
  });

  it("logs a query delete exactly once when its timed-out mutation commits late", async (t) => {
    const testCase = await createCase();
    const deleteGate = deferred();
    const deleteStarted = deferred();
    let rawDelete;

    MemoryDB.prototype.delete = function timedOutQueryDelete(id) {
      if (id !== testCase.memoryId) return originalDelete.call(this, id);
      rawDelete = (async () => {
        deleteStarted.resolve();
        await deleteGate.promise;
        return originalDelete.call(this, id);
      })();
      return withTimeout(rawDelete, 20, `MemoryDB.delete:${id}`);
    };
    t.after(async () => {
      deleteGate.resolve();
      await Promise.allSettled([rawDelete].filter(Boolean));
    });

    const query = `semantic target query ${sequence}`;
    const execution = testCase.forgetTool.execute("forget-query-late", { query });
    await deleteStarted.promise;
    const result = await execution;
    assert.match(result.content[0].text, /Memory forget failed:.*timed out/i);
    assert.ok(await readMemory(testCase.agentId, testCase.memoryId));
    assert.equal(readDestructiveOps(testCase.workspaceDir).length, 0);

    deleteGate.resolve();
    await rawDelete;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await readMemory(testCase.agentId, testCase.memoryId), null);
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1, "the late committed query delete must retain exactly one audit record");
    assert.equal(logs[0].source, "memory_forget");
    assert.equal(logs[0].via, "query");
    assert.equal(logs[0].memoryId, testCase.memoryId);
    assert.equal(logs[0].query, query);
    assert.match(logs[0].idempotencyKey, /^sha256:/);
  });

  it("deletes and logs a normal ID request", async () => {
    const testCase = await createCase();

    const result = await testCase.forgetTool.execute("forget-id-normal", { memoryId: testCase.memoryId });

    assert.match(result.content[0].text, /forgotten \(archived\)/i);
    assert.equal(await readMemory(testCase.agentId, testCase.memoryId), null);
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].via, "id");
    assert.match(logs[0].idempotencyKey, /^sha256:/);
  });

  it("deletes and logs a normal query request", async () => {
    const testCase = await createCase();
    const query = `normal semantic query ${sequence}`;

    const result = await testCase.forgetTool.execute("forget-query-normal", { query });

    assert.match(result.content[0].text, /Forgotten:/);
    assert.equal(await readMemory(testCase.agentId, testCase.memoryId), null);
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].via, "query");
    assert.equal(logs[0].query, query);
    assert.match(logs[0].idempotencyKey, /^sha256:/);
  });
});
