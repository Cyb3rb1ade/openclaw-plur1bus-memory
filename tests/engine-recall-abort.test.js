/**
 * tests/engine-recall-abort.test.js — PR-05, spec success criterion 3.
 *
 * Drives the real before_prompt_build path through the golden driver with an
 * embedder that only settles when its signal aborts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const aborted = () => SCENARIOS.find((s) => s.name === "recall-aborted");

describe("recall abort", () => {
  it("abort at 100 ms cancels the embedder and resolves within 50 ms with degraded.reason=timeout (scheduler owns the budget, fix round 1)", async () => {
    const scenario = { ...aborted(), config: { ...aborted().config, runtime: { recallTimeoutMs: 100 } } };
    const events = [];
    const embedder = { calls: 0, abortedAt: null };
    let recallMs = null;
    const prefix = await runScenario(scenario, {
      hostEvents: { emit: (name, payload) => events.push({ name, payload }) },
      embedderProbe: embedder,
      onTiming: (t) => { recallMs = t.recallMs; },
    });
    assert.ok(embedder.calls >= 1, "the embedder was reached");
    assert.ok(embedder.abortedAt !== null, "the embedder saw its signal abort");
    assert.ok(recallMs < 150, `recall took ${recallMs} ms`);
    const degraded = events.find((e) => e.name === "recall.degraded");
    assert.ok(degraded, "recall.degraded emitted");
    // Fix round 1 (controller ruling): register-recall-hook's own signal now
    // carries a +250 ms margin over the scheduler's internal recallTimeoutMs,
    // specifically so the scheduler's own timer — not the host signal — wins
    // a genuine overrun like this one (an embedder that never settles on its
    // own). That is deterministic: pinned to "timeout", not "aborted". The
    // "aborted" outcome is exercised deterministically below and in
    // tests/runtime-scheduler-caller-signal.test.js (a caller signal that
    // fires strictly before the scheduler's own budget).
    assert.equal(degraded.payload.degraded.reason, "timeout");
    assert.match(prefix, /^<plur1bus-start-notice>\n/);
  });

  it("a later scheduler-reported abort maps to degraded.reason=aborted with zero blocks (deterministic, fix round 1)", async () => {
    const { createPromptContextAssembler } = await import("../engine/recall/assemble-prompt-context.js");
    const events = [];
    // Unlike the already-aborted case below, this exercises the *outer exit*
    // after `runtimeScheduler.runRecall` resolves — the exact shape a real
    // scheduler returns for a caller signal that aborts before its own
    // internal timeout (tests/runtime-scheduler-caller-signal.test.js pins
    // that shape at the scheduler layer). The callback is never invoked, so
    // this is deterministic regardless of any real timing race.
    const handler = createPromptContextAssembler({
      runtimeScheduler: {
        config: { recallTimeoutMs: 1_000 },
        runRecall: async () => ({ ok: false, aborted: true, reason: "aborted", background: false }),
      },
      host: {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        events: { emit: (name, payload) => events.push({ name, payload }) },
      },
    });
    const result = await handler({ prompt: "hello there" }, { agentId: "a" }, { signal: AbortSignal.timeout(1_000) });
    assert.deepEqual(result.degraded, { reason: "aborted", capability: "recall" });
    assert.equal(result.blocks.length, 0);
    const degraded = events.find((e) => e.name === "recall.degraded");
    assert.ok(degraded, "recall.degraded emitted");
    assert.deepEqual(degraded.payload.degraded, { reason: "aborted", capability: "recall" });
  });

  it("an already-aborted signal returns zero blocks and consumes nothing (Review Focus 1)", async () => {
    const { createPromptContextAssembler } = await import("../engine/recall/assemble-prompt-context.js");
    const touched = [];
    const events = [];
    const handler = createPromptContextAssembler({
      automaticWorkspacePolicyDecision: () => { touched.push("policy"); return { allowed: true }; },
      runtimeScheduler: { config: { recallTimeoutMs: 1_000 }, runRecall: () => { touched.push("scheduler"); } },
      host: {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        events: { emit: (name, payload) => events.push({ name, payload }) },
      },
    });
    const result = await handler({ prompt: "hello there" }, { agentId: "a" }, { signal: AbortSignal.abort() });
    assert.deepEqual(result.degraded, { reason: "aborted", capability: "recall" });
    assert.equal(result.blocks.length, 0);
    assert.deepEqual(touched, []);
    const degraded = events.find((e) => e.name === "recall.degraded");
    assert.ok(degraded, "recall.degraded emitted");
  });

  it("a missing signal is an invalid query, not a throw, and emits recall.degraded (fix round 1)", async () => {
    const { createPromptContextAssembler } = await import("../engine/recall/assemble-prompt-context.js");
    const events = [];
    const handler = createPromptContextAssembler({
      host: {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        events: { emit: (name, payload) => events.push({ name, payload }) },
      },
    });
    const result = await handler({ prompt: "hello there" }, { agentId: "a" });
    assert.equal(result.degraded.reason, "invalid-query");
    const degraded = events.find((e) => e.name === "recall.degraded");
    assert.ok(degraded, "recall.degraded emitted");
    assert.deepEqual(degraded.payload, { agentId: "a", degraded: result.degraded });
  });
});
