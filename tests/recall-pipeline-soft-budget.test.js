import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { createRecallPhaseTimer } from "../lib/recall-phase-timer.js";

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
  };
}

function mockTable({ vectorRows = [] } = {}) {
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
        where() {
          return { limit() { return { async toArray() { return []; } }; } };
        },
      };
    },
  };
}

function makeTimerThatExceedsAfter(phase) {
  const started = new Set();
  const completed = new Set();
  const base = createRecallPhaseTimer({ softBudgetMs: 1_000_000, hardTimeoutMs: 1_000_000 });
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "start") {
        return (p) => {
          started.add(p);
          target.start(p);
        };
      }
      if (prop === "end") {
        return (p) => {
          completed.add(p);
          target.end(p);
        };
      }
      if (prop === "isSoftBudgetExceeded") return () => completed.has(phase);
      if (prop === "startedPhases") return started;
      return target[prop];
    },
  });
}

describe("recall-pipeline soft-budget fallback", () => {
  it("skips slow rerank and returns boosted/deduped results", async () => {
    const rows = [
      makeRow({ id: "a", text: "alpha", summary: "alpha summary", _distance: 0.1 }),
      makeRow({ id: "b", text: "beta", summary: "beta summary", _distance: 0.2 }),
      makeRow({ id: "c", text: "gamma", summary: "gamma summary", _distance: 0.3 }),
    ];
    const reranker = {
      async rerank() {
        throw new Error("reranker should not be called under soft-budget fallback");
      },
    };
    const phaseTimer = makeTimerThatExceedsAfter("budget");

    const result = await runRecallPipeline({
      query: "alpha beta gamma",
      dbTable: mockTable({ vectorRows: rows }),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 2,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      reranker,
      rerankCandidates: 10,
      rerankerTimeoutMs: 100,
      phaseTimer,
      softBudgetFallback: true,
      decisionTrace: true,
    });

    assert.strictEqual(result.memories.length, 2);
    assert.deepStrictEqual(result.memories.map((r) => r.entry.id), ["a", "b"]);
    assert.ok(!phaseTimer.startedPhases.has("rerank"), "rerank phase should not start when budget exceeded before rerank");
    const guard = result.trace?.guards?.find((g) => g.name === "soft-budget");
    assert.ok(guard, "soft-budget guard should be recorded");
    assert.strictEqual(guard.reason, "soft_budget_fallback");
  });

  it("skips graph expansion when soft budget is exceeded after scoring", async () => {
    const rows = [
      makeRow({ id: "a", text: "alpha", summary: "alpha summary" }),
    ];
    const phaseTimer = makeTimerThatExceedsAfter("scoring");

    const result = await runRecallPipeline({
      query: "alpha",
      dbTable: mockTable({ vectorRows: rows }),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      graphEdges: [{ source: "a", target: "b", weight: 1 }],
      associativeEnabled: true,
      phaseTimer,
      softBudgetFallback: true,
    });

    assert.ok(result.memories.length >= 1);
    assert.ok(!phaseTimer.startedPhases.has("graph"), "graph phase should not start when budget exceeded after scoring");
  });

  it("retains safety/correction memories in fallback", async () => {
    const rows = [
      makeRow({ id: "decision-1", text: "Always confirm before deleting", summary: "confirm before delete", category: "decision", importance: 0.9 }),
      makeRow({ id: "fact-1", text: "Paris is a city", summary: "Paris city" }),
    ];
    const phaseTimer = makeTimerThatExceedsAfter("scoring");

    const result = await runRecallPipeline({
      query: "deletion safety",
      dbTable: mockTable({ vectorRows: rows }),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      phaseTimer,
      softBudgetFallback: true,
    });

    const ids = result.memories.map((r) => r.entry.id);
    assert.ok(ids.includes("decision-1"), "safety decision memory should be retained in fallback");
  });

  it("does not short-circuit when softBudgetFallback is disabled", async () => {
    const rows = [
      makeRow({ id: "a", text: "alpha" }),
      makeRow({ id: "b", text: "beta" }),
    ];
    let rerankCalled = false;
    const reranker = {
      async rerank() {
        rerankCalled = true;
        return [{ index: 0 }];
      },
    };
    const phaseTimer = makeTimerThatExceedsAfter("budget");

    await runRecallPipeline({
      query: "alpha",
      dbTable: mockTable({ vectorRows: rows }),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      reranker,
      rerankCandidates: 10,
      rerankerTimeoutMs: 100,
      phaseTimer,
      softBudgetFallback: false,
    });

    assert.strictEqual(rerankCalled, true, "rerank should still run when fallback is disabled");
  });
});
