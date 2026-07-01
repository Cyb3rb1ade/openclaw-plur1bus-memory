/**
 * test/emotional-dynamics.test.js — Emotionale Dynamik: Engine-getriebene
 * Stimmungs-Updates, Temperamente, Diff-Dominanz, Persistenz.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EmotionalState } from "../lib/emotional-state.js";

describe("applyEmotionScore", () => {
  it("bewegt die Stimmung deutlich bei starkem Signal", () => {
    const state = new EmotionalState();
    state.applyEmotionScore({ anger: 0.8, emotionalIntensity: 0.8, emotionalDominant: "anger", nuances: [] });
    // Baseline anger 0.02 → target 0.82, blend 0.5×1.0×(0.5+0.4)=0.45 → ~0.38
    assert.ok(state.current.anger > 0.3, `anger sollte > 0.3 sein, ist ${state.current.anger}`);
  });

  it("sensitivity skaliert den Ausschlag", () => {
    const calm = new EmotionalState({ sensitivity: 0.5 });
    const hot = new EmotionalState({ sensitivity: 1.5 });
    const signal = { sadness: 0.6, emotionalIntensity: 0.6, emotionalDominant: "sadness", nuances: [] };
    calm.applyEmotionScore(signal);
    hot.applyEmotionScore(signal);
    assert.ok(hot.current.sadness > calm.current.sadness,
      `hot(${hot.current.sadness}) sollte > calm(${calm.current.sadness}) sein`);
  });

  it("übernimmt Nuancen aus dem Score", () => {
    const state = new EmotionalState();
    state.applyEmotionScore({
      joy: 0.5, emotionalIntensity: 0.5, emotionalDominant: "gratitude",
      nuances: [{ label: "gratitude", intensity: 0.7 }],
    });
    assert.ok((state.nuanceState.gratitude ?? 0) >= 0.69, `gratitude: ${state.nuanceState.gratitude}`);
  });

  it("ignoriert ungültige Eingaben ohne Crash", () => {
    const state = new EmotionalState();
    const before = { ...state.current };
    state.applyEmotionScore(null);
    state.applyEmotionScore("kaputt");
    assert.deepStrictEqual(state.current, before);
  });
});

describe("Temperament: decayMultiplier", () => {
  it("verlangsamt bzw. beschleunigt den Abfall zur Baseline", () => {
    const fast = new EmotionalState({ decayMultiplier: 0.5 });
    const slow = new EmotionalState({ decayMultiplier: 2.0 });
    for (const s of [fast, slow]) {
      s.current.anger = 0.9;
      s.lastUpdateAt = Date.now() - 60 * 60 * 1000; // 1h zurück
      s._applyDecay();
    }
    assert.ok(slow.current.anger > fast.current.anger,
      `slow(${slow.current.anger}) sollte > fast(${fast.current.anger}) sein`);
  });
});
