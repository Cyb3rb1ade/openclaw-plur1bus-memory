import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EmotionScore } from "../lib/emotion-score.js";
import { Tier3LLMClassifier } from "../lib/tier3-llm.js";

function tier1Fallback() {
  return new EmotionScore({
    valence: 0.6,
    arousal: 0.2,
    dominance: 0.1,
    intensity: 0.7,
    primary_emotion: "joy",
    emotion_labels: { joy: 1 },
    language: "en",
    source: "user",
    tier_used: 1,
    confidence: 0.8,
  });
}

describe("Tier3LLMClassifier fallback", () => {
  it("falls back to tier-1 when LLM JSON has out-of-range emotion values", async () => {
    const fallback = tier1Fallback();
    const classifier = new Tier3LLMClassifier({
      callLlm: async () => JSON.stringify({
        valence: 1.5,
        arousal: 0.2,
        dominance: 0.1,
        intensity: 0.8,
        primary_emotion: "joy",
        emotion_labels: { joy: 1 },
        confidence: 0.9,
        language: "en",
      }),
    });

    const score = await classifier.classify("I am happy", "user", fallback);

    assert.strictEqual(score, fallback);
  });
});
