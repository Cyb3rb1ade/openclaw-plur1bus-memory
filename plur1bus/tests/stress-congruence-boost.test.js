// tests/stress-congruence-boost.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStressCongruenceBoost } from "../lib/emotional-state.js";

describe("computeStressCongruenceBoost", () => {
  it("returns 0 when current session is calm (both anger and fear low)", () => {
    const boost = computeStressCongruenceBoost(
      { anger: 0.2, fear: 0.1 },
      { anger: 0.8, fear: 0.8, emotionalIntensity: 1.0 },
    );
    assert.strictEqual(boost, 0);
  });

  it("returns 0 when memory is not stress-shaped (joy memory)", () => {
    const boost = computeStressCongruenceBoost(
      { anger: 0.8, fear: 0.8 },
      { anger: 0.1, fear: 0.1, emotionalIntensity: 0.9 },
    );
    assert.strictEqual(boost, 0);
  });

  it("triggers on pure anger (Math.max, not average)", () => {
    // anger=1.0, fear=0.0 → max=1.0, not average=0.5
    const boost = computeStressCongruenceBoost(
      { anger: 1.0, fear: 0.0 },
      { anger: 0.8, fear: 0.0, emotionalIntensity: 0.8 },
    );
    assert.ok(boost > 0, `Expected boost > 0, got ${boost}`);
  });

  it("triggers on pure fear (Math.max, not average)", () => {
    const boost = computeStressCongruenceBoost(
      { anger: 0.0, fear: 1.0 },
      { anger: 0.0, fear: 0.9, emotionalIntensity: 0.8 },
    );
    assert.ok(boost > 0, `Expected boost > 0, got ${boost}`);
  });

  it("does NOT trigger when either side is exactly 0.5 (strict > threshold)", () => {
    const atThreshold = computeStressCongruenceBoost(
      { anger: 0.5, fear: 0.0 },
      { anger: 0.8, fear: 0.0, emotionalIntensity: 1.0 },
    );
    assert.strictEqual(atThreshold, 0);
  });

  it("calculates correct value: max(0.8,0.6) * max(0.7,0.7) * 0.8 * 0.25", () => {
    // currentStress = max(0.8, 0.6) = 0.8
    // memoryStress  = max(0.7, 0.7) = 0.7
    // result = 0.8 * 0.7 * 0.8 * 0.25 = 0.112
    const boost = computeStressCongruenceBoost(
      { anger: 0.8, fear: 0.6 },
      { anger: 0.7, fear: 0.7, emotionalIntensity: 0.8 },
    );
    assert.ok(
      Math.abs(boost - 0.112) < 0.0001,
      `Expected ≈0.112, got ${boost}`,
    );
  });

  it("returns 0 when memoryValence is null or missing fields", () => {
    assert.strictEqual(computeStressCongruenceBoost({ anger: 0.9, fear: 0.9 }, null), 0);
    assert.strictEqual(computeStressCongruenceBoost({ anger: 0.9, fear: 0.9 }, {}), 0);
  });

  it("returns 0 when current is null or missing fields", () => {
    assert.strictEqual(computeStressCongruenceBoost(null, { anger: 0.9, fear: 0.9, emotionalIntensity: 1.0 }), 0);
    assert.strictEqual(computeStressCongruenceBoost({}, { anger: 0.9, fear: 0.9, emotionalIntensity: 1.0 }), 0);
  });
});

describe("computeStressCongruenceBoost wiring in computeRecallBoost", () => {
  it("stressed session recalls stress-memory with higher score than calm session", async () => {
    const { EmotionalState } = await import("../lib/emotional-state.js");

    const stressed = new EmotionalState();
    // Override current mood to high anger (> 0.5 threshold)
    stressed.current = {
      anger: 0.9, fear: 0.1, joy: 0.1, trust: 0.1,
      anticipation: 0.0, sadness: 0.0, disgust: 0.0, surprise: 0.0,
    };

    const calm = new EmotionalState();
    // Default baseline: anger=0.02, far below 0.5 threshold

    const stressMemory = {
      anger: 0.8, fear: 0.0, joy: 0.0, trust: 0.1,
      anticipation: 0.0, sadness: 0.0, disgust: 0.0,
      surprise: 0.0, emotionalIntensity: 0.8,
    };

    const boostStressed = stressed.computeRecallBoost(stressMemory, 0.5);
    const boostCalm     = calm.computeRecallBoost(stressMemory, 0.5);

    assert.ok(
      boostStressed > boostCalm,
      `Stressed session (${boostStressed}) should outscore calm session (${boostCalm})`,
    );
  });
});
