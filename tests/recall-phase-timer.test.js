import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRecallPhaseTimer } from "../lib/recall-phase-timer.js";

describe("recall-phase-timer", () => {
  it("tracks elapsed time and completed phases", async () => {
    const timer = createRecallPhaseTimer({ softBudgetMs: 100, hardTimeoutMs: 200 });
    timer.start("embedding");
    await new Promise((r) => setTimeout(r, 5));
    timer.end("embedding");
    timer.start("vector_search");
    timer.end("vector_search");

    assert.ok(timer.elapsedMs() >= 0);
    assert.strictEqual(timer.activePhase(), null);
    const summary = timer.summary();
    assert.strictEqual(summary.softBudgetMs, 100);
    assert.strictEqual(summary.hardTimeoutMs, 200);
    assert.ok(summary.exceededBudget === false || summary.exceededBudget === true);
    assert.strictEqual(summary.completed.length, 2);
    assert.strictEqual(summary.completed[0].phase, "embedding");
    assert.ok(summary.completed[0].ms >= 0);
  });

  it("detects soft budget exceedance", async () => {
    const timer = createRecallPhaseTimer({ softBudgetMs: 1, hardTimeoutMs: 100 });
    timer.start("embedding");
    await new Promise((r) => setTimeout(r, 5));
    timer.end("embedding");
    assert.strictEqual(timer.isSoftBudgetExceeded(), true);
    assert.strictEqual(timer.summary().exceededBudget, true);
  });

  it("bounds completed phase list", () => {
    const timer = createRecallPhaseTimer({});
    for (let i = 0; i < 40; i++) {
      timer.start(`phase-${i}`);
      timer.end(`phase-${i}`);
    }
    assert.strictEqual(timer.summary().completed.length, 32);
    assert.strictEqual(timer.summary().completed[0].phase, "phase-8");
  });

  it("does not retain payloads in fail()", () => {
    const logs = [];
    const timer = createRecallPhaseTimer({ logger: { warn: (m) => logs.push(m) } });
    const payload = { text: "secret memory content", vector: [1, 2, 3] };
    timer.fail("rerank", payload);
    const summary = timer.summary();
    assert.strictEqual(summary.completed.length, 0);
    assert.ok(!logs.some((m) => typeof m === "string" && m.includes("secret")));
  });

  it("retains the phase failure and returns a throwing logger as secondary evidence", () => {
    const loggerError = new Error("injected phase logger failure");
    const timer = createRecallPhaseTimer({
      logger: { warn() { throw loggerError; } },
    });

    const result = timer.fail("namespace-recall", new Error("original namespace timeout"));

    assert.deepEqual(result, { ok: false, error: loggerError });
    assert.equal(timer.summary().errors.length, 1);
    assert.equal(timer.summary().errors[0].phase, "namespace-recall");
    assert.match(timer.summary().errors[0].error, /original namespace timeout/);
  });

  it("returns the current active phase", () => {
    const timer = createRecallPhaseTimer({});
    timer.start("scoring");
    assert.strictEqual(timer.activePhase(), "scoring");
    timer.end("scoring");
    assert.strictEqual(timer.activePhase(), null);
  });
});
