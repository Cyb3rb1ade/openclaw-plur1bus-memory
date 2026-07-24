import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import OpenAI from "openai";

const VECTOR_DIM = 384;
const AGENT_PREFIX = "testagent-store-trace";

function makeVector(offset = 0) {
  const vec = Array(VECTOR_DIM).fill(0.1);
  vec[0] = 0.1 + offset;
  return vec;
}

function makeMockApi(baseDbPath, overrides = {}) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      duplicateThreshold: 0.9,
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      // Isolate store-decision tracing from the emotion Tier-3 feature (on by
      // default since v6.8.8), which otherwise adds a store-time LLM call that the
      // llmCalls counters in these tests would catch.
      emotion: { t3: { enabled: false } },
      recall: {
        decisionTrace: { enabled: true, includeInPrompt: true, persist: false },
      },
      ...overrides,
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

function findStoreDecision(trace, action) {
  return trace?.storeDecisions?.find((d) => d.action === action);
}

describe("memory store decision trace", () => {
  let basePath;
  let workspaceDir;
  let openclawHome;
  let originalOpenClawHome;
  let originalCreate;
  let originalEmbed;

  before(async () => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-store-trace-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-store-trace-ws-"));

    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_HOME = openclawHome;
    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive");
    mkdirSync(archiveDir, { recursive: true });

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

  it("exact duplicate produces trace storeDecision safe_duplicate", async () => {
    const agentId = `${AGENT_PREFIX}-dup`;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.001);
    };

    const originalId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: originalId,
      text: "User prefers dark mode.",
      vector: makeVector(),
      category: "preference",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-1", { text: "User prefers dark mode.", category: "preference" });
    assert.strictEqual(result.details.action, "duplicate");
    assert.ok(result.details.decisionTrace, "decisionTrace should be returned");

    const decision = findStoreDecision(result.details.decisionTrace, "safe_duplicate");
    assert.ok(decision, `expected safe_duplicate decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`);
    assert.strictEqual(decision.memoryId, originalId);
  });

  it("unsafe duplicate stores separately and traces unsafe_duplicate_rejected", async () => {
    const agentId = `${AGENT_PREFIX}-unsafe-dup`;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.001);
    };

    const originalId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: originalId,
      text: "We use Postgres.",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-2", { text: "We use MySQL.", category: "fact" });
    assert.strictEqual(result.details.action, "stored");
    assert.ok(result.details.decisionTrace, "decisionTrace should be returned");

    assert.ok(
      findStoreDecision(result.details.decisionTrace, "unsafe_duplicate_rejected"),
      `expected unsafe_duplicate_rejected decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`
    );
    assert.ok(
      findStoreDecision(result.details.decisionTrace, "stored_separately"),
      `expected stored_separately decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`
    );

    const checkDb = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.strictEqual(rows.length, 2, "distinct facts must be stored separately");
  });

  it("unsafe LLM merge blocked before LLM traces merge_aborted", async () => {
    const agentId = `${AGENT_PREFIX}-meaningful`;
    let llmCalls = 0;
    OpenAI.Chat.Completions.prototype.create = async function mockedCreate() {
      llmCalls++;
      return { choices: [{ message: { content: JSON.stringify({ merge: true, reason: "test", mergedText: "should not be used" }) } }] };
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.25);
    };

    const originalId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: originalId,
      text: "Project Alpha uses the Auth-Service.",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const api = makeMockApi(basePath, {
      merging: { enabled: true, autoApply: true, model: "mock-model", apiKey: "sk-test" },
      duplicateThreshold: 0.9999,
    });
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-3", { text: "Project Beta uses the Auth-Service.", category: "fact" });
    assert.strictEqual(result.details.action, "stored");
    assert.strictEqual(llmCalls, 0, "safety guard must skip LLM call for meaningfully different facts");
    assert.ok(result.details.decisionTrace, "decisionTrace should be returned");

    assert.ok(
      findStoreDecision(result.details.decisionTrace, "merge_candidate"),
      `expected merge_candidate decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`
    );
    const aborted = findStoreDecision(result.details.decisionTrace, "merge_aborted");
    assert.ok(aborted, `expected merge_aborted decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`);
    assert.ok(aborted.reason.includes("meaningful difference"), `expected meaningful-difference reason, got: ${aborted.reason}`);
    assert.ok(
      findStoreDecision(result.details.decisionTrace, "stored_separately"),
      `expected stored_separately decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`
    );
  });

  it("unsafe mergedText after LLM traces merge_aborted", async () => {
    const agentId = `${AGENT_PREFIX}-lossy`;
    let llmCalls = 0;
    OpenAI.Chat.Completions.prototype.create = async function mockedCreate() {
      llmCalls++;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              merge: true,
              reason: "test-lossy",
              mergedText: "Project Alpha uses the Auth-Service and other related services.",
            }),
          },
        }],
      };
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.25);
    };

    const originalId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: originalId,
      text: "Project Alpha uses the Auth-Service.",
      vector: makeVector(0.2),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const api = makeMockApi(basePath, {
      merging: { enabled: true, autoApply: true, model: "mock-model", apiKey: "sk-test" },
      duplicateThreshold: 0.9999,
    });
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-4", { text: "Project Alpha uses the Auth-Service externally.", category: "fact" });
    assert.strictEqual(result.details.action, "stored");
    assert.strictEqual(llmCalls, 1, "LLM should be consulted for same-project candidate");
    assert.ok(result.details.decisionTrace, "decisionTrace should be returned");

    const aborted = findStoreDecision(result.details.decisionTrace, "merge_aborted");
    assert.ok(aborted, `expected merge_aborted decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`);
    assert.ok(aborted.reason.includes("loses facts"), `expected fact-preservation reason, got: ${aborted.reason}`);
    assert.ok(
      findStoreDecision(result.details.decisionTrace, "stored_separately"),
      `expected stored_separately decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`
    );
  });

  it("safe merge traces merge_allowed and archive-first path remains intact", async () => {
    const agentId = `${AGENT_PREFIX}-safe-merge`;
    OpenAI.Chat.Completions.prototype.create = async function mockedCreate() {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              merge: true,
              reason: "test-safe",
              mergedText: "Original fact about cats and additional detail",
            }),
          },
        }],
      };
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector(0.25);
    };

    const originalId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: originalId,
      text: "Original fact about cats",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const archiveAgentDir = join(openclawHome, ".openclaw", "memory", "_archive", agentId);
    const archiveBefore = existsSync(archiveAgentDir) ? readdirSync(archiveAgentDir).length : 0;

    const api = makeMockApi(basePath, {
      merging: { enabled: true, autoApply: true, model: "mock-model", apiKey: "sk-test" },
      duplicateThreshold: 0.9999,
    });
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-5", { text: "Additional cat fact", category: "fact" });
    assert.strictEqual(result.details.action, "merged");
    assert.ok(result.details.decisionTrace, "decisionTrace should be returned");

    assert.ok(
      findStoreDecision(result.details.decisionTrace, "merge_allowed"),
      `expected merge_allowed decision, got: ${JSON.stringify(result.details.decisionTrace.storeDecisions)}`
    );

    const checkDb = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.ok(!rows.some((r) => r.id === originalId), "original memory should be archived after merge");
    assert.ok(rows.some((r) => r.text.includes("additional detail")), "merged memory should be stored");

    assert.ok(existsSync(archiveAgentDir), "archive directory should exist after merge");
    assert.strictEqual(readdirSync(archiveAgentDir).length, archiveBefore + 1, "exactly one archive file should be written");
  });
});
