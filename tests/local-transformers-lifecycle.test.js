import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { LocalTransformersRerankerProvider } from "../lib/providers/reranker-local-transformers.js";
import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";
import { createSharedLocalModelLease } from "../lib/providers/local-transformers-shared-pool.js";

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

  it("rejects an owner-required scoped load until the active full runtime claims the pool", async () => {
    let pipelineLoads = 0;
    const loadTransformers = async () => ({
      async pipeline() {
        pipelineLoads += 1;
        return Object.assign(async () => ({ data: Float32Array.of(1) }), { async dispose() {} });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5-owner-gate",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const full = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    const beforeActivation = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });
    await assert.rejects(beforeActivation.embed("before activation"), /no activated full-runtime owner/i);
    assert.equal(pipelineLoads, 0);
    await full.activateSharedModelOwner();
    await assert.rejects(
      beforeActivation.embed("stale after failed admission"),
      /shared local model.*closed/i,
    );
    const requestScoped = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });
    assert.deepEqual(await requestScoped.embed("after activation"), [1]);
    assert.equal(pipelineLoads, 1);
    await full.shutdown();
    await beforeActivation.shutdown();
    await requestScoped.shutdown();
  });

  it("reports only hashed model identities when a scoped runtime cannot find its owner", async () => {
    const owner = new LocalTransformersEmbeddingProvider({
      model: "fixture/shared-openclaw-e5-diagnostic-owner",
      revision: "immutable-revision",
      dimensions: 1,
      cacheDir: "/private/owner/cache",
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      sharedModelOwner: true,
    });
    await owner.activateSharedModelOwner();
    const borrower = new LocalTransformersEmbeddingProvider({
      model: "fixture/shared-openclaw-e5-diagnostic-borrower",
      revision: "immutable-revision",
      dimensions: 1,
      cacheDir: "/private/borrower/cache",
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      sharedModelRequireOwner: true,
    });

    await assert.rejects(
      borrower.embed("diagnostic mismatch"),
      (error) => {
        assert.equal(error?.code, "shared_local_model_owner_unavailable");
        assert.match(error.message, /requested=[a-f0-9]{16}/);
        assert.match(error.message, /activeOwners=[a-f0-9]{16}/);
        assert.doesNotMatch(error.message, /private|diagnostic-owner|diagnostic-borrower/);
        assert.match(error.requestedIdentityDigest, /^[a-f0-9]{16}$/);
        assert.equal(error.activeOwnerIdentityDigests.length, 1);
        assert.notEqual(error.requestedIdentityDigest, error.activeOwnerIdentityDigests[0]);
        return true;
      },
    );
    await borrower.shutdown();
    await owner.shutdown();
  });

  it("poisons a shared owner epoch when pipeline disposal fails", async () => {
    let pipelineLoads = 0;
    const loadTransformers = async () => ({
      async pipeline() {
        pipelineLoads += 1;
        return Object.assign(async () => ({ data: Float32Array.of(1) }), {
          async dispose() { throw new Error("fixture disposal failed"); },
        });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5-poison",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const owner = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    await owner.activateSharedModelOwner();
    const borrower = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });
    await borrower.embed("load poisoned fixture");
    await assert.rejects(owner.shutdown(), /fixture disposal failed/);

    const successor = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    await assert.rejects(
      successor.activateSharedModelOwner(),
      (error) => error?.code === "shared_local_model_cleanup_failed",
    );
    assert.equal(pipelineLoads, 1, "a failed disposal must not allow a second allocation");
    await assert.rejects(borrower.embed("stale borrower"), /shared local model.*closed/i);
    await successor.shutdown();
    await borrower.shutdown();
  });

  it("rejects incompatible process-global pool state with an explicit ABI diagnostic", async () => {
    const poolSymbol = Symbol.for("@cyb3rb1ade/plur1bus-memory/shared-local-transformers-model-pool");
    const previous = globalThis[poolSymbol];
    globalThis[poolSymbol] = { abiVersion: 999, entries: new Map() };
    try {
      const lease = createSharedLocalModelLease({ key: "fixture/abi-drift", owner: true });
      await assert.rejects(
        lease.activate(),
        (error) => error?.code === "shared_local_model_pool_abi_mismatch",
      );
    } finally {
      if (previous === undefined) delete globalThis[poolSymbol];
      else globalThis[poolSymbol] = previous;
    }
  });

  it("lets the activated full runtime own a pipeline loaded first by a scoped borrower", async () => {
    let pipelineLoads = 0;
    let pipelineDisposals = 0;
    const loadTransformers = async () => ({
      async pipeline() {
        pipelineLoads += 1;
        return Object.assign(async () => ({ data: Float32Array.of(1) }), {
          async dispose() { pipelineDisposals += 1; },
        });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5-borrower-first",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const full = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    const requestScoped = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: false });

    await full.activateSharedModelOwner();
    assert.deepEqual(await requestScoped.embed("borrower loads first"), [1]);
    assert.equal(pipelineLoads, 1);
    await full.shutdown();
    assert.equal(pipelineDisposals, 1, "active full-runtime shutdown owns scoped-first disposal");
    await assert.rejects(requestScoped.embed("stale borrower"), /shared local model.*closed/i);
    await requestScoped.shutdown();
  });

  it("does not let an activation-managed full provider self-activate through inference", async () => {
    let pipelineLoads = 0;
    const owner = new LocalTransformersEmbeddingProvider({
      model: "fixture/shared-openclaw-e5-service-gate",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      sharedModelOwner: true,
      sharedModelActivationManaged: true,
      loadTransformers: async () => ({
        async pipeline() {
          pipelineLoads += 1;
          return Object.assign(async () => ({ data: Float32Array.of(1) }), { async dispose() {} });
        },
      }),
    });

    await assert.rejects(owner.embed("before service start"), /owner is not activated/i);
    assert.equal(pipelineLoads, 0);
    await owner.activateSharedModelOwner();
    assert.deepEqual(await owner.embed("after service start"), [1]);
    assert.equal(pipelineLoads, 1);
    await owner.shutdown();
  });

  it("invalidates an idle scoped borrower when its activated owner epoch closes", async () => {
    let pipelineLoads = 0;
    const loadTransformers = async () => ({
      async pipeline() {
        pipelineLoads += 1;
        return Object.assign(async () => ({ data: Float32Array.of(1) }), { async dispose() {} });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5-idle-borrower",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const owner = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    await owner.activateSharedModelOwner();
    const idleBorrower = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });

    await owner.embed("owner load");
    await owner.shutdown();
    const successor = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    await successor.activateSharedModelOwner();
    await assert.rejects(idleBorrower.embed("after successor activation"), /shared local model.*closed/i);
    const successorBorrower = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });
    await successorBorrower.embed("fresh successor borrower");
    assert.equal(pipelineLoads, 2, "only a fresh borrower may allocate in the successor epoch");
    await idleBorrower.shutdown();
    await successorBorrower.shutdown();
    await successor.shutdown();
  });

  it("keeps a successor owner behind an over-budget scoped operation until cleanup completes", async () => {
    let signalBorrower;
    let releaseBorrower;
    const borrowerStarted = new Promise((resolve) => { signalBorrower = resolve; });
    const borrowerGate = new Promise((resolve) => { releaseBorrower = resolve; });
    let calls = 0;
    const loadTransformers = async () => ({
      async pipeline() {
        return Object.assign(async () => {
          calls += 1;
          if (calls === 2) {
            signalBorrower();
            await borrowerGate;
          }
          return { data: Float32Array.of(1) };
        }, { async dispose() {} });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5-replacement-timeout",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const owner = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    await owner.activateSharedModelOwner();
    const borrower = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });
    const successor = new LocalTransformersEmbeddingProvider({ ...common, sharedModelOwner: true });
    await owner.embed("warm owner");
    const inference = borrower.embed("long scoped inference");
    await borrowerStarted;
    const cleanup = owner.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    const closingEpochBorrower = new LocalTransformersEmbeddingProvider({
      ...common,
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });
    const successorStart = successor.activateSharedModelOwner();
    const outcome = await Promise.race([
      Promise.all([cleanup, successorStart]).then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("deadline"), 10)),
    ]);
    assert.equal(outcome, "deadline", "replacement remains blocked after the host stop budget expires");

    releaseBorrower();
    await Promise.all([inference, cleanup, successorStart]);
    await assert.rejects(
      closingEpochBorrower.embed("must not cross into successor"),
      /no activated full-runtime owner|shared local model.*closed/i,
    );
    await successor.shutdown();
    await closingEpochBorrower.shutdown();
    await borrower.shutdown();
  });

  it("shares equivalent lexical cache paths under one exact model identity", async () => {
    let pipelineLoads = 0;
    const loadTransformers = async () => ({
      env: {},
      async pipeline() {
        pipelineLoads += 1;
        return Object.assign(async () => ({ data: Float32Array.of(1) }), { async dispose() {} });
      },
    });
    const common = {
      model: "fixture/shared-openclaw-e5-canonical-path",
      revision: "immutable-revision",
      dimensions: 1,
      embeddingCacheEnabled: false,
      sharedModelPool: true,
      loadTransformers,
    };
    const owner = new LocalTransformersEmbeddingProvider({
      ...common,
      cacheDir: "/tmp/plur1bus-model-cache/../plur1bus-model-cache",
      sharedModelOwner: true,
    });
    await owner.activateSharedModelOwner();
    const borrower = new LocalTransformersEmbeddingProvider({
      ...common,
      cacheDir: "/tmp/plur1bus-model-cache",
      sharedModelOwner: false,
      sharedModelRequireOwner: true,
    });
    await Promise.all([owner.embed("owner"), borrower.embed("borrower")]);
    assert.equal(pipelineLoads, 1);
    await borrower.shutdown();
    await owner.shutdown();
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
