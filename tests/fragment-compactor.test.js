/**
 * tests/fragment-compactor.test.js — E5 Task 6: bounded LanceDB fragment
 * compaction between consolidate-daily runs (`runtime.lancedbCompaction`).
 *
 * (a)–(c), (f) are unit tests of createFragmentCompactor with injected
 * fragmentCount/optimize fakes. (d) and (e) run a real engine on a temp
 * LanceDB with the deterministic text-hash embedder of
 * tests/engine-capture-replay.test.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import {
  DEFAULT_LANCEDB_COMPACTION,
  createFragmentCompactor,
  resolveLancedbCompaction,
} from "../engine/store/fragment-compactor.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const quietLogger = () => {
  const log = { warn: [], debug: [] };
  return { log, logger: { info() {}, warn: (m) => log.warn.push(String(m)), debug: (m) => log.debug.push(String(m)) } };
};
const manualTimers = () => ({ setInterval: () => ({ unref() {} }), clearInterval() {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe("fragment compactor (unit)", () => {
  it("a check compacts only above the threshold", async () => {
    const counts = [10, 70, 3];
    const calls = [];
    const { logger } = quietLogger();
    const compactor = createFragmentCompactor({
      config: {},
      fragmentCount: async () => counts.shift() ?? null,
      optimize: async (agentId, opts) => { calls.push({ agentId, opts }); return { ok: true }; },
      keepVersionsHours: 24,
      logger,
      clock: () => NOW,
      timers: manualTimers(),
    });
    const first = await compactor.check("a");
    assert.equal(first.action, "skipped");
    assert.equal(first.reason, "below-threshold");
    assert.equal(first.fragmentsBefore, 10);
    assert.equal(calls.length, 0);

    const second = await compactor.check("a");
    assert.equal(second.action, "compacted");
    assert.equal(second.agentId, "a");
    assert.equal(second.fragmentsBefore, 70);
    assert.equal(second.fragmentsAfter, 3);
    assert.equal(typeof second.ms, "number");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentId, "a");
    assert.equal(calls[0].opts.timeoutMs, 60_000);
    assert.equal(calls[0].opts.maxAttempts, 3);
    assert.equal(calls[0].opts.retryDelayMs, 1_000);
    assert.ok(calls[0].opts.cleanupOlderThan instanceof Date);
    assert.equal(calls[0].opts.cleanupOlderThan.getTime(), NOW - 24 * 3_600_000);
    await compactor.close();
  });

  it("writes trigger a check every checkEveryWrites", async () => {
    const { logger } = quietLogger();
    const counted = [];
    const parked = deferred();
    const optimizeStarted = deferred();
    const compactor = createFragmentCompactor({
      config: { checkEveryWrites: 4, fragmentThreshold: 8 },
      fragmentCount: async (agentId) => { counted.push(agentId); return 100; },
      optimize: async (agentId) => {
        if (agentId === "a") { optimizeStarted.resolve(); await parked.promise; }
        return { ok: true };
      },
      keepVersionsHours: 24,
      logger,
      clock: () => NOW,
      timers: manualTimers(),
    });
    for (let i = 0; i < 3; i++) compactor.noteWrite("a");
    await tick();
    assert.equal(counted.length, 0, "three writes start no check");
    compactor.noteWrite("a");
    await optimizeStarted.promise;
    assert.deepEqual(counted, ["a"], "the fourth write starts one check");

    // A second check for "a" joins the one in flight.
    const joinA1 = compactor.check("a");
    const joinA2 = compactor.check("a");
    assert.equal(joinA1, joinA2, "concurrent checks for one agent share one promise");

    // "b" queues behind "a"'s parked optimize: its fragmentCount waits.
    const checkB = compactor.check("b");
    await tick();
    await tick();
    assert.deepEqual(counted, ["a"], "b's check does not start while a's optimize runs");
    parked.resolve();
    const [outA, outB] = await Promise.all([joinA1, checkB]);
    assert.equal(outA.action, "compacted");
    assert.equal(outB.action, "compacted");
    assert.equal(counted.indexOf("b") > counted.indexOf("a"), true);
    await compactor.close();
  });

  it("without stats the write count stands in", async () => {
    const { logger } = quietLogger();
    let optimized = 0;
    const compactor = createFragmentCompactor({
      config: { fragmentThreshold: 8, checkEveryWrites: 1_000 },
      fragmentCount: async () => null,
      optimize: async () => { optimized++; return { ok: true }; },
      keepVersionsHours: 24,
      logger,
      clock: () => NOW,
      timers: manualTimers(),
    });
    for (let i = 0; i < 8; i++) compactor.noteWrite("a");
    const first = await compactor.check("a");
    assert.equal(first.action, "compacted");
    assert.equal(first.fragmentsBefore, null);
    assert.equal(first.fragmentsAfter, null);
    for (let i = 0; i < 7; i++) compactor.noteWrite("a");
    const second = await compactor.check("a");
    assert.equal(second.action, "skipped");
    assert.equal(second.reason, "below-threshold");
    assert.equal(optimized, 1);
    await compactor.close();
  });

  it("a failure caused only by commit conflicts is logged at debug; other failures warn once", async () => {
    const { log, logger } = quietLogger();
    const outcomes = [
      { ok: false, reason: "Retryable commit conflict for version 7", conflict: true },
      { ok: false, reason: "disk full" },
      { ok: false, reason: "no-table" },
      { ok: false, reason: "busy", busy: true },
    ];
    const compactor = createFragmentCompactor({
      config: { fragmentThreshold: 8 },
      fragmentCount: async () => 50,
      optimize: async () => outcomes.shift(),
      keepVersionsHours: 24,
      logger,
      clock: () => NOW,
      timers: manualTimers(),
    });
    const conflict = await compactor.check("a");
    assert.equal(conflict.action, "failed");
    assert.match(conflict.reason, /commit conflict/);
    assert.equal(log.warn.length, 0);
    assert.equal(log.debug.length, 1);
    const hard = await compactor.check("a");
    assert.equal(hard.action, "failed");
    assert.equal(hard.reason, "disk full");
    assert.equal(log.warn.length, 1);
    const noTable = await compactor.check("a");
    assert.deepEqual([noTable.action, noTable.reason], ["skipped", "no-table"]);
    const busy = await compactor.check("a");
    assert.deepEqual([busy.action, busy.reason], ["skipped", "busy"]);
    assert.equal(log.warn.length, 1);
    await compactor.close();
  });

  it("resolveLancedbCompaction rejects out-of-range values", async () => {
    assert.deepEqual(resolveLancedbCompaction(undefined), DEFAULT_LANCEDB_COMPACTION);
    assert.deepEqual(DEFAULT_LANCEDB_COMPACTION, {
      enabled: true, fragmentThreshold: 64, checkEveryWrites: 16, checkIntervalMs: 600_000, timeoutMs: 60_000,
    });
    assert.ok(Object.isFrozen(DEFAULT_LANCEDB_COMPACTION));
    const bad = resolveLancedbCompaction({ fragmentThreshold: 2, checkIntervalMs: 5 });
    assert.equal(bad.fragmentThreshold, 64);
    assert.equal(bad.checkIntervalMs, 600_000);
    const good = resolveLancedbCompaction({ fragmentThreshold: 8, checkEveryWrites: 1, checkIntervalMs: 60_000, timeoutMs: 10_000 });
    assert.deepEqual(good, { enabled: true, fragmentThreshold: 8, checkEveryWrites: 1, checkIntervalMs: 60_000, timeoutMs: 10_000 });
    assert.equal(resolveLancedbCompaction({ fragmentThreshold: 8.5 }).fragmentThreshold, 64, "non-integers fall back");

    let counted = 0;
    let optimized = 0;
    let intervals = 0;
    const { logger } = quietLogger();
    const compactor = createFragmentCompactor({
      config: { enabled: false },
      fragmentCount: async () => { counted++; return 1_000; },
      optimize: async () => { optimized++; return { ok: true }; },
      keepVersionsHours: 24,
      logger,
      clock: () => NOW,
      timers: { setInterval: () => { intervals++; return { unref() {} }; }, clearInterval() {} },
    });
    const outcome = await compactor.check("a");
    assert.deepEqual([outcome.action, outcome.reason], ["skipped", "disabled"]);
    for (let i = 0; i < 100; i++) compactor.noteWrite("a");
    await tick();
    assert.equal(counted, 0);
    assert.equal(optimized, 0);
    assert.equal(intervals, 0, "a disabled compactor starts no timer");
    await compactor.close();
  });

  it("the interval timer checks every remembered agent and close() stops it", async () => {
    const { logger } = quietLogger();
    const counted = [];
    let intervalFn = null;
    let intervalMs = null;
    let cleared = 0;
    const compactor = createFragmentCompactor({
      config: { checkEveryWrites: 1_000 },
      fragmentCount: async (agentId) => { counted.push(agentId); return 1; },
      optimize: async () => ({ ok: true }),
      keepVersionsHours: 24,
      logger,
      clock: () => NOW,
      timers: {
        setInterval: (fn, ms) => { intervalFn = fn; intervalMs = ms; return { unref() {} }; },
        clearInterval: () => { cleared++; },
      },
    });
    assert.equal(intervalMs, 600_000);
    compactor.noteWrite("a");
    compactor.noteWrite("b");
    intervalFn();
    await tick();
    await tick();
    await tick();
    assert.deepEqual(counted, ["a", "b"]);
    await compactor.close();
    assert.equal(cleared, 1);
    const after = await compactor.check("a");
    assert.deepEqual([after.action, after.reason], ["skipped", "closed"]);
  });
});

describe("db-adapter support for the compactor", () => {
  const silent = () => {
    const log = { warn: [], debug: [] };
    return { log, logger: { info() {}, error() {}, warn: (m) => log.warn.push(String(m)), debug: (m) => log.debug.push(String(m)) } };
  };

  it("fragmentCount answers null unless numFragments is a finite number or bigint", async () => {
    const withStats = (stats) => createDbAdapter({ basePath: makeTempDir("e5-fc-count-"), getTable: async () => stats });
    assert.equal(await withStats({ stats: async () => ({ fragmentStats: { numFragments: 12 } }) }).fragmentCount("a"), 12);
    assert.equal(await withStats({ stats: async () => ({ fragmentStats: { numFragments: 5n } }) }).fragmentCount("a"), 5);
    assert.equal(await withStats({ stats: async () => ({ fragmentStats: { numFragments: "7" } }) }).fragmentCount("a"), null);
    assert.equal(await withStats({ stats: async () => ({ fragmentStats: {} }) }).fragmentCount("a"), null);
    assert.equal(await withStats({ stats: async () => ({ fragmentStats: { numFragments: Number.NaN } }) }).fragmentCount("a"), null);
    assert.equal(await withStats({ stats: async () => { throw new Error("stats broke"); } }).fragmentCount("a"), null);
    assert.equal(await withStats({}).fragmentCount("a"), null, "a build without stats()");
    assert.equal(await withStats(null).fragmentCount("a"), null, "no table");
  });

  it("one optimize per table path in the process: a second adapter waits, or skips with ifBusy", async () => {
    const basePath = makeTempDir("e5-fc-lock-");
    const parked = deferred();
    const started = deferred();
    const order = [];
    const table = (name) => ({
      optimize: async () => {
        order.push(`${name}:start`);
        if (name === "first") { started.resolve(); await parked.promise; }
        order.push(`${name}:end`);
        return {};
      },
    });
    const first = createDbAdapter({ basePath, getTable: async () => table("first"), logger: silent().logger });
    const second = createDbAdapter({ basePath, getTable: async () => table("second"), logger: silent().logger });
    const other = createDbAdapter({ basePath, getTable: async () => table("other"), logger: silent().logger });

    const running = first.optimizeTable("agent-x", { timeoutMs: 20_000 });
    await started.promise;
    const busy = await second.optimizeTable("agent-x", { timeoutMs: 20_000, ifBusy: "skip" });
    assert.deepEqual(busy, { ok: false, reason: "busy", busy: true });
    const otherAgent = await other.optimizeTable("agent-y", { timeoutMs: 20_000, ifBusy: "skip" });
    assert.equal(otherAgent.ok, true, "another table is not locked");
    const queued = second.optimizeTable("agent-x", { timeoutMs: 20_000 });
    await tick();
    assert.ok(!order.includes("second:start"), "the queued optimize waits for the running one");
    parked.resolve();
    assert.equal((await running).ok, true);
    assert.equal((await queued).ok, true);
    assert.ok(order.indexOf("second:start") > order.indexOf("first:end"), order.join(","));
    await tick();
    const free = await second.optimizeTable("agent-x", { timeoutMs: 20_000, ifBusy: "skip" });
    assert.equal(free.ok, true, "the lock is released afterwards");
  });

  it("a timed-out optimize holds the lock until LanceDB's optimize settles: two optimizes never overlap", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const basePath = makeTempDir("e5-fc-lock-timeout-");
    let active = 0;
    let maxActive = 0;
    const native = deferred();
    const starts = [];
    const table = (name) => ({
      optimize: async () => {
        starts.push(name);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (name === "first") await native.promise;
          return {};
        } finally {
          active--;
        }
      },
    });
    const first = createDbAdapter({ basePath, getTable: async () => table("first"), logger: silent().logger });
    const second = createDbAdapter({ basePath, getTable: async () => table("second"), logger: silent().logger });

    const running = first.optimizeTable("agent-x", { timeoutMs: 10_000 });
    const runningOutcome = running.then(() => null, (err) => err);
    await tick();
    assert.deepEqual(starts, ["first"]);
    const queued = second.optimizeTable("agent-x", { timeoutMs: 60_000 });
    await tick();

    t.mock.timers.tick(10_001);
    const timedOut = await runningOutcome;
    assert.equal(timedOut?.name, "TimeoutError", "the first optimize timed out");
    await tick();
    await tick();
    assert.deepEqual(starts, ["first"], "the queued optimize waits while LanceDB still runs the timed-out one");
    const skip = await second.optimizeTable("agent-x", { timeoutMs: 60_000, ifBusy: "skip" });
    assert.equal(skip.busy, true, "the lock is still held");

    native.resolve();
    const result = await queued;
    assert.equal(result.ok, true);
    assert.deepEqual(starts, ["first", "second"]);
    assert.equal(maxActive, 1, "two optimizes of one table never overlapped");
  });

  it("the lock is released after a throw and after a failed optimize", async () => {
    const basePath = makeTempDir("e5-fc-lock-throw-");
    const broken = createDbAdapter({ basePath, getTable: async () => { throw new Error("open broke"); }, logger: silent().logger });
    const failing = createDbAdapter({ basePath, getTable: async () => ({ optimize: async () => { throw new Error("disk full"); } }), logger: silent().logger });
    const healthy = createDbAdapter({ basePath, getTable: async () => ({ optimize: async () => ({}) }), logger: silent().logger });

    const thrown = broken.optimizeTable("agent-x", { timeoutMs: 20_000 });
    const afterThrow = healthy.optimizeTable("agent-x", { timeoutMs: 20_000 });
    await assert.rejects(thrown, /open broke/);
    assert.equal((await afterThrow).ok, true, "a waiter behind a throw runs");

    const failed = await failing.optimizeTable("agent-x", { timeoutMs: 20_000 });
    assert.equal(failed.ok, false);
    await tick();
    assert.equal((await healthy.optimizeTable("agent-x", { timeoutMs: 20_000, ifBusy: "skip" })).ok, true, "released after a failure");
  });

  it("a lock waiter's timeoutMs includes its wait (M1)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const basePath = makeTempDir("e5-fc-lock-wait-");
    const hold = deferred();
    let waiterRan = false;
    const holder = createDbAdapter({ basePath, getTable: async () => ({ optimize: async () => { await hold.promise; return {}; } }), logger: silent().logger });
    const waiter = createDbAdapter({ basePath, getTable: async () => ({ optimize: async () => { waiterRan = true; return {}; } }), logger: silent().logger });

    const held = holder.optimizeTable("agent-x", { timeoutMs: 600_000 });
    await tick();
    const gaveUp = waiter.optimizeTable("agent-x", { timeoutMs: 30_000 });
    await tick();
    t.mock.timers.tick(30_001);
    const outcome = await gaveUp;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.busy, true);
    assert.match(outcome.reason, /lock wait exceeded/);
    assert.equal(waiterRan, false);
    // The holder still owns the lock after the waiter gave up.
    assert.equal((await waiter.optimizeTable("agent-x", { timeoutMs: 30_000, ifBusy: "skip" })).busy, true);

    // A waiter left with less than one 10 s attempt after the wait gives up too.
    const late = waiter.optimizeTable("agent-x", { timeoutMs: 15_000 });
    await tick();
    t.mock.timers.tick(8_000);
    hold.resolve();
    assert.equal((await held).ok, true);
    const lateOutcome = await late;
    assert.equal(lateOutcome.busy, true);
    assert.equal(waiterRan, false);
  });

  it("after shutdown() the adapter starts no optimize and reads no stats (M2)", async () => {
    let optimized = 0;
    let statsRead = 0;
    const adapter = createDbAdapter({
      basePath: makeTempDir("e5-fc-shutdown-"),
      getTable: async () => ({ optimize: async () => { optimized++; return {}; }, stats: async () => { statsRead++; return { fragmentStats: { numFragments: 3 } }; } }),
      logger: silent().logger,
    });
    await adapter.shutdown();
    assert.deepEqual(await adapter.optimizeTable("a", { timeoutMs: 20_000 }), { ok: false, reason: "shutdown" });
    assert.equal(await adapter.fragmentCount("a"), null);
    assert.equal(optimized, 0);
    assert.equal(statsRead, 0);
  });

  it("fragmentCount's 5 s budget covers opening the table (M4)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const adapter = createDbAdapter({ basePath: makeTempDir("e5-fc-open-"), getTable: () => new Promise(() => {}), logger: silent().logger });
    const pending = adapter.fragmentCount("a");
    await tick();
    t.mock.timers.tick(5_001);
    assert.equal(await pending, null);
  });

  it("fragmentCount opens the table without column migrations and shutdown closes it (M3)", async () => {
    const lancedb = await import("@lancedb/lancedb");
    const basePath = makeTempDir("e5-fc-stats-");
    const db = await lancedb.connect(join(basePath, "agent-s"));
    await db.createTable("memories", [{ id: "row-1", text: "synthetic", createdAt: 1 }]);
    const adapter = createDbAdapter({ basePath, logger: silent().logger });
    const count = await adapter.fragmentCount("agent-s");
    assert.ok(count === null || count >= 1, `fragment count ${count}`);
    const fields = (await (await db.openTable("memories")).schema()).fields.map((f) => f.name);
    assert.deepEqual(fields.sort(), ["createdAt", "id", "text"], "no ensure*Columns migration ran");
    await adapter.shutdown();
    assert.equal(await adapter.fragmentCount("agent-s"), null);
    db.close?.();
  });

  it("quietConflicts logs a conflict-only failure at debug and marks it", async () => {
    const { log, logger } = silent();
    const received = [];
    const adapter = createDbAdapter({
      basePath: makeTempDir("e5-fc-conflict-"),
      getTable: async () => ({
        optimize: async (opts) => { received.push(opts); throw new Error("Retryable commit conflict: preempted by concurrent transaction Update. Please retry."); },
      }),
      logger,
    });
    const result = await adapter.optimizeTable("a", { timeoutMs: 20_000, maxAttempts: 2, retryDelayMs: 0, ifBusy: "skip", quietConflicts: true });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.deepEqual(log.warn, []);
    assert.equal(log.debug.length, 2, "one retry line and one failure line");
    assert.ok(received.every((opts) => !("ifBusy" in opts) && !("quietConflicts" in opts)), "wrapper options are not passed to LanceDB");

    const loud = silent();
    const plain = createDbAdapter({
      basePath: makeTempDir("e5-fc-conflict-"),
      getTable: async () => ({ optimize: async () => { throw new Error("disk full"); } }),
      logger: loud.logger,
    });
    const hard = await plain.optimizeTable("a", { timeoutMs: 20_000, quietConflicts: true });
    assert.equal(hard.conflict, undefined);
    assert.equal(loud.log.warn.length, 1, "a non-conflict failure still warns");
  });
});

// ── integration ───────────────────────────────────────────────────────────

const AGENT = "agent-a";

function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function hashVector(text) {
  const h = textHash(String(text));
  const scale = 1 / Math.sqrt(384);
  return Array.from({ length: 384 }, (_, i) => (((h >>> (i % 24)) & 1) ? scale : -scale));
}
const hashEmbedder = () => ({
  embed: async (text) => hashVector(text),
  embedQuery: async (text) => hashVector(text),
  embedPassage: async (text) => hashVector(text),
  embedBatch: async (texts) => texts.map(hashVector),
  shutdown: async () => {},
});

const engineConfig = (baseDbPath, lancedbCompaction) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  metaCognition: { enabled: false },
  runtime: { recallTimeoutMs: 10_000, lancedbCompaction },
  duplicateThreshold: 0.95,
});

function setupEngine(prefix, lancedbCompaction) {
  const warned = [];
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const host = createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    logger: { info() {}, warn: (m) => warned.push(String(m)), error: (m) => warned.push(String(m)), debug() {} },
  });
  const engine = createEngine(host, engineConfig(baseDbPath, lancedbCompaction), { internals: { embeddings: hashEmbedder() } });
  return { engine, warned };
}

const principal = { agentId: AGENT, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
const userAgent = { origin: "user", background: false };
const TOPICS = ["harbor", "glacier", "orchard", "lantern", "meadow", "quarry", "canyon", "tundra"];
const factText = (i) => `Synthetic fact ${i}: the ${TOPICS[i % TOPICS.length]} depot keeps crate number ${1000 + i * 37} on shelf ${i % 11}.`;
const turn = (i) => ({
  agentId: AGENT,
  principal,
  agent: userAgent,
  runId: `run-${i}`,
  messages: [{ role: "user", content: factText(i) }],
  sessionKey: `agent:${AGENT}:main`,
  incognito: false,
  signal: new AbortController().signal,
});
const capture = async (engine, i) => {
  const result = await engine.capture(turn(i)).done;
  assert.equal(result?.stored, 1, `capture ${i} stored one row (${JSON.stringify(result)})`);
  return result;
};

describe("fragment compactor (engine)", () => {
  it("compaction runs beside captures and recalls without losing rows", async (t) => {
    const { engine } = setupEngine("e5-compact-d-", { fragmentThreshold: 8, checkEveryWrites: 4 });
    try {
      for (let i = 0; i < 24; i++) await capture(engine, i);
      const compactor = internalsOf(engine).fragmentCompactor;
      const early = (await engine.memory.list({ since: 0, limit: 100 }, principal, userAgent)).items;
      assert.equal(early.length, 24);
      const victim = early.find((card) => card.text === factText(3));
      assert.ok(victim, "the card to forget exists");

      const work = [
        compactor.compactNow(AGENT),
        ...Array.from({ length: 8 }, (_, k) => capture(engine, 24 + k)),
        ...Array.from({ length: 8 }, (_, k) => engine.memory.list({ topic: TOPICS[k] }, principal, userAgent)),
        engine.memory.forget(victim.id, principal, userAgent),
      ];
      const settled = await Promise.allSettled(work);
      const rejected = settled.filter((s) => s.status === "rejected");
      assert.deepEqual(rejected.map((s) => String(s.reason?.stack || s.reason)), [], "nothing rejected");

      const live = (await engine.memory.list({ since: 0, limit: 100 }, principal, userAgent)).items;
      assert.equal(live.length, 31, "32 captures minus one forgotten card");
      assert.ok(!live.some((card) => card.id === victim.id));

      const final = await compactor.compactNow(AGENT);
      assert.notEqual(final.action, "failed", JSON.stringify(final));
      const count = await internalsOf(engine).memoryDbAdapter.fragmentCount(AGENT);
      if (count === null) {
        t.diagnostic("table.stats() unavailable: fragment-count assertion skipped");
      } else {
        assert.ok(count <= 8, `fragments after compaction: ${count}`);
      }
    } finally {
      await engine.close();
    }
  });

  it("close() stops compaction", async () => {
    const { engine } = setupEngine("e5-compact-e-", { fragmentThreshold: 8, checkEveryWrites: 4 });
    const internals = internalsOf(engine);
    // Capture notes each stored row with the compactor (read at call time).
    const noted = [];
    const realNoteWrite = internals.fragmentCompactor.noteWrite;
    internals.fragmentCompactor.noteWrite = (agentId) => { noted.push(agentId); realNoteWrite(agentId); };
    for (let i = 0; i < 2; i++) await capture(engine, i);
    assert.deepEqual(noted, [AGENT, AGENT], "every stored row is noted once");
    const adapter = internals.memoryDbAdapter;
    const realOptimize = adapter.optimizeTable;
    const parked = deferred();
    const started = deferred();
    let optimizeCalls = 0;
    adapter.optimizeTable = async (...args) => {
      optimizeCalls++;
      started.resolve();
      await parked.promise;
      return realOptimize(...args);
    };
    const compactor = internals.fragmentCompactor;
    const running = compactor.compactNow(AGENT);
    await started.promise;
    assert.equal(optimizeCalls, 1);

    // The closer's other steps must not queue behind the parked optimize (I2).
    let poolShutdown = false;
    let cacheClosed = false;
    const realPoolShutdown = internals.pool.shutdown.bind(internals.pool);
    internals.pool.shutdown = async (...args) => { poolShutdown = true; return realPoolShutdown(...args); };
    const realCacheClose = internals.llmResultCache.close.bind(internals.llmResultCache);
    internals.llmResultCache.close = async (...args) => { cacheClosed = true; return realCacheClose(...args); };

    const t0 = Date.now();
    await engine.close({ budgetMs: 2_000 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 4_000, `close() resolved near its 2 s budget (${elapsed} ms)`);
    assert.equal(poolShutdown, true, "the pool shut down while the optimize was still parked");
    assert.equal(cacheClosed, true, "the LLM result cache closed while the optimize was still parked");

    for (let i = 0; i < 100; i++) compactor.noteWrite(AGENT);
    await tick();
    const afterClose = await compactor.check(AGENT);
    assert.deepEqual([afterClose.action, afterClose.reason], ["skipped", "closed"]);
    assert.equal(optimizeCalls, 1, "no optimize starts after close()");

    // Cleanup: let the parked optimize and the background close finish.
    parked.resolve();
    await running;
    await internals.closeResources();
  });
});
