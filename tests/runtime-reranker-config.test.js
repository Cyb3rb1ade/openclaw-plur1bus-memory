import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRuntimeRerankerProvider } from "../index.js";

describe("runtime reranker config", () => {
  it("uses configured fallbackModel for Cohere local fallback", () => {
    const { reranker } = createRuntimeRerankerProvider({
      provider: "cohere",
      apiKeyEnv: "_PLUR1BUS_RUNTIME_RERANK_KEY",
      fallbackProvider: "local-transformers",
      fallbackModel: "custom/local-reranker",
    }, null);

    assert.equal(reranker.fallback.model, "custom/local-reranker");
  });
});
