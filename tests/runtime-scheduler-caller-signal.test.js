/**
 * tests/runtime-scheduler-caller-signal.test.js — PR-05.
 *
 * The caller's AbortSignal joins the scheduler's own controller: an abort
 * cancels the job's signal and resolves runRecall promptly, and an already
 * aborted signal never takes a queue slot.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe("runRecall caller signal", () => {
  it("resolves within 50 ms of an abort at 100 ms and aborts the job signal", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: { recallTimeoutMs: 10_000 }, logger: quietLogger });
    let jobSignal = null;
    const started = Date.now();
    const result = await scheduler.runRecall({ cacheKey: "", signal: AbortSignal.timeout(100) }, (signal) => {
      jobSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(jobSignal.aborted, true);
    assert.ok(elapsed < 150, `resolved after ${elapsed} ms`);
  });

  it("never enqueues when the signal is already aborted", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    const before = scheduler.status().recall.queued;
    let called = false;
    const result = await scheduler.runRecall({ signal: AbortSignal.abort() }, async () => { called = true; });
    assert.deepEqual({ ok: result.ok, aborted: result.aborted, reason: result.reason }, { ok: false, aborted: true, reason: "aborted" });
    assert.equal(called, false);
    assert.equal(scheduler.status().recall.queued, before);
  });

  it("a late value from an aborted job never becomes the cached recall (final review I7)", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: { recallTimeoutMs: 10_000 }, logger: quietLogger });
    const controller = new AbortController();
    let finishLate = null;
    const pending = scheduler.runRecall({ cacheKey: "k", signal: controller.signal }, () => new Promise((resolve) => { finishLate = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("caller gave up"));
    const result = await pending;
    assert.equal(result.aborted, true);
    finishLate("late value");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(scheduler.status().recall.cacheSize, 0, "the late value was not cached");
  });

  it("behaves exactly as before when no signal is given", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    const result = await scheduler.runRecall({ cacheKey: "" }, async () => "value");
    assert.deepEqual(result, { ok: true, value: "value", background: false });
  });
});

describe("enqueueCapture caller signal (Task 13c)", () => {
  it("never enqueues when the signal is already aborted", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    let called = false;
    const result = await scheduler.enqueueCapture("a", { signal: AbortSignal.abort() }, async () => { called = true; });
    assert.deepEqual(result, { ok: false, aborted: true, reason: "aborted", background: false });
    assert.equal(called, false);
    assert.equal(scheduler.status().capture.queuedTotal, 0);
  });

  it("an abort after enqueueing reaches the job's signal", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    const controller = new AbortController();
    let jobSignal = null;
    const done = scheduler.enqueueCapture("a", { signal: controller.signal }, (signal) => {
      jobSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("caller gave up"));
    const result = await done;
    assert.equal(jobSignal.aborted, true);
    assert.equal(result.ok, false);
  });

  it("behaves exactly as before when no signal is given", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    assert.deepEqual(await scheduler.enqueueCapture("a", {}, async () => "value"), { ok: true, background: false });
  });
});
