/**
 * mai/tests/edge-context.test.js — Edge + ContextWeightManager unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { Edge } from "../edge-emotion.js";
import { EmotionScore } from "../emotion-score.js";
import { ContextWeightManager } from "../context-weight.js";

describe("Edge + ContextWeightManager", () => {
  test("Edge emotion weight computation with same primary emotion", () => {
    const edge = new Edge({ weight: 0.5 });
    const joy1 = new EmotionScore({ valence: 0.8, arousal: 0.4, dominance: 0.3, intensity: 0.7, primary_emotion: "joy" });
    const joy2 = new EmotionScore({ valence: 0.7, arousal: 0.5, dominance: 0.2, intensity: 0.6, primary_emotion: "joy" });
    const w = edge.computeEmotionWeight(joy1, joy2);
    assert.ok(w > 0);
    assert.strictEqual(edge.shared_emotion, "joy");
    assert.ok(edge.weight > 0);
  });

  test("Edge emotion weight with different emotions", () => {
    const edge = new Edge({ weight: 0.5 });
    const anger = new EmotionScore({ valence: -0.6, arousal: 0.6, dominance: 0.4, intensity: 0.8, primary_emotion: "anger" });
    const joy = new EmotionScore({ valence: 0.8, arousal: 0.4, dominance: 0.3, intensity: 0.7, primary_emotion: "joy" });
    const w = edge.computeEmotionWeight(anger, joy);
    assert.strictEqual(typeof w, "number");
    assert.strictEqual(edge.shared_emotion, null);
  });

  test("Edge emotion weight with null emotions", () => {
    const edge = new Edge({ weight: 0.5 });
    const w = edge.computeEmotionWeight(null, null);
    assert.strictEqual(w, 1.0);
    assert.strictEqual(edge.emotional_resonance, 0.0);
    assert.strictEqual(edge.shared_emotion, null);
  });

  test("Context weighting: emotional engrams get higher weight", () => {
    const manager = new ContextWeightManager();
    const engrams = [
      { content: "A", emotion: new EmotionScore({ valence: 0.8, arousal: 0.5, dominance: 0.3, intensity: 0.9 }) },
      { content: "B", emotion: new EmotionScore({ valence: 0.0, arousal: 0.0, dominance: 0.0, intensity: 0.0 }) },
    ];
    const weighted = manager.weightEngrams(engrams);
    assert.ok(weighted[0][1] > weighted[1][1], "emotional engram should have higher weight");
  });

  test("selectContextWindow respects maxTokens", () => {
    const manager = new ContextWeightManager();
    const engrams = [
      { content: "a".repeat(400), emotion: new EmotionScore({ valence: 0.8, arousal: 0.5, dominance: 0.3, intensity: 0.9 }) },
      { content: "b".repeat(400), emotion: new EmotionScore({ valence: 0.7, arousal: 0.4, dominance: 0.2, intensity: 0.8 }) },
      { content: "c".repeat(400), emotion: new EmotionScore({ valence: 0.6, arousal: 0.3, dominance: 0.1, intensity: 0.7 }) },
    ];
    const selected = manager.selectContextWindow(engrams, null, 200);
    let tokens = 0;
    for (const e of selected) {
      tokens += Math.ceil(e.content.length / 4);
    }
    assert.ok(tokens <= 200, `tokens=${tokens} exceeded maxTokens=200`);
    assert.ok(selected.length <= 2);
  });
});
