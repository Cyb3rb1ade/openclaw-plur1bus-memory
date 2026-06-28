/**
 * tests/memory-store-input-validation.test.js
 *
 * Regression: the agent-facing memory_store tool handler embedded + stored
 * params.text with no length validation, while its twin storeMemoryFromToolParams
 * validates via validateMemoryText. Oversized text must be rejected, not stored.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

const VECTOR_DIM = 384;
const AGENT_ID = "testagent-validation";

function makeMockApi(baseDbPath) {
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
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (p) => p,
    registerCommand: noop,
    registerTool(factory) { this._toolFactory = factory; },
    on: noop,
    registerService: noop,
  };
}

describe("memory_store input validation", () => {
  let basePath, workspaceDir, openclawHome, originalHome, originalEmbed;

  before(() => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-val-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-val-ws-"));
    originalHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-val-"));
    process.env.OPENCLAW_HOME = openclawHome;
    mkdirSync(join(openclawHome, ".openclaw", "memory", "_archive"), { recursive: true });
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.1);
  });

  after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    if (originalHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalHome;
    for (const d of [basePath, workspaceDir, openclawHome]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it("rejects text over the length limit and does not store it", async () => {
    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId: AGENT_ID, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");

    const huge = "a".repeat(50_001);
    const result = await storeTool.execute("call-huge", { text: huge, category: "fact" });

    assert.notStrictEqual(
      result?.details?.action,
      "stored",
      `oversized text must not be stored; got ${JSON.stringify(result?.details)}`
    );

    const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.strictEqual(rows.filter((r) => r.id !== "__schema__").length, 0, "no oversized memory may be persisted");
  });
});
