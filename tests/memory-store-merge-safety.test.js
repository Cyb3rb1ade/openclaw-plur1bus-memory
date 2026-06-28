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
const AGENT_ID = "testagent-merge";
const ORIGINAL_ID = "33333333-3333-3333-3333-333333333333";

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
      // Isolate merge-safety behavior from the emotion Tier-3 feature, which is
      // on by default since v6.8.8 (full-experience policy) and otherwise adds an
      // extra store-time LLM call that this test's global llmCalls counter would catch.
      emotion: { t3: { enabled: false } },
      duplicateThreshold: 0.9999,
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

describe("memory store merge safety (K1-04)", () => {
  let basePath;
  let workspaceDir;
  let openclawHome;
  let originalOpenClawHome;
  let originalCreate;
  let originalEmbed;

  before(async () => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-merge-safety-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-merge-safety-ws-"));

    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_HOME = openclawHome;
    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive");
    mkdirSync(archiveDir, { recursive: true });

    const db = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await db.store({
      id: ORIGINAL_ID,
      text: "Projekt Alpha nutzt den Auth-Service.",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: AGENT_ID,
    });

    originalCreate = OpenAI.Chat.Completions.prototype.create;
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
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

  it("does not merge different project names even if LLM says merge", async () => {
    let llmCalls = 0;
    OpenAI.Chat.Completions.prototype.create = async function mockedCreate() {
      llmCalls++;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              merge: true,
              reason: "test-llm-wrong",
              mergedText: "Projekt Alpha und Beta nutzen den Auth-Service.",
            }),
          },
        }],
      };
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.25);
    };

    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId: AGENT_ID, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    assert.ok(storeTool);

    const result = await storeTool.execute("call-1", { text: "Projekt Beta nutzt den Auth-Service.", category: "fact" });
    assert.ok(result);
    assert.strictEqual(llmCalls, 0, "safety guard must skip LLM call for meaningfully different facts");

    const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.strictEqual(rows.length, 2, "different project facts must be stored separately");
    assert.ok(rows.some((r) => r.text.includes("Alpha")), "original Alpha memory must remain");
    assert.ok(rows.some((r) => r.text.includes("Beta")), "new Beta memory must be stored");
  });

  it("aborts merge when LLM mergedText loses facts", async () => {
    let llmCalls = 0;
    OpenAI.Chat.Completions.prototype.create = async function mockedCreate() {
      llmCalls++;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              merge: true,
              reason: "test-llm-lossy",
              mergedText: "Projekt Alpha nutzt etwas.",
            }),
          },
        }],
      };
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.25);
    };

    // Seed a memory that is semantically close enough to merge but describes the same project.
    const localDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await localDb.init();
    const sameProjectId = "44444444-4444-4444-4444-444444444444";
    await localDb.store({
      id: sameProjectId,
      text: "Projekt Alpha nutzt den Auth-Service intern.",
      vector: makeVector(0.2),
      category: "fact",
      createdAt: Date.now(),
      storedBy: AGENT_ID,
    });

    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId: AGENT_ID, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    assert.ok(storeTool);

    const result = await storeTool.execute("call-2", { text: "Projekt Alpha nutzt den Auth-Service extern.", category: "fact" });
    assert.ok(result);
    assert.strictEqual(llmCalls, 1, "LLM should be consulted for same-project candidate");

    const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.ok(rows.some((r) => r.id === sameProjectId), "original memory must be preserved when mergedText loses facts");
    assert.ok(rows.some((r) => r.text.includes("extern")), "new memory must be stored separately");
  });
});
