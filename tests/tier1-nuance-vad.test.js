/**
 * tests/tier1-nuance-vad.test.js
 *
 * Regression: common words (love, grateful, proud, relieved, curious …) map to
 * NUANCE labels that have no EMOTION_VAD entry. The tier-1 classifier did
 * `{ ...EMOTION_VAD[primary] }` → {} → vad.v = NaN → intensity = NaN, which
 * EmotionScore._validate did not catch (NaN comparisons are false). The legacy
 * mapping then clamped NaN to 0, silently zeroing the emotional signal.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { Tier1LexiconClassifier } from "../lib/tier1-lexicon.js";
import { EmotionScore } from "../lib/emotion-score.js";

describe("tier-1 nuance VAD fallback", () => {
  const clf = new Tier1LexiconClassifier();

  for (const text of ["I love this project", "I am so grateful", "I am proud", "feeling relieved"]) {
    it(`produces finite, non-zero intensity for: "${text}"`, () => {
      const score = clf.classify(text, "user");
      assert.ok(Number.isFinite(score.valence), `valence must be finite, got ${score.valence}`);
      assert.ok(Number.isFinite(score.intensity), `intensity must be finite, got ${score.intensity}`);
      assert.ok(score.intensity > 0, `a clearly emotional phrase must not have zero intensity`);
    });
  }
});

describe("EmotionScore._validate rejects non-finite numbers", () => {
  it("throws on NaN valence (defense-in-depth)", () => {
    assert.throws(() => new EmotionScore({ valence: NaN, intensity: 0.5 }), /finite|valence/i);
  });
});
