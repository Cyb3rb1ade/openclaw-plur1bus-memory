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

describe("memory_forget late tombstone audit continuation", () => {
  let api;
  let baseDbPath;
  let openclawHome;
  let originalOpenClawHome;
  let originalTombstone;
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
    originalTombstone = MemoryDB.prototype.tombstone;
    originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function mockQueryEmbedding() {
      return makeVector();
    };
    api = makeMockApi(baseDbPath);
    plugin.register(api);
  });

  afterEach(() => {
    MemoryDB.prototype.tombstone = originalTombstone;
  });

  after(() => {
    MemoryDB.prototype.tombstone = originalTombstone;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    rmSync(baseDbPath, { recursive: true, force: true });
    for (const workspaceDir of workspaceDirs) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    rmSync(openclawHome, { recursive: true, force: true });
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
  });

  it("logs an ID tombstone exactly once when its timed-out mutation commits late", async (t) => {
    const testCase = await createCase();
    const gate = deferred();
    const started = deferred();
    let rawTombstone;

    MemoryDB.prototype.tombstone = function timedOutIdTombstone(id) {
      if (id !== testCase.memoryId) return originalTombstone.call(this, id);
      rawTombstone = (async () => {
        started.resolve();
        await gate.promise;
        return originalTombstone.call(this, id);
      })();
      return withTimeout(rawTombstone, 20, `MemoryDB.tombstone:${id}`);
    };
    t.after(async () => {
      gate.resolve();
      await Promise.allSettled([rawTombstone].filter(Boolean));
    });

    const execution = testCase.forgetTool.execute("forget-id-late", { memoryId: testCase.memoryId });
    await started.promise;
    const result = await execution;
    assert.match(result.content[0].text, /Memory forget failed:.*timed out/i);
    assert.equal((await readMemory(testCase.agentId, testCase.memoryId)).status, "active", "the prompt timeout must occur before raw tombstone settlement");
    assert.equal(readDestructiveOps(testCase.workspaceDir).length, 0);

    gate.resolve();
    await rawTombstone;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((await readMemory(testCase.agentId, testCase.memoryId)).status, "deleted");
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1, "the late committed ID tombstone must retain exactly one audit record");
    assert.equal(logs[0].source, "memory_forget");
    assert.equal(logs[0].via, "id");
    assert.equal(logs[0].memoryId, testCase.memoryId);
    assert.equal(logs[0].result, "committed");
    assert.ok(logs[0].tombstoneId);
  });

  it("logs a query tombstone exactly once when its timed-out mutation commits late", async (t) => {
    const testCase = await createCase();
    const gate = deferred();
    const started = deferred();
    let rawTombstone;

    MemoryDB.prototype.tombstone = function timedOutQueryTombstone(id) {
      if (id !== testCase.memoryId) return originalTombstone.call(this, id);
      rawTombstone = (async () => {
        started.resolve();
        await gate.promise;
        return originalTombstone.call(this, id);
      })();
      return withTimeout(rawTombstone, 20, `MemoryDB.tombstone:${id}`);
    };
    t.after(async () => {
      gate.resolve();
      await Promise.allSettled([rawTombstone].filter(Boolean));
    });

    const query = `semantic target query ${sequence}`;
    const execution = testCase.forgetTool.execute("forget-query-late", { query });
    await started.promise;
    const result = await execution;
    assert.match(result.content[0].text, /Memory forget failed:.*timed out/i);
    assert.equal((await readMemory(testCase.agentId, testCase.memoryId)).status, "active");
    assert.equal(readDestructiveOps(testCase.workspaceDir).length, 0);

    gate.resolve();
    await rawTombstone;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((await readMemory(testCase.agentId, testCase.memoryId)).status, "deleted");
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1, "the late committed query tombstone must retain exactly one audit record");
    assert.equal(logs[0].source, "memory_forget");
    assert.equal(logs[0].via, "query");
    assert.equal(logs[0].memoryId, testCase.memoryId);
    assert.equal(logs[0].query, query);
    assert.equal(logs[0].result, "committed");
    assert.ok(logs[0].tombstoneId);
  });

  it("tombstones and logs a normal ID request", async () => {
    const testCase = await createCase();

    const result = await testCase.forgetTool.execute("forget-id-normal", { memoryId: testCase.memoryId });

    assert.match(result.content[0].text, /forgotten \(tombstoned\)/i);
    assert.equal((await readMemory(testCase.agentId, testCase.memoryId)).status, "deleted");
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].via, "id");
    assert.equal(logs[0].result, "committed");
    assert.ok(logs[0].tombstoneId);
  });

  it("tombstones and logs a normal query request", async () => {
    const testCase = await createCase();
    const query = `normal semantic query ${sequence}`;

    const result = await testCase.forgetTool.execute("forget-query-normal", { query });

    assert.match(result.content[0].text, /Forgotten:/);
    assert.equal((await readMemory(testCase.agentId, testCase.memoryId)).status, "deleted");
    const logs = readDestructiveOps(testCase.workspaceDir);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].via, "query");
    assert.equal(logs[0].query, query);
    assert.equal(logs[0].result, "committed");
    assert.ok(logs[0].tombstoneId);
  });

  it("Late-Settlement mit Audit-Fehler erzeugt kein falsches Commit-Audit und wird bei Wiederholung nachgetragen", async (t) => {
    const gate = deferred();
    const started = deferred();
    let rawTombstone;

    const { agentId, workspaceDir, memoryId } = await createCase();

    // Audit-Pfad blockieren: destructive-ops.jsonl als VERZEICHNIS anlegen.
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true });

    MemoryDB.prototype.tombstone = function timedOutIdTombstone(id) {
      if (id !== memoryId) return originalTombstone.call(this, id);
      rawTombstone = (async () => {
        started.resolve();
        await gate.promise;
        return originalTombstone.call(this, id);
      })();
      return withTimeout(rawTombstone, 20, `MemoryDB.tombstone:${id}`);
    };
    t.after(async () => {
      gate.resolve();
      await Promise.allSettled([rawTombstone].filter(Boolean));
    });

    const execution = (await api._toolFactory({ agentId, workspaceDir }))
      .find((tool) => tool.name === "memory_forget")
      .execute("forget-id-late-audit", { memoryId });
    await started.promise;
    const result = await execution;
    assert.match(result.content[0].text, /Memory forget failed:.*timed out/i);

    gate.resolve();
    await rawTombstone;
    await new Promise((resolve) => setImmediate(resolve));

    // Mutation ist durch, aber das Late-Settlement musste wegen Audit-Fehler
    // abgelehnt werden: KEIN falsches Commit-Audit (Pfad ist weiterhin das
    // blockierende Verzeichnis).
    const auditPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    if (existsSync(auditPath)) {
      const { statSync } = await import("node:fs");
      assert.ok(statSync(auditPath).isDirectory(), "kein falsches Commit-Audit (Pfad bleibt blockiert)");
    }

    // Pfad freigeben → Wiederholung trägt das Audit nach.
    MemoryDB.prototype.tombstone = originalTombstone;
    rmSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true, force: true });
    const second = await (await api._toolFactory({ agentId, workspaceDir }))
      .find((tool) => tool.name === "memory_forget")
      .execute("forget-id-repeat", { memoryId });
    assert.match(second.content[0].text, /forgotten/i);
    assert.ok(existsSync(auditPath), "Audit muss nach Wiederholung existieren");
    const events = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.memoryId === memoryId && (e.result === "committed" || e.result === "already_tombstoned")));
  });
});
