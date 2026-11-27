/**
 * tests/engine-recall-deferrals.test.js — PR-04b (L3).
 *
 * The planner must report exactly the clips and drops the joiner performs,
 * and nothing it does not perform — including the over-cap case where no
 * block is droppable (Review Focus 5).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyGlobalInjectBudget, planGlobalInjectBudget } from "../lib/inject-budget.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import { emitEngineEvent } from "../engine/events.js";
import { createStubHost } from "../lib/host-services.js";
import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const record = (id, body) => `<memory-record id="${id}">${body}</memory-record>`;

describe("planGlobalInjectBudget", () => {
  it("returns the same text as applyGlobalInjectBudget", () => {
    const blocks = [
      { name: "neo", text: "N".repeat(30), droppable: true },
      { name: "memories", text: `<relevant-memories>\n${record("a", "x".repeat(40))}\n${record("b", "y".repeat(40))}\n</relevant-memories>`, droppable: true },
      { name: "time", text: "T".repeat(20), droppable: false },
    ];
    for (const maxChars of [17_000, 150, 90, 40, 10]) {
      assert.equal(planGlobalInjectBudget({ blocks, maxChars }).text, applyGlobalInjectBudget({ blocks, maxChars }), `maxChars=${maxChars}`);
    }
  });

  it("records a drop for a droppable block with no record boundary", () => {
    const { deferrals } = planGlobalInjectBudget({
      blocks: [{ name: "start", text: "S".repeat(50), droppable: true }, { name: "time", text: "T".repeat(10), droppable: false }],
      maxChars: 20,
    });
    assert.deepEqual(deferrals, [{ block: "start", kind: "dropped", from: 50, to: 0, reason: "global-cap" }]);
  });

  it("records a clip at a record boundary", () => {
    const memories = `<relevant-memories>\n${record("a", "x".repeat(40))}\n${record("b", "y".repeat(40))}\n</relevant-memories>`;
    // 198 chars; at 170 the first record (ends at 98) plus the marker (34) and
    // the closing wrapper (21) fits, the second does not.
    const { text, deferrals } = planGlobalInjectBudget({ blocks: [{ name: "memories", text: memories, droppable: true }], maxChars: 170 });
    assert.equal(deferrals.length, 1);
    assert.equal(deferrals[0].kind, "clipped");
    assert.equal(deferrals[0].from, memories.length);
    assert.equal(deferrals[0].to, text.length);
  });

  it("records nothing when no block is droppable and the cap is exceeded (Review Focus 5)", () => {
    const blocks = ["time", "temporal", "reminder"].map((name) => ({ name, text: name[0].repeat(50), droppable: false }));
    const plan = planGlobalInjectBudget({ blocks, maxChars: 20 });
    assert.equal(plan.text, blocks.map((b) => b.text).join("\n\n"));
    assert.deepEqual(plan.deferrals, []);
  });
});

describe("formatRelevantMemoriesContext onTruncate", () => {
  it("reports the inner cap with from/to lengths, and stays silent under the cap", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, category: "fact", source: "memory", display: `memory number ${i} `.repeat(8), memoryStrength: 1 }));
    const reports = [];
    const text = formatRelevantMemoriesContext(items, { maxTotalChars: 800, onTruncate: (r) => reports.push(r) });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].to, text.length);
    assert.ok(reports[0].from > reports[0].to);
    const quiet = [];
    formatRelevantMemoriesContext(items.slice(0, 1), { maxTotalChars: 12_000, onTruncate: (r) => quiet.push(r) });
    assert.deepEqual(quiet, []);
  });
});

describe("emitEngineEvent", () => {
  it("is a no-op without host.events and survives a throwing listener", () => {
    emitEngineEvent(createStubHost(), "recall.block-dropped", {});
    const debug = [];
    emitEngineEvent(createStubHost({ events: { emit() { throw new Error("boom"); } }, logger: { debug: (m) => debug.push(m) } }), "x", {});
    assert.equal(debug.length, 1);
  });
});

describe("recall emits one event per deferral", () => {
  it("recall-truncated emits memories-cap and global-cap deferrals, and its prefix is unchanged", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "recall-truncated");
    const events = [];
    const withEvents = await runScenario(scenario, { hostEvents: { emit: (name, payload) => events.push({ name, payload }) } });
    const without = await runScenario(scenario);
    assert.equal(withEvents, without);
    const reasons = events.filter((e) => e.name.startsWith("recall.block-")).map((e) => `${e.payload.block}:${e.payload.reason}`);
    assert.ok(reasons.includes("memories:memories-cap"), `got ${reasons.join(",")}`);
    assert.ok(reasons.includes("memories:global-cap"), `got ${reasons.join(",")}`);
  });
});
