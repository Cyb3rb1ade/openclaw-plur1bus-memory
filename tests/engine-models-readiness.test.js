/**
 * tests/engine-models-readiness.test.js — E4 Task 3: embedder and reranker
 * readiness, Engine.models.warm() as the warm-up entry point.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  duplicateThreshold: 1.01,
});

function stubHost(stateDir, warned) {
  return createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const { mkdirSync } = await import("node:fs");
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    logger: { info() {}, warn: (m) => warned.push(String(m)), error: (m) => warned.push(String(m)), debug() {} },
  });
}

// 384-dim embedder stub, counts embedQuery calls, and a controllable return value.
function probeEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  let queryImpl = async () => vector();
  const calls = [];
  return {
    calls,
    setQueryImpl: (fn) => { queryImpl = fn; },
    embed: async () => vector(),
    embedQuery: async (text, opts) => { calls.push(text); return queryImpl(text, opts); },
    embedPassage: async () => vector(),
    embedBatch: async (texts) => texts.map(vector),
    shutdown: async () => {},
  };
}

// Reranker stub, counts rerank() calls, and a controllable return value.
function probeReranker() {
  const calls = [];
  let impl = async () => [{ index: 0, score: 0.9 }];
  return {
    calls,
    setImpl: (fn) => { impl = fn; },
    rerank: async (query, docs, topN) => { calls.push([query, docs, topN]); return impl(query, docs, topN); },
  };
}

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil() timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function setup(prefix, { reranker = probeReranker() } = {}) {
  const warned = [];
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const embeddings = probeEmbedder();
  const engine = createEngine(stubHost(stateDir, warned), config(baseDbPath), { internals: { embeddings, reranker } });
  return { engine, embeddings, reranker, warned };
}

describe("Engine.models readiness and warm-up (E4 Task 3)", () => {
  it("(a) models report loading before any probe and ready after warm", async () => {
    const { engine, embeddings, reranker } = await setup("e4-models-a-");
    const identity = engine.embedding.identities()[0];

    const before = engine.models.status();
    assert.deepEqual(before.embedder, { state: "loading", warming: false, checkedAt: null, identity });

    const status = await engine.models.warm();
    assert.equal(status.embedder.state, "ready");
    assert.equal(status.reranker.state, "ready");
    assert.equal(typeof status.embedder.checkedAt, "number");
    assert.equal(typeof status.reranker.checkedAt, "number");
    assert.equal(embeddings.calls.length, 1);
    assert.equal(reranker.calls.length, 1);

    await engine.models.warm();
    assert.equal(embeddings.calls.length, 1, "a second warm() made no new provider calls");
    assert.equal(reranker.calls.length, 1);

    await engine.models.warm({ refresh: true });
    assert.equal(embeddings.calls.length, 2, "refresh forced one more embedder call");
    assert.equal(reranker.calls.length, 2, "refresh forced one more reranker call");
    await engine.close();
  });

  it("(b) a disabled reranker reports disabled and is never probed", async () => {
    const { engine } = await setup("e4-models-b-", { reranker: null });
    const expected = { state: "disabled", warming: false, checkedAt: null, provider: null };
    assert.deepEqual(engine.models.status().reranker, expected);

    await engine.models.warm();
    assert.deepEqual(engine.models.status().reranker, expected);
    await engine.close();
  });

  it("(c) warming is visible while a probe runs and an abort leaves loading", async () => {
    const { engine, embeddings } = await setup("e4-models-c-");
    let release;
    const parked = new Promise((resolve) => { release = resolve; });
    embeddings.setQueryImpl(async () => {
      await parked;
      return Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    });

    // A ref'd timer standing in for AbortSignal.timeout(20): the same abort
    // semantics, but guaranteed to fire regardless of what else is (or isn't)
    // keeping the event loop busy at the moment — AbortSignal.timeout()'s own
    // internal timer is unref'd and can be skipped entirely when nothing else
    // is pending, which is exactly the situation this parked-embedder test sets up.
    const controller = new AbortController();
    const armed = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), 20);
    try {
      const w = engine.models.warm({ signal: controller.signal });
      // warm() is tracked (memoryOpsContext.track), which schedules the real
      // work one microtask after this call returns.
      await waitUntil(() => engine.models.status().embedder.warming === true, { timeoutMs: 200 });

      const result = await w;
      assert.equal(result.embedder.state, "loading", "an aborted wait leaves loading, not failed");

      release();
      await waitUntil(() => engine.models.status().embedder.state === "ready");
      const after = engine.models.status();
      assert.equal(after.embedder.state, "ready");
      assert.equal(after.embedder.warming, false);
    } finally {
      clearTimeout(armed);
    }
  });

  it("(d) a failing reranker does not fail the embedder", async () => {
    const { engine, reranker } = await setup("e4-models-d-");
    reranker.setImpl(async () => { throw new Error("boom sk-secret"); });

    const status = await engine.models.warm();
    assert.equal(status.reranker.state, "failed");
    assert.equal(status.reranker.error, "provider-failed");
    assert.equal(status.embedder.state, "ready");
    assert.ok(!JSON.stringify(status).includes("sk-secret"), "the raw provider error never reaches the status");

    reranker.setImpl(async () => [{ index: 7, score: 1 }]);
    const status2 = await engine.models.warm({ refresh: true });
    assert.equal(status2.reranker.state, "failed");
    assert.equal(status2.reranker.error, "invalid-result");
  });

  it("(d2) a relevance_score-shaped hit (both real reranker providers' shape) reports ready (E4-R1)", async () => {
    const { engine, reranker } = await setup("e4-models-d2-");
    reranker.setImpl(async () => [{ index: 0, relevance_score: 0.7 }]);
    const status = await engine.models.warm();
    assert.equal(status.reranker.state, "ready");
  });

  it("(d3) an empty rerank result is invalid-result, not ready", async () => {
    const { engine, reranker } = await setup("e4-models-d3-");
    reranker.setImpl(async () => []);
    const status = await engine.models.warm();
    assert.equal(status.reranker.state, "failed");
    assert.equal(status.reranker.error, "invalid-result");
  });

  it("(e) a failed refresh after a success reports failed", async () => {
    const { engine, embeddings } = await setup("e4-models-e-");
    const ok = await engine.models.warm();
    assert.equal(ok.embedder.state, "ready");

    embeddings.setQueryImpl(async () => { throw new Error("boom"); });
    const failed = await engine.models.warm({ refresh: true });
    assert.equal(failed.embedder.state, "failed");
    assert.equal(failed.embedder.error, "provider-failed");
  });

  it("(f) warm after close rejects storage; status still returns", async () => {
    const { engine } = await setup("e4-models-f-");
    await engine.close();

    await assert.rejects(() => engine.models.warm(), (error) => {
      assert.equal(error.name, "MemoryOpError");
      assert.equal(error.code, "storage");
      assert.equal(error.message, "engine is closed");
      return true;
    });
    const status = engine.models.status();
    assert.equal(status.embedder.state, "loading");
  });
});
