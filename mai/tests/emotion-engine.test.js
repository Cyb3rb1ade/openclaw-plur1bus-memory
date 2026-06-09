/**
 * mai/tests/emotion-engine.test.js — EmotionEngine unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { EmotionEngine } from "../emotion-engine.js";

describe("EmotionEngine", () => {
  test("forceTier=1 routes to tier1", async () => {
    const engine = new EmotionEngine();
    const result = await engine.analyze("I am so happy and excited today!", "user", 1);
    assert.strictEqual(result.tier_used, 1);
  });

  test("forceTier=2 routes to tier2", async () => {
    const engine = new EmotionEngine();
    const result = await engine.analyze("I am so happy and excited today!", "user", 2);
    assert.strictEqual(result.tier_used, 2);
  });

  test("forceTier=3 routes to tier3 (fallback since no client)", async () => {
    const engine = new EmotionEngine();
    const result = await engine.analyze("I am so happy and excited today!", "user", 3);
    assert.strictEqual(result.tier_used, 3);
    assert.strictEqual(result.primary_emotion, "neutral");
  });

  test("default routing for clear text uses tier1", async () => {
    const engine = new EmotionEngine();
    const result = await engine.analyze("I am absolutely delighted and thrilled!");
    assert.strictEqual(result.tier_used, 1);
    assert.strictEqual(result.primary_emotion, "joy");
  });

  test("stats tracking after analyses", async () => {
    const engine = new EmotionEngine();
    await engine.analyze("happy", "user", 1);
    await engine.analyze("happy", "user", 2);
    await engine.analyze("happy", "user", 3);

    const stats = engine.stats;
    assert.strictEqual(stats.tier1, 1);
    assert.strictEqual(stats.tier2, 1);
    assert.strictEqual(stats.tier3, 1);
    assert.strictEqual(stats.total, 3);
    assert.ok(stats.avg_ms >= 0);
    assert.ok(stats.pct_tier1 > 0);
    assert.ok(stats.pct_tier2 > 0);
    assert.ok(stats.pct_tier3 > 0);
  });

  test("VAD bounds on all results", async () => {
    const engine = new EmotionEngine();
    const texts = [
      "I love this!",
      "I hate this!",
      "The weather is okay.",
      "Ich bin so glücklich!",
      "Ich bin traurig und wütend.",
    ];
    for (const text of texts) {
      for (const tier of [1, 2, 3, null]) {
        const result = await engine.analyze(text, "user", tier);
        assert.ok(result.valence >= -1 && result.valence <= 1, `valence out of bounds: ${result.valence}`);
        assert.ok(result.arousal >= -1 && result.arousal <= 1, `arousal out of bounds: ${result.arousal}`);
        assert.ok(result.dominance >= -1 && result.dominance <= 1, `dominance out of bounds: ${result.dominance}`);
      }
    }
  });
});
