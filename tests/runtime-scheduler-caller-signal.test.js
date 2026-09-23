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

  it("behaves exactly as before when no signal is given", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    const result = await scheduler.runRecall({ cacheKey: "" }, async () => "value");
    assert.deepEqual(result, { ok: true, value: "value", background: false });
  });
});
