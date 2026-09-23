/**
 * Smoke-Test: Reranker Pipeline Timeout & Fallback
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { runRecallPipeline as runRecallPipelineRaw } from "../lib/recall-pipeline.js";

function runRecallPipeline(options) {
  return runRecallPipelineRaw({ agentId: "agent-a", ...options });
}

describe("reranker-pipeline", () => {
  const makeDbTable = (rows) => ({
    vectorSearch: () => ({
      limit: () => ({
        toArray: async () => rows,
      }),
    }),
  });

  const embeddings = {
    dim: 3,
    embed: async () => [0.1, 0.2, 0.3],
    embedQuery: async () => [0.1, 0.2, 0.3],
  };

  const rows = [
    { id: "a", text: "alpha", _distance: 0.1, importance: 0.8, scope: "agent-private", agentId: "agent-a", storedBy: "agent-a" },
    { id: "b", text: "beta", _distance: 0.2, importance: 0.5, scope: "agent-private", agentId: "agent-a", storedBy: "agent-a" },
    { id: "c", text: "gamma", _distance: 0.3, importance: 0.3, scope: "agent-private", agentId: "agent-a", storedBy: "agent-a" },
  ];

  it("falls back to unreranked on reranker error when fallbackOnError=true", async () => {
    const badReranker = {
      rerank: async () => { throw new Error("cohere down"); },
    };
    const { memories } = await runRecallPipeline({
      query: "test",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 2,
      reranker: badReranker,
      rerankCandidates: 10,
      rerankerTimeoutMs: 5000,
      rerankerFallbackOnError: true,
      canonicalEnabled: false,
      logger: { warn: () => {}, info: () => {} },
    });
    assert.strictEqual(memories.length, 2);
    assert.strictEqual(memories[0].entry.id, "a");
  });

  it("propagates reranker error when fallbackOnError=false", async () => {
    const badReranker = {
      rerank: async () => { throw new Error("cohere down"); },
    };
    await assert.rejects(
      () => runRecallPipeline({
        query: "test",
        dbTable: makeDbTable(rows),
        embeddings,
        topN: 2,
        reranker: badReranker,
        rerankCandidates: 10,
        rerankerTimeoutMs: 5000,
        rerankerFallbackOnError: false,
        canonicalEnabled: false,
        logger: { warn: () => {}, info: () => {} },
      }),
      /cohere down/
    );
  });

  it("times out and falls back when reranker is too slow", async () => {
    // PR-09: the pipeline no longer races its own setTimeout against the
    // reranker's promise — it hands the reranker one signal and relies on
    // the reranker's own request being driven by it (exactly like the real
    // Cohere/local providers). This stub honors that signal, same as a real
    // provider's HTTP request would.
    const slowReranker = {
      rerank: async (_query, _documents, _topN, { signal } = {}) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve([{ index: 0 }]), 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    };
    const t0 = Date.now();
    const { memories } = await runRecallPipeline({
      query: "test",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 2,
      reranker: slowReranker,
      rerankCandidates: 10,
      rerankerTimeoutMs: 50,
      rerankerFallbackOnError: true,
      canonicalEnabled: false,
      logger: { warn: () => {}, info: () => {} },
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 300, `expected fast fallback, took ${elapsed}ms`);
    assert.strictEqual(memories.length, 2);
  });

  it("uses reranked order on success", async () => {
    const goodReranker = {
      rerank: async () => [{ index: 2 }, { index: 0 }, { index: 1 }],
    };
    const { memories } = await runRecallPipeline({
      query: "test",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 3,
      reranker: goodReranker,
      rerankCandidates: 10,
      rerankerTimeoutMs: 5000,
      rerankerFallbackOnError: true,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger: { warn: () => {}, info: () => {} },
    });
    assert.strictEqual(memories.length, 3);
    assert.strictEqual(memories[0].entry.id, "c");
    assert.strictEqual(memories[1].entry.id, "a");
    assert.strictEqual(memories[2].entry.id, "b");
  });
});
