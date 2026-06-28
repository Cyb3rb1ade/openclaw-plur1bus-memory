import { describe, it } from "node:test";
import assert from "node:assert";
import { detectBlend } from "../lib/emotion-blends.js";
import { Tier2TransformerClassifier } from "../lib/tier2-transformer.js";

describe("emotion input safety", () => {
  it("handles non-string Tier-2 classifier input", () => {
    const classifier = new Tier2TransformerClassifier();

    const score = classifier.classify({ text: "love" });

    assert.strictEqual(score.primary_emotion, "neutral");
    assert.strictEqual(score.language, "en");
  });

  it("handles non-string blend text", () => {
    const blend = detectBlend({ joy: 0.6, sadness: 0.6 }, null);

    assert.ok(blend);
    assert.strictEqual(blend.label, "bittersweet");
  });
});
