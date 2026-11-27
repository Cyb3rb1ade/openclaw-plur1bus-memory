/**
 * tests/engine-recall-result.test.js — PR-04a.
 *
 * The engine returns blocks as data; the OpenClaw host joins and caps. These
 * pin the two value helpers and the host join on every exit shape the recall
 * handlers produce, so the golden corpus is not the only thing standing
 * between a mapping slip and a changed prompt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { contextBlock, recallResult, UNCAPPED } from "../engine/recall/recall-result.js";
import { prependContextFromRecall } from "../adapter/openclaw/join-recall.js";

describe("engine/recall/recall-result", () => {
  it("contextBlock carries chars and coerces text", () => {
    assert.deepEqual(contextBlock("time", "abc", false), { name: "time", text: "abc", droppable: false, chars: 3 });
    assert.deepEqual(contextBlock("neo", undefined, true), { name: "neo", text: "", droppable: true, chars: 0 });
  });

  it("recallResult fills every field of the 1.4.0 shape", () => {
    assert.deepEqual(recallResult(), {
      blocks: [],
      capChars: UNCAPPED,
      degraded: null,
      timing: { phases: null, totalMs: 0 },
      deferrals: [],
    });
  });
});

describe("adapter/openclaw/join-recall", () => {
  it("maps zero blocks to undefined (the old `return undefined` exits)", () => {
    assert.equal(prependContextFromRecall(recallResult()), undefined);
    assert.equal(prependContextFromRecall(undefined), undefined);
  });

  it("keeps an all-empty six-block result as an empty prependContext", () => {
    const blocks = ["neo", "start", "memories", "time", "temporal", "reminder"]
      .map((name) => contextBlock(name, "", name !== "time" && name !== "temporal" && name !== "reminder"));
    assert.deepEqual(prependContextFromRecall(recallResult({ blocks, capChars: 17_000 })), { prependContext: "" });
  });

  it("returns a lone uncapped neo block verbatim (the neo-only early returns)", () => {
    const neo = "<plur1bus-recall>x</plur1bus-recall>";
    assert.deepEqual(
      prependContextFromRecall(recallResult({ blocks: [contextBlock("neo", neo, true)] })),
      { prependContext: neo },
    );
  });

  it("joins the error fallback exactly like [neo, start].filter(Boolean).join", () => {
    const neo = "N".repeat(40);
    const start = "S".repeat(30);
    const expected = [neo, start].filter(Boolean).join("\n\n");
    const blocks = [contextBlock("neo", neo, true), contextBlock("start", start, true)].filter((b) => b.text);
    assert.equal(prependContextFromRecall(recallResult({ blocks })).prependContext, expected);
  });

  it("applies the cap when capChars is finite", () => {
    const blocks = [contextBlock("start", "S".repeat(50), true), contextBlock("time", "T".repeat(10), false)];
    assert.equal(prependContextFromRecall(recallResult({ blocks, capChars: 20 })).prependContext, "T".repeat(10));
  });
});
