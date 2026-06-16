import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import OpenAI from "openai";

const VECTOR_DIM = 384;
const AGENT_ID = "testagent-dedup";
const ORIGINAL_ID = "22222222-2222-2222-2222-222222222222";

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
      merging: { enabled: false },
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

describe("memory store dedup safety (K1-05)", () => {
  let basePath;
  let workspaceDir;
  let openclawHome;
  let originalOpenClawHome;
  let originalEmbed;

  before(async () => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-dedup-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-dedup-ws-"));

    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_HOME = openclawHome;
    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive");
    mkdirSync(archiveDir, { recursive: true });

    const db = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await db.store({
      id: ORIGINAL_ID,
      text: "Wir nutzen Postgres.",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: AGENT_ID,
    });

    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  });

  after(() => {
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

  it("stores distinct database facts separately despite high vector similarity", async () => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      // Slightly different vector, but above duplicate threshold so it reaches the duplicate guard.
      return makeVector(0.001);
    };

    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId: AGENT_ID, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    assert.ok(storeTool);

    const result = await storeTool.execute("call-1", { text: "Wir nutzen MySQL.", category: "fact" });
    assert.ok(result);

    const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.strictEqual(rows.length, 2, "distinct database facts must be stored separately");
  });

  it("still deduplicates exact text duplicates", async () => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.001);
    };

    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId: AGENT_ID, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    assert.ok(storeTool);

    const result = await storeTool.execute("call-2", { text: "Wir nutzen Postgres.", category: "fact" });
    assert.ok(result);
    assert.match(result.content[0].text, /already exists|duplicate/i);

    const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.strictEqual(rows.length, 2, "exact duplicate must not create a third row");
  });
});
