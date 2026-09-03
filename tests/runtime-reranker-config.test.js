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

  it("passes the host SecretInput resolver only to the remote primary", () => {
    const credentialResolver = async () => "secret";
    const { reranker } = createRuntimeRerankerProvider({
      provider: "cohere",
      apiKey: { source: "store", provider: "lab", id: "PLUR1BUS_COHERE_API_KEY" },
      fallbackProvider: "local-transformers",
    }, null, { credentialResolver });

    assert.equal(reranker.primary.credentialResolver, credentialResolver);
    assert.equal(reranker.fallback.credentialResolver, undefined);
  });
});
