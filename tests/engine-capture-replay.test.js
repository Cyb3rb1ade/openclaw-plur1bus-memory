/**
 * tests/engine-capture-replay.test.js — E4 Task 5 (Q3): a journal replay of a
 * turn the engine already captured is recognised at the turn level, before
 * the capture pipeline runs. It answers `duplicate-turn`, makes no
 * capture-summary LLM call, stores no second row and does not advance the
 * meta-reflection session counter — across an engine restart too. A capture
 * that did not complete is not recorded, so its replay is captured.
 *
 * The embedder is the E1 tests' test-internals seam
 * (`createEngine(host, config, { internals: { embeddings } })`), here a
 * deterministic text-hash embedder: equal texts give equal vectors, different
 * texts give (practically) orthogonal ones.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const AGENT = "agent-a";
const T = "The staging database host for the replay test is called orca-staging-7.";
const U = "The backup window for the replay test cluster opens at 02:30 UTC.";

const config = (baseDbPath, extra = {}) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  metaCognition: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  duplicateThreshold: 0.95,
  ...extra,
});

function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 384 dims, v[i] = ±1 from bit (i % 24) of the text hash, normalised. */
function hashVector(text) {
  const h = textHash(String(text));
  const scale = 1 / Math.sqrt(384);
  return Array.from({ length: 384 }, (_, i) => (((h >>> (i % 24)) & 1) ? scale : -scale));
}

/** `down = true` makes every capture-side embed call throw (embedder down);
 *  `holdBatch = true` parks the next embedBatch until `release()`. */
function hashEmbedder() {
  const stub = {
    down: false,
    holdBatch: false,
    release: null,
    onHeld: null,
    embed: async (text) => { gate(); return hashVector(text); },
    embedQuery: async (text) => hashVector(text),
    embedPassage: async (text) => hashVector(text),
    embedBatch: async (texts) => {
      gate();
      if (stub.holdBatch) await new Promise((resolve) => { stub.release = resolve; stub.onHeld?.(); });
      return texts.map(hashVector);
    },
    shutdown: async () => {},
  };
  const gate = () => {
    if (stub.down) throw new Error("embedder unavailable (synthetic)");
  };
  return stub;
}

function stubHost(stateDir, warned, llm) {
  return createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    ...(llm ? { runtime: { llm } } : {}),
    logger: { info() {}, warn: (m) => warned.push(String(m)), error: (m) => warned.push(String(m)), debug() {} },
  });
}

const principal = { agentId: AGENT, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
const userAgent = { origin: "user", background: false };

const turn = ({ runId, text }) => ({
  agentId: AGENT,
  principal,
  agent: userAgent,
  runId,
  messages: [{ role: "user", content: text }],
  sessionKey: `agent:${AGENT}:main`,
  incognito: false,
  signal: new AbortController().signal,
});

function setup({ extra = {}, embeddings = hashEmbedder(), llm, dirs, internals = {} } = {}) {
  const warned = [];
  const stateDir = dirs?.stateDir ?? makeTempDir("e4-replay-state-");
  const baseDbPath = dirs?.baseDbPath ?? join(makeTempDir("e4-replay-root-"), "lancedb-namespaced");
  const engine = createEngine(stubHost(stateDir, warned, llm), config(baseDbPath, extra), { internals: { embeddings, ...internals } });
  return { engine, warned, stateDir, baseDbPath, embeddings };
}

const cardsWithText = async (engine, text) => (await engine.memory.list({ since: 0, limit: 100 }, principal, userAgent))
  .items.filter((card) => card.text === text);

const DUPLICATE = { stored: 0, skipped: 1, reason: "duplicate-turn" };

/** Keys persisted in the replay guard's agent file (empty when it does not exist yet). */
function guardKeys(baseDbPath) {
  try {
    return JSON.parse(readFileSync(join(baseDbPath, "_capture-turns", `${AGENT}.json`), "utf8")).entries.map((e) => e.key);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** Resolves with `value` after `ms`, so a hung promise fails an assertion instead of the test timeout. */
const within = (promise, ms, value) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(value), ms))]);

describe("Engine.capture replay guard (E4 Task 5, Q3)", () => {
  it("replaying the same turn is a duplicate-turn and does not advance the meta-reflection counter", async () => {
    const { engine } = setup({ extra: { metaCognition: { enabled: true, sessionThreshold: 50 } } });
    try {
      const first = await engine.capture(turn({ runId: "r1", text: T })).done;
      assert.ok(first.stored >= 1, `first capture stored (${JSON.stringify(first)})`);
      const count = internalsOf(engine).captureContext.metaReflectionState.sessionCount;
      assert.ok(count >= 1, "the first capture counted a session");

      const replay = await engine.capture(turn({ runId: "r1", text: T })).done;
      assert.deepEqual(replay, DUPLICATE);
      assert.equal(internalsOf(engine).captureContext.metaReflectionState.sessionCount, count);
      assert.equal((await cardsWithText(engine, T)).length, 1);
      assert.equal((await engine.jobs.history(AGENT)).filter((r) => r.llmSession).length, 0);
    } finally {
      await engine.close();
    }
  });

  it("a different runId with the same text is not a duplicate-turn", async () => {
    const { engine } = setup();
    try {
      const first = await engine.capture(turn({ runId: "r1", text: T })).done;
      assert.ok(first.stored >= 1, `first capture stored (${JSON.stringify(first)})`);
      // A new turn: the guard lets it through and the vector dedup keeps the
      // store at one row.
      const other = await engine.capture(turn({ runId: "r2", text: T })).done;
      assert.notEqual(other.reason, "duplicate-turn");
      assert.equal(other.stored, 0);
      assert.equal((await cardsWithText(engine, T)).length, 1);
    } finally {
      await engine.close();
    }
  });

  it("a replay makes no capture-summary LLM call", async () => {
    const purposes = [];
    let n = 0;
    const llm = {
      async complete(params) {
        purposes.push(params?.purpose);
        n++;
        return { text: `Summary variant ${n}: the replay test host is orca-${n}.`, provider: "stub", model: "stub", usage: {} };
      },
    };
    const { engine } = setup({ extra: { merging: { enabled: true }, captureMaxChars: 100, emotion: { t3: { enabled: false } } }, llm });
    try {
      const long = `${"The replay test cluster keeps its nightly backups on the orca volume. ".repeat(10)}`.slice(0, 700);
      assert.equal(long.length, 700);
      const first = await engine.capture(turn({ runId: "r-long", text: long })).done;
      assert.ok(first.stored >= 1, `first capture stored (${JSON.stringify(first)})`);
      const summaryCalls = () => purposes.filter((p) => p === "capture-summary").length;
      assert.equal(summaryCalls(), 1);

      const replay = await engine.capture(turn({ runId: "r-long", text: long })).done;
      assert.equal(replay.reason, "duplicate-turn");
      assert.equal(summaryCalls(), 1, "the replay made no second capture-summary call");
    } finally {
      await engine.close();
    }
  });

  it("a replay survives an engine restart", async () => {
    const first = setup();
    const r1 = await first.engine.capture(turn({ runId: "r-restart", text: T })).done;
    assert.ok(r1.stored >= 1, `first capture stored (${JSON.stringify(r1)})`);
    await first.engine.close();

    const second = setup({ dirs: { stateDir: first.stateDir, baseDbPath: first.baseDbPath } });
    try {
      const replay = await second.engine.capture(turn({ runId: "r-restart", text: T })).done;
      assert.deepEqual(replay, DUPLICATE);
      // POSIX file-mode bits are not meaningful on Windows; the restart/replay
      // check itself still runs there.
      if (process.platform !== "win32") {
        const root = join(first.baseDbPath, "_capture-turns");
        assert.equal(statSync(root).mode & 0o777, 0o700);
        assert.equal(statSync(join(root, `${AGENT}.json`)).mode & 0o777, 0o600);
      }
    } finally {
      await second.engine.close();
    }
  });

  it("a failed capture is not recorded, so its replay is captured", async () => {
    const { engine, embeddings } = setup();
    try {
      embeddings.down = true;
      const failed = await engine.capture(turn({ runId: "r-fail", text: T })).done;
      assert.equal(typeof failed.reason, "string", `the failed capture has a reason (${JSON.stringify(failed)})`);
      assert.equal(failed.stored, 0);
      embeddings.down = false;
      const replay = await engine.capture(turn({ runId: "r-fail", text: T })).done;
      assert.ok(replay.stored >= 1, `the replay was captured (${JSON.stringify(replay)})`);
      assert.equal(replay.reason, undefined);
    } finally {
      await engine.close();
    }
  });

  it("an aborted capture is not recorded, so its replay is captured", async () => {
    const { engine } = setup();
    try {
      const handle = engine.capture(turn({ runId: "r-abort", text: U }));
      handle.abort("test");
      const aborted = await handle.done;
      assert.equal(typeof aborted.reason, "string", `the aborted capture has a reason (${JSON.stringify(aborted)})`);
      const replay = await engine.capture(turn({ runId: "r-abort", text: U })).done;
      assert.ok(replay.stored >= 1, `the replay was captured (${JSON.stringify(replay)})`);
    } finally {
      await engine.close();
    }
  });

  it("a capture aborted inside the pipeline is not recorded, so its replay is captured", async () => {
    const { engine, embeddings } = setup();
    try {
      embeddings.holdBatch = true;
      const held = new Promise((resolve) => { embeddings.onHeld = resolve; });
      const handle = engine.capture(turn({ runId: "r-abort-mid", text: U }));
      await held;
      embeddings.holdBatch = false;
      handle.abort("test");
      embeddings.release();
      const aborted = await handle.done;
      assert.equal(aborted.reason, "aborted", JSON.stringify(aborted));
      assert.equal(aborted.stored, 0);
      assert.equal((await cardsWithText(engine, U)).length, 0);
      const replay = await engine.capture(turn({ runId: "r-abort-mid", text: U })).done;
      assert.ok(replay.stored >= 1, `the replay was captured (${JSON.stringify(replay)})`);
      assert.equal(replay.reason, undefined);
    } finally {
      await engine.close();
    }
  });

  it("E4.1: the turn is recorded once its rows settled, before the post-store steps (a kill there does not re-store on replay)", async () => {
    // The speaker pipeline is the first post-store step; parking it stands in
    // for the ~300 ms window (speaker, meta-cognition, graph, neo drain) in
    // which the harness kill soak SIGKILLed the process.
    let releaseSpeaker;
    let enteredSpeaker;
    const entered = new Promise((resolve) => { enteredSpeaker = resolve; });
    const runSpeakerProposalPipeline = async () => {
      enteredSpeaker();
      await new Promise((resolve) => { releaseSpeaker = resolve; });
    };
    const { engine, baseDbPath } = setup({ internals: { runSpeakerProposalPipeline } });
    try {
      const t = turn({ runId: "journal:e41-hang", text: T });
      const { turnKeyOf } = await import("../engine/capture/turn-replay-guard.js");
      const handle = engine.capture(t);
      await entered;
      assert.equal((await cardsWithText(engine, T)).length, 1, "the row is stored before the post-store steps");
      assert.deepEqual(guardKeys(baseDbPath), [turnKeyOf(t)], "the key is persisted while the post-store steps still run");

      const replay = await within(engine.capture(turn({ runId: "journal:e41-hang", text: T })).done, 2_000, "replay hung behind the in-flight capture");
      assert.deepEqual(replay, DUPLICATE);
      assert.equal((await cardsWithText(engine, T)).length, 1, "no second row");

      releaseSpeaker();
      const first = await handle.done;
      assert.ok(first.stored >= 1 && first.reason === undefined, JSON.stringify(first));
      assert.deepEqual(guardKeys(baseDbPath), [turnKeyOf(t)]);
    } finally {
      releaseSpeaker?.();
      await engine.close();
    }
  });

  it("E4.1: a post-store step that throws leaves the turn recorded (post-store steps are best-effort)", async () => {
    const runSpeakerProposalPipeline = async () => { throw new Error("speaker pipeline failed (synthetic)"); };
    const { engine, baseDbPath } = setup({ internals: { runSpeakerProposalPipeline } });
    try {
      const t = turn({ runId: "journal:e41-throw", text: U });
      const { turnKeyOf } = await import("../engine/capture/turn-replay-guard.js");
      const first = await engine.capture(t).done;
      assert.ok(first.stored >= 1, JSON.stringify(first));
      assert.deepEqual(guardKeys(baseDbPath), [turnKeyOf(t)]);
      const replay = await engine.capture(turn({ runId: "journal:e41-throw", text: U })).done;
      assert.deepEqual(replay, DUPLICATE);
      assert.equal((await cardsWithText(engine, U)).length, 1);
    } finally {
      await engine.close();
    }
  });

  it("E4.1: a capture that fails before its rows settle is not recorded, so its replay is captured", async () => {
    let speakerCalls = 0;
    const runSpeakerProposalPipeline = async () => { speakerCalls++; };
    const { engine, embeddings, baseDbPath } = setup({ internals: { runSpeakerProposalPipeline } });
    try {
      embeddings.holdBatch = true;
      const held = new Promise((resolve) => { embeddings.onHeld = resolve; });
      const handle = engine.capture(turn({ runId: "journal:e41-fail", text: T }));
      await held;
      assert.deepEqual(guardKeys(baseDbPath), [], "nothing is recorded before the rows settle");
      embeddings.holdBatch = false;
      handle.abort("test");
      embeddings.release();
      const failed = await handle.done;
      assert.equal(failed.reason, "aborted", JSON.stringify(failed));
      assert.equal(speakerCalls, 0, "no post-store step ran");
      assert.deepEqual(guardKeys(baseDbPath), []);
      const replay = await engine.capture(turn({ runId: "journal:e41-fail", text: T })).done;
      assert.ok(replay.stored >= 1 && replay.reason === undefined, JSON.stringify(replay));
      assert.equal(guardKeys(baseDbPath).length, 1);
    } finally {
      await engine.close();
    }
  });

  it("concurrent identical turns capture once", async () => {
    const { engine } = setup();
    try {
      const results = await Promise.all([
        engine.capture(turn({ runId: "r3", text: U })).done,
        engine.capture(turn({ runId: "r3", text: U })).done,
      ]);
      const stored = results.filter((r) => r.stored >= 1 && r.reason === undefined);
      const duplicates = results.filter((r) => r.reason === "duplicate-turn");
      assert.equal(stored.length, 1, JSON.stringify(results));
      assert.equal(duplicates.length, 1, JSON.stringify(results));
      assert.deepEqual(duplicates[0], DUPLICATE);
      assert.equal((await cardsWithText(engine, U)).length, 1);
    } finally {
      await engine.close();
    }
  });
});

describe("createTurnReplayGuard (E4 Task 5, unit)", () => {
  const load = () => import("../engine/capture/turn-replay-guard.js");
  const done = (extra = {}) => async () => ({ stored: 1, skipped: 0, ...extra });

  it("turnKeyOf is the sha256 of agent, runId, sessionKey and the messages", async () => {
    const { turnKeyOf } = await load();
    const base = turn({ runId: "k1", text: T });
    assert.match(turnKeyOf(base), /^[0-9a-f]{64}$/);
    assert.equal(turnKeyOf(base), turnKeyOf(turn({ runId: "k1", text: T })));
    assert.notEqual(turnKeyOf(base), turnKeyOf(turn({ runId: "k2", text: T })));
    assert.notEqual(turnKeyOf(base), turnKeyOf(turn({ runId: "k1", text: U })));
    assert.notEqual(turnKeyOf(base), turnKeyOf({ ...base, sessionKey: "agent:agent-a:other" }));
    assert.equal(turnKeyOf({ ...base, runId: undefined }), turnKeyOf({ ...base, runId: null }));
  });

  it("a corrupt agent file is treated as empty with one warn line and rewritten valid", async () => {
    const { createTurnReplayGuard } = await load();
    const root = join(makeTempDir("e4-guard-corrupt-"), "_capture-turns");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${AGENT}.json`), "{");
    const warned = [];
    const guard = createTurnReplayGuard({ root, logger: { warn: (m) => warned.push(String(m)) } });
    let calls = 0;
    const fn = async () => { calls++; return { stored: 1, skipped: 0 }; };
    assert.deepEqual(await guard.run(AGENT, "k-a", fn), { stored: 1, skipped: 0 });
    assert.deepEqual(await guard.run(AGENT, "k-b", fn), { stored: 1, skipped: 0 });
    assert.equal(calls, 2);
    assert.equal(warned.length, 1, warned.join("\n"));
    const file = JSON.parse(readFileSync(join(root, `${AGENT}.json`), "utf8"));
    assert.equal(file.v, 1);
    assert.deepEqual(file.entries.map((e) => e.key), ["k-a", "k-b"]);
    assert.deepEqual(await guard.run(AGENT, "k-a", fn), DUPLICATE);
    assert.equal(calls, 2);
  });

  it("keeps the newest 512 entries and drops entries older than the TTL on the next write", async () => {
    const { createTurnReplayGuard, REPLAY_GUARD_MAX_ENTRIES, REPLAY_GUARD_TTL_MS } = await load();
    assert.equal(REPLAY_GUARD_MAX_ENTRIES, 512);
    assert.equal(REPLAY_GUARD_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    const root = join(makeTempDir("e4-guard-cap-"), "_capture-turns");
    let now = 1_000_000;
    const guard = createTurnReplayGuard({ root, clock: () => now, logger: { warn() {} } });
    for (let i = 0; i < 600; i++) {
      now++;
      await guard.run(AGENT, `k-${i}`, done());
    }
    const read = () => JSON.parse(readFileSync(join(root, `${AGENT}.json`), "utf8"));
    const capped = read();
    assert.equal(capped.entries.length, 512);
    assert.equal(capped.entries.at(-1).key, "k-599");
    assert.equal(capped.entries[0].key, "k-88");

    // Every entry is now older than the TTL except the one written next.
    now += REPLAY_GUARD_TTL_MS + 1;
    await guard.run(AGENT, "k-fresh", done());
    assert.deepEqual(read().entries.map((e) => e.key), ["k-fresh"]);
    // An expired key is no longer a duplicate.
    let ran = false;
    await guard.run(AGENT, "k-599", async () => { ran = true; return { stored: 0, skipped: 1 }; });
    assert.equal(ran, true);
  });

  it("a result with a reason is not recorded; a write failure is warned and the result returned", async () => {
    const { createTurnReplayGuard } = await load();
    const base = makeTempDir("e4-guard-fail-");
    const warned = [];
    const guard = createTurnReplayGuard({ root: join(base, "_capture-turns"), logger: { warn: (m) => warned.push(String(m)) } });
    let calls = 0;
    const failing = async () => { calls++; return { stored: 0, skipped: 1, reason: "aborted" }; };
    await guard.run(AGENT, "k-r", failing);
    await guard.run(AGENT, "k-r", failing);
    assert.equal(calls, 2);

    // A file where the root directory should be makes every write fail.
    const blocked = join(base, "blocked");
    writeFileSync(blocked, "x");
    const broken = createTurnReplayGuard({ root: blocked, logger: { warn: (m) => warned.push(String(m)) } });
    assert.deepEqual(await broken.run(AGENT, "k-w", done()), { stored: 1, skipped: 0 });
    assert.ok(warned.length >= 1);
  });

  it("E4.1: onRowsSettled records the key before fn resolves; a later reason does not unrecord it; a waiter sees duplicate-turn", async () => {
    const { createTurnReplayGuard } = await load();
    const root = join(makeTempDir("e4-guard-early-"), "_capture-turns");
    const guard = createTurnReplayGuard({ root, logger: { warn() {} } });
    const keys = () => {
      try { return JSON.parse(readFileSync(join(root, `${AGENT}.json`), "utf8")).entries.map((e) => e.key); } catch { return []; }
    };
    let release;
    let settledSeen;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = guard.run(AGENT, "k-early", async (onRowsSettled) => {
      onRowsSettled();
      onRowsSettled(); // idempotent
      settledSeen = keys();
      await gate;
      return { stored: 1, skipped: 0, reason: "aborted" };
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(settledSeen, ["k-early"], "persisted before fn resolved");
    // A fresh call is answered from the record at once; it does not wait.
    assert.deepEqual(await guard.run(AGENT, "k-early", async () => ({ stored: 1, skipped: 0 })), DUPLICATE);
    release();
    assert.deepEqual(await first, { stored: 1, skipped: 0, reason: "aborted" });
    assert.deepEqual(keys(), ["k-early"], "a reason after the rows settled keeps the turn recorded");

    // Not calling onRowsSettled and failing: not recorded.
    let calls = 0;
    const failing = async () => { calls++; return { stored: 0, skipped: 1, reason: "capture-failed" }; };
    await guard.run(AGENT, "k-late", failing);
    await guard.run(AGENT, "k-late", failing);
    assert.equal(calls, 2);
  });

  it("a waiter's own signal aborting while it waits on an identical in-flight capture resolves immediately as aborted (M4)", async () => {
    const { createTurnReplayGuard } = await load();
    const base = makeTempDir("e4-guard-abort-wait-");
    const guard = createTurnReplayGuard({ root: join(base, "_capture-turns"), logger: { warn() {} } });

    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const first = guard.run(AGENT, "k-abort", async () => { await firstGate; return { stored: 1, skipped: 0 }; });

    const controller = new AbortController();
    const waiterStart = Date.now();
    const waiter = guard.run(AGENT, "k-abort", async () => ({ stored: 1, skipped: 0 }), { signal: controller.signal });
    // Give the waiter a tick to actually start waiting on the in-flight capture.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    const waiterResult = await waiter;
    const waiterElapsedMs = Date.now() - waiterStart;
    assert.deepEqual(waiterResult, { stored: 0, skipped: 1, reason: "aborted" });
    // It did not wait out the whole in-flight capture (which only resolves
    // after `releaseFirst()`, well below): well under any real capture time.
    assert.ok(waiterElapsedMs < 1000, `waiter should not block on the in-flight capture, took ${waiterElapsedMs}ms`);

    // The in-flight capture itself is untouched by the waiter's own abort.
    releaseFirst();
    assert.deepEqual(await first, { stored: 1, skipped: 0 });

    // A waiter with no signal still behaves exactly as before (waits it out).
    let releaseSecond;
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    const second = guard.run(AGENT, "k-abort-2", async () => { await secondGate; return { stored: 1, skipped: 0 }; });
    const plainWaiter = guard.run(AGENT, "k-abort-2", async () => ({ stored: 1, skipped: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseSecond();
    assert.deepEqual(await second, { stored: 1, skipped: 0 });
    assert.deepEqual(await plainWaiter, { stored: 0, skipped: 1, reason: "duplicate-turn" });
  });
});
