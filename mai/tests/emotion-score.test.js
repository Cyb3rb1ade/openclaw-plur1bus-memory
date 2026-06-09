/**
 * mai/tests/emotion-score.test.js — EmotionScore unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { EmotionScore } from "../emotion-score.js";

describe("EmotionScore", () => {
  test("constructor with valid values", () => {
    const score = new EmotionScore({
      valence: 0.5,
      arousal: -0.3,
      dominance: 0.8,
      intensity: 0.7,
      primary_emotion: "joy",
      secondary_emotion: "surprise",
      language: "en",
      source: "user",
      tier_used: 1,
      confidence: 0.9,
    });
    assert.strictEqual(score.valence, 0.5);
    assert.strictEqual(score.arousal, -0.3);
    assert.strictEqual(score.dominance, 0.8);
    assert.strictEqual(score.intensity, 0.7);
    assert.strictEqual(score.primary_emotion, "joy");
    assert.strictEqual(score.secondary_emotion, "surprise");
    assert.strictEqual(score.language, "en");
    assert.strictEqual(score.source, "user");
    assert.strictEqual(score.tier_used, 1);
    assert.strictEqual(score.confidence, 0.9);
    assert.ok(score.timestamp instanceof Date);
  });

  test("validation throws on out-of-bounds valence", () => {
    assert.throws(() => new EmotionScore({ valence: 1.5 }), /valence must be in \[-1, 1\]/);
    assert.throws(() => new EmotionScore({ valence: -1.5 }), /valence must be in \[-1, 1\]/);
  });

  test("validation throws on out-of-bounds arousal", () => {
    assert.throws(() => new EmotionScore({ arousal: 2.0 }), /arousal must be in \[-1, 1\]/);
  });

  test("validation throws on out-of-bounds dominance", () => {
    assert.throws(() => new EmotionScore({ dominance: -2.0 }), /dominance must be in \[-1, 1\]/);
  });

  test("validation throws on out-of-bounds intensity", () => {
    assert.throws(() => new EmotionScore({ intensity: 1.5 }), /intensity must be in \[0, 1\]/);
    assert.throws(() => new EmotionScore({ intensity: -0.1 }), /intensity must be in \[0, 1\]/);
  });

  test("validation throws on out-of-bounds confidence", () => {
    assert.throws(() => new EmotionScore({ confidence: 1.1 }), /confidence must be in \[0, 1\]/);
    assert.throws(() => new EmotionScore({ confidence: -0.1 }), /confidence must be in \[0, 1\]/);
  });

  test("toDict round-trips through fromDict preserving scalar fields", () => {
    const original = new EmotionScore({
      valence: 0.42,
      arousal: -0.12,
      dominance: 0.33,
      intensity: 0.55,
      primary_emotion: "trust",
      secondary_emotion: "anticipation",
      emotion_labels: { trust: 0.8, anticipation: 0.2 },
      language: "de",
      source: "assistant",
      tier_used: 2,
      confidence: 0.75,
    });
    const dict = original.toDict();
    const restored = EmotionScore.fromDict(dict);

    assert.strictEqual(restored.valence, original.valence);
    assert.strictEqual(restored.arousal, original.arousal);
    assert.strictEqual(restored.dominance, original.dominance);
    assert.strictEqual(restored.intensity, original.intensity);
    assert.strictEqual(restored.primary_emotion, original.primary_emotion);
    assert.strictEqual(restored.secondary_emotion, original.secondary_emotion);
    assert.deepStrictEqual(restored.emotion_labels, original.emotion_labels);
    assert.strictEqual(restored.language, original.language);
    assert.strictEqual(restored.source, original.source);
    assert.strictEqual(restored.tier_used, original.tier_used);
    assert.strictEqual(restored.confidence, original.confidence);
  });

  test("toVadVector returns Float32Array[3]", () => {
    const score = new EmotionScore({ valence: 0.1, arousal: 0.2, dominance: 0.3 });
    const vec = score.toVadVector();
    assert.ok(vec instanceof Float32Array);
    assert.strictEqual(vec.length, 3);
    assert.ok(Math.abs(vec[0] - 0.1) < 1e-6);
    assert.ok(Math.abs(vec[1] - 0.2) < 1e-6);
    assert.ok(Math.abs(vec[2] - 0.3) < 1e-6);
  });

  test("isHighIntensity getter", () => {
    assert.strictEqual(new EmotionScore({ intensity: 0.61 }).isHighIntensity, true);
    assert.strictEqual(new EmotionScore({ intensity: 0.6 }).isHighIntensity, false);
    assert.strictEqual(new EmotionScore({ intensity: 0.0 }).isHighIntensity, false);
  });

  test("isAmbivalent getter", () => {
    assert.strictEqual(new EmotionScore({ valence: 0.1 }).isAmbivalent, true);
    assert.strictEqual(new EmotionScore({ valence: -0.15 }).isAmbivalent, true);
    assert.strictEqual(new EmotionScore({ valence: 0.2 }).isAmbivalent, false);
    assert.strictEqual(new EmotionScore({ valence: -0.3 }).isAmbivalent, false);
  });
});
