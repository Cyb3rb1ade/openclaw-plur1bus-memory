/**
 * tests/engine-assemble-prompt-context.test.js — PR-03d.
 *
 * The engine module must be constructible from a plain context object with no
 * OpenClaw api in it, and its refusal paths must stay refusals. Recall content
 * is covered byte for byte by tests/golden-prefix.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptContextAssembler } from "../engine/recall/assemble-prompt-context.js";
import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("engine/recall/assemble-prompt-context", () => {
  it("exports a factory", () => {
    assert.equal(typeof createPromptContextAssembler, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("keeps the six named blocks and the 17000-char default in one place", () => {
    const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
    for (const [name, droppable] of [["neo", true], ["start", true], ["memories", true], ["time", false], ["temporal", false], ["reminder", false]]) {
      assert.match(source, new RegExp(`contextBlock\\("${name}", [^\\n]+, ${droppable}\\)`), `block ${name} must keep droppable=${droppable}`);
    }
    assert.match(source, /capChars = cfg\.recall\?\.globalInjectMaxChars \?\? 17_000/);
  });

  it("refuses a turn the workspace policy declines, without touching the pool", async () => {
    // The context object is destructured eagerly by the factory (so every
    // binding the 1 067 moved lines close over resolves once, at registration
    // time), which is why "touching the pool" is measured at the first DB call
    // rather than at the property read.
    let poolTouched = false;
    const handler = createPromptContextAssembler({
      automaticWorkspacePolicyDecision: () => ({ allowed: false }),
      pool: { withDb: async () => { poolTouched = true; return undefined; } },
    });
    const result = await handler({ prompt: "x" }, { workspaceDir: "/tmp/ws", agentId: "a" });
    assert.equal(result.blocks.length, 0);
    assert.equal(poolTouched, false);
  });

  describe("recallTimingSink — Task 19 fix round (additive, observational only)", () => {
    it("is called exactly once per attempted recall with {agentId, phases, totalMs}, and never changes the returned prependContext", async () => {
      const scenario = SCENARIOS.find((s) => s.name === "recall-basic");
      const calls = [];
      const withSink = await runScenario(scenario, {
        freezeClock: false,
        recallTimingSink: (entry) => calls.push(entry),
      });
      const withoutSink = await runScenario(scenario, { freezeClock: false });

      assert.strictEqual(calls.length, 1, "sink must fire exactly once for one attempted recall");
      const [entry] = calls;
      assert.strictEqual(entry.agentId, scenario.ctx.agentId);
      assert.strictEqual(typeof entry.totalMs, "number");
      assert.ok(entry.totalMs >= 0);
      assert.ok(entry.phases && Array.isArray(entry.phases.completed), "phases must be a phaseTimer.summary()-shaped object");
      assert.ok(entry.phases.completed.some((c) => c.phase === "namespace-recall"), "attaching a sink also enables the namespace-phase fold (recordNamespacePhases), so completed must contain more than just the coarse phase");

      // The whole point of "additive, observational only": attaching a sink
      // must not change one byte of what the model would see.
      assert.strictEqual(withSink, withoutSink);
    });

    it("a throwing sink does not break the turn (caught and swallowed, not rethrown)", async () => {
      const scenario = SCENARIOS.find((s) => s.name === "recall-basic");
      const result = await runScenario(scenario, {
        freezeClock: false,
        recallTimingSink: () => { throw new Error("sink boom"); },
      });
      assert.strictEqual(typeof result, "string");
      assert.ok(result.length > 0);
    });
  });

  describe("recordNamespacePhases — tied 1:1 to recallTimingSink (Task 19 fix round 2/3)", () => {
    // `runMergedNamespaceRecall`'s per-namespace phase fold is gated on
    // `recordNamespacePhases`, which `assemble-prompt-context.js` sets to
    // `Boolean(recallTimingSink)` — so the two can never be observed
    // independently through the public hook: whenever a test can read the
    // outer timer's summary() at all (by attaching a sink), the fold has
    // necessarily already been enabled for that same call (proven by the
    // "namespace-recall" test above finding fine-grained phases present, not
    // just the coarse block). The one case worth asserting directly is the
    // production wiring itself: that recordNamespacePhases is *derived from*
    // recallTimingSink, not an independent flag someone could accidentally
    // default to `true`. Source assertions are this file's own established
    // pattern for exactly this kind of structural invariant (see "does not
    // mention the OpenClaw api surface" and "keeps the six named blocks..."
    // above).
    it("assemble-prompt-context.js derives recordNamespacePhases from Boolean(recallTimingSink), not an independent flag", () => {
      const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
      assert.match(source, /recordNamespacePhases:\s*Boolean\(recallTimingSink\)/);
    });

    it("index.js only ever supplies a real recallTimingSink through a test-only api property, so recordNamespacePhases is false for every real OpenClaw host", () => {
      const source = readFileSync(join(root, "index.js"), "utf8");
      assert.match(source, /recallTimingSink:\s*api\.__recallTimingSinkForTests\s*\?\?\s*null/);
    });
  });

  describe("recall.memoriesMaxChars (F2 — threads to truncateMemoryContext's maxTotalChars)", () => {
    it("a lowered recall.memoriesMaxChars shrinks the memories block", async () => {
      // globalInjectMaxChars is raised well past the inner cap so the outer
      // budget (applyGlobalInjectBudget) never binds here — only the inner
      // cap (truncateMemoryContext's maxTotalChars, fed by
      // recall.memoriesMaxChars) is under test.
      const base = SCENARIOS.find((s) => s.name === "recall-truncated");
      const withDefaultCap = {
        ...base,
        config: { recall: { ...base.config.recall, globalInjectMaxChars: 50_000 } },
      };
      const withLoweredCap = {
        ...base,
        config: { recall: { ...base.config.recall, globalInjectMaxChars: 50_000, memoriesMaxChars: 2_000 } },
      };
      const defaultOut = await runScenario(withDefaultCap);
      const loweredOut = await runScenario(withLoweredCap);

      assert.ok(loweredOut.length < defaultOut.length, "a smaller memoriesMaxChars must shrink the prependContext");
      const defaultRecords = (defaultOut.match(/<memory-record\b/g) || []).length;
      const loweredRecords = (loweredOut.match(/<memory-record\b/g) || []).length;
      assert.ok(loweredRecords < defaultRecords, "fewer records must survive the smaller inner cap");
      assert.match(loweredOut, /<!-- memory context truncated -->/);
    });

    it("fix round 1, item 3: a lowered memoriesMaxChars still produces well-formed XML (no half-open elements, wrappers closed)", async () => {
      const base = SCENARIOS.find((s) => s.name === "recall-truncated");
      const withLoweredCap = {
        ...base,
        config: { recall: { ...base.config.recall, globalInjectMaxChars: 50_000, memoriesMaxChars: 2_000 } },
      };
      const out = await runScenario(withLoweredCap);

      for (const tag of ["memory-record", "relevant-memories"]) {
        const opens = (out.match(new RegExp(`<${tag}\\b`, "g")) || []).length;
        const closes = (out.match(new RegExp(`</${tag}>`, "g")) || []).length;
        assert.equal(opens, closes, `every <${tag}> must be closed`);
      }
      assert.doesNotMatch(out, /<memory-record[^>]*$/);
      assert.doesNotMatch(out, /<quoted-evidence>[^<]*$/);
      assert.match(out, /<!-- memory context truncated -->/);
    });

    it("omitting recall.memoriesMaxChars keeps the 12000-char default (behaviour-neutral)", () => {
      const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
      assert.match(source, /memoriesMaxChars\s*\?\?\s*12_000/);
    });
  });
});
