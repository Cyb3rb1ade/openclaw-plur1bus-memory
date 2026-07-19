import { randomUUID } from "node:crypto";
import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import OpenAI from "openai";

const VECTOR_DIM = 384;
const AGENT_ID_PREFIX = "testagent";
const ORIGINAL_ID = "11111111-1111-1111-1111-111111111111";
const ORIGINAL_TEXT = "Original fact about cats";

function makeVector(offset = 0) {
  const vec = Array(VECTOR_DIM).fill(0.1);
  vec[0] = 0.1 + offset;
  return vec;
}

function makeMockApi(baseDbPath) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: true, model: "mock-model", apiKey: "sk-test" },
      duplicateThreshold: 0.99,
      obsidianBridge: { enabled: false },
      runtime: { llmResultCacheEnabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (p) => p,
    registerCommand: noop,
    registerTool(factory) {
      this._toolFactory = factory;
    },
    on: noop,
    registerService: noop,
  };
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === "bigint" ? String(item) : item
  )));
}

function mergedText(existingText, incomingText) {
  return `${existingText}; ${incomingText}`;
}

describe("memory_store durable merge boundary (BUG-02 / BUG-09)", () => {
  let basePath;
  let api;
  let agentId;
  let agentSequence = 0;
  let workspaceDir;
  let archiveDir;
  let archiveAgentDir;
  let openclawHome;
  let originalOpenClawHome;
  let seedDb;
  let storeTool;
  let authoritativeOriginal;
  let mergeLlmCalls;
  let originalCreate;
  let originalEmbed;
  let originalStore;
  let originalGetById;
  let originalFindMergeCandidate;
  let originalDelete;

  function readArchiveEntries() {
    if (!existsSync(archiveAgentDir)) return [];
    return readdirSync(archiveAgentDir)
      .sort()
      .map((name) => {
        const path = join(archiveAgentDir, name);
        return { path, card: JSON.parse(readFileSync(path, "utf8")) };
      });
  }

  function readDestructiveOps() {
    const logPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function readRows() {
    const checkDb = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await checkDb.init();
    try {
      return await checkDb.table.query().toArray();
    } finally {
      await checkDb.shutdown();
    }
  }

  async function executeStore(text = "Additional cat fact") {
    return storeTool.execute(`call-${randomUUID()}`, { text, category: "fact" });
  }

  before(async () => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-merge-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-merge-ws-"));

    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_HOME = openclawHome;
    archiveDir = join(openclawHome, ".openclaw", "memory", "_archive");

    originalCreate = OpenAI.Chat.Completions.prototype.create;
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalStore = MemoryDB.prototype.store;
    originalGetById = MemoryDB.prototype.getById;
    originalFindMergeCandidate = MemoryDB.prototype.findMergeCandidate;
    originalDelete = MemoryDB.prototype.delete;

    OpenAI.Chat.Completions.prototype.create = async function mockedCreate(body) {
      const prompt = String(body?.messages?.at(-1)?.content || "");
      if (prompt.includes("Two memory fragments")) mergeLlmCalls += 1;
      const existingText = prompt.match(/Fragment A: ([^\n]+)/)?.[1] || ORIGINAL_TEXT;
      const incomingText = prompt.match(/Fragment B: ([^\n]+)/)?.[1] || "Additional cat fact";
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              merge: true,
              reason: "test",
              mergedText: mergedText(existingText, incomingText),
            }),
          },
        }],
      };
    };

    api = makeMockApi(basePath);
    plugin.register(api);
  });

  beforeEach(async () => {
    MemoryDB.prototype.store = originalStore;
    MemoryDB.prototype.getById = originalGetById;
    MemoryDB.prototype.findMergeCandidate = originalFindMergeCandidate;
    MemoryDB.prototype.delete = originalDelete;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.25);
    };
    mergeLlmCalls = 0;
    agentSequence += 1;
    agentId = `${AGENT_ID_PREFIX}${agentSequence}`;
    archiveAgentDir = join(archiveDir, agentId);

    rmSync(archiveAgentDir, { recursive: true, force: true });
    mkdirSync(archiveAgentDir, { recursive: true });
    rmSync(join(workspaceDir, ".adaptive-learning"), { recursive: true, force: true });

    const tools = api._toolFactory({ agentId, workspaceDir });
    storeTool = tools.find((tool) => tool.name === "memory_store");
    assert.ok(storeTool, "memory_store tool should be registered");

    seedDb = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await seedDb.init();
    const existingRows = await seedDb.table.query().toArray();
    for (const row of existingRows) {
      await originalDelete.call(seedDb, row.id);
    }
    await originalStore.call(seedDb, {
      id: ORIGINAL_ID,
      text: ORIGINAL_TEXT,
      summary: "Complete original summary",
      origin: "dm",
      vector: makeVector(),
      importance: 0.7,
      category: "fact",
      createdAt: 1_700_000_000_000,
      storedBy: agentId,
      sourceUrl: "https://example.test/original",
      evidenceQuote: "Original evidence",
      scope: "agent-private",
      emotionalDominant: "curiosity",
      status: "active",
    });
    const authoritativeDb = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await authoritativeDb.init();
    authoritativeOriginal = await originalGetById.call(authoritativeDb, ORIGINAL_ID);
    await authoritativeDb.shutdown();
    assert.ok(authoritativeOriginal, "seeded authoritative original should exist");
  });

  afterEach(async () => {
    MemoryDB.prototype.store = originalStore;
    MemoryDB.prototype.getById = originalGetById;
    MemoryDB.prototype.findMergeCandidate = originalFindMergeCandidate;
    MemoryDB.prototype.delete = originalDelete;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    if (seedDb) await seedDb.shutdown();
  });

  after(() => {
    OpenAI.Chat.Completions.prototype.create = originalCreate;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    MemoryDB.prototype.store = originalStore;
    MemoryDB.prototype.getById = originalGetById;
    MemoryDB.prototype.findMergeCandidate = originalFindMergeCandidate;
    MemoryDB.prototype.delete = originalDelete;

    try { rmSync(basePath, { recursive: true, force: true }); } catch {}
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
    try { rmSync(openclawHome, { recursive: true, force: true }); } catch {}

    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
  });

  it("preserves the original memory when merged embedding fails", async () => {
    let embedCallCount = 0;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      embedCallCount += 1;
      if (embedCallCount === 2) {
        throw new Error("embedding failed for merged text");
      }
      return makeVector(0.25);
    };

    const result = await executeStore();
    assert.match(result.content[0].text, /Memory store failed:.*embedding failed for merged text/);
    assert.equal(embedCallCount, 2, "merge path should attempt to embed the merged text");

    const rows = await readRows();
    assert.ok(rows.some((row) => row.id === ORIGINAL_ID), "embedding failure must preserve the original");
    assert.deepEqual(readArchiveEntries(), [], "embedding failure must not archive before preparation completes");
    assert.deepEqual(readDestructiveOps(), [], "embedding failure must not emit a deletion log");
  });

  it("preserves and fully archives the original when replacement store fails", async () => {
    let replacementStoreCalls = 0;
    MemoryDB.prototype.store = async function failingReplacementStore(entry) {
      replacementStoreCalls += 1;
      throw new Error(`store failed for merged entry ${entry.id}`);
    };

    const result = await executeStore();
    MemoryDB.prototype.store = originalStore;

    assert.match(result.content[0].text, /Memory store failed:.*store failed for merged entry/);
    assert.notEqual(result.details?.action, "merged", "store failure must never acknowledge merge success");
    assert.equal(replacementStoreCalls, 1, "merge path should attempt one replacement store");

    const rows = await readRows();
    assert.ok(rows.some((row) => row.id === ORIGINAL_ID), "replacement store failure must preserve the original");
    const archives = readArchiveEntries();
    assert.equal(archives.length, 1, "the authoritative original should be archived exactly once");
    assert.deepEqual(archives[0].card, jsonClone(authoritativeOriginal), "archive must contain the full authoritative row");
    assert.deepEqual(readDestructiveOps(), [], "store failure must not emit a deletion log");
  });

  it("keeps a repairable fork when replacement readback verification fails", async () => {
    let replacementReadbacks = 0;
    MemoryDB.prototype.getById = async function missingReplacementReadback(id) {
      const row = await originalGetById.call(this, id);
      if (id !== ORIGINAL_ID) {
        replacementReadbacks += 1;
        return null;
      }
      return row;
    };

    const incomingText = "Additional cat fact";
    const result = await executeStore(incomingText);
    MemoryDB.prototype.getById = originalGetById;

    assert.match(result.content[0].text, /Memory store failed:.*verification/i);
    assert.notEqual(result.details?.action, "merged", "failed readback must never acknowledge merge success");
    assert.equal(replacementReadbacks, 1, "replacement must be read back exactly once");

    const rows = await readRows();
    assert.ok(rows.some((row) => row.id === ORIGINAL_ID), "failed readback must leave the original active");
    const replacement = rows.find((row) => row.id !== ORIGINAL_ID);
    assert.ok(replacement, "the durably written replacement should remain as a repairable fork");
    assert.equal(replacement.text, mergedText(ORIGINAL_TEXT, incomingText));
    const archives = readArchiveEntries();
    assert.equal(archives.length, 1);
    assert.deepEqual(archives[0].card, jsonClone(authoritativeOriginal));
    assert.deepEqual(readDestructiveOps(), [], "failed readback must not emit a deletion log");
  });

  it("stores and verifies the replacement before deleting and logging the original", async () => {
    const incomingText = "Additional cat fact";
    const result = await executeStore(incomingText);

    assert.equal(result.details?.action, "merged");
    const rows = await readRows();
    assert.ok(!rows.some((row) => row.id === ORIGINAL_ID), "original should be absent only after a durable merge");
    const replacement = rows.find((row) => row.id === result.details.id);
    assert.ok(replacement, "returned replacement ID must exist");
    assert.equal(replacement.text, mergedText(ORIGINAL_TEXT, incomingText));
    assert.equal(replacement.status, "active");
    assert.deepEqual(JSON.parse(replacement.mergedFrom), [ORIGINAL_ID]);

    const archives = readArchiveEntries();
    assert.equal(archives.length, 1);
    assert.deepEqual(archives[0].card, jsonClone(authoritativeOriginal));

    const mergeLogs = readDestructiveOps().filter((entry) => entry.source === "memory_store_merge");
    assert.equal(mergeLogs.length, 1, "successful merge should emit exactly one destructive log");
    assert.equal(mergeLogs[0].event, "memory.deleted");
    assert.equal(mergeLogs[0].agentId, agentId);
    assert.equal(mergeLogs[0].memoryId, ORIGINAL_ID);
    assert.equal(mergeLogs[0].archivePath, archives[0].path);
  });

  it("continues the same-candidate queue after failure and rejects a stale waiter before LLM", async () => {
    let arrivals = 0;
    let releaseBarrier;
    let rejectBarrier;
    const barrier = new Promise((resolve, reject) => {
      releaseBarrier = resolve;
      rejectBarrier = reject;
    });
    const barrierTimer = setTimeout(() => rejectBarrier(new Error("same-candidate barrier timed out")), 10_000);

    MemoryDB.prototype.findMergeCandidate = async function synchronizedFindMergeCandidate(...args) {
      const candidate = await originalFindMergeCandidate.apply(this, args);
      if (candidate?.entry?.id === ORIGINAL_ID && arrivals < 3) {
        arrivals += 1;
        if (arrivals === 3) {
          clearTimeout(barrierTimer);
          releaseBarrier();
        }
        await barrier;
      }
      return candidate;
    };

    let replacementStoreAttempts = 0;
    MemoryDB.prototype.store = async function failFirstReplacementStore(entry) {
      replacementStoreAttempts += 1;
      if (replacementStoreAttempts === 1) {
        throw new Error("first queued replacement store failed");
      }
      return originalStore.call(this, entry);
    };

    const results = await Promise.all([
      executeStore("Additional cat fact"),
      executeStore("Additional cat fact"),
      executeStore("Additional cat fact"),
    ]);
    clearTimeout(barrierTimer);
    MemoryDB.prototype.findMergeCandidate = originalFindMergeCandidate;
    MemoryDB.prototype.store = originalStore;

    assert.equal(arrivals, 3, "all stores should select the same pre-boundary snapshot");
    const mergedResults = results.filter((result) => result.details?.action === "merged");
    const failedStoreResults = results.filter((result) => /first queued replacement store failed/i.test(result.content?.[0]?.text || ""));
    const rejectedResults = results.filter((result) => /stale|no longer active|not found/i.test(result.content?.[0]?.text || ""));
    assert.equal(mergedResults.length, 1, "exactly one same-candidate merge may commit");
    assert.equal(failedStoreResults.length, 1, "the first queued replacement failure must stay visible");
    assert.equal(rejectedResults.length, 1, "the stale waiter must be rejected explicitly");
    assert.equal(replacementStoreAttempts, 2, "the queue must continue to a successful replacement after predecessor failure");
    assert.equal(mergeLlmCalls, 2, "the stale waiter must be rejected before a third LLM evaluation");

    const rows = await readRows();
    assert.ok(!rows.some((row) => row.id === ORIGINAL_ID));
    assert.equal(rows.filter((row) => JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)).length, 1);
    assert.equal(readDestructiveOps().filter((entry) => entry.source === "memory_store_merge").length, 1);
  });
});
