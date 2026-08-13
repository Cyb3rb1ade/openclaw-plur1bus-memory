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
import { resolveToolMemoryRequestContext } from "../lib/memory-request-context.js";

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

  function toolContext(agentId = AGENT_ID, userId = "") {
    return {
      agentId,
      workspaceDir,
      messageChannel: "telegram",
      agentAccountId: "primary",
      requesterSenderId: userId || undefined,
    };
  }

  it("rejects a missing tool agent before exposing store or recall handlers", () => {
    const api = makeMockApi(basePath);
    plugin.register(api);
    assert.throws(() => api._toolFactory({
      workspaceDir,
      messageChannel: "telegram",
      agentAccountId: "primary",
      requesterSenderId: "owner-user",
    }), /agentId is required/);
  });

  it("rejects text over the length limit and does not store it", async () => {
    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory(toolContext());
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

  it("rejects overlong validFrom and validUntil before database or embedding work", async () => {
    const originalInit = MemoryDB.prototype.init;
    const originalPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    MemoryDB.prototype.init = async function forbiddenInit() {
      throw new Error("database touched before valid-time validation");
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function forbiddenEmbed() {
      throw new Error("embedding touched before valid-time validation");
    };
    try {
      for (const field of ["validFrom", "validUntil"]) {
        const api = makeMockApi(basePath);
        plugin.register(api);
        const storeTool = api._toolFactory(toolContext(`${AGENT_ID}-${field.toLowerCase()}`))
          .find((tool) => tool.name === "memory_store");
        const result = await storeTool.execute(`call-overlong-${field}`, {
          text: `bounded validation for ${field}`,
          category: "fact",
          [field]: "x".repeat(129),
        });
        assert.match(result.content[0].text, new RegExp(`${field} exceeds maximum length of 128`));
        assert.equal(result.details?.action, "rejected");
      }
    } finally {
      MemoryDB.prototype.init = originalInit;
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalPassage;
    }
  });

  it("rejects overlong validAt in memory_recall and memory_search before database or embedding work", async () => {
    const originalInit = MemoryDB.prototype.init;
    const originalPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    MemoryDB.prototype.init = async function forbiddenInit() {
      throw new Error("database touched before valid-time validation");
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function forbiddenEmbed() {
      throw new Error("embedding touched before valid-time validation");
    };
    try {
      const api = makeMockApi(basePath);
      plugin.register(api);
      const tools = api._toolFactory(toolContext(`${AGENT_ID}-recall-validat`));
      for (const name of ["memory_recall", "memory_search"]) {
        const result = await tools.find((tool) => tool.name === name).execute(`call-${name}-validAt`, {
          query: "bounded validAt validation",
          validAt: "x".repeat(129),
        });
        assert.match(result.content[0].text, /validAt exceeds maximum length of 128/);
      }
    } finally {
      MemoryDB.prototype.init = originalInit;
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalPassage;
    }
  });

  it('rejects scope="user" when no user identity is available', async () => {
    const api = makeMockApi(basePath);
    plugin.register(api);
    const tools = api._toolFactory(toolContext());
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-user-scope-missing-owner", {
      text: "remember this for my agents",
      category: "fact",
      scope: "user",
    });

    assert.notStrictEqual(result?.details?.action, "stored");
    assert.match(result.content[0].text, /user scope requires an authenticated user/i);
  });

  it('persists an owner binding for scope="user" when user identity is available', async () => {
    const api = makeMockApi(basePath);
    plugin.register(api);
    const ownerContext = toolContext(AGENT_ID, "owner-user");
    const tools = api._toolFactory(ownerContext);
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-user-scope-owner", {
      text: "remember this for my agents",
      category: "fact",
      scope: "user",
    });

    assert.strictEqual(result?.details?.action, "stored");

    const checkDb = new MemoryDB(join(basePath, AGENT_ID), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    const stored = rows.find((row) => row.id === result.details.id);
    assert.ok(stored, "stored user-scoped memory must exist");
    assert.strictEqual(stored.scope, "user");
    assert.strictEqual(stored.ownerUserId, resolveToolMemoryRequestContext(ownerContext).userPrincipal);
    assert.strictEqual(stored.agentId, AGENT_ID);
    assert.strictEqual(stored.storedBy, AGENT_ID);
    assert.strictEqual(stored.workspaceId, "");
  });

  it('does not dedupe user-scoped memories across different users', async () => {
    const api = makeMockApi(basePath);
    plugin.register(api);

    const ownerContext = toolContext("testagent-validation-dedupe", "owner-user");
    const ownerTools = api._toolFactory(ownerContext);
    const ownerStoreTool = ownerTools.find((t) => t.name === "memory_store");
    const ownerResult = await ownerStoreTool.execute("call-user-scope-dedupe-owner", {
      text: "same scoped text",
      category: "fact",
      scope: "user",
    });
    assert.strictEqual(ownerResult?.details?.action, "stored");

    const otherContext = toolContext("testagent-validation-dedupe", "other-user");
    const otherTools = api._toolFactory(otherContext);
    const otherStoreTool = otherTools.find((t) => t.name === "memory_store");
    const otherResult = await otherStoreTool.execute("call-user-scope-dedupe-other", {
      text: "same scoped text",
      category: "fact",
      scope: "user",
    });
    assert.strictEqual(otherResult?.details?.action, "stored");

    const checkDb = new MemoryDB(join(basePath, "testagent-validation-dedupe"), VECTOR_DIM);
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    const userScopedRows = rows.filter((row) => row.scope === "user" && row.text === "same scoped text");
    assert.strictEqual(userScopedRows.length, 2, "same user-scoped text from different users must persist twice");
    assert.deepStrictEqual(
      userScopedRows.map((row) => row.ownerUserId).sort(),
      [
        resolveToolMemoryRequestContext(otherContext).userPrincipal,
        resolveToolMemoryRequestContext(ownerContext).userPrincipal,
      ].sort(),
    );
  });

  it("does not expose a foreign user-scoped memory as a duplicate for another scope", async () => {
    const api = makeMockApi(basePath);
    plugin.register(api);

    const ownerTools = api._toolFactory(toolContext("testagent-validation-scope-boundary", "owner-user"));
    const ownerStoreTool = ownerTools.find((t) => t.name === "memory_store");
    const ownerResult = await ownerStoreTool.execute("call-scope-boundary-owner", {
      text: "cross-scope duplicate probe",
      category: "fact",
      scope: "user",
    });
    assert.strictEqual(ownerResult?.details?.action, "stored");

    const otherTools = api._toolFactory(toolContext("testagent-validation-scope-boundary", "other-user"));
    const otherStoreTool = otherTools.find((t) => t.name === "memory_store");
    const otherResult = await otherStoreTool.execute("call-scope-boundary-other", {
      text: "cross-scope duplicate probe",
      category: "fact",
      scope: "agent-private",
    });
    assert.strictEqual(otherResult?.details?.action, "stored");
    assert.doesNotMatch(otherResult.content[0].text, /Similar memory already exists/i);
  });
});
