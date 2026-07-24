// tests/recall-pipeline-decision-trace.test.js
// P2 RecallDecisionTrace integration for recall pipeline + continuity gate.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRecallPipeline as runRecallPipelineRaw } from "../lib/recall-pipeline.js";
import { filterAssociativeCandidates } from "../lib/continuity-gate.js";

const VECTOR_DIM = 4;

function makeVector() {
  return Array(VECTOR_DIM).fill(0.1);
}

function makeEmbeddings() {
  return {
    dim: VECTOR_DIM,
    async embed() { return makeVector(); },
    async embedQuery() { return makeVector(); },
  };
}

function mockTable(vectorRows = [], queryRows = null) {
  const lookupRows = queryRows ?? vectorRows;
  function matchRows(whereClause) {
    if (typeof whereClause !== "string") return lookupRows;
    const eqMatch = whereClause.match(/^id\s*=\s*['"]([^'"]+)['"]$/i);
    if (eqMatch) return lookupRows.filter(r => r.id === eqMatch[1]);
    const inMatch = whereClause.match(/^id\s+IN\s*\((.+)\)$/i);
    if (inMatch) {
      const ids = new Set(inMatch[1].match(/'([^']*)'/g)?.map(s => s.slice(1, -1)) ?? []);
      return lookupRows.filter(r => ids.has(r.id));
    }
    return lookupRows;
  }
  return {
    vectorSearch() {
      return {
        limit() {
          return { async toArray() { return vectorRows; } };
        },
      };
    },
    query() {
      return {
        where(whereClause) {
          return {
            limit() {
              return { async toArray() { return matchRows(whereClause); } };
            },
          };
        },
      };
    },
  };
}

function makeRow(opts) {
  return {
    id: opts.id,
    text: opts.text ?? "",
    summary: opts.summary ?? "",
    category: opts.category ?? "fact",
    origin: opts.origin ?? "dm",
    status: opts.status ?? "active",
    importance: opts.importance ?? 0.5,
    memoryStrength: opts.memoryStrength ?? 1.0,
    _distance: opts.distance ?? 0,
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
  };
}

function runRecallPipeline(options) {
  return runRecallPipelineRaw({ agentId: "agent-a", ...options });
}

describe("recall-pipeline decision trace", () => {
  it("includes vector memory with source=vector and score", async () => {
    const seedRow = makeRow({ id: "seed-1", text: "Seed memory about project alpha", summary: "seed" });
    const result = await runRecallPipeline({
      query: "project alpha",
      dbTable: mockTable([seedRow]),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      decisionTrace: true,
    });

    assert.ok(result.memories.some(r => r.entry.id === "seed-1" && r.source === "vector"));
    assert.ok(result.trace, "trace should be returned");
    const candidate = result.trace.candidates.find(c => c.id === "seed-1");
    assert.ok(candidate, "vector candidate should be recorded");
    assert.strictEqual(candidate.source, "vector");
    assert.strictEqual(candidate.score, 1.0);
  });

  it("includes graph-only memory with source=graph and evidence=weak-association", async () => {
    const seedRow = makeRow({ id: "seed-1", text: "Seed memory about project alpha", summary: "seed" });
    const assocRow = makeRow({ id: "assoc-1", text: "Associated memory about project beta", summary: "assoc" });
    const graphEdges = [{
      source: "seed-1",
      target: "assoc-1",
      type: "semantic",
      strength: 0.9,
      directed: false,
    }];
    const result = await runRecallPipeline({
      query: "project alpha",
      dbTable: mockTable([seedRow], [seedRow, assocRow]),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      graphEdges,
      associativeEnabled: true,
      decisionTrace: true,
    });

    const graphMemory = result.memories.find(r => r.entry.id === "assoc-1");
    assert.ok(graphMemory, "graph-only memory should be recalled");
    assert.strictEqual(graphMemory.source, "graph");

    const decision = result.trace.decisions.find(
      d => d.memoryId === "assoc-1" && d.stage === "associative-merge"
    );
    assert.ok(decision, "associative-merge decision should exist");
    assert.strictEqual(decision.action, "inclusion");
    assert.strictEqual(decision.reason, "weak-association");
  });

  it("records canonical memory with source=canonical", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-canonical-"));
    try {
      const knowledgePath = join(tmpDir, "memory");
      mkdirSync(knowledgePath, { recursive: true });
      writeFileSync(join(knowledgePath, "KNOWLEDGE.md"), "# Project Alpha\n\nWe use Postgres for project alpha.\n");
      const seedRow = makeRow({ id: "seed-1", text: "Seed memory", summary: "seed" });
      const result = await runRecallPipeline({
        query: "project alpha",
        dbTable: mockTable([seedRow]),
        embeddings: makeEmbeddings(),
        workspaceDir: tmpDir,
        topN: 5,
        budget: 0,
        recallMinScore: 0.1,
        importanceBoost: 0,
        canonicalEnabled: true,
        canonicalMinScore: 0.30,
        canonicalMaxItems: 5,
        decisionTrace: true,
      });

      assert.ok(result.canonical.length > 0, "canonical hits should exist");
      const canonicalCandidate = result.trace.candidates.find(c => c.source === "canonical");
      assert.ok(canonicalCandidate, "canonical candidate should be recorded in trace");
      assert.ok(canonicalCandidate.score >= 0.30);
      const canonicalDecision = result.trace.decisions.find(
        d => d.memoryId === canonicalCandidate.id && d.stage === "canonical"
      );
      assert.ok(canonicalDecision, "canonical inclusion decision should exist");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records a rejection reason when a graph candidate is denied by the continuity gate", async () => {
    const { createRecallDecisionTrace } = await import("../lib/recall-decision-trace.js");
    const trace = createRecallDecisionTrace();
    const candidates = [
      { id: "g1", graphSource: "graph", relevanceScore: 0.6, depth: 1 },
    ];
    const result = filterAssociativeCandidates(candidates, {
      maxAssociations: 1,
      assocThreshold: 0.75,
      sessionState: {},
      decisionTrace: trace,
    });

    assert.deepStrictEqual(result, []);
    const rejection = trace.decisions.find(
      d => d.memoryId === "g1" && d.stage === "continuity-gate" && d.action === "rejection"
    );
    assert.ok(rejection, "rejection decision should be recorded");
    assert.strictEqual(rejection.reason, "score_below_threshold");
  });

  it("returns a populated trace object with summary and candidates", async () => {
    const seedRow = makeRow({ id: "seed-1", text: "Seed memory about project alpha", summary: "seed" });
    const result = await runRecallPipeline({
      query: "project alpha",
      dbTable: mockTable([seedRow]),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      decisionTrace: true,
    });

    assert.ok(result.trace, "trace should be returned");
    assert.ok(Array.isArray(result.trace.candidates));
    assert.ok(result.trace.candidates.length > 0);
    assert.ok(result.trace.summary, "trace summary should exist");
    assert.strictEqual(typeof result.trace.summary.totalCandidates, "number");
    assert.ok(result.trace.summary.totalCandidates > 0);
  });

  it("returns selected memories when both retrieval-ledger and warning delivery fail", async () => {
    const callbackError = new Error("injected retrieval ledger failure");
    const loggerError = new Error("injected retrieval logger failure");
    const seedRow = makeRow({ id: "seed-logger", text: "Selected memory", summary: "selected" });

    const result = await runRecallPipeline({
      query: "selected",
      dbTable: mockTable([seedRow]),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      retrievalLogger() { throw callbackError; },
      logger: { warn() { throw loggerError; } },
    });

    assert.deepEqual(result.memories.map((item) => item.entry.id), ["seed-logger"]);
  });
});
