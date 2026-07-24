// tests/recall-pipeline-timeout.test.js
// Scope A: LanceDB timeouts + rerank safety for recall-pipeline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecallPipeline as runRecallPipelineRaw } from "../lib/recall-pipeline.js";

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
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
  };
}

function runRecallPipeline(options) {
  return runRecallPipelineRaw({ agentId: "agent-a", ...options });
}

function mockTable({ vectorRows = [], queryRows = null, vectorDelayMs = 0, queryDelayMs = 0 } = {}) {
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
          return {
            async toArray() {
              if (vectorDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, vectorDelayMs));
              }
              return vectorRows;
            },
          };
        },
      };
    },
    query() {
      return {
        where(whereClause) {
          return {
            limit() {
              return {
                async toArray() {
                  if (queryDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, queryDelayMs));
                  }
                  return matchRows(whereClause);
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("recall-pipeline timeouts and rerank safety", () => {
  it("treats a hanging vectorSearch as empty and continues", async () => {
    const row = makeRow({ id: "seed-1", text: "seed memory" });
    const warnings = [];
    const logger = {
      warn(msg) { warnings.push(msg); },
      info() {},
    };

    const result = await runRecallPipeline({
      query: "seed",
      dbTable: mockTable({ vectorRows: [row], vectorDelayMs: 12_000 }),
      embeddings: makeEmbeddings(),
      workspaceDir: null,
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      logger,
    });

    assert.deepStrictEqual(result.memories, []);
    assert.ok(warnings.some(w => typeof w === "string" && w.includes("vectorSearch timed out")));
  });

  it("falls back safely when reranker returns malformed indices", async () => {
    const rows = [
      makeRow({ id: "a", text: "alpha", summary: "alpha summary" }),
      makeRow({ id: "b", text: "beta", summary: "beta summary" }),
      makeRow({ id: "c", text: "gamma", summary: "gamma summary" }),
    ];
    const reranker = {
      async rerank() {
        return [
          { index: -1 },
          { index: "not-a-number" },
          { index: 99 },
          {},
          { index: 1.5 },
        ];
      },
    };

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
      decisionTrace: true,
    });

    assert.strictEqual(result.memories.length, 2);
    const ids = result.memories.map(r => r.entry.id);
    assert.deepStrictEqual(ids, ["a", "b"]);
    const guard = result.trace?.guards?.find(g => g.name === "rerank");
    assert.ok(guard, "rerank guard should be recorded");
    assert.strictEqual(guard.passed, false);
  });

  it("does not produce the string undefined when text is missing in rerank docs", async () => {
    const rows = [
      makeRow({ id: "no-text", text: undefined, summary: "" }),
      makeRow({ id: "has-text", text: "real text", summary: "" }),
    ];
    let capturedDocs = null;
    const reranker = {
      async rerank(_query, docs) {
        capturedDocs = docs;
        return docs.map((_, i) => ({ index: i }));
      },
    };

    await runRecallPipeline({
      query: "whatever",
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
    });

    assert.ok(Array.isArray(capturedDocs));
    assert.strictEqual(capturedDocs.length, 2);
    assert.ok(!capturedDocs.some(d => d === "undefined"), "no doc should be the literal string undefined");
    assert.strictEqual(capturedDocs[0], "");
    assert.strictEqual(capturedDocs[1], "real text");
  });
});
