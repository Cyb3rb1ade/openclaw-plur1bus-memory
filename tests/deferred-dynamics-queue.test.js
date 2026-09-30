import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDeferredDynamicsQueue } from "../lib/deferred-dynamics-queue.js";
import { recordFeedbackBatch } from "../lib/feedback-log.js";
import { completePendingReplyOutcomes, recordPendingReplyOutcome } from "../lib/reply-outcome-tracking.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// 7.12.30: Reply-Outcome-Dynamik laeuft nicht mehr im Prompt-Hook.

function makeLogger() {
  const lines = { info: [], warn: [], debug: [] };
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), debug: (m) => lines.debug.push(m) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createDeferredDynamicsQueue", () => {
  it("runs jobs serially per agent only after kick, and logs slow runs", async () => {
    const logger = makeLogger();
    const queue = createDeferredDynamicsQueue({ logger, fallbackDelayMs: 0 === 1 ? 0 : 60_000, slowLogMs: 0 });
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    queue.enqueue("main", async () => { order.push("a:start"); await gate; order.push("a:end"); }, { entries: 3 });
    queue.enqueue("main", async () => { order.push("b"); }, { entries: 1 });
    queue.enqueue("bernhardine", async () => { order.push("c"); }, { entries: 2 });
    await sleep(20);
    assert.deepEqual(order, [], "nothing runs before kick or fallback");
    assert.equal(queue.pending("main"), 2);
    const kicked = queue.kick("main");
    await sleep(10);
    assert.deepEqual(order, ["a:start"], "second job waits for the first");
    release();
    await kicked;
    assert.deepEqual(order, ["a:start", "a:end", "b"]);
    assert.equal(queue.pending("main"), 0);
    assert.equal(queue.pending("bernhardine"), 1, "other agent untouched by main's kick");
    await queue.drain("bernhardine");
    assert.deepEqual(order, ["a:start", "a:end", "b", "c"]);
    assert.equal(logger.lines.info.filter((l) => l.includes("dynamics applied entries=3")).length, 1);
    queue.close();
  });

  it("starts by itself after the fallback delay and caps the backlog", async () => {
    const logger = makeLogger();
    const timers = [];
    const queue = createDeferredDynamicsQueue({
      logger, maxBacklog: 2, fallbackDelayMs: 5000,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
    });
    const ran = [];
    for (let i = 0; i < 4; i++) queue.enqueue("main", async () => { ran.push(i); }, { entries: 1 });
    assert.equal(queue.pending("main"), 2, "backlog capped at two waiting runs");
    assert.equal(logger.lines.warn.filter((l) => l.includes("backlog full")).length, 2);
    assert.equal(timers.length, 1, "one fallback timer per idle lane");
    assert.equal(timers[0].ms, 5000);
    timers[0].fn();
    await queue.drain("main");
    assert.deepEqual(ran, [2, 3], "the two newest runs survived");
    assert.deepEqual(queue.stats().main, { waiting: 0, running: false, dropped: 2 });
  });

  it("keeps going after a failing job and reports it", async () => {
    const logger = makeLogger();
    const queue = createDeferredDynamicsQueue({ logger, fallbackDelayMs: 0 });
    const ran = [];
    queue.enqueue("main", async () => { throw new Error("lancedb exploded"); }, { entries: 2 });
    queue.enqueue("main", async () => { ran.push("ok"); }, { entries: 1 });
    await queue.drain("main");
    assert.deepEqual(ran, ["ok"]);
    assert.ok(logger.lines.warn.some((l) => String(l).includes("reply-outcome.dynamics")));
    queue.close();
    assert.equal(queue.enqueue("main", async () => {}), false, "closed queue accepts nothing");
  });
});

// Every update() waits for `release()`. A call that waited for the DB work would therefore never settle, so
// "returns before the updates" is a fact about ordering, not about the host's wall clock (a 25/35 ms budget
// failed on windows-2025, where the synchronous feedback-log I/O alone took longer).
function gatedDb(updates) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release,
    async withDb(_agentId, fn) { return fn(this); },
    async getById(id) { return { id, memoryStrength: 1, retrievalCount: 0, lastRetrievedAt: 0, memoryClass: "working", halfLifeDays: 30 }; },
    async update(id, patch) { await gate; updates.push({ id, patch }); },
  };
}

// Settles with the call's value, or with NOT_SETTLED if it is still pending once the event loop has had `ms` to
// run it. Only reached as a failure: a call that does not wait for the gated DB settles within a few ticks.
const NOT_SETTLED = Symbol("not settled");
function settledWithin(promise, ms = 5_000) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(NOT_SETTLED), ms); })]).finally(() => clearTimeout(timer));
}

describe("recordFeedbackBatch with a dynamics scheduler", () => {
  it("returns synchronously and hands the DB work to the scheduler", async (t) => {
    const workspaceDir = makeTempDir("plur1bus-feedback-sched-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const updates = [];
    const scheduled = [];
    const db = gatedDb(updates);
    const result = recordFeedbackBatch(workspaceDir, [
      { query: "q", memoryId: "11111111-1111-4111-8111-111111111111", feedback: "positive", scoreComponents: {} },
      { query: "q", memoryId: "22222222-2222-4222-8222-222222222222", feedback: "negative", scoreComponents: {} },
      { query: "q", memoryId: "33333333-3333-4333-8333-333333333333", feedback: "neutral", scoreComponents: {} },
    ], { applyDynamics: true, dbPool: db, agentId: "main", dynamicsScheduler: (run, meta) => scheduled.push({ run, meta }) });
    assert.equal(result, undefined, "no DB wait inside the call: it returns synchronously, not a promise");
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].meta.entries, 2, "neutral feedback is not a dynamics entry");
    assert.equal(updates.length, 0);
    db.release();
    await scheduled[0].run();
    assert.deepEqual(updates.map((u) => u.id), ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("completePendingReplyOutcomes passes the scheduler through and no longer waits for updates", async (t) => {
    const workspaceDir = makeTempDir("plur1bus-outcome-sched-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const memoryIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    recordPendingReplyOutcome(workspaceDir, {
      agentId: "main", sessionKey: "s", userPrompt: "Wie war das Rezept?", assistantText: "Hier ist das Rezept.", memoryIds,
    });
    const updates = [];
    const queue = createDeferredDynamicsQueue({ logger: makeLogger(), fallbackDelayMs: 60_000 });
    t.after(() => queue.close());
    const db = gatedDb(updates);
    const completed = await settledWithin(completePendingReplyOutcomes(workspaceDir, {
      agentId: "main", sessionKey: "s", replyText: "Danke, genau so, das passt.",
      dbPool: db, applyDynamics: true,
      dynamicsScheduler: (run, meta) => queue.enqueue("main", run, meta),
    }));
    assert.notEqual(completed, NOT_SETTLED, "hook-side call returns before the (blocked) updates");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].feedback, "positive");
    assert.equal(updates.length, 0);
    assert.equal(queue.pending("main"), 1);
    db.release();
    await queue.kick("main");
    assert.deepEqual(updates.map((u) => u.id).sort(), memoryIds);
  });
});
