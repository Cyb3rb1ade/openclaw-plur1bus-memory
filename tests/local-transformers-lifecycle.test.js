import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { LocalTransformersRerankerProvider } from "../lib/providers/reranker-local-transformers.js";
import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";

function disposablePipeline(calls) {
  return Object.assign(async () => [0], {
    async dispose() {
      calls.push("pipeline.dispose");
    },
  });
}

describe("local Transformers.js lifecycle", () => {
  it("disposes the embedding pipeline and closes its cache exactly once", async () => {
    const calls = [];
    const provider = new LocalTransformersEmbeddingProvider({
      model: "fixture/e5",
      dimensions: 1,
    });
    provider._pipeline = disposablePipeline(calls);
    provider._cache = { close: () => calls.push("cache.close") };

    await provider.shutdown();
    await provider.shutdown();

    assert.deepStrictEqual(calls, ["pipeline.dispose", "cache.close"]);
    assert.equal(provider._pipeline, null);
  });

  it("waits for an in-flight embedding model load and disposes the resulting pipeline", async () => {
    const calls = [];
    let releaseLoad;
    let signalLoadStarted;
    const loadStarted = new Promise((resolve) => { signalLoadStarted = resolve; });
    const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
    const pipeline = disposablePipeline(calls);
    const provider = new LocalTransformersEmbeddingProvider({
      model: "fixture/e5",
      dimensions: 1,
      embeddingCacheEnabled: false,
      loadTransformers: async () => ({
        async pipeline() {
          signalLoadStarted();
          await loadGate;
          return pipeline;
        },
      }),
    });

    const loading = provider._getPipeline();
    await loadStarted;
    const shutdown = provider.shutdown();
    releaseLoad();
    await Promise.all([loading, shutdown]);

    assert.deepStrictEqual(calls, ["pipeline.dispose"]);
    await assert.rejects(provider._getPipeline(), /shut down/i);
  });

  it("retries a transient embedding model-load failure without caching the rejection", async () => {
    let attempts = 0;
    const pipeline = disposablePipeline([]);
    const provider = new LocalTransformersEmbeddingProvider({
      model: "fixture/e5",
      dimensions: 1,
      embeddingCacheEnabled: false,
      loadTransformers: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient import failure");
        return { pipeline: async () => pipeline };
      },
    });

    await assert.rejects(provider._getPipeline(), /transient import failure/);
    assert.equal(await provider._getPipeline(), pipeline);
    assert.equal(attempts, 2);
  });

  it("disposes the local reranker pipeline exactly once", async () => {
    const calls = [];
    const provider = new LocalTransformersRerankerProvider({ model: "fixture/reranker" });
    provider._pipeline = disposablePipeline(calls);

    await provider.shutdown();
    await provider.shutdown();

    assert.deepStrictEqual(calls, ["pipeline.dispose"]);
    assert.equal(provider._pipeline, null);
  });

  it("shuts down both chained rerankers even when the primary cleanup fails", async () => {
    const calls = [];
    const provider = new ChainedRerankerProvider(
      { id: "primary", async shutdown() { calls.push("primary"); throw new Error("primary cleanup failed"); } },
      { id: "fallback", async shutdown() { calls.push("fallback"); } },
    );

    await assert.rejects(provider.shutdown(), /primary cleanup failed/);
    assert.deepStrictEqual(calls, ["primary", "fallback"]);
  });
});

describe("remote embedding lifecycle", () => {
  it("closes the OpenAI embedding cache and releases its client exactly once", async () => {
    const calls = [];
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      embeddingCacheEnabled: false,
    });
    provider._cache = { close: async () => calls.push("cache.close") };
    provider._client = { embeddings: {} };

    await provider.shutdown();
    await provider.shutdown();

    assert.deepStrictEqual(calls, ["cache.close"]);
    assert.equal(provider._client, null);
  });
});
