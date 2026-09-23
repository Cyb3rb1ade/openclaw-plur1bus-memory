/**
 * tests/rerank-single-timeout.test.js — PR-09.
 *
 * Exactly one timer per rerank, and it is the one that aborts the HTTP request.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { CohereRerankerProvider } from "../lib/providers/reranker-cohere.js";

const rows = Array.from({ length: 4 }, (_, i) => ({
  id: `r${i}`, text: `memory ${i}`, summary: `memory ${i}`, _distance: i * 0.01,
  importance: 0.5, scope: "agent-private", agentId: "agent-a", storedBy: "agent-a",
}));
const dbTable = { vectorSearch: () => ({ limit: () => ({ toArray: async () => rows }) }) };
const embeddings = { embedQuery: async () => [0.1, 0.2, 0.3], embed: async () => [0.1, 0.2, 0.3] };

function countTimers() {
  const realTimeout = AbortSignal.timeout;
  const realSetTimeout = globalThis.setTimeout;
  const seen = { abortTimeouts: [], rerankSetTimeouts: 0 };
  AbortSignal.timeout = (ms) => { seen.abortTimeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 60) seen.rerankSetTimeouts += 1;
    return realSetTimeout(fn, ms, ...rest);
  };
  return { seen, restore() { AbortSignal.timeout = realTimeout; globalThis.setTimeout = realSetTimeout; } };
}

describe("rerank timeout ownership", () => {
  it("creates exactly one 60 ms timer and aborts the HTTP request with it", async () => {
    const originalFetch = globalThis.fetch;
    let requestSignal = null;
    globalThis.fetch = (_url, opts) => new Promise((_, reject) => {
      requestSignal = opts.signal;
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
    });
    const timers = countTimers();
    try {
      const reranker = new CohereRerankerProvider({ apiKey: "test-key", timeoutMs: 60 });
      const { memories } = await runRecallPipeline({
        query: "q", dbTable, embeddings, reranker, rerankerTimeoutMs: 60,
        logger: { info() {}, warn() {}, debug() {}, error() {} }, recallMinScore: 0, topN: 3, dedupEnabled: false,
        canonicalEnabled: false, associativeEnabled: false, agentId: "agent-a",
      });
      assert.equal(memories.length, 3, "fell back to unreranked top-N");
      assert.equal(timers.seen.abortTimeouts.filter((ms) => ms === 60).length, 1, "one AbortSignal.timeout for the whole rerank");
      assert.equal(timers.seen.rerankSetTimeouts, 0, "no setTimeout-based rerank race left");
      assert.equal(requestSignal.aborted, true, "the HTTP request observed the abort");
    } finally {
      timers.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("a caller abort during rerank propagates instead of falling back", async () => {
    const controller = new AbortController();
    const reranker = { id: "stub", rerank: (_q, _d, _n, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
      controller.abort(new Error("caller gone"));
    }) };
    await assert.rejects(() => runRecallPipeline({
      query: "q", dbTable, embeddings, reranker, rerankerTimeoutMs: 5_000, signal: controller.signal,
      logger: { info() {}, warn() {}, debug() {}, error() {} }, recallMinScore: 0, topN: 3, dedupEnabled: false,
      canonicalEnabled: false, associativeEnabled: false, agentId: "agent-a",
    }), /caller gone/);
  });
});
