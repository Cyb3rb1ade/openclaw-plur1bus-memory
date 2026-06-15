import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import OpenAI from "openai";

const VECTOR_DIM = 384;
const AGENT_ID = "testagent";
const ORIGINAL_ID = "11111111-1111-1111-1111-111111111111";

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

describe("memory_store merge archive-first (DATA-003)", () => {
  let basePath;
  let workspaceDir;
  let archiveDir;
  let openclawHome;
  let originalOpenClawHome;
  let db;
  let originalCreate;
  let originalEmbed;
  let archiveFilesBefore;

  before(async () => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-merge-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-merge-ws-"));

    // Isolate the test from the real OpenClaw home directory.
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_HOME = openclawHome;
    archiveDir = join(openclawHome, ".openclaw", "memory", "_archive");
    mkdirSync(archiveDir, { recursive: true });

    db = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await db.store({
      id: ORIGINAL_ID,
      text: "Original fact about cats",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: AGENT_ID,
    });

    originalCreate = OpenAI.Chat.Completions.prototype.create;
    OpenAI.Chat.Completions.prototype.create = async function mockedCreate(body) {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              merge: true,
              reason: "test",
              mergedText: "Original fact about cats and additional detail",
            }),
          },
        }],
      };
    };

    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;

    const archiveAgentDir = join(archiveDir, AGENT_ID);
    archiveFilesBefore = existsSync(archiveAgentDir) ? readdirSync(archiveAgentDir).length : 0;
  });

  after(() => {
    OpenAI.Chat.Completions.prototype.create = originalCreate;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;

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
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed(text) {
      embedCallCount++;
      if (embedCallCount === 2) {
        throw new Error("embedding failed for merged text");
      }
      // First call embeds the incoming memory text; use a vector that is
      // similar enough to merge but not so similar that it is treated as a duplicate.
      return makeVector(0.25);
    };

    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId: AGENT_ID, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    assert.ok(storeTool, "memory_store tool should be registered");

    const result = await storeTool.execute("call-1", { text: "Additional cat fact", category: "fact" });
    assert.ok(result, "tool should return a result");
    assert.strictEqual(embedCallCount, 2, "merge path should attempt to embed the merged text");

    // Query a fresh DB instance so we see the committed state, not a stale
    // in-memory snapshot of the seed DB.
    const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    const original = rows.find((r) => r.id === ORIGINAL_ID);
    assert.ok(
      original,
      `original memory should be preserved; got ${rows.length} rows: ${JSON.stringify(rows.map((r) => r.id))}`,
    );
  });

  it("archives the original memory when merged store fails", async () => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed(text) {
      return makeVector(0.25);
    };

    const originalStore = MemoryDB.prototype.store;
    let storeCallCount = 0;
    MemoryDB.prototype.store = async function mockedStore(entry) {
      storeCallCount++;
      if (storeCallCount === 1) {
        throw new Error("store failed for merged entry");
      }
      return originalStore.call(this, entry);
    };

    try {
      const api = makeMockApi(basePath);
      plugin.register(api);
      const tools = api._toolFactory({ agentId: AGENT_ID, workspaceDir });
      const storeTool = tools.find((t) => t.name === "memory_store");
      assert.ok(storeTool, "memory_store tool should be registered");

      const result = await storeTool.execute("call-2", { text: "Another cat fact", category: "fact" });
      assert.ok(result, "tool should return a result");
      assert.strictEqual(storeCallCount, 1, "merge path should attempt to store the merged entry");

      const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
      await checkDb.init();
      const rows = await checkDb.table.query().toArray();
      assert.ok(
        !rows.some((r) => r.id === ORIGINAL_ID),
        "original memory should be deleted once merged entry is prepared",
      );

      const archiveAgentDir = join(archiveDir, AGENT_ID);
      assert.ok(existsSync(archiveAgentDir), "archive directory should exist after archive-first merge");
      assert.strictEqual(
        readdirSync(archiveAgentDir).length,
        archiveFilesBefore + 1,
        "exactly one archive file should be written for the original memory",
      );
    } finally {
      MemoryDB.prototype.store = originalStore;
    }
  });
});
