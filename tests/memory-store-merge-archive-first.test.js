import { randomUUID } from "node:crypto";
import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { withTimeout } from "../lib/with-timeout.js";
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
      merging: { enabled: true, autoApply: true, model: "mock-model", apiKey: "sk-test" },
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
  let originalFindSimilar;
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

  async function executeStore(text = "Additional cat fact", overrides = {}) {
    return storeTool.execute(`call-${randomUUID()}`, { text, category: "fact", ...overrides });
  }

  before(async () => {
    // realpathSync: macOS tmpdir is a symlink (/var -> /private/var) and the
    // production code resolves real paths, so compare against resolved paths.
    basePath = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-merge-")));
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-merge-ws-")));

    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-test-")));
    process.env.OPENCLAW_HOME = openclawHome;
    archiveDir = join(openclawHome, ".openclaw", "memory", "_archive");

    originalCreate = OpenAI.Chat.Completions.prototype.create;
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalStore = MemoryDB.prototype.store;
    originalGetById = MemoryDB.prototype.getById;
    originalFindSimilar = MemoryDB.prototype.findSimilar;
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
    MemoryDB.prototype.findSimilar = originalFindSimilar;
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
    MemoryDB.prototype.findSimilar = originalFindSimilar;
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
    MemoryDB.prototype.findSimilar = originalFindSimilar;
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

  it("keeps a repairable fork after failed readback and reuses it on the same-input retry", async () => {
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
    assert.equal(
      replacementReadbacks,
      2,
      "the deterministic replacement key is checked before store and read back again after store",
    );

    const rows = await readRows();
    assert.ok(rows.some((row) => row.id === ORIGINAL_ID), "failed readback must leave the original active");
    const replacement = rows.find((row) => row.id !== ORIGINAL_ID);
    assert.ok(replacement, "the durably written replacement should remain as a repairable fork");
    assert.equal(replacement.text, mergedText(ORIGINAL_TEXT, incomingText));
    const archives = readArchiveEntries();
    assert.equal(archives.length, 1);
    assert.deepEqual(archives[0].card, jsonClone(authoritativeOriginal));
    assert.deepEqual(readDestructiveOps(), [], "failed readback must not emit a deletion log");

    MemoryDB.prototype.findSimilar = async function bypassRepairableForkDuplicate() {
      return [];
    };
    MemoryDB.prototype.findMergeCandidate = async function selectRepairableOriginal() {
      const entry = await originalGetById.call(this, ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    let retryReplacementWrites = 0;
    MemoryDB.prototype.store = async function trackUnexpectedRetryWrite(entry) {
      if (JSON.parse(entry?.mergedFrom || "[]").includes(ORIGINAL_ID)) {
        retryReplacementWrites += 1;
      }
      return originalStore.call(this, entry);
    };

    const retry = await executeStore(incomingText);
    assert.equal(retry.details?.action, "merged");
    assert.equal(retry.details?.id, replacement.id, "the same input should reuse its deterministic replacement");
    assert.equal(retryReplacementWrites, 0, "repair must not write a duplicate replacement");
    const repairedRows = await readRows();
    assert.equal(repairedRows.some((row) => row.id === ORIGINAL_ID), false);
    assert.equal(
      repairedRows.filter((row) => JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)).length,
      1,
    );
    assert.equal(readDestructiveOps().filter((entry) => entry.source === "memory_store_merge").length, 1);
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
    assert.deepEqual(JSON.parse(replacement.mergedFrom), [ORIGINAL_ID, "valid-time:0:0"]);

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

  it("preserves disputed epistemic state and records merge provenance on the replacement", async () => {
    const updatedAt = Date.now() - 1000;
    await seedDb.update(ORIGINAL_ID, {
      epistemicStatus: "disputed",
      previousEpistemicStatus: "observed",
      epistemicStatusActor: "human:reviewer",
      epistemicStatusReason: "conflicting evidence",
      epistemicStatusUpdatedAt: updatedAt,
    });

    const result = await executeStore();

    assert.equal(result.details?.action, "merged");
    const replacement = (await readRows()).find((row) => row.id === result.details.id);
    assert.ok(replacement);
    assert.equal(replacement.epistemicStatus, "disputed");
    assert.equal(replacement.previousEpistemicStatus, "disputed");
    assert.equal(replacement.epistemicStatusActor, "system:merge");
    assert.match(replacement.epistemicStatusReason, new RegExp(ORIGINAL_ID));
    assert.ok(Number(replacement.epistemicStatusUpdatedAt) > updatedAt);
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

  it("keeps a timed-out replacement store in the B2 queue until its late commit completes", async (t) => {
    const storeGate = deferred();
    const lateStoreStarted = deferred();
    const retrySelectedCandidate = deferred();
    let replacementStoreAttempts = 0;
    let candidateSelections = 0;
    let rawStoreActive = 0;
    let first;
    let second;

    MemoryDB.prototype.store = function timeoutFirstReplacement(entry) {
      const mergedFrom = JSON.parse(entry?.mergedFrom || "[]");
      if (!mergedFrom.includes(ORIGINAL_ID)) return originalStore.call(this, entry);
      replacementStoreAttempts += 1;
      if (replacementStoreAttempts !== 1) return originalStore.call(this, entry);
      const rawStore = (async () => {
        rawStoreActive += 1;
        lateStoreStarted.resolve();
        try {
          await storeGate.promise;
          return await originalStore.call(this, entry);
        } finally {
          rawStoreActive -= 1;
        }
      })();
      return withTimeout(rawStore, 20, "MemoryDB.store");
    };
    MemoryDB.prototype.findMergeCandidate = async function trackRetryCandidate(...args) {
      const candidate = await originalFindMergeCandidate.apply(this, args);
      if (candidate?.entry?.id === ORIGINAL_ID) {
        candidateSelections += 1;
        if (candidateSelections === 2) retrySelectedCandidate.resolve();
      }
      return candidate;
    };
    t.after(async () => {
      storeGate.resolve();
      await Promise.allSettled([first, second].filter(Boolean));
      MemoryDB.prototype.findMergeCandidate = originalFindMergeCandidate;
    });

    first = executeStore("Additional cat fact");
    await lateStoreStarted.promise;
    const firstResult = await first;
    assert.match(firstResult.content[0].text, /Memory store failed:.*timed out/i);
    assert.equal(rawStoreActive, 1, "the public timeout occurs while the raw add is still live");

    let secondSettled = false;
    second = executeStore("Additional cat fact").then((result) => {
      secondSettled = true;
      return result;
    });
    await retrySelectedCandidate.promise;
    await sleep(20);
    assert.equal(secondSettled, false, "the queued retry must not outrun the first raw store settlement");
    assert.equal(replacementStoreAttempts, 1, "the retry must not start a competing replacement write");

    storeGate.resolve();
    const secondResult = await second;
    assert.match(secondResult.content[0].text, /stale|no longer active|not found/i);

    const rows = await readRows();
    assert.equal(rows.some((row) => row.id === ORIGINAL_ID), false);
    assert.equal(
      rows.filter((row) => JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)).length,
      1,
      "late settlement plus retry must leave one idempotent replacement",
    );
    assert.equal(readDestructiveOps().filter((entry) => entry.source === "memory_store_merge").length, 1);
  });

  it("logs a timed-out delete exactly once when the underlying delete later commits", async (t) => {
    const deleteGate = deferred();
    const lateDeleteStarted = deferred();
    const retrySelectedCandidate = deferred();
    let originalDeleteAttempts = 0;
    let candidateSelections = 0;
    let rawDeleteActive = 0;
    let first;
    let second;

    MemoryDB.prototype.delete = function timeoutFirstOriginalDelete(id) {
      if (id !== ORIGINAL_ID) return originalDelete.call(this, id);
      originalDeleteAttempts += 1;
      if (originalDeleteAttempts !== 1) return originalDelete.call(this, id);
      const rawDelete = (async () => {
        rawDeleteActive += 1;
        lateDeleteStarted.resolve();
        try {
          await deleteGate.promise;
          return await originalDelete.call(this, id);
        } finally {
          rawDeleteActive -= 1;
        }
      })();
      return withTimeout(rawDelete, 20, `MemoryDB.delete:${id}`);
    };
    MemoryDB.prototype.findMergeCandidate = async function trackRetryCandidate(...args) {
      const candidate = await originalFindMergeCandidate.apply(this, args);
      if (candidate?.entry?.id === ORIGINAL_ID) {
        candidateSelections += 1;
        if (candidateSelections === 2) retrySelectedCandidate.resolve();
      }
      return candidate;
    };
    t.after(async () => {
      deleteGate.resolve();
      await Promise.allSettled([first, second].filter(Boolean));
      MemoryDB.prototype.findMergeCandidate = originalFindMergeCandidate;
    });

    first = executeStore("Additional cat fact");
    await lateDeleteStarted.promise;
    const firstResult = await first;
    assert.match(firstResult.content[0].text, /Memory store failed:.*timed out/i);
    assert.equal(rawDeleteActive, 1);
    assert.equal(readDestructiveOps().filter((entry) => entry.source === "memory_store_merge").length, 0);

    let secondSettled = false;
    second = executeStore("Additional cat fact").then((result) => {
      secondSettled = true;
      return result;
    });
    await retrySelectedCandidate.promise;
    await sleep(20);
    assert.equal(secondSettled, false, "the retry must wait for the first delete's real settlement");
    assert.equal(originalDeleteAttempts, 1, "no overlapping delete may enter the same candidate boundary");

    deleteGate.resolve();
    const secondResult = await second;
    assert.match(secondResult.content[0].text, /stale|no longer active|not found/i);

    const rows = await readRows();
    assert.equal(rows.some((row) => row.id === ORIGINAL_ID), false);
    assert.equal(
      rows.filter((row) => JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)).length,
      1,
    );
    const mergeLogs = readDestructiveOps().filter((entry) => entry.source === "memory_store_merge");
    assert.equal(mergeLogs.length, 1, "the late committed delete must retain exactly one audit record");
    assert.equal(typeof mergeLogs[0].idempotencyKey, "string");
    assert.ok(mergeLogs[0].idempotencyKey.length > 0);
  });

  it("uses provenance-changing input in the deterministic replacement identity", async () => {
    let deleteAttempts = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() {
      return [];
    };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await originalGetById.call(this, ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function failFirstOriginalDelete(id) {
      if (id === ORIGINAL_ID) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("injected first delete failure");
      }
      return originalDelete.call(this, id);
    };

    const first = await executeStore("Additional cat fact", {
      sourceUrl: "https://example.test/source-a",
      evidenceQuote: "Source A evidence",
      importance: 0.72,
      ttl: "week",
    });
    assert.match(first.content[0].text, /Memory store failed:.*delete failure/i);
    const afterFirst = await readRows();
    const firstReplacement = afterFirst.find((row) => (
      JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)
    ));
    assert.ok(firstReplacement, "the failed delete leaves the first durable replacement repairable");
    assert.equal(firstReplacement.sourceUrl, "https://example.test/source-a");

    const second = await executeStore("Additional cat fact", {
      sourceUrl: "https://example.test/source-b",
      evidenceQuote: "Source B evidence",
      importance: 0.81,
      ttl: "month",
    });
    assert.equal(second.details?.action, "merged");
    assert.notEqual(
      second.details.id,
      firstReplacement.id,
      "materially different merge input must not silently reuse the first replacement identity",
    );

    const afterSecond = await readRows();
    const acknowledged = afterSecond.find((row) => row.id === second.details.id);
    assert.equal(acknowledged?.sourceUrl, "https://example.test/source-b");
    assert.equal(acknowledged?.evidenceQuote, "Source B evidence");
    assert.equal(acknowledged?.importance, 0.81);
  });

  it("uses validity-window input in the deterministic replacement identity", async () => {
    let deleteAttempts = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() {
      return [];
    };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await originalGetById.call(this, ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function failFirstOriginalDelete(id) {
      if (id === ORIGINAL_ID) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("injected first delete failure");
      }
      return originalDelete.call(this, id);
    };

    const first = await executeStore("Additional cat fact", {
      validFrom: "2025-01-01",
      validUntil: "2025-06-01",
    });
    assert.match(first.content[0].text, /Memory store failed:.*delete failure/i);
    const firstReplacement = (await readRows()).find((row) => (
      JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)
    ));
    assert.ok(firstReplacement);

    const second = await executeStore("Additional cat fact", {
      validFrom: "2025-02-01",
      validUntil: "2025-07-01",
    });
    assert.equal(second.details?.action, "merged");
    assert.notEqual(second.details.id, firstReplacement.id);
  });

  it("rejects an existing deterministic replacement with mismatched provenance", async () => {
    let deleteAttempts = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() {
      return [];
    };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await originalGetById.call(this, ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function failFirstOriginalDelete(id) {
      if (id === ORIGINAL_ID) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("injected first delete failure");
      }
      return originalDelete.call(this, id);
    };

    const input = {
      sourceUrl: "https://example.test/expected-source",
      evidenceQuote: "Expected source evidence",
      importance: 0.78,
      scope: "agent-private",
    };
    const first = await executeStore("Additional cat fact", input);
    assert.match(first.content[0].text, /Memory store failed:.*delete failure/i);

    const afterFirst = await readRows();
    const replacement = afterFirst.find((row) => (
      JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)
    ));
    assert.ok(replacement, "the failed delete should leave the deterministic replacement available for retry");
    MemoryDB.prototype.getById = async function exposeMismatchedReplacement(id) {
      const row = await originalGetById.call(this, id);
      if (id !== replacement.id || !row) return row;
      return {
        ...row,
        storedBy: "otheragent",
        workspaceKey: "other-workspace",
        scope: "workspace",
        ownerUserId: "other-owner",
        sourceUrl: "https://example.test/tampered-source",
        evidenceQuote: "Tampered source evidence",
      };
    };

    const retry = await executeStore("Additional cat fact", input);
    assert.match(retry.content[0].text, /idempotency collision/i);
    assert.notEqual(retry.details?.action, "merged");
    assert.equal(deleteAttempts, 1, "a provenance mismatch must be rejected before deleting the original");

    const afterRetry = await readRows();
    assert.ok(afterRetry.some((row) => row.id === ORIGINAL_ID));
    assert.deepEqual(readDestructiveOps(), []);
  });

  it("rejects an existing deterministic replacement with a mismatched validity window", async () => {
    let deleteAttempts = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() { return []; };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await originalGetById.call(this, ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function failFirstOriginalDelete(id) {
      if (id === ORIGINAL_ID) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("injected first delete failure");
      }
      return originalDelete.call(this, id);
    };

    const input = { validFrom: "2025-01-01", validUntil: "2025-06-01" };
    const first = await executeStore("Additional cat fact", input);
    assert.match(first.content[0].text, /Memory store failed:.*delete failure/i);
    const replacement = (await readRows()).find((row) => (
      JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)
    ));
    assert.ok(replacement);

    MemoryDB.prototype.getById = async function exposeMismatchedWindow(id) {
      const row = await originalGetById.call(this, id);
      return id === replacement.id && row ? { ...row, validFrom: 123n } : row;
    };
    const retry = await executeStore("Additional cat fact", input);
    assert.match(retry.content[0].text, /idempotency collision/i);
    assert.equal(deleteAttempts, 1);
  });

  it("rejects a non-array mergedFrom string even when it contains both lineage markers", async () => {
    let deleteAttempts = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() { return []; };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await originalGetById.call(this, ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function failFirstOriginalDelete(id) {
      if (id === ORIGINAL_ID) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("injected first delete failure");
      }
      return originalDelete.call(this, id);
    };

    const first = await executeStore();
    assert.match(first.content[0].text, /Memory store failed:.*delete failure/i);
    const replacement = (await readRows()).find((row) => (
      JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)
    ));
    assert.ok(replacement);
    MemoryDB.prototype.getById = async function exposeStringLineage(id) {
      const row = await originalGetById.call(this, id);
      return id === replacement.id && row
        ? { ...row, mergedFrom: JSON.stringify(`${ORIGINAL_ID} valid-time:0:0`) }
        : row;
    };

    const retry = await executeStore();
    assert.match(retry.content[0].text, /idempotency collision/i);
    assert.notEqual(retry.details?.action, "merged");
    assert.equal(deleteAttempts, 1);
    assert.ok((await readRows()).some((row) => row.id === ORIGINAL_ID));
  });

  it("rejects a legacy mergedFrom array that lacks the validity fingerprint", async () => {
    let deleteAttempts = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() { return []; };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await originalGetById.call(this, ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function failFirstOriginalDelete(id) {
      if (id === ORIGINAL_ID) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("injected first delete failure");
      }
      return originalDelete.call(this, id);
    };

    const first = await executeStore();
    assert.match(first.content[0].text, /Memory store failed:.*delete failure/i);
    const replacement = (await readRows()).find((row) => (
      JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)
    ));
    assert.ok(replacement);
    MemoryDB.prototype.getById = async function exposeLegacyLineage(id) {
      const row = await originalGetById.call(this, id);
      return id === replacement.id && row
        ? { ...row, mergedFrom: JSON.stringify([ORIGINAL_ID]) }
        : row;
    };

    const retry = await executeStore();
    assert.match(retry.content[0].text, /idempotency collision/i);
    assert.notEqual(retry.details?.action, "merged");
    assert.equal(deleteAttempts, 1);
    assert.ok((await readRows()).some((row) => row.id === ORIGINAL_ID));
  });

  it("rejects a retry when candidate validity changes but the conservative union stays unchanged", async () => {
    let deleteAttempts = 0;
    let candidateWindowChanged = false;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() { return []; };
    MemoryDB.prototype.getById = async function exposeCurrentCandidateWindow(id) {
      const row = await originalGetById.call(this, id);
      if (!row || id !== ORIGINAL_ID || !candidateWindowChanged) return row;
      return {
        ...row,
        validUntil: BigInt(Date.parse("2025-03-01")),
      };
    };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await this.getById(ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function failFirstOriginalDelete(id) {
      if (id === ORIGINAL_ID) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("injected first delete failure");
      }
      return originalDelete.call(this, id);
    };
    const input = { validFrom: "2025-01-01" };
    const first = await executeStore("Additional cat fact", input);
    assert.match(first.content[0].text, /Memory store failed:.*delete failure/i);
    const firstReplacement = (await readRows()).find((row) => (
      JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)
    ));
    assert.ok(firstReplacement);
    assert.ok((await readRows()).some((row) => row.id === ORIGINAL_ID), "failed delete must keep the original");

    await seedDb.update(ORIGINAL_ID, {
      validUntil: Date.parse("2025-03-01"),
    });
    candidateWindowChanged = true;
    const mutatedOriginal = await originalGetById.call(seedDb, ORIGINAL_ID);
    assert.ok(mutatedOriginal.validFrom == 0);
    assert.ok(mutatedOriginal.validUntil == Date.parse("2025-03-01"));
    const retry = await executeStore("Additional cat fact", input);
    assert.notEqual(retry.details?.action, "merged");
    assert.match(retry.content[0].text, /stale|idempotency|collision|validity/i);

    const rows = await readRows();
    const replacements = rows.filter((row) => JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID));
    assert.deepEqual(replacements.map((row) => row.id), [firstReplacement.id]);
    assert.ok(rows.some((row) => row.id === ORIGINAL_ID), "a conflicting retry must preserve the original");
    assert.equal(deleteAttempts, 1, "the rejected retry must not delete the original");
  });

  it("revalidates candidate validity after replacement preparation before storing or deleting", async () => {
    let mutateCandidate = false;
    let embedCalls = 0;
    let replacementStoreCalls = 0;
    let originalDeleteCalls = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() { return []; };
    MemoryDB.prototype.getById = async function exposeMutationDuringPreparation(id) {
      const row = await originalGetById.call(this, id);
      if (!row || id !== ORIGINAL_ID || !mutateCandidate) return row;
      return { ...row, validFrom: BigInt(Date.parse("2025-01-01")) };
    };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await this.getById(ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mutateOnMergedEmbedding() {
      embedCalls += 1;
      if (embedCalls === 2) mutateCandidate = true;
      return makeVector(0.25);
    };
    MemoryDB.prototype.store = async function trackReplacementStore(entry) {
      if (entry.id !== ORIGINAL_ID) replacementStoreCalls += 1;
      return originalStore.call(this, entry);
    };
    MemoryDB.prototype.delete = async function trackOriginalDelete(id) {
      if (id === ORIGINAL_ID) originalDeleteCalls += 1;
      return originalDelete.call(this, id);
    };

    const result = await executeStore();

    assert.notEqual(result.details?.action, "merged");
    assert.match(result.content[0].text, /stale|revalidation|validity/i);
    assert.equal(replacementStoreCalls, 0);
    assert.equal(originalDeleteCalls, 0);
    assert.ok((await readRows()).some((row) => row.id === ORIGINAL_ID));
  });

  it("revalidates candidate epistemic metadata after replacement preparation before storing or deleting", async () => {
    let mutateCandidate = false;
    let embedCalls = 0;
    let replacementStoreCalls = 0;
    let originalDeleteCalls = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() { return []; };
    MemoryDB.prototype.getById = async function exposeTrustMutationDuringPreparation(id) {
      const row = await originalGetById.call(this, id);
      if (!row || id !== ORIGINAL_ID || !mutateCandidate) return row;
      return {
        ...row,
        epistemicStatus: "disputed",
        previousEpistemicStatus: "observed",
        epistemicStatusActor: "human:reviewer",
        epistemicStatusReason: "new conflicting evidence",
        epistemicStatusUpdatedAt: BigInt(Date.now()),
      };
    };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await this.getById(ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mutateOnMergedEmbedding() {
      embedCalls += 1;
      if (embedCalls === 2) mutateCandidate = true;
      return makeVector(0.25);
    };
    MemoryDB.prototype.store = async function trackReplacementStore(entry) {
      if (entry.id !== ORIGINAL_ID) replacementStoreCalls += 1;
      return originalStore.call(this, entry);
    };
    MemoryDB.prototype.delete = async function trackOriginalDelete(id) {
      if (id === ORIGINAL_ID) originalDeleteCalls += 1;
      return originalDelete.call(this, id);
    };

    const result = await executeStore();

    assert.notEqual(result.details?.action, "merged");
    assert.match(result.content[0].text, /stale|revalidation|epistemic/i);
    assert.equal(replacementStoreCalls, 0);
    assert.equal(originalDeleteCalls, 0);
    assert.ok((await readRows()).some((row) => row.id === ORIGINAL_ID));
  });

  it("revalidates candidate validity after replacement readback before deleting the original", async () => {
    let mutateCandidate = false;
    let originalDeleteCalls = 0;
    MemoryDB.prototype.findSimilar = async function bypassReplacementDuplicate() { return []; };
    MemoryDB.prototype.getById = async function mutateAfterReplacementReadback(id) {
      const row = await originalGetById.call(this, id);
      if (id === ORIGINAL_ID && row && mutateCandidate) {
        return { ...row, validFrom: BigInt(Date.parse("2025-01-01")) };
      }
      if (id !== ORIGINAL_ID && row && JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)) {
        mutateCandidate = true;
      }
      return row;
    };
    MemoryDB.prototype.findMergeCandidate = async function selectOriginalCandidate() {
      const entry = await this.getById(ORIGINAL_ID);
      return entry ? { entry, score: 0.95 } : null;
    };
    MemoryDB.prototype.delete = async function trackOriginalDelete(id) {
      if (id === ORIGINAL_ID) originalDeleteCalls += 1;
      return originalDelete.call(this, id);
    };

    const result = await executeStore();

    assert.notEqual(result.details?.action, "merged");
    assert.match(result.content[0].text, /stale|revalidation|validity/i);
    assert.equal(originalDeleteCalls, 0);
    const rows = await readRows();
    assert.ok(rows.some((row) => row.id === ORIGINAL_ID));
    assert.equal(
      rows.filter((row) => JSON.parse(row.mergedFrom || "[]").includes(ORIGINAL_ID)).length,
      1,
      "the verified replacement remains repairable without deleting the changed original",
    );
  });
});
