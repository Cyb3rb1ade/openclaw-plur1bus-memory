/**
 * Registered recall entry points must use the one global namespace merge.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { TimeoutError } from "../lib/with-timeout.js";

const VECTOR_DIM = 384;
const AGENT_ID = "namespace-recall-agent";

function vector() {
  return Array(VECTOR_DIM).fill(0.1);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function readRetrievalLedger(baseDbPath) {
  const path = join(baseDbPath, "_neo", "workspaces", "namespace-workspace", "retrieval-ledger.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function makeApi(baseDbPath) {
  const handlers = new Map();
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: true,
      merging: { enabled: false },
      duplicateThreshold: 0.9999,
      obsidianBridge: { enabled: false },
      neo: { enabled: false },
      gc: { enabled: false },
      continuityEngine: { enabled: false },
      conversationReactivationRecall: { enabled: false },
      replyOutcomeTracking: { enabled: false },
      temporalContext: { enabled: false },
      personaVoice: { enabled: false },
      emotion: { t3: { enabled: false } },
      runtime: { recallTimeoutMs: 5_000 },
      recall: {
        dedup: false,
        canonicalFirst: true,
        canonicalMaxItems: 1,
        maxPromptMemories: 5,
        decisionTrace: { enabled: true, includeInPrompt: true },
      },
      namespaces: {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["active"],
        legacyReadOnlyNamespaces: ["legacy"],
        crossNamespaceRecall: true,
      },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath(value) { return value; },
    registerCommand: noop,
    registerTool(factory) { this.toolFactory = factory; },
    registerService: noop,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    handlers,
  };
}

async function storeFixture(dbPath, id, text, summary) {
  const db = new MemoryDB(dbPath, VECTOR_DIM);
  await db.store({
    id,
    text,
    summary,
    vector: vector(),
    category: "fact",
    createdAt: Date.now(),
    storedBy: AGENT_ID,
    workspaceKey: "namespace-workspace",
  });
  return db;
}

describe("multi-namespace registered recall", () => {
  it("merges same-agent namespace records globally for memory_recall, memory_search, and before_prompt_build without writing legacy storage", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-namespace-runtime-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-namespace-workspace-"));
    const activePath = join(baseDbPath, "active", AGENT_ID);
    const legacyPath = join(baseDbPath, "legacy", AGENT_ID);
    const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => vector();
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => vector();
    t.after(async () => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    const active = await storeFixture(
      activePath,
      "11111111-1111-4111-8111-111111111111",
      "Active namespace remembers the release decision.",
      "active release decision",
    );
    await active.store({
      id: "22222222-2222-4222-8222-222222222222",
      text: "The user prefers a navy theme for the dashboard.",
      summary: "navy dashboard theme",
      vector: vector(),
      category: "preference",
      createdAt: Date.now(),
      storedBy: AGENT_ID,
      workspaceKey: "namespace-workspace",
    });
    const legacy = await storeFixture(
      legacyPath,
      "33333333-3333-4333-8333-333333333333",
      "Legacy namespace remembers the migration deadline.",
      "legacy migration deadline",
    );
    await legacy.store({
      id: "44444444-4444-4444-8444-444444444444",
      text: "The user prefers a navy dashboard theme.",
      summary: "navy dashboard preference",
      vector: vector(),
      category: "preference",
      createdAt: Date.now(),
      storedBy: AGENT_ID,
      workspaceKey: "namespace-workspace",
    });
    const legacyRowsBeforeStore = (await legacy.table.query().toArray()).map((row) => row.id);
    const legacySchemaBeforeStore = (await legacy.table.schema()).fields.map((field) => field.name);

    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "memory", "KNOWLEDGE.md"),
      "# Namespace knowledge\n\nThe canonical knowledge record must appear once across every namespace.\n",
    );

    const api = makeApi(baseDbPath);
    plugin.register(api);
    const context = {
      agentId: AGENT_ID,
      workspaceDir,
      workspaceKey: "namespace-workspace",
      userId: "namespace-owner",
    };
    const tools = api.toolFactory(context);
    const recall = tools.find((tool) => tool.name === "memory_recall");
    const search = tools.find((tool) => tool.name === "memory_search");
    assert.ok(recall && search, "both public aliases must be registered");

    const recallResult = await recall.execute("namespace-recall", { query: "dashboard release migration", limit: 5 });
    const recallText = recallResult.content[0].text;
    assert.match(recallText, /11111111-1111-4111-8111-111111111111/);
    assert.match(recallText, /33333333-3333-4333-8333-333333333333/);
    assert.match(recallText, /22222222-2222-4222-8222-222222222222/);
    assert.match(recallText, /44444444-4444-4444-8444-444444444444/);
    assert.equal((recallText.match(/\[canonical\|knowledge\]/g) || []).length, 1, "canonical content is global");
    assert.equal(readRetrievalLedger(baseDbPath).length, 1, "multi-namespace recall emits one final ledger entry");

    const searchResult = await search.execute("namespace-search", { query: "dashboard release migration", limit: 5 });
    const searchText = searchResult.content[0].text;
    assert.match(searchText, /11111111-1111-4111-8111-111111111111/);
    assert.match(searchText, /33333333-3333-4333-8333-333333333333/);
    assert.equal(readRetrievalLedger(baseDbPath).length, 2, "the search alias emits one additional ledger entry");
    const limitedResult = await search.execute("namespace-search-limited", { query: "dashboard release migration", limit: 2 });
    assert.equal((limitedResult.content[0].text.match(/ID: /g) || []).length, 1, "limit is applied globally after canonical slots");
    assert.equal(readRetrievalLedger(baseDbPath).length, 3, "global limiting does not duplicate ledger writes");

    const hook = api.handlers.get("before_prompt_build")?.at(-1);
    assert.equal(typeof hook, "function");
    const hookResult = await hook(
      { prompt: "dashboard release migration", messages: [{ role: "user", content: "dashboard release migration" }] },
      { ...context, sessionKey: "namespace-recall-session" },
    );
    assert.match(hookResult?.prependContext || "", /11111111-1111-4111-8111-111111111111/);
    assert.match(hookResult?.prependContext || "", /33333333-3333-4333-8333-333333333333/);
    assert.equal((hookResult?.prependContext?.match(/category="canonical"/g) || []).length, 1);
    assert.equal(readRetrievalLedger(baseDbPath).length, 4, "the hook emits one final merged ledger entry");

    const store = tools.find((tool) => tool.name === "memory_store");
    const storeResult = await store.execute("namespace-store", {
      text: "Only the active namespace receives this new record.",
      category: "fact",
    });
    assert.equal(storeResult.details?.action, "stored");
    const legacyRowsAfterStore = (await legacy.table.query().toArray()).map((row) => row.id);
    const legacySchemaAfterStore = (await legacy.table.schema()).fields.map((field) => field.name);
    assert.deepEqual(legacyRowsAfterStore, legacyRowsBeforeStore, "legacy storage remains unchanged by memory_store");
    assert.deepEqual(legacySchemaAfterStore, legacySchemaBeforeStore, "legacy storage schema remains unchanged by memory_store");

    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
  });

  it("waits for every namespace pipeline before reporting a query failure", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-namespace-settlement-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-namespace-settlement-workspace-"));
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    const originalInit = MemoryDB.prototype.init;
    const legacyStarted = deferred();
    const releaseLegacy = deferred();
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => vector();
    MemoryDB.prototype.init = async function initSettlementFixture() {
      const legacy = this.dbPath.endsWith(join("legacy", AGENT_ID));
      this.table = {
        vectorSearch() {
          return {
            limit() { return this; },
            async toArray() {
              if (!legacy) throw new Error("injected active namespace query failure");
              legacyStarted.resolve();
              await releaseLegacy.promise;
              return [];
            },
          };
        },
      };
      return true;
    };
    t.after(() => {
      releaseLegacy.resolve();
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      MemoryDB.prototype.init = originalInit;
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    const api = makeApi(baseDbPath);
    api.pluginConfig.autoRecall = false;
    plugin.register(api);
    const recall = api.toolFactory({
      agentId: AGENT_ID,
      workspaceDir,
      workspaceKey: "namespace-workspace",
      userId: "namespace-owner",
    }).find((tool) => tool.name === "memory_recall");
    let recallSettled = false;
    const resultPromise = recall.execute("namespace-query-failure", { query: "settlement" })
      .then((result) => {
        recallSettled = true;
        return result;
      });

    await legacyStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recallSettled, false, "the public call retains all namespace work until every pipeline settles");
    releaseLegacy.resolve();
    const result = await resultPromise;
    assert.match(result.content[0].text, /memory recall failed.*active namespace query failure/i);
    assert.equal(readRetrievalLedger(baseDbPath).length, 0, "a failed merged recall emits no partial ledger entry");
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
  });

  it("rejects a multi-namespace read timeout and retains leases through its raw settlement", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-namespace-timeout-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-namespace-timeout-workspace-"));
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    const originalInit = MemoryDB.prototype.init;
    const rawSettlements = [deferred(), deferred()];
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => vector();
    MemoryDB.prototype.init = async function initTimeoutFixture() {
      const legacyIndex = this.dbPath.endsWith(join("legacy-a", AGENT_ID))
        ? 0
        : (this.dbPath.endsWith(join("legacy-b", AGENT_ID)) ? 1 : -1);
      this.table = {
        vectorSearch() {
          return {
            limit() { return this; },
            async toArray() {
              if (legacyIndex === -1) {
                return [{
                  id: "55555555-5555-4555-8555-555555555555",
                  text: "Active namespace result must never escape a failed sibling.",
                  summary: "active result",
                  category: "fact",
                  storedBy: AGENT_ID,
                  workspaceKey: "namespace-workspace",
                  _distance: 0,
                }];
              }
              throw new TimeoutError(
                `legacy namespace ${legacyIndex + 1} vector read`,
                10,
                rawSettlements[legacyIndex].promise,
              );
            },
          };
        },
      };
      return true;
    };
    t.after(() => {
      for (const settlement of rawSettlements) settlement.resolve();
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      MemoryDB.prototype.init = originalInit;
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    const api = makeApi(baseDbPath);
    api.pluginConfig.autoRecall = false;
    api.pluginConfig.recall.canonicalFirst = false;
    api.pluginConfig.namespaces.legacyReadOnlyNamespaces = ["legacy-a", "legacy-b"];
    plugin.register(api);
    const recall = api.toolFactory({
      agentId: AGENT_ID,
      workspaceDir,
      workspaceKey: "namespace-workspace",
      userId: "namespace-owner",
    }).find((tool) => tool.name === "memory_recall");

    const result = await recall.execute("namespace-read-timeout", { query: "timeout isolation" });
    assert.match(result.content[0].text, /memory recall failed.*legacy namespace 1 vector read timed out/i);
    assert.doesNotMatch(result.content[0].text, /55555555-5555-4555-8555-555555555555/);
    assert.equal(readRetrievalLedger(baseDbPath).length, 0, "a timed-out sibling emits no partial ledger");

    let shutdownSettled = false;
    const shutdownPromise = Promise.all(
      (api.handlers.get("gateway_stop") || []).map((stop) => stop()),
    ).then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false, "shutdown waits for the timed-out raw namespace read");
    rawSettlements[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false, "shutdown also waits for the second timed-out namespace read");
    rawSettlements[1].resolve();
    await shutdownPromise;
  });
});
