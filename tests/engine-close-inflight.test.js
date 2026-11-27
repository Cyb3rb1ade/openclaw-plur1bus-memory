/**
 * tests/engine-close-inflight.test.js — E2 Task 3: Engine.close() drains
 * in-flight memory and admin operations, bounded by budgetMs, and refuses
 * operations that arrive after close() began.
 *
 * The hold seam is the E1 tests' test-internals embedder
 * (`createEngine(host, config, { internals: { embeddings } })`): `embed`
 * answers immediately until `holdNext` is set, then parks the call on a
 * deferred promise the test releases. `correct` embeds the new text inside
 * its store lease, so a held embed keeps a real memory write in flight.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
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

// Flat 384-dimension embedder with a hold switch on `embed`.
function holdableEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const flat = async () => vector();
  const held = [];
  let signalHeld = null;
  const stub = {
    holdNext: false,
    /** Resolves once an embed call is parked. */
    whenHeld: () => new Promise((resolve) => {
      if (held.length > 0) resolve();
      else signalHeld = resolve;
    }),
    /** Releases every parked embed call. */
    release: () => { for (const r of held.splice(0)) r(vector()); },
    embed: async () => {
      if (!stub.holdNext) return vector();
      return new Promise((resolve) => {
        held.push(resolve);
        signalHeld?.();
        signalHeld = null;
      });
    },
    embedQuery: flat,
    embedPassage: flat,
    embedBatch: async (texts) => texts.map(vector),
    shutdown: async () => {},
  };
  return stub;
}

function stubHost(stateDir, warned) {
  return createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    logger: { info() {}, warn: (m) => warned.push(String(m)), error: (m) => warned.push(String(m)), debug() {} },
  });
}

const principalFor = (agentId) => ({ agentId, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" });
const userAgent = { origin: "user", background: false };

async function setup(prefix) {
  const warned = [];
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const embeddings = holdableEmbedder();
  const engine = createEngine(stubHost(stateDir, warned), config(baseDbPath), { internals: { embeddings } });
  const agentId = "agent-close";
  const p = principalFor(agentId);
  const outcome = await engine.capture({
    agentId,
    principal: p,
    agent: userAgent,
    messages: [
      { role: "user", content: "The staging database host is called orca-staging." },
      { role: "assistant", content: "noted." },
    ],
    sessionKey: `agent:${agentId}:main`,
    incognito: false,
    signal: AbortSignal.timeout(8_000),
  }).done;
  assert.ok(outcome.stored >= 1, `capture stored a fact (${outcome.reason ?? outcome.stored})`);
  const listed = await engine.memory.list({ topic: "staging database" }, p, userAgent);
  assert.ok(listed.items.length >= 1);
  return { engine, embeddings, warned, p, id: listed.items[0].id };
}

// Settles to "pending" if `promise` has not settled within `ms`.
const stateAfter = (promise, ms) => Promise.race([
  promise.then(() => "resolved", () => "rejected"),
  new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
]);

describe("Engine.close() and in-flight operations (E2 Task 3)", () => {
  it("(a)+(c) close() waits for a memory write already in flight; the set is empty afterwards", async () => {
    const { engine, embeddings, p, id } = await setup("e2-close-a-");
    embeddings.holdNext = true;
    const op = engine.memory.correct(id, "changed", p, userAgent);
    const opOutcome = op.then((value) => ({ value }), (error) => ({ error }));
    // Close only once the write is parked inside its store lease.
    await embeddings.whenHeld();
    const ctx = internalsOf(engine).memoryOpsContext;
    assert.equal(ctx.activeOperations.size, 1, "the held write is tracked");

    let opSettledFirst = false;
    opOutcome.then(() => { opSettledFirst = true; });
    // The stores must not start shutting down under the running write:
    // memoryDbAdapter.shutdown() runs before the pool's own lease wait.
    const internals = internalsOf(engine);
    const realCloseResources = internals.closeResources;
    let resourcesClosedUnderWrite = null;
    internals.closeResources = async () => {
      resourcesClosedUnderWrite = (await stateAfter(op, 0)) === "pending";
      return realCloseResources();
    };
    const closed = engine.close({ budgetMs: 5_000 });
    let closedBeforeOp = null;
    closed.then(() => { closedBeforeOp ??= !opSettledFirst; });

    assert.equal(await stateAfter(closed, 100), "pending", "close() waits for the held write");
    assert.equal(await stateAfter(op, 0), "pending", "the held write is still running");

    embeddings.release();
    await closed;
    const settled = await opOutcome;
    assert.equal(closedBeforeOp, false, "the write settled before close() resolved");
    assert.equal(resourcesClosedUnderWrite, false, "resources were closed only after the write settled");
    if (settled.error) {
      assert.equal(settled.error.code, "storage");
      assert.equal(settled.error.message, "engine is closed");
    } else {
      assert.equal(typeof settled.value.id, "string", "the write completed");
    }
    // (c)
    assert.equal(ctx.activeOperations.size, 0);
  });

  it("(b) a write that never finishes does not hold close() past budgetMs", async () => {
    const { engine, embeddings, warned, p, id } = await setup("e2-close-b-");
    embeddings.holdNext = true;
    const op = engine.memory.correct(id, "changed", p, userAgent);
    const opDone = op.catch(() => {});
    await embeddings.whenHeld();

    const started = Date.now();
    await engine.close({ budgetMs: 300 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `close() resolved within ~1 s (${elapsed} ms)`);
    assert.ok(warned.some((m) => m.includes("close exceeded")), "the budget overrun was logged");

    // Cleanup: let the parked write and the background close finish.
    embeddings.release();
    await opDone;
    const ctx = internalsOf(engine).memoryOpsContext;
    assert.equal(ctx.activeOperations.size, 0);
  });

  it("(d) an operation started after close() rejects with storage at once", async () => {
    const { engine, embeddings, p, id } = await setup("e2-close-d-");
    embeddings.holdNext = true;
    const op = engine.memory.correct(id, "changed", p, userAgent);
    const opDone = op.catch(() => {});
    await embeddings.whenHeld();

    const closed = engine.close({ budgetMs: 5_000 });
    const started = Date.now();
    await assert.rejects(engine.memory.show(id, p, userAgent), (error) => error.code === "storage" && error.message === "engine is closed");
    await assert.rejects(engine.admin.migrate(1, 2), (error) => error.code === "storage");
    assert.ok(Date.now() - started < 1_000, "the late call did not wait for the in-flight write or the budget");
    assert.equal(internalsOf(engine).memoryOpsContext.activeOperations.size, 1, "a refused call is not tracked");

    embeddings.release();
    await opDone;
    await closed;
  });
});
