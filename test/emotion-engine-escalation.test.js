/**
 * test/emotion-engine-escalation.test.js — Konfigurierbare T3-Eskalation:
 * beim kleinsten Zweifel (Konfidenz < escalationConfidence, T1/T2-Widerspruch)
 * geht die Analyse zu Tier 3; T3-Timeout fällt sauber zurück.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EmotionEngine } from "../lib/emotion-engine.js";
import { EmotionScore } from "../lib/emotion-score.js";

function makeScore(props) {
  return new EmotionScore({
    valence: 0, arousal: 0, dominance: 0, intensity: 0.5,
    secondary_emotion: null, emotion_labels: {}, language: "de",
    source: "user", confidence: 0.5, timestamp: new Date(),
    ...props,
  });
}

const t3Response = {
  valence: -0.8, arousal: 0.6, dominance: 0, intensity: 0.9,
  primary_emotion: "anger", secondary_emotion: null,
  emotion_labels: { anger: 0.9 }, confidence: 0.9, language: "de",
};

function t3Stub(result = t3Response) {
  return { enabled: true, callLlm: async () => JSON.stringify(result) };
}

describe("EmotionEngine Eskalations-Schwelle", () => {
  it("eskaliert T1-Ergebnisse unterhalb der Schwelle zu T3", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.95, tier3: t3Stub() });
    // T1 liefert konfident-aber-unter-Schwelle (nicht ambivalent, nicht schwach)
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 3);
    assert.strictEqual(score.primary_emotion, "anger");
  });

  it("bleibt bei T1 wenn Konfidenz über der Schwelle liegt", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.5, tier3: t3Stub() });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 1);
    assert.strictEqual(score.primary_emotion, "joy");
  });

  it("eskaliert bei T1/T2-Widerspruch zu T3", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.7, tier3: t3Stub() });
    // ambivalent (|valence| < 0.2) → T2-Pfad; T2 widerspricht T1
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.1, confidence: 0.4, tier_used: 1 }) };
    engine._tier2 = { classify: () => makeScore({ primary_emotion: "sadness", valence: -0.5, confidence: 0.75, tier_used: 2 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 3);
  });

  it("ohne T3 bleibt der Widerspruchsfall beim besseren lokalen Ergebnis", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.7, tier3: { enabled: false } });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.1, confidence: 0.4, tier_used: 1 }) };
    engine._tier2 = { classify: () => makeScore({ primary_emotion: "sadness", valence: -0.5, confidence: 0.75, tier_used: 2 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 2, "Sollte das konfidentere T2-Ergebnis nehmen");
    assert.strictEqual(score.primary_emotion, "sadness");
  });
});

describe("EmotionEngine T3-Timeout", () => {
  it("fällt bei hängendem T3-Call auf das lokale Ergebnis zurück", async () => {
    const engine = new EmotionEngine({
      escalationConfidence: 0.95,
      tier3: { enabled: true, timeoutMs: 50, callLlm: () => new Promise(() => {}) },
    });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const start = Date.now();
    const score = await engine.analyze("egal", "user");
    assert.ok(Date.now() - start < 2000, "Timeout sollte schnell greifen");
    assert.strictEqual(score.primary_emotion, "joy");
    assert.strictEqual(score.tier_used, 1);
  });

  it("fällt bei T3-Fehler auf das lokale Ergebnis zurück", async () => {
    const engine = new EmotionEngine({
      escalationConfidence: 0.95,
      tier3: { enabled: true, callLlm: async () => { throw new Error("boom"); } },
    });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "trust", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.primary_emotion, "trust");
  });
});
