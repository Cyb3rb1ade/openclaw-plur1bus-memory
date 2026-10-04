import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manifestConfigDefaults, validatePluginConfig } from "../lib/setup/config-contract.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { createNeoStore } from "../lib/neo-arch.js";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function privateRow(id, score = 0.1) {
  return {
    id,
    _distance: score,
    text: `memory ${id}`,
    summary: `memory ${id}`,
    category: "fact",
    status: "active",
    scope: "agent-private",
    agentId: "b12p-agent",
    storedBy: "b12p-agent",
  };
}

function tableWithObservedLimits(rows) {
  const limits = [];
  return {
    limits,
    vectorSearch() {
      return {
        limit(value) {
          limits.push(value);
          return { async toArray() { return rows; } };
        },
      };
    },
    query() {
      return { where() { return { limit() { return { async toArray() { return rows; } }; } }; } };
    },
  };
}

const embeddings = {
  async embed() { return [0.1, 0.2]; },
  async embedQuery() { return [0.1, 0.2]; },
};

const VECTOR_DIM = 384;
const AGENT_ID = "b12p-runtime-agent";
const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return value || undefined; },
  normalizeMessageChannel(value) { return value || undefined; },
});

function runtimeVector() {
  return Array(VECTOR_DIM).fill(0.1);
}

function makeRuntimeApi(baseDbPath, semanticCompression, recallOverrides = {}) {
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
        canonicalFirst: false,
        maxPromptMemories: 12,
        adaptiveBudget: { enabled: true, tokenBudgetPct: 0.3 },
        semanticCompression,
        ...recallOverrides,
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

function readRuntimeLedger(baseDbPath) {
  const path = createNeoStore(
    join(baseDbPath, "_neo"),
    "b12p-runtime-workspace",
  ).paths.retrievalLedger;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function storeRuntimeRows(baseDbPath, rows) {
  const db = new MemoryDB(join(baseDbPath, AGENT_ID), VECTOR_DIM);
  for (const row of rows) {
    await db.store({
      ...row,
      vector: runtimeVector(),
      createdAt: Date.now(),
      storedBy: AGENT_ID,
      workspaceKey: "b12p-runtime-workspace",
    });
  }
  return db;
}

describe("B12-P advertised recall runtime contract", () => {
  it("materializes and strictly validates each advertised recall switch", () => {
    const cfg = manifestConfigDefaults();
    // An seit 03.09.2026, zusammen mit continuityEngine und semanticLens: der
    // Operator-Tab beschreibt alle Features als opt-out.
    assert.equal(cfg.recall.queryRefinement.enabled, true);
    assert.equal(cfg.recall.adaptiveBudget.enabled, false);
    assert.equal(cfg.recall.adaptiveBudget.tokenBudgetPct, 0.3);
    assert.equal(cfg.recall.semanticCompression.enabled, false);
    assert.equal(cfg.continuityEngine.associativeRecall.graphIndex.enabled, true);
    assert.throws(
      () => validatePluginConfig({ recall: { candidateTopK: 101 } }),
      /at most 100/,
    );
  });

  it("uses candidateTopK for the initial ANN fetch without a reranker", async () => {
    const table = tableWithObservedLimits([privateRow("11111111-1111-4111-8111-111111111111")]);
    await runRecallPipeline({
      query: "candidate limit",
      dbTable: table,
      embeddings,
      topN: 2,
      candidateTopK: 17,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      agentId: "b12p-agent",
    });
    assert.deepEqual(table.limits, [17]);
  });

  it("applies adaptive budget and final ledger once to the default private route", async (t) => {
    const baseDbPath = makeTempDir("plur1bus-b12p-private-budget-");
    const workspaceDir = makeTempDir("plur1bus-b12p-private-workspace-");
    const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => runtimeVector();
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => runtimeVector();
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(join(workspaceDir, "memory", "KNOWLEDGE.md"), "# Canonical\n\nThis canonical knowledge item must consume a global adaptive budget slot.\n");
    await storeRuntimeRows(baseDbPath, Array.from({ length: 6 }, (_, index) => ({
      id: `40000000-0000-4000-8000-00000000000${index + 1}`,
      text: `private memory ${index + 1}`,
      summary: `private memory ${index + 1}`,
      category: "fact",
    })));
    const api = makeRuntimeApi(baseDbPath, { enabled: false, tokenBudget: 240 }, { canonicalFirst: true, canonicalMaxItems: 1 });
    plugin.register(api, { importRouting: async () => routingCapability });
    const tools = api.toolFactory({ agentId: AGENT_ID, workspaceDir, workspaceKey: "b12p-runtime-workspace", userId: "owner" });
    const recall = tools.find((tool) => tool.name === "memory_recall");
    const result = await recall.execute("b12p-private-budget", { query: "tiny" });
    const text = result.content[0].text;
    assert.ok((text.match(/^\[/gm) || []).length <= 6, "canonical and memories share the adaptive budget");
    assert.equal(readRuntimeLedger(baseDbPath).length, 1, "one final ledger entry is written");
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
  });

  it("drops every auto-injected memory when a token budget of one allocates zero slots", async (t) => {
    const baseDbPath = makeTempDir("plur1bus-b12p-compress-");
    const workspaceDir = makeTempDir("plur1bus-b12p-workspace-");
    const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => runtimeVector();
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => runtimeVector();
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });
    const rows = ["alpha", "bravo", "charlie"].map((label, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      text: `${label} first line\n${label} second line`,
      summary: `${label} first line\n${label} second line`,
      category: ["fact", "project", "decision"][index],
    }));
    await storeRuntimeRows(baseDbPath, rows);
    // 7.18.16: Spitzentreffer umgehen die Kompression mit ihrem Volltext;
    // ohne sie bleibt ein Budget von 1 Token wirkungsgleich mit "nichts".
    const api = makeRuntimeApi(baseDbPath, { enabled: true, tokenBudget: 1 }, { fullTextTopRecords: 0 });
    plugin.register(api, { importRouting: async () => routingCapability });
    const hook = api.handlers.get("before_prompt_build")?.at(-1);
    const result = await hook(
      { prompt: "tiny prompt", messages: [{ role: "user", content: "tiny prompt" }] },
      { agentId: AGENT_ID, workspaceDir, workspaceKey: "b12p-runtime-workspace", userId: "owner", sessionKey: "b12p-compress" },
    );
    const context = result?.prependContext || "";
    assert.equal((context.match(/<memory-record /g) || []).length, 0);
    for (const row of rows) assert.doesNotMatch(context, new RegExp(row.text.split(" ")[0]));
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
  });

  it("keeps multiline compressed text attached to its original metadata slot", async (t) => {
    const baseDbPath = makeTempDir("plur1bus-b12p-compress-slots-");
    const workspaceDir = makeTempDir("plur1bus-b12p-slots-workspace-");
    const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => runtimeVector();
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => runtimeVector();
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });
    const rows = [
      { id: "10000000-0000-4000-8000-000000000001", text: "alpha unique\nalpha continuation", category: "fact" },
      { id: "20000000-0000-4000-8000-000000000002", text: "bravo unique\nbravo continuation", category: "project" },
      { id: "30000000-0000-4000-8000-000000000003", text: "charlie unique\ncharlie continuation", category: "decision" },
    ].map((row) => ({ ...row, summary: row.text }));
    await storeRuntimeRows(baseDbPath, rows);
    const api = makeRuntimeApi(baseDbPath, { enabled: true, tokenBudget: 6 });
    plugin.register(api, { importRouting: async () => routingCapability });
    const hook = api.handlers.get("before_prompt_build")?.at(-1);
    const result = await hook(
      { prompt: "multiline memory", messages: [{ role: "user", content: "multiline memory" }] },
      { agentId: AGENT_ID, workspaceDir, workspaceKey: "b12p-runtime-workspace", userId: "owner", sessionKey: "b12p-slots" },
    );
    const context = result?.prependContext || "";
    for (const row of rows) {
      const record = new RegExp(`<memory-record category="${row.category}"[^>]*id="${row.id}"[^>]*><quoted-evidence>([^<]*)`, "s").exec(context);
      assert.ok(record, `missing record metadata for ${row.id}`);
      assert.match(record[1], new RegExp(row.text.split(" ")[0]));
      for (const other of rows.filter((candidate) => candidate.id !== row.id)) {
        assert.doesNotMatch(record[1], new RegExp(other.text.split(" ")[0]));
      }
    }
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
  });
});

// 7.18.16: Ein gespeichertes Rezept kam als Bruchstueck an ("Mehl, 7 g
// Hirschhornsalz, ... auskuehlen lassen"): Recall zeigte je Erinnerung nur die
// Zusammenfassung, verdichtet auf ~16 Woerter und hoechstens 400 Zeichen.
describe("recall injects the stored text of its top records", () => {
  const recipe = [
    "Ammonplaetzchen DDR 1959.",
    "Teig: 250 g Mehl, 125 g weiche Butter, 125 g Zucker, 2 Eier, 1 Prise Salz.",
    "Triebmittel: 7 g Hirschhornsalz in 2 EL kaltem Wasser.",
    ...Array.from({ length: 12 }, (_, i) => `Schritt ${i + 1}: Teig ruhig weiterverarbeiten und auf das gefettete Blech setzen, Abstand lassen.`),
    "Zum Schluss auskuehlen lassen und die Unterseite glasieren.",
  ].join("\n");

  async function promptFor(t, rows, recallOverrides = {}) {
    const baseDbPath = makeTempDir("plur1bus-fulltext-");
    const workspaceDir = makeTempDir("plur1bus-fulltext-ws-");
    const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => runtimeVector();
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => runtimeVector();
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });
    await storeRuntimeRows(baseDbPath, rows);
    const api = makeRuntimeApi(baseDbPath, { enabled: true, tokenBudget: 1 }, recallOverrides);
    plugin.register(api, { importRouting: async () => routingCapability });
    const hook = api.handlers.get("before_prompt_build")?.at(-1);
    const result = await hook(
      { prompt: "Gib mir das alte Rezept", messages: [{ role: "user", content: "Gib mir das alte Rezept" }] },
      { agentId: AGENT_ID, workspaceDir, workspaceKey: "b12p-runtime-workspace", userId: "owner", sessionKey: "fulltext" },
    );
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
    return result?.prependContext || "";
  }

  it("shows a long record in full despite a tight compression budget", async (t) => {
    assert.ok(recipe.length > 1200 && recipe.length < 2000);
    const context = await promptFor(t, [{
      id: "00000000-0000-4000-8000-000000000101",
      text: recipe,
      summary: "Ammonplaetzchen DDR 1959",
      category: "decision",
    }]);
    assert.match(context, /Schritt 7: Teig ruhig weiterverarbeiten/);
    assert.match(context, /Zum Schluss auskuehlen lassen und die Unterseite glasieren\./);
    assert.doesNotMatch(context, /truncated="true"/);
  });

  it("marks a record cut at fullTextMaxChars and tells the model how to get the rest", async (t) => {
    const context = await promptFor(t, [{
      id: "00000000-0000-4000-8000-000000000102",
      text: recipe,
      summary: "Ammonplaetzchen DDR 1959",
      category: "decision",
    }], { fullTextMaxChars: 400 });
    assert.match(context, /truncated="true"/);
    assert.match(context, /TRUNCATED RECALL: .*memory_recall with full_text: true/);
    assert.doesNotMatch(context, /Zum Schluss auskuehlen/);
  });
});
