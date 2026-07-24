/**
 * tests/recall-golden-set-pipeline.test.js
 *
 * Behavioral regression golden-set for runRecallPipeline.
 * All fixtures are deterministic and DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecallPipeline as runRecallPipelineRaw, dedupResults } from "../lib/recall-pipeline.js";
import { distanceToScore } from "../lib/score.js";
import { resolveMemoryRequestContext } from "../lib/memory-request-context.js";
import {
  makeEmbeddings,
  makeRow as makeHarnessRow,
  mockTable,
  expectOrderedIds,
  expectTraceSummary,
  expectScore,
  makeKnowledgeDirSync,
  cleanupDir,
} from "./helpers/golden-recall-harness.js";

function silence() {
  return { warn() {}, info() {} };
}

function makeRow(options) {
  const row = makeHarnessRow(options);
  const ownerAgentId = row.agentId || "agent-a";
  return {
    ...row,
    agentId: ownerAgentId,
    storedBy: options.storedBy ?? ownerAgentId,
  };
}

function runRecallPipeline(options) {
  return runRecallPipelineRaw({ agentId: "agent-a", ...options });
}

describe("Golden-Set: runRecallPipeline ranking", () => {
  it("returns results ordered by descending vector score", async () => {
    const rows = [
      makeRow({ id: "mid", text: "mid relevance", distance: 0.5 }),
      makeRow({ id: "high", text: "high relevance", distance: 0.1 }),
      makeRow({ id: "low", text: "low relevance", distance: 0.9 }),
    ];
    const result = await runRecallPipeline({
      query: "relevance",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["high", "mid", "low"]);
    expectScore(result.memories[0].score, distanceToScore(0.1));
    expectScore(result.memories[1].score, distanceToScore(0.5));
    expectScore(result.memories[2].score, distanceToScore(0.9));
  });

  it("rejects results below recallMinScore", async () => {
    // threshold distance for score=0.15 is d = 1/0.15 - 1 ≈ 5.6667
    const rows = [
      makeRow({ id: "above", text: "above threshold", distance: 5.666 }), // score > 0.15
      makeRow({ id: "below", text: "below threshold", distance: 5.667 }), // score < 0.15
    ];
    const result = await runRecallPipeline({
      query: "threshold",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.15,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["above"]);
  });

  it("importance boost keeps ranking stable when relevance gap is large", async () => {
    const rows = [
      makeRow({ id: "relevant", text: "very relevant", distance: 0.1, importance: 0.5 }),
      makeRow({ id: "important", text: "less relevant but important", distance: 1.5, importance: 1.0 }),
    ];
    const result = await runRecallPipeline({
      query: "ranking",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0.3,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["relevant", "important"]);
    const relevant = result.memories.find(r => r.entry.id === "relevant");
    const important = result.memories.find(r => r.entry.id === "important");
    expectScore(relevant.score, distanceToScore(0.1));
    expectScore(important.score, distanceToScore(1.5) + 0.5 * 0.3);
  });

  it("emotional boost is clamped to +/-10%", async () => {
    const rows = [
      makeRow({ id: "base", text: "base memory", distance: 0.2, importance: 0.5 }),
    ];
    const emotionalState = {
      computeRecallBoost() { return 1.5; }, // would be +50% if unclamped
    };
    const result = await runRecallPipeline({
      query: "emotion",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      emotionalState,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["base"]);
    expectScore(result.memories[0].score, distanceToScore(0.2) * 1.1);
  });
});

describe("Golden-Set: dedupResults boundary", () => {
  it("keeps distinct project memories at default 0.78 threshold", () => {
    const m1 = { entry: { id: "a", text: "Project Alpha: implement auth service for internal tools" } };
    const m2 = { entry: { id: "b", text: "Project Alpha: implement login service for internal tools" } };
    const out = dedupResults([m1, m2], 10, 0.78);
    assert.strictEqual(out.length, 2);
  });

  it("collapses near-duplicates above threshold", () => {
    const m1 = { entry: { id: "a", text: "Project Alpha uses OAuth2" } };
    const m2 = { entry: { id: "b", text: "Project Alpha uses OAuth2" } };
    const out = dedupResults([m1, m2], 10, 0.78);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].entry.id, "a");
  });

  it("preserves first occurrence on reorder", () => {
    const m1 = { entry: { id: "a", text: "OAuth2 for Project Alpha" } };
    const m2 = { entry: { id: "b", text: "OAuth2 for Project Alpha" } };
    const out = dedupResults([m2, m1], 10, 0.78);
    assert.strictEqual(out[0].entry.id, "b");
  });
});

describe("Golden-Set: runRecallPipeline budget / tiers", () => {
  it("defers only the final display cap while retaining the physical candidate hard bound", async () => {
    const rows = [
      makeRow({ id: "deferred-a", text: "candidate a", distance: 0.1 }),
      makeRow({ id: "deferred-b", text: "candidate b", distance: 0.2 }),
      makeRow({ id: "deferred-c", text: "candidate c", distance: 0.3 }),
    ];
    const result = await runRecallPipeline({
      query: "candidates",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 1,
      budget: 1,
      deferFinalCap: true,
      candidateHardLimit: 2,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: true,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["deferred-a", "deferred-b"]);
  });

  it("enforces tier priority core > project > episodic in vector results", async () => {
    const rows = [
      makeRow({ id: "episodic", text: "episodic memory", category: "fact", distance: 0.1 }),
      makeRow({ id: "core", text: "core memory", category: "person", coreMemoryScore: 0.8, distance: 0.3 }),
      makeRow({ id: "project", text: "project memory", category: "project", distance: 0.2 }),
    ];
    const result = await runRecallPipeline({
      query: "memory",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 4,
      budget: 4,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["core", "project", "episodic"]);
  });

  it("caps associative at 30% of budget", async () => {
    const rows = [
      makeRow({ id: "e1", text: "episodic one", category: "fact", distance: 0.1 }),
      makeRow({ id: "e2", text: "episodic two", category: "fact", distance: 0.2 }),
      makeRow({ id: "e3", text: "episodic three", category: "fact", distance: 0.3 }),
      makeRow({ id: "e4", text: "episodic four", category: "fact", distance: 0.4 }),
      makeRow({ id: "e5", text: "episodic five", category: "fact", distance: 0.5 }),
      makeRow({ id: "e6", text: "episodic six", category: "fact", distance: 0.6 }),
      makeRow({ id: "e7", text: "episodic seven", category: "fact", distance: 0.7 }),
      makeRow({ id: "a1", text: "associative one", category: "fact", distance: 0.01, source: "graph" }),
      makeRow({ id: "a2", text: "associative two", category: "fact", distance: 0.02, source: "graph" }),
      makeRow({ id: "a3", text: "associative three", category: "fact", distance: 0.03, source: "graph" }),
      makeRow({ id: "a4", text: "associative four", category: "fact", distance: 0.04, source: "graph" }),
    ];
    // Mark graph rows so applyRecallBudget classifies them as associative.
    rows.forEach(r => {
      if (r.id.startsWith("a")) {
        r.source = "graph";
      }
    });
    const result = await runRecallPipeline({
      query: "memory",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 10,
      budget: 10,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false, // disable graph spread; we directly mark source=graph
      logger: silence(),
    });
    const associativeCount = result.memories.filter(r => r.source === "graph").length;
    assert.ok(associativeCount <= 3, `expected at most 3 associative results, got ${associativeCount}`);
  });

  it("reserves canonical slots and caps vector results accordingly", async () => {
    let workspaceDir;
    try {
      workspaceDir = makeKnowledgeDirSync([
        { heading: "K1", text: "First canonical chunk with enough text to pass the 30 char filter." },
        { heading: "K2", text: "Second canonical chunk with enough text to pass the 30 char filter." },
        { heading: "K3", text: "Third canonical chunk with enough text to pass the 30 char filter." },
      ]);
      const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
      const rows = Array.from({ length: 12 }, (_, i) =>
        makeRow({ id: `v${i}`, text: `memory about ${words[i]}`, distance: i * 0.05 }),
      );
      const result = await runRecallPipeline({
        query: "canonical",
        dbTable: mockTable(rows),
        embeddings: makeEmbeddings(),
        workspaceDir,
        topN: 8,
        recallMinScore: 0.1,
        importanceBoost: 0,
        canonicalEnabled: true,
        canonicalMinScore: 0.01,
        canonicalMaxItems: 3,
        associativeEnabled: false,
        logger: silence(),
      });
      assert.strictEqual(result.canonical.length, 3, "expected 3 canonical results");
      // vector results are capped to topN minus canonical slots
      assert.strictEqual(result.memories.length, 5, "expected 5 vector results");
      assert.strictEqual(result.memories.every(r => r.source !== "canonical"), true, "memories should not contain canonical items");
    } finally {
      cleanupDir(workspaceDir);
    }
  });

  it("passes the initial frozen agent context by identity to canonical cache-miss embeddings", async () => {
    let workspaceDir;
    try {
      workspaceDir = makeKnowledgeDirSync([{
        heading: "Canonical context",
        text: "Canonical cache miss content long enough to become an embedded knowledge section.",
      }]);
      class ContextRecordingEmbeddings {
        constructor() {
          this.calls = [];
        }

        async embedQuery(text, context) {
          this.calls.push(["query", text, context]);
          return [1, 0, 0, 0];
        }

        async embed(text, context) {
          this.calls.push(["canonical", text, context]);
          return [1, 0, 0, 0];
        }
      }
      const embeddings = new ContextRecordingEmbeddings();

      const result = await runRecallPipeline({
        query: "canonical context",
        dbTable: mockTable([]),
        embeddings,
        workspaceDir,
        canonicalEnabled: true,
        canonicalMinScore: -1,
        canonicalMaxItems: 1,
        associativeEnabled: false,
        logger: silence(),
      });

      assert.equal(result.canonical.length, 1);
      assert.deepEqual(embeddings.calls.map(([kind]) => kind), ["query", "canonical"]);
      const queryContext = embeddings.calls[0][2];
      const canonicalContext = embeddings.calls[1][2];
      assert.equal(canonicalContext, queryContext, "canonical embedding must reuse the exact request context object");
      assert.deepEqual(canonicalContext, { agentId: "agent-a" });
      assert.ok(Object.isFrozen(canonicalContext));
    } finally {
      cleanupDir(workspaceDir);
    }
  });
});

describe("Golden-Set: runRecallPipeline reranker", () => {
  it("uses mock reranker to reorder results", async () => {
    const rows = [
      makeRow({ id: "first", text: "first by score", distance: 0.1 }),
      makeRow({ id: "second", text: "second by score", distance: 0.2 }),
    ];
    const reranker = {
      async rerank(query, docs, topN) {
        return docs.map((_, i) => ({ index: docs.length - 1 - i }));
      },
    };
    const result = await runRecallPipeline({
      query: "rerank",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 2,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      reranker,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["second", "first"]);
  });

  it("falls back to unreranked order on reranker timeout", async () => {
    const rows = [
      makeRow({ id: "first", text: "first by score", distance: 0.1 }),
      makeRow({ id: "second", text: "second by score", distance: 0.2 }),
    ];
    const reranker = {
      async rerank() {
        await new Promise(r => setTimeout(r, 50));
        return [{ index: 1 }, { index: 0 }];
      },
    };
    const result = await runRecallPipeline({
      query: "timeout",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 2,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      reranker,
      rerankerTimeoutMs: 10,
      decisionTrace: true,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["first", "second"]);
    const guard = result.trace.guards.find(g => g.name === "rerank");
    assert.ok(guard, "expected rerank guard");
    assert.strictEqual(guard.passed, false);
  });
});

describe("Golden-Set: runRecallPipeline ACL", () => {
  it("denies agent-private memories from another agent", async () => {
    const rows = [
      makeRow({ id: "own", text: "own memory", distance: 0.1, agent_id: "agent-a", scope: "agent-private" }),
      makeRow({ id: "foreign", text: "foreign memory", distance: 0.1, agent_id: "agent-b", scope: "agent-private" }),
    ];
    const result = await runRecallPipeline({
      query: "acl",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      agentId: "agent-a",
      decisionTrace: true,
      logger: silence(),
    });
    expectOrderedIds(result.memories, ["own"]);
    const foreignDecision = result.trace.decisions.find(d => d.memoryId === "foreign" && d.stage === "initial-acl");
    assert.ok(foreignDecision, "expected ACL rejection decision");
  });

  it("never sends a foreign workspace candidate to the reranker and preserves ownership aliases", async () => {
    const workspaceIdentity = "workspace:v1:ws-a";
    const ownerCtx = resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: workspaceIdentity,
      channel: "telegram",
      accountId: "default",
      userId: "owner",
    });
    const ownershipAliases = {
      sourceMemoryId: "source-own",
      sourceAgentId: "source-agent",
      shareIdempotencyKey: "share-own",
      shareProvenance: JSON.stringify({ source: "fixture" }),
    };
    const rows = [
      {
        ...makeRow({ id: "own", text: "allowed workspace", distance: 0.1 }),
        scope: "workspace",
        workspaceId: workspaceIdentity,
        workspaceKey: workspaceIdentity,
        ...ownershipAliases,
      },
      {
        ...makeRow({ id: "user-own", text: "allowed user", distance: 0.2 }),
        scope: "user",
        ownerUserId: ownerCtx.userPrincipal,
      },
      {
        ...makeRow({ id: "foreign", text: "secret-b", distance: 0.05 }),
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      },
    ];
    const seenDocs = [];
    const result = await runRecallPipeline({
      query: "acl",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      reranker: {
        async rerank(_query, docs) {
          seenDocs.push(...docs);
          return docs.map((_, index) => ({ index }));
        },
      },
      agentId: "agent-a",
      workspaceId: workspaceIdentity,
      userPrincipal: ownerCtx.userPrincipal,
      topN: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      logger: silence(),
    });

    assert.deepEqual(seenDocs, ["allowed workspace", "allowed user"]);
    assert.deepEqual(result.memories.map((item) => item.entry.id), ["own", "user-own"]);
    assert.deepEqual(
      Object.fromEntries(Object.keys(ownershipAliases).map((key) => [key, result.memories[0].entry[key]])),
      ownershipAliases,
    );
  });

  it("authorizes refined rows before merge and preserves request-bound embedding context", async () => {
    const workspaceIdentity = "workspace:v1:ws-a";
    const ownerCtx = resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: workspaceIdentity,
      channel: "telegram",
      accountId: "default",
      userId: "owner",
    });
    const ownershipAliases = {
      sourceMemoryId: "source-refined",
      sourceAgentId: "source-agent",
      shareIdempotencyKey: "share-refined",
      shareProvenance: JSON.stringify({ source: "refined-fixture" }),
    };
    const refinedRows = [
      {
        ...makeRow({ id: "refined-own", text: "allowed refined", distance: 0.1 }),
        scope: "workspace",
        workspaceId: workspaceIdentity,
        workspaceKey: workspaceIdentity,
        ...ownershipAliases,
      },
      {
        ...makeRow({ id: "refined-user", text: "allowed refined user", distance: 0.2 }),
        scope: "user",
        ownerUserId: ownerCtx.userPrincipal,
      },
      {
        ...makeRow({ id: "refined-foreign", text: "refined secret-b", distance: 0.05 }),
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      },
    ];
    const embeddingCalls = [];
    const embeddings = {
      dim: 2,
      async embedQuery(text, context) {
        embeddingCalls.push([text, context]);
        return embeddingCalls.length === 1 ? [1, 0] : [0, 1];
      },
    };
    const table = {
      vectorSearch(vector) {
        const rows = vector[0] === 1 ? [] : refinedRows;
        return { limit() { return { async toArray() { return rows; } }; } };
      },
      query() {
        return { where() { return this; }, limit() { return this; }, async toArray() { return refinedRows; } };
      },
    };
    const seenDocs = [];
    const result = await runRecallPipeline({
      query: "acl",
      dbTable: table,
      embeddings,
      reranker: {
        async rerank(_query, docs) {
          seenDocs.push(...docs);
          return docs.map((_, index) => ({ index }));
        },
      },
      agentId: "agent-a",
      workspaceId: workspaceIdentity,
      userPrincipal: ownerCtx.userPrincipal,
      memoryCtx: ownerCtx,
      queryRefinerEnabled: true,
      topN: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      decisionTrace: true,
      logger: silence(),
    });

    assert.deepEqual(seenDocs, ["allowed refined", "allowed refined user"]);
    assert.deepEqual(result.memories.map((item) => item.entry.id), ["refined-own", "refined-user"]);
    assert.deepEqual(embeddingCalls, [
      ["acl", { agentId: "agent-a" }],
      ["acl", { agentId: "agent-a" }],
    ]);
    assert.ok(Object.isFrozen(embeddingCalls[0][1]), "embedding context must be immutable");
    assert.deepEqual(
      Object.fromEntries(Object.keys(ownershipAliases).map((key) => [key, result.memories[0].entry[key]])),
      ownershipAliases,
    );
    assert.ok(
      result.trace.decisions.some((entry) => entry.memoryId === "refined-foreign" && entry.stage === "refined-acl"),
      "foreign refined rows must be traced before merge/provider construction",
    );
  });

  it("fails closed before initial reranking when canonical request context is absent", async () => {
    const rows = [
      {
        ...makeRow({ id: "foreign-a", text: "workspace-b secret one", distance: 0.1 }),
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      },
      {
        ...makeRow({ id: "foreign-b", text: "workspace-b secret two", distance: 0.2 }),
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      },
    ];
    const seenDocs = [];

    const result = await runRecallPipelineRaw({
      query: "acl",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      reranker: {
        async rerank(_query, docs) {
          seenDocs.push(...docs);
          return docs.map((_, index) => ({ index }));
        },
      },
      topN: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      decisionTrace: true,
      logger: silence(),
    });

    assert.deepEqual(seenDocs, []);
    assert.deepEqual(result.memories, []);
    assert.ok(result.trace.decisions.some((entry) => (
      entry.memoryId === "foreign-a"
      && entry.stage === "initial-acl"
      && entry.reason === "acl.request.missing_agent"
    )));
  });

  it("fails closed before refined merge and reranking when canonical request context is absent", async () => {
    const refinedRows = [
      {
        ...makeRow({ id: "refined-foreign-a", text: "refined workspace-b secret one", distance: 0.1 }),
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      },
      {
        ...makeRow({ id: "refined-foreign-b", text: "refined workspace-b secret two", distance: 0.2 }),
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      },
    ];
    let searchCount = 0;
    const table = {
      vectorSearch() {
        const rows = searchCount++ === 0 ? [] : refinedRows;
        return { limit() { return { async toArray() { return rows; } }; } };
      },
      query() {
        return { where() { return this; }, limit() { return this; }, async toArray() { return refinedRows; } };
      },
    };
    const seenDocs = [];

    const result = await runRecallPipelineRaw({
      query: "acl",
      dbTable: table,
      embeddings: makeEmbeddings(),
      reranker: {
        async rerank(_query, docs) {
          seenDocs.push(...docs);
          return docs.map((_, index) => ({ index }));
        },
      },
      queryRefinerEnabled: true,
      topN: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      decisionTrace: true,
      logger: silence(),
    });

    assert.deepEqual(seenDocs, []);
    assert.deepEqual(result.memories, []);
    assert.ok(result.trace.decisions.some((entry) => (
      entry.memoryId === "refined-foreign-a"
      && entry.stage === "refined-acl"
      && entry.reason === "acl.request.missing_agent"
    )));
  });
});

describe("Golden-Set: runRecallPipeline temporal embedding context", () => {
  it("passes the same frozen agent context to initial and temporal-anchor embeddings", async () => {
    const createdAt = 1_750_000_000_000;
    const rows = [makeRow({ id: "anchor", text: "docker setup", distance: 0.1, createdAt })];
    const embeddingCalls = [];
    const embeddings = {
      async embedQuery(text, context) {
        embeddingCalls.push(["query", text, context]);
        return [1, 0];
      },
      async embed(text, context) {
        embeddingCalls.push(["anchor", text, context]);
        return [1, 0];
      },
    };

    await runRecallPipeline({
      query: "what happened after the docker setup",
      dbTable: mockTable(rows),
      embeddings,
      topN: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: silence(),
    });

    assert.deepEqual(embeddingCalls, [
      ["query", "what happened after the docker setup", { agentId: "agent-a" }],
      ["anchor", "docker setup", { agentId: "agent-a" }],
    ]);
    assert.equal(embeddingCalls[0][2], embeddingCalls[1][2]);
    assert.ok(Object.isFrozen(embeddingCalls[1][2]));
  });
});

describe("Golden-Set: runRecallPipeline decision trace", () => {
  it("records trace summary for a known fixture", async () => {
    const rows = [
      makeRow({ id: "kept", text: "kept memory", distance: 0.1 }),
      makeRow({ id: "dropped", text: "dropped memory", distance: 10 }), // below default recallMinScore
    ];
    const result = await runRecallPipeline({
      query: "trace fixture",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.15,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      decisionTrace: true,
      logger: silence(),
    });
    assert.ok(result.trace, "trace should exist");
    assert.strictEqual(result.trace.candidates.some(c => c.id === "kept"), true);
    // Rows below recallMinScore are filtered before becoming candidates.
    assert.strictEqual(result.trace.candidates.some(c => c.id === "dropped"), false);
    assert.strictEqual(result.trace.query.text, "trace fixture");
    assert.ok(result.trace.traceId.startsWith("rdt-"));
  });
});

describe("Golden-Set: runRecallPipeline graph/associative scoring", () => {
  it("H1-01 caps graph-only scores below best vector score", async () => {
    const seed = makeRow({ id: "seed", text: "seed memory about project alpha", distance: 0.25 });
    const assoc = makeRow({ id: "assoc", text: "associated memory about project beta", distance: 10 });
    const graphEdges = [{
      source: "seed",
      target: "assoc",
      type: "semantic",
      strength: 0.95,
      directed: false,
    }];
    const result = await runRecallPipeline({
      query: "project alpha",
      dbTable: mockTable([seed], [seed, assoc]),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: true,
      graphEdges,
      graphConfig: { graphHydrationRelevanceThreshold: 0.0 }, // disable relevance drop for this test
      logger: silence(),
    });
    const assocResult = result.memories.find(r => r.entry.id === "assoc");
    assert.ok(assocResult, "expected associative result");
    assert.strictEqual(assocResult.source, "graph");
    const seedScore = distanceToScore(0.25);
    assert.ok(
      assocResult.score <= seedScore * 0.85,
      `expected graph score <= ${seedScore * 0.85}, got ${assocResult.score}`,
    );
  });

  it("H1-02 keeps vector score and marks source=both for vector+graph overlap", async () => {
    const seed = makeRow({ id: "seed", text: "seed memory about project alpha", distance: 0.25 });
    const overlap = makeRow({ id: "overlap", text: "overlap memory about project alpha", distance: 0.5 });
    const graphEdges = [{
      source: "seed",
      target: "overlap",
      type: "semantic",
      strength: 0.95,
      directed: false,
    }];
    const result = await runRecallPipeline({
      query: "project alpha",
      dbTable: mockTable([seed, overlap], [seed, overlap]),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: true,
      graphEdges,
      graphConfig: { graphHydrationRelevanceThreshold: 0.0 },
      logger: silence(),
    });
    const overlapResult = result.memories.find(r => r.entry.id === "overlap");
    assert.ok(overlapResult, "expected overlap result");
    assert.strictEqual(overlapResult.source, "both");
    expectScore(overlapResult.score, distanceToScore(0.5));
  });

  it("drops hydrated graph results with non-active status", async () => {
    const seed = makeRow({ id: "seed", text: "seed memory about project alpha", distance: 0.25 });
    const inactive = makeRow({
      id: "inactive",
      text: "inactive associated memory",
      distance: 10,
      status: "archived",
    });
    const graphEdges = [{
      source: "seed",
      target: "inactive",
      type: "semantic",
      strength: 0.95,
      directed: false,
    }];
    const result = await runRecallPipeline({
      query: "project alpha",
      dbTable: mockTable([seed], [seed, inactive]),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: true,
      logger: silence(),
    });
    assert.strictEqual(
      result.memories.some(r => r.entry.id === "inactive"),
      false,
      "inactive graph result should be dropped",
    );
  });
});
