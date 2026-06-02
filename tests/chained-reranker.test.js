import { describe, it } from "node:test";
import assert from "node:assert";
import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";

class FakePrimary {
  constructor(shouldFail) { this.id = "primary"; this.shouldFail = shouldFail; }
  async rerank(query, documents, topN) {
    if (this.shouldFail) throw new Error("primary failed");
    return documents.map((_, i) => ({ index: i, relevance_score: 1.0 }));
  }
}

class FakeFallback {
  constructor() { this.id = "fallback"; }
  async rerank(query, documents, topN) {
    return documents.map((_, i) => ({ index: i, relevance_score: 0.5 }));
  }
}

describe("chained-reranker", () => {
  it("nutzt primary wenn erfolgreich", async () => {
    const chained = new ChainedRerankerProvider(new FakePrimary(false), new FakeFallback());
    const result = await chained.rerank("q", ["a", "b"], 2);
    assert.strictEqual(result[0].relevance_score, 1.0);
  });

  it("fallback bei primary-fehler", async () => {
    const chained = new ChainedRerankerProvider(new FakePrimary(true), new FakeFallback());
    const result = await chained.rerank("q", ["a", "b"], 2);
    assert.strictEqual(result[0].relevance_score, 0.5);
  });
});
