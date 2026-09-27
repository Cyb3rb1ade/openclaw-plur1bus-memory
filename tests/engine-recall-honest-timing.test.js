/**
 * tests/engine-recall-honest-timing.test.js — E5 Task 8: honest recall timing.
 *
 * `RecallResult.timing.totalMs` counts from `Engine.recall` entry: the
 * `entry`, `queue` and `prelude` phases head `timing.phases.completed`, and
 * the soft budget counts from the call (the OpenClaw hook path, which passes
 * no `startedAt`, counts from the assembler's timer, queue wait included).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createPromptContextAssembler } from "../engine/recall/assemble-prompt-context.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = (baseDbPath, overrides = {}) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000, maxConcurrentRecall: 1 },
  ...overrides,
});

const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// The first embedQuery call parks on a deferred (holding the only recall
// slot); every later call answers at once.
function parkingEmbedder() {
  const release = deferred();
  const firstCalled = deferred();
  let calls = 0;
  const embedQuery = async () => {
    calls += 1;
    if (calls === 1) {
      firstCalled.resolve();
      await release.promise;
    }
    return vector();
  };
  const embedder = { embed: embedQuery, embedQuery, embedPassage: async () => vector(), embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
  return { embedder, release: () => release.resolve(), firstCalled: firstCalled.promise };
}

function delayingEmbedder(ms) {
  const embedQuery = async () => { await new Promise((r) => setTimeout(r, ms)); return vector(); };
  return { embed: embedQuery, embedQuery, embedPassage: async () => vector(), embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

function newEngine(prefix, overrides, embeddings) {
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const workspaceDir = async (agentId) => {
    const dir = join(stateDir, "workspaces", agentId);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const host = createStubHost({ stateDir, workspaceDir, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  return { engine: createEngine(host, config(baseDbPath, overrides), { internals: { embeddings } }), workspaceDir };
}

const principal = { agentId: "agent-t8", workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "inferred" };
const agent = { origin: "user", background: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("honest recall timing (E5 Task 8)", () => {
  it("queue wait is a phase and inside totalMs", async () => {
    const parking = parkingEmbedder();
    const { engine } = newEngine("t8-b-", {}, parking.embedder);
    try {
      const first = engine.recall({ query: "first question about the garden", principal, agent, signal: new AbortController().signal });
      await parking.firstCalled;
      const wallStart = performance.now();
      const second = engine.recall({ query: "second question about the kitchen", principal, agent, signal: new AbortController().signal });
      await sleep(120);
      parking.release();
      const result = await second;
      const wall = performance.now() - wallStart;
      await first;
      const { timing } = result;
      assert.ok(timing, "the scheduled recall carries timing");
      const head = timing.phases.completed.slice(0, 3);
      assert.deepEqual(head.map((c) => c.phase), ["entry", "queue", "prelude"]);
      const queue = head[1];
      assert.ok(queue.ms >= 100, `queue ${queue.ms} ms`);
      assert.ok(timing.totalMs >= queue.ms);
      // Date.now() differences are whole milliseconds and never exceed the
      // ceiling of the true span, which the caller's wall clock encloses.
      assert.ok(timing.totalMs <= Math.ceil(wall), `totalMs ${timing.totalMs} > wall ${wall}`);
      assert.ok(timing.totalMs >= wall - 30, `totalMs ${timing.totalMs} < wall ${wall} - 30`);
    } finally {
      parking.release();
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("the neo prelude is a phase", async () => {
    const { engine } = newEngine("t8-c-", { neo: { enabled: true, recall: { global: { embedTimeoutMs: 1000 } } } }, delayingEmbedder(80));
    try {
      const result = await engine.recall({ query: "what did we decide about the roof", principal, agent, signal: new AbortController().signal });
      const prelude = result.timing.phases.completed.find((c) => c.phase === "prelude");
      assert.ok(prelude, "prelude phase recorded");
      assert.ok(prelude.ms >= 70, `prelude ${prelude.ms} ms`);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("the soft budget now counts the queue wait", async () => {
    const parking = parkingEmbedder();
    const { engine, workspaceDir } = newEngine("t8-d-", { recall: { softBudgetMs: 50 } }, parking.embedder);
    try {
      // The OpenClaw hook path: the assembler itself, no startedAt, no memoryCtx.
      const hook = createPromptContextAssembler(internalsOf(engine).recallContext);
      const first = engine.recall({ query: "first question about the garden", principal, agent, signal: new AbortController().signal });
      await parking.firstCalled;
      const wsDir = await workspaceDir(principal.agentId);
      const second = hook(
        { prompt: "second question about the kitchen", messages: [{ role: "user", content: "second question about the kitchen" }] },
        { agentId: principal.agentId, workspaceDir: wsDir, sessionKey: "agent:agent-t8:main" },
        { signal: new AbortController().signal },
      );
      await sleep(120);
      parking.release();
      const result = await second;
      await first;
      assert.notEqual(result, undefined);
      const { timing } = result;
      assert.equal(timing.phases.completed[0].phase, "queue");
      assert.ok(timing.phases.completed[0].ms >= 100, `queue ${timing.phases.completed[0].ms} ms`);
      assert.ok(!timing.phases.completed.some((c) => c.phase === "entry"), "no entry phase without startedAt");
      assert.equal(timing.phases.exceededBudget, true);
      // The pipeline took its soft-budget exit after the vector search: the
      // later phases never ran.
      const fine = timing.namespacePhases.map((c) => c.phase);
      assert.ok(fine.includes("vector_search"), `namespace phases: ${fine.join(",")}`);
      assert.ok(!fine.includes("finalize"), `namespace phases: ${fine.join(",")}`);
    } finally {
      parking.release();
      await engine.close({ budgetMs: 5_000 });
    }
  });
});
