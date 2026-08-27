/**
 * tests/reranker-cohere-timeout.test.js
 *
 * Regression: CohereRerankerProvider hardcoded a 30s abort timeout and ignored
 * the configured timeoutMs (normalizeRerankerConfig default 5000, overridable).
 * A Cohere rerank could hang up to 30s regardless of config — relevant to this
 * stack's timeout/cooldown sensitivity.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { CohereRerankerProvider } from "../lib/providers/reranker-cohere.js";

describe("CohereRerankerProvider timeout", () => {
  it("resolves a structured SecretInput lazily before the real request", async () => {
    const originalFetch = global.fetch;
    const resolverCalls = [];
    const fetchCalls = [];
    const reference = { source: "env", provider: "default", id: "PLUR1BUS_COHERE_API_KEY" };
    global.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }) };
    };
    try {
      const provider = new CohereRerankerProvider({
        apiKey: reference,
        credentialResolver: async (params) => {
          resolverCalls.push(params);
          return "resolved-reranker-secret";
        },
      });
      await provider.rerank("query", ["document"], 1);
      assert.equal(resolverCalls.length, 1);
      assert.equal(resolverCalls[0].value, reference);
      assert.equal(resolverCalls[0].path, "plugins.entries.memory-lancedb-namespaced.config.reranker.apiKey");
      assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer resolved-reranker-secret");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("honors a configured timeoutMs and aborts the request at that bound", async () => {
    const originalFetch = global.fetch;
    process.env.COHERE_API_KEY = "test-key";
    // fetch that never resolves until aborted via the signal.
    global.fetch = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });

    try {
      const provider = new CohereRerankerProvider({ timeoutMs: 30, apiKey: "test-key" });
      const start = Date.now();
      await assert.rejects(() => provider.rerank("q", ["a", "b"], 2));
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < 1000,
        `rerank must abort at the configured ~30ms bound, not the old hardcoded 30s; took ${elapsed}ms`,
      );
    } finally {
      global.fetch = originalFetch;
      delete process.env.COHERE_API_KEY;
    }
  });

  it("exposes the configured timeoutMs", () => {
    assert.strictEqual(new CohereRerankerProvider({ timeoutMs: 7000 }).timeoutMs, 7000);
  });
});
