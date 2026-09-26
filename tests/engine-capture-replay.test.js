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

function setup({ extra = {}, embeddings = hashEmbedder(), llm, dirs } = {}) {
  const warned = [];
  const stateDir = dirs?.stateDir ?? makeTempDir("e4-replay-state-");
  const baseDbPath = dirs?.baseDbPath ?? join(makeTempDir("e4-replay-root-"), "lancedb-namespaced");
  const engine = createEngine(stubHost(stateDir, warned, llm), config(baseDbPath, extra), { internals: { embeddings } });
  return { engine, warned, stateDir, baseDbPath, embeddings };
}

const cardsWithText = async (engine, text) => (await engine.memory.list({ since: 0, limit: 100 }, principal, userAgent))
  .items.filter((card) => card.text === text);

const DUPLICATE = { stored: 0, skipped: 1, reason: "duplicate-turn" };

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
});
