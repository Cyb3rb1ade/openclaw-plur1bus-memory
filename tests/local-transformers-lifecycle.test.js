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
  it("shares one exact embedding pipeline between full and request-scoped OpenClaw runtimes", async () => {
    let pipelineLoads = 0;
    let pipelineDisposals = 0;
    const loadTransformers = async () => ({
      async pipeline() {
        pipelineLoads += 1;
        return Object.assign(async () => ({
          data: Float32Array.of(1),
          async dispose() {},
        }), {
          async dispose() { pipelineDisposals += 1; },
        });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const full = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: true,
    });
    const requestScoped = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
    });

    assert.deepEqual(await Promise.all([
      full.embedQuery("first query"),
      requestScoped.embedQuery("second query"),
    ]), [[1], [1]]);
    assert.equal(pipelineLoads, 1);

    await requestScoped.shutdown();
    assert.equal(pipelineDisposals, 0, "a borrower must not dispose the active full-runtime model");
    await full.shutdown();
    assert.equal(pipelineDisposals, 1);
  });

  it("waits for request-scoped inference before the full runtime disposes its shared pipeline", async () => {
    let calls = 0;
    let releaseBorrower;
    let signalBorrower;
    const borrowerStarted = new Promise((resolve) => { signalBorrower = resolve; });
    const borrowerGate = new Promise((resolve) => { releaseBorrower = resolve; });
    let disposals = 0;
    const loadTransformers = async () => ({
      async pipeline() {
        return Object.assign(async () => {
          calls += 1;
          if (calls === 2) {
            signalBorrower();
            await borrowerGate;
          }
          return { data: Float32Array.of(1), async dispose() {} };
        }, {
          async dispose() { disposals += 1; },
        });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5-drain",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const full = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    const requestScoped = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: false });
    await full.embed("warm owner");

    const inference = requestScoped.embed("active borrower");
    await borrowerStarted;
    let shutdownSettled = false;
    const shutdown = full.shutdown().then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false);
    assert.equal(disposals, 0);

    releaseBorrower();
    await Promise.all([inference, shutdown]);
    assert.equal(disposals, 1);
    await assert.rejects(requestScoped.embed("stale borrower"), /shared local model.*closed/i);
    await requestScoped.shutdown();
  });

  it("registers local providers and waits for the active runtime generation before model load", async () => {
    const registered = [];
    const unregistered = [];
    let releaseAcquisition;
    const acquisitionGate = new Promise((resolve) => { releaseAcquisition = resolve; });
    const generation = {
      async beforeAcquire() { await acquisitionGate; },
      registerResource(resource, label) {
        registered.push([resource, label]);
        return () => {
          unregistered.push([resource, label]);
          return true;
        };
      },
    };
    let embeddingLoads = 0;
    let rerankerLoads = 0;
    const embedding = new LocalTransformersEmbeddingProvider({
      model: "fixture/e5",
      dimensions: 1,
      embeddingCacheEnabled: false,
      localModelGeneration: generation,
      loadTransformers: async () => {
        embeddingLoads += 1;
        return { pipeline: async () => disposablePipeline([]) };
      },
    });
    const reranker = new LocalTransformersRerankerProvider({
      model: "fixture/reranker",
      localModelGeneration: generation,
      loadTransformers: async () => {
        rerankerLoads += 1;
        return { pipeline: async () => disposablePipeline([]) };
      },
    });

    const embeddingLoad = embedding._getPipeline();
    const rerankerLoad = reranker._getPipeline();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(embeddingLoads, 0);
    assert.equal(rerankerLoads, 0);
    assert.deepEqual(registered.map(([, label]) => label), ["embedding:fixture/e5", "reranker:fixture/reranker"]);

    releaseAcquisition();
    await Promise.all([embeddingLoad, rerankerLoad]);
    assert.equal(embeddingLoads, 1);
    assert.equal(rerankerLoads, 1);
    await Promise.all([embedding.shutdown(), reranker.shutdown()]);
    assert.deepEqual(unregistered.map(([, label]) => label), ["embedding:fixture/e5", "reranker:fixture/reranker"]);
  });

  it("does not dispose an embedding pipeline while inference is active", async () => {
    const calls = [];
    let signalStarted;
    let releaseInference;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseInference = resolve; });
    const pipeline = Object.assign(async () => {
      calls.push("inference.start");
      signalStarted();
      await blocked;
      calls.push("inference.end");
      return [1];
    }, {
      async dispose() { calls.push("pipeline.dispose"); },
    });
    const provider = new LocalTransformersEmbeddingProvider({
      model: "fixture/e5",
      dimensions: 1,
      embeddingCacheEnabled: false,
      loadTransformers: async () => ({ pipeline: async () => pipeline }),
    });

    const inference = provider.embed("active inference");
    await started;
    const shutdown = provider.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["inference.start"]);

    releaseInference();
    await Promise.all([inference, shutdown]);
    assert.deepEqual(calls, ["inference.start", "inference.end", "pipeline.dispose"]);
  });

  it("does not dispose a reranker pipeline while inference is active", async () => {
    const calls = [];
    let signalStarted;
    let releaseInference;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseInference = resolve; });
    const pipeline = Object.assign(async () => {
      calls.push("rerank.start");
      signalStarted();
      await blocked;
      calls.push("rerank.end");
      return [{ score: 0.9 }];
    }, {
      async dispose() { calls.push("reranker.dispose"); },
    });
    const provider = new LocalTransformersRerankerProvider({
      model: "fixture/reranker",
      loadTransformers: async () => ({ pipeline: async () => pipeline }),
    });

    const inference = provider.rerank("query", ["document"], 1);
    await started;
    const shutdown = provider.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["rerank.start"]);

    releaseInference();
    await Promise.all([inference, shutdown]);
    assert.deepEqual(calls, ["rerank.start", "rerank.end", "reranker.dispose"]);
  });

  it("keeps a provider registered when model disposal fails so generation cleanup remains fail-closed", async () => {
    const unregistered = [];
    const generation = {
      registerResource(resource, label) {
        return () => {
          unregistered.push([resource, label]);
          return true;
        };
      },
    };
    const embedding = new LocalTransformersEmbeddingProvider({
      model: "fixture/e5",
      dimensions: 1,
      embeddingCacheEnabled: false,
      localModelGeneration: generation,
    });
    embedding._pipeline = Object.assign(async () => [1], {
      async dispose() { throw new Error("embedding dispose failed"); },
    });
    const reranker = new LocalTransformersRerankerProvider({
      model: "fixture/reranker",
      localModelGeneration: generation,
    });
    reranker._pipeline = Object.assign(async () => [{ score: 1 }], {
      async dispose() { throw new Error("reranker dispose failed"); },
    });

    await assert.rejects(embedding.shutdown(), /embedding dispose failed/);
    await assert.rejects(reranker.shutdown(), /reranker dispose failed/);
    assert.deepEqual(unregistered, []);
  });

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
