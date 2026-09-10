/**
 * Regression: the Neo agent_end worker ran on the full capture signal. On the
 * first turn after an idle phase the store is cold and the worker needed 56 of
 * the 60 seconds (09.09.2026, bernhardine: "worker captured turns=221" at
 * 11:28:16), so the capture that followed was aborted 4 s later and stored
 * nothing. Two minutes on, warm, the same work took 1 s. The worker now gets a
 * sub-budget, so it can no longer spend the caller's whole window.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { deriveBudgetedSignal, isAbortError, isBudgetExhaustion } from "../lib/abort.js";

describe("deriveBudgetedSignal", () => {
  it("aborts on its own budget while the parent stays open", async () => {
    const parent = new AbortController();
    const derived = deriveBudgetedSignal(parent.signal, 20);
    await delay(60);
    assert.equal(derived.aborted, true, "sub-budget must fire");
    assert.equal(parent.signal.aborted, false, "caller keeps its window");
  });

  it("aborts when the parent aborts, before the budget runs out", () => {
    const parent = new AbortController();
    const derived = deriveBudgetedSignal(parent.signal, 60_000);
    parent.abort();
    assert.equal(derived.aborted, true);
  });

  it("returns a usable signal when there is no parent", () => {
    const derived = deriveBudgetedSignal(undefined, 50);
    assert.ok(derived instanceof AbortSignal);
    assert.equal(derived.aborted, false);
  });

  it("passes the parent through for a missing or nonsensical budget", () => {
    const parent = new AbortController();
    for (const budget of [0, -1, Number.NaN, undefined, null, "spät"]) {
      assert.equal(deriveBudgetedSignal(parent.signal, budget), parent.signal, `budget: ${String(budget)}`);
    }
    assert.equal(deriveBudgetedSignal(undefined, 0), undefined);
  });
});

describe("isBudgetExhaustion", () => {
  it("separates the sub-budget running out from the caller cancelling", () => {
    const open = new AbortController();
    const cancelled = new AbortController();
    cancelled.abort();
    const timeoutError = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });

    assert.equal(isBudgetExhaustion(timeoutError, open.signal), true);
    assert.equal(isBudgetExhaustion(abortError, open.signal), true);
    assert.equal(isBudgetExhaustion(abortError, cancelled.signal), false, "caller aborted: not a budget overrun");
  });

  it("ignores ordinary failures", () => {
    const open = new AbortController();
    assert.equal(isBudgetExhaustion(new Error("db down"), open.signal), false);
    assert.equal(isBudgetExhaustion(undefined, open.signal), false);
    assert.equal(isBudgetExhaustion("AbortError", open.signal), false);
  });
});

describe("isAbortError", () => {
  it("recognises the cancellation errors an aborted signal produces", () => {
    assert.equal(isAbortError(Object.assign(new Error("x"), { name: "AbortError" })), true);
    assert.equal(isAbortError(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
  });

  it("leaves real failures alone", () => {
    // Der Capture-Block unterscheidet daran, ob er "Budget alle, Rest folgt"
    // oder einen echten Fehler meldet. Ein zu weiter Treffer wuerde echte
    // Speicherfehler als harmlos ausgeben.
    assert.equal(isAbortError(new Error("db down")), false);
    assert.equal(isAbortError(undefined), false);
    assert.equal(isAbortError(null), false);
    assert.equal(isAbortError("AbortError"), false);
    assert.equal(isAbortError({ name: "SyntaxError" }), false);
  });
});
