/**
 * mai/tests/engram-decay.test.js — Engram + DecayEngine unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { Engram } from "../engram-emotion.js";
import { EmotionScore } from "../emotion-score.js";
import { DecayEngine } from "../decay-engine.js";

describe("Engram + DecayEngine", () => {
  test("high intensity engram has longer half-life than low intensity", () => {
    const high = new Engram({
      emotion: new EmotionScore({ valence: 0.8, arousal: 0.5, dominance: 0.4, intensity: 0.9 }),
    });
    const low = new Engram({
      emotion: new EmotionScore({ valence: 0.1, arousal: 0.0, dominance: 0.0, intensity: 0.1 }),
    });
    const highHL = high.computeDecayHalfLife(2.0);
    const lowHL = low.computeDecayHalfLife(2.0);
    assert.ok(highHL > lowHL, `high=${highHL}, low=${lowHL}`);
  });

  test("half-life > 168.0 (default) for emotional engrams", () => {
    const engram = new Engram({
      emotion: new EmotionScore({ valence: 0.6, arousal: 0.4, dominance: 0.3, intensity: 0.7 }),
    });
    const hl = engram.computeDecayHalfLife(2.0);
    assert.ok(hl > 168.0, `half-life was ${hl}`);
  });

  test("access count increases half-life via DecayEngine retention", () => {
    const baseTime = Date.now();
    const engram = new Engram({
      created_at: new Date(baseTime - 1000 * 60 * 60 * 24), // 24h old
      emotion: new EmotionScore({ valence: 0.5, arousal: 0.3, dominance: 0.2, intensity: 0.6 }),
      decay_access_count: 0,
    });
    const engine = new DecayEngine({ k: 2.0, accessBoost: 1.2 });

    const p0 = engine.computeRetentionProbability(engram, baseTime);
    engram.decay_access_count = 5;
    const p5 = engine.computeRetentionProbability(engram, baseTime);
    assert.ok(p5 > p0, `p0=${p0}, p5=${p5}`);
  });

  test("retention probability decreases with age", () => {
    const now = Date.now();
    const engram = new Engram({
      created_at: new Date(now - 1000 * 60 * 60), // 1h old
      emotion: new EmotionScore({ valence: 0.5, arousal: 0.3, dominance: 0.2, intensity: 0.6 }),
    });
    const engine = new DecayEngine();

    const p1h = engine.computeRetentionProbability(engram, now);
    engram.created_at = new Date(now - 1000 * 60 * 60 * 24 * 30); // 30 days old
    const p30d = engine.computeRetentionProbability(engram, now);
    assert.ok(p1h > p30d, `p1h=${p1h}, p30d=${p30d}`);
  });

  test("shouldForget threshold works", () => {
    const now = Date.now();
    const engram = new Engram({
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 50), // 50 days old
      emotion: new EmotionScore({ valence: 0.0, arousal: 0.0, dominance: 0.0, intensity: 0.0 }),
    });
    const engine = new DecayEngine();
    assert.strictEqual(engine.shouldForget(engram, 0.1), true);
    assert.strictEqual(engine.shouldForget(engram, 0.0001), false);
  });

  test("reviveIfEmotionallyRelevant works with similar emotions", () => {
    const engram = new Engram({
      emotion: new EmotionScore({ valence: 0.8, arousal: 0.5, dominance: 0.4, intensity: 0.9 }),
      decay_access_count: 0,
    });
    const engine = new DecayEngine();
    const trigger = new EmotionScore({ valence: 0.7, arousal: 0.4, dominance: 0.3, intensity: 0.8 });

    const revived = engine.reviveIfEmotionallyRelevant(engram, trigger, 0.7);
    assert.strictEqual(revived, true);
    assert.strictEqual(engram.decay_access_count, 3);
    assert.ok(engram.decay_last_accessed instanceof Date || typeof engram.decay_last_accessed === "number");
  });

  test("reviveIfEmotionallyRelevant returns false for dissimilar emotions", () => {
    const engram = new Engram({
      emotion: new EmotionScore({ valence: -0.8, arousal: 0.5, dominance: -0.4, intensity: 0.9 }),
      decay_access_count: 0,
    });
    const engine = new DecayEngine();
    const trigger = new EmotionScore({ valence: 0.8, arousal: 0.5, dominance: 0.4, intensity: 0.9 });

    const revived = engine.reviveIfEmotionallyRelevant(engram, trigger, 0.7);
    assert.strictEqual(revived, false);
    assert.strictEqual(engram.decay_access_count, 0);
  });
});
