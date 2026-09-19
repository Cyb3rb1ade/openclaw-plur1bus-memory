import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecallPipeline as runRecallPipelineRaw } from "../lib/recall-pipeline.js";
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
  const ownerAgentId = opts.agentId ?? "agent-a";
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
    scope: opts.scope ?? "agent-private",
    agentId: ownerAgentId,
    storedBy: opts.storedBy ?? ownerAgentId,
    workspaceId: opts.workspaceId ?? "",
    workspaceKey: opts.workspaceKey ?? "",
    ownerUserId: opts.ownerUserId ?? "",
  };
}

function runRecallPipeline(options) {
  return runRecallPipelineRaw({ agentId: "agent-a", ...options });
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
  it("filters a foreign candidate before an immediate soft-budget return", async () => {
    const rows = [
      makeRow({ id: "own", text: "allowed" }),
      makeRow({
        id: "foreign",
        text: "workspace-b secret",
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      }),
    ];
    const phaseTimer = makeTimerThatExceedsAfter("vector_search");
    const result = await runRecallPipeline({
      query: "soft budget acl",
      dbTable: mockTable({ vectorRows: rows }),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      phaseTimer,
      softBudgetFallback: true,
      decisionTrace: true,
    });

    assert.deepEqual(result.memories.map((item) => item.entry.id), ["own"]);
    assert.ok(result.trace.decisions.some((entry) => (
      entry.memoryId === "foreign"
      && entry.stage === "initial-acl"
      && entry.reason === "acl.workspace.mismatch"
    )));
    assert.ok(result.trace.guards.some((guard) => guard.name === "soft-budget"));
  });

  /**
   * Der Notausgang kehrte vor dem Scoring-Block zurueck (Zeile 1797) und
   * ignorierte damit Zerfall und Gebrauch vollstaendig — unter Zeitdruck
   * rangierte er allein nach Aehnlichkeit. Eine seit Monaten unbenutzte Zeile
   * stand dann gleichauf mit einer taeglich gebrauchten. Der Hauptweg wertet
   * die Staerke (recall-pipeline.js:1833), der Notausgang tat es nicht: zwei
   * Wege, zwei Regeln.
   */
  it("wertet die Gedaechtnisstaerke auch im Notausgang", async () => {
    const rows = [
      makeRow({ id: "verblasst", text: "alte Notiz", memoryStrength: 0.05 }),
      makeRow({ id: "praesent", text: "alte Notiz", memoryStrength: 0.95 }),
    ];
    const phaseTimer = makeTimerThatExceedsAfter("vector_search");
    const result = await runRecallPipeline({
      query: "alte Notiz",
      dbTable: mockTable({ vectorRows: rows }),
      embeddings: makeEmbeddings(),
      topN: 1,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      phaseTimer,
      softBudgetFallback: true,
    });
    assert.deepEqual(result.memories.map((item) => item.entry.id), ["praesent"]);
  });

  it("wendet die Staerke im Notausgang nicht doppelt an", async () => {
    const rows = [
      makeRow({ id: "a", text: "notiz", memoryStrength: 0.5 }),
      makeRow({ id: "b", text: "notiz", memoryStrength: 0.4 }),
    ];
    // Notausgang NACH dem Scoring: die Staerke ist dort bereits verrechnet.
    const phaseTimer = makeTimerThatExceedsAfter("scoring");
    const result = await runRecallPipeline({
      query: "notiz",
      dbTable: mockTable({ vectorRows: rows }),
      embeddings: makeEmbeddings(),
      topN: 2,
      recallMinScore: -5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      phaseTimer,
      softBudgetFallback: true,
    });
    const a = result.memories.find((item) => item.entry.id === "a");
    assert.ok(a, "Zeile a muss enthalten sein");
    // Einmal angewandt: score = Rohwert + (0.5 - 1). Zweimal waere -1.0.
    assert.ok(a.score > -1, `Staerke doppelt angewandt: score ${a.score}`);
  });

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
