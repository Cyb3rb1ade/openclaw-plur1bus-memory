import { describe, it } from "node:test";
import assert from "node:assert";
import { frameRecallConfidence } from "../lib/recall-confidence-framing.js";

function mem(id, score) { return { id, relevanceScore: score, display: `text-${id}` }; }

describe("frameRecallConfidence", () => {
  it("markiert das untere Drittel als unsicher", () => {
    const items = [mem("a", 0.9), mem("b", 0.8), mem("c", 0.7), mem("d", 0.3), mem("e", 0.2), mem("f", 0.1)];
    const { items: framed, hedgedIds } = frameRecallConfidence(items);
    assert.deepStrictEqual([...hedgedIds].sort(), ["e", "f"]); // maxHedged=2, niedrigste zuerst
    assert.strictEqual(framed.find((m) => m.id === "f").recallUncertain, true);
    assert.strictEqual(framed.find((m) => m.id === "a").recallUncertain, undefined);
  });

  it("mutiert die Originale nicht", () => {
    const items = [mem("a", 0.9), mem("b", 0.5), mem("c", 0.1)];
    frameRecallConfidence(items);
    assert.strictEqual(items[2].recallUncertain, undefined);
  });

  it("hedgt nichts bei weniger als minItems", () => {
    const { hedgedIds } = frameRecallConfidence([mem("a", 0.9), mem("b", 0.1)]);
    assert.deepStrictEqual(hedgedIds, []);
  });

  it("hedgt nichts, wenn alle Scores gleich sind (kein Spread)", () => {
    const { hedgedIds } = frameRecallConfidence([mem("a", 0.5), mem("b", 0.5), mem("c", 0.5)]);
    assert.deepStrictEqual(hedgedIds, []);
  });

  it("ignoriert Items ohne numerischen relevanceScore", () => {
    const items = [mem("a", 0.9), mem("b", 0.8), { id: "x", display: "no-score" }, mem("c", 0.1)];
    const { hedgedIds, items: framed } = frameRecallConfidence(items);
    assert.ok(!hedgedIds.includes("x"));
    assert.strictEqual(framed.length, 4);
  });

  it("cap maxHedged greift", () => {
    const items = [mem("a", 0.9), mem("b", 0.8), mem("c", 0.7), mem("d", 0.03), mem("e", 0.02), mem("f", 0.01)];
    const { hedgedIds } = frameRecallConfidence(items, { maxHedged: 1 });
    assert.deepStrictEqual(hedgedIds, ["f"]);
  });

  it("fail-open bei kaputtem Input", () => {
    assert.deepStrictEqual(frameRecallConfidence(null).hedgedIds, []);
    assert.deepStrictEqual(frameRecallConfidence("nope").hedgedIds, []);
  });
});
