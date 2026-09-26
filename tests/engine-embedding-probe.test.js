/**
 * tests/engine-embedding-probe.test.js — E3 Task 3: EmbeddingService.probe()
 * exercises the provider, memoizes readiness, coalesces concurrent calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { join } from "node:path";
import { PROBE_TEXT_PREFIX, createEmbeddingProbe } from "../engine/providers/embedding-service.js";

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
  let queryImpl = async (_text) => vector();
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

async function setup(prefix) {
  const warned = [];
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const embeddings = probeEmbedder();
  const engine = createEngine(stubHost(stateDir, warned), config(baseDbPath), { internals: { embeddings } });
  return { engine, embeddings, warned };
}

describe("EmbeddingService.probe() (E3 Task 3)", () => {
  it("(a) exercises the provider, memoizes ok results, and refresh forces a new call", async () => {
    const { engine, embeddings } = await setup("e3-probe-a-");
    const identity = engine.embedding.identities()[0];

    const first = await engine.embedding.probe();
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.deepEqual(first.identity, identity);
    assert.ok(first.durationMs >= 0);
    assert.ok(embeddings.calls[0].startsWith(PROBE_TEXT_PREFIX));

    const second = await engine.embedding.probe();
    assert.equal(second.cached, true);
    assert.equal(second.checkedAt, first.checkedAt);
    assert.equal(embeddings.calls.length, 1, "second probe reused the memoized result");

    const third = await engine.embedding.probe({ refresh: true });
    assert.equal(third.cached, false);
    assert.equal(embeddings.calls.length, 2, "refresh forced a new provider call");
    assert.ok(embeddings.calls[1].startsWith(PROBE_TEXT_PREFIX));
    assert.notEqual(embeddings.calls[0], embeddings.calls[1], "probe texts differ between calls");
  });

  it("(b) concurrent probes coalesce into one provider call; an abort answers only that caller", async () => {
    const { engine, embeddings } = await setup("e3-probe-b-");
    let release;
    const parked = new Promise((resolve) => { release = resolve; });
    embeddings.setQueryImpl(async () => {
      await parked;
      return Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    });

    const a = engine.embedding.probe();
    const b = engine.embedding.probe({ signal: AbortSignal.abort() });

    const bResult = await b;
    assert.equal(bResult.ok, false);
    assert.equal(bResult.error, "aborted");
    assert.equal(bResult.cached, false);

    release();
    const aResult = await a;
    assert.equal(aResult.ok, true);
    assert.equal(embeddings.calls.length, 1, "the aborted caller did not trigger a second provider call");
  });

  it("(c) a provider failure is not memoized and never leaks its message; the next probe retries", async () => {
    const { engine, embeddings, warned } = await setup("e3-probe-c-");
    embeddings.setQueryImpl(async () => { throw new Error("boom sk-secret"); });

    const failed = await engine.embedding.probe();
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "provider-failed");
    assert.equal(failed.cached, false);
    assert.ok(!JSON.stringify(failed).includes("sk-secret"));
    assert.ok(warned.some((line) => line.includes("embedding.probe")), "a warn line was logged");

    embeddings.setQueryImpl(async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));
    const succeeded = await engine.embedding.probe();
    assert.equal(succeeded.ok, true, "failure was not memoized, so the next probe retries the provider");
  });

  it("(d) classifies a wrong-length or non-finite vector", async () => {
    const { engine: engineShort, embeddings: shortEmbeddings } = await setup("e3-probe-d1-");
    shortEmbeddings.setQueryImpl(async () => Array.from({ length: 383 }, () => 1));
    const mismatch = await engineShort.embedding.probe();
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error, "dimension-mismatch");

    const { engine: engineNaN, embeddings: nanEmbeddings } = await setup("e3-probe-d2-");
    nanEmbeddings.setQueryImpl(async () => Array.from({ length: 384 }, () => NaN));
    const invalid = await engineNaN.embedding.probe();
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, "invalid-vector");
  });

  it("(e) probe() rejects with MemoryOpError storage \"engine is closed\" after close()", async () => {
    const { engine } = await setup("e3-probe-e-");
    await engine.close();
    await assert.rejects(
      () => engine.embedding.probe(),
      (error) => {
        assert.equal(error.name, "MemoryOpError");
        assert.equal(error.code, "storage");
        assert.equal(error.message, "engine is closed");
        return true;
      },
    );
  });

  it("(f) refresh: true forces a new provider call even while another call is in flight", async () => {
    const { engine, embeddings } = await setup("e3-probe-f-");
    const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    let release;
    const parked = new Promise((resolve) => { release = resolve; });
    let parkedOnce = false;
    embeddings.setQueryImpl(async () => {
      if (!parkedOnce) { parkedOnce = true; await parked; }
      return vector();
    });

    const a = engine.embedding.probe();
    const b = engine.embedding.probe({ refresh: true });
    const c = engine.embedding.probe({ refresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(embeddings.calls.length, 1, "the refreshed call waits for the in-flight one to settle");

    release();
    const [aResult, bResult, cResult] = await Promise.all([a, b, c]);
    assert.equal(aResult.ok, true);
    assert.equal(bResult.ok, true);
    assert.equal(bResult.cached, false);
    assert.equal(embeddings.calls.length, 2, "refresh made its own provider call; queued refreshes share it");
    assert.equal(cResult, bResult, "two refreshes queued behind the same call share one new call");
    assert.notEqual(embeddings.calls[0], embeddings.calls[1]);
  });
});

describe("createEmbeddingProbe lastResult()/lastAttempt() (E3)", () => {
  const identity = Object.freeze({ fingerprintId: "fp", provider: "stub", model: "stub", dimensions: 2 });

  it("lastResult() keeps the last success; lastAttempt() tracks the last completed probe, never an abort", async () => {
    let impl = async () => [1, 0];
    let tick = 0;
    const probe = createEmbeddingProbe({
      getEmbeddings: () => ({ embedQuery: (text) => impl(text) }),
      getIdentity: () => identity,
      logger: { warn() {} },
      clock: () => ++tick,
    });
    assert.equal(probe.lastResult(), null);
    assert.equal(probe.lastAttempt(), null);

    const ok = await probe.probe();
    assert.equal(ok.ok, true);
    assert.deepEqual(probe.lastResult(), ok);
    assert.deepEqual(probe.lastAttempt(), ok);

    impl = async () => { throw new Error("down"); };
    const failed = await probe.probe({ refresh: true });
    assert.equal(failed.error, "provider-failed");
    assert.deepEqual(probe.lastResult(), ok, "a failure does not replace the last success");
    assert.deepEqual(probe.lastAttempt(), failed, "lastAttempt() reports the failure");

    let release;
    impl = () => new Promise((resolve) => { release = () => resolve([1, 0]); });
    const aborted = await probe.probe({ refresh: true, signal: AbortSignal.abort() });
    assert.equal(aborted.error, "aborted");
    assert.deepEqual(probe.lastAttempt(), failed, "an abort is not a completed attempt");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probe.lastAttempt().ok, true, "the shared call completed and is the last attempt");
    assert.equal(probe.lastResult(), probe.lastAttempt());
  });
});
