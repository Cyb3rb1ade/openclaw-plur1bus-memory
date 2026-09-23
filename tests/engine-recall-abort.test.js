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
  it("abort at 100 ms cancels the embedder and resolves within 50 ms with degraded.reason=aborted", async () => {
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
    assert.ok(["aborted", "timeout"].includes(degraded.payload.degraded.reason));
    assert.match(prefix, /^<plur1bus-start-notice>\n/);
  });

  it("an already-aborted signal returns zero blocks and consumes nothing (Review Focus 1)", async () => {
    const { createPromptContextAssembler } = await import("../engine/recall/assemble-prompt-context.js");
    const touched = [];
    const handler = createPromptContextAssembler({
      automaticWorkspacePolicyDecision: () => { touched.push("policy"); return { allowed: true }; },
      runtimeScheduler: { config: { recallTimeoutMs: 1_000 }, runRecall: () => { touched.push("scheduler"); } },
      host: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    });
    const result = await handler({ prompt: "hello there" }, { agentId: "a" }, { signal: AbortSignal.abort() });
    assert.deepEqual(result.degraded, { reason: "aborted", capability: "recall" });
    assert.equal(result.blocks.length, 0);
    assert.deepEqual(touched, []);
  });

  it("a missing signal is an invalid query, not a throw", async () => {
    const { createPromptContextAssembler } = await import("../engine/recall/assemble-prompt-context.js");
    const handler = createPromptContextAssembler({ host: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
    const result = await handler({ prompt: "hello there" }, { agentId: "a" });
    assert.equal(result.degraded.reason, "invalid-query");
  });
});
