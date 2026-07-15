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

  it("hedgt nicht bei geringem Spread unterhalb minSpread (Default 0.1)", () => {
    const items = [mem("a", 0.95), mem("b", 0.93), mem("c", 0.90)];
    const { hedgedIds } = frameRecallConfidence(items);
    assert.deepStrictEqual(hedgedIds, []);
  });

  it("hedgt weiterhin bei ausreichendem Spread (Default minSpread)", () => {
    const items = [mem("a", 0.9), mem("b", 0.8), mem("c", 0.7), mem("d", 0.3), mem("e", 0.2), mem("f", 0.1)];
    const { hedgedIds } = frameRecallConfidence(items);
    assert.deepStrictEqual([...hedgedIds].sort(), ["e", "f"]);
  });

  it("minSpread: 0 stellt das rein relative Verhalten wieder her", () => {
    const items = [mem("a", 0.95), mem("b", 0.93), mem("c", 0.90)];
    const { hedgedIds } = frameRecallConfidence(items, { minSpread: 0 });
    assert.deepStrictEqual(hedgedIds, ["c"]);
  });

  it("absoluteFloor: uniform starkes, enges Band hedgt weiterhin nicht (0.95..0.92)", () => {
    const items = [mem("a", 0.95), mem("b", 0.94), mem("c", 0.93), mem("d", 0.92)];
    const { hedgedIds } = frameRecallConfidence(items);
    assert.deepStrictEqual(hedgedIds, []);
  });

  it("absoluteFloor: schwaches enges Band hedgt trotz Spread < minSpread (Graph-Recall-Fall)", () => {
    const items = [mem("a", 0.38), mem("b", 0.36), mem("c", 0.35), mem("d", 0.34)];
    const { hedgedIds } = frameRecallConfidence(items);
    // scores sorted: [0.34,0.35,0.36,0.38]; bottom-third cut = scores[ceil(4/3)-1] = scores[1] = 0.35
    // bottomThird = {c:0.35, d:0.34}; spread top(0.38)-cut(0.35)=0.03 < 0.1 → escape hatch applies,
    // both are < absoluteFloor(0.4) → both eligible, maxHedged=2 keeps both.
    assert.deepStrictEqual([...hedgedIds].sort(), ["c", "d"]);
  });

  it("absoluteFloor: gemischtes Set — nur absolut schwache Items im unteren Drittel sind eligible, wenn Spread zu klein ist", () => {
    // Spread top-cut = 0.60 - 0.55 = 0.05 < minSpread 0.1 → nur < absoluteFloor eligible.
    const items = [mem("a", 0.60), mem("b", 0.58), mem("c", 0.56), mem("d", 0.55), mem("e", 0.35)];
    const { hedgedIds } = frameRecallConfidence(items);
    // bottomFraction 1/3 of 5 items -> cut index = ceil(5/3)-1 = 1 -> cut = scores[1] = 0.35?
    // scores sorted asc: [0.35,0.55,0.56,0.58,0.60]; cut = scores[ceil(5*1/3)-1] = scores[1] = 0.55
    // bottomThird = items with score <= 0.55 => d(0.55), e(0.35)
    // top=0.60, spread = 0.60-0.55=0.05 < 0.1 -> escape hatch: only score<0.4 -> e(0.35)
    assert.deepStrictEqual(hedgedIds, ["e"]);
  });

  it("absoluteFloor: 0 deaktiviert den Escape-Hatch", () => {
    const items = [mem("a", 0.38), mem("b", 0.36), mem("c", 0.35)];
    const { hedgedIds } = frameRecallConfidence(items, { absoluteFloor: 0 });
    assert.deepStrictEqual(hedgedIds, []);
  });
});
