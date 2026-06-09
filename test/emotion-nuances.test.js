/**
 * test/emotion-nuances.test.js — Tests für emotionale Nuancen und Blends.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { inferEmotionalValence, inferEmotionalValenceAsync, emotionEmoji } from "../lib/emotion.js";
import { detectBlend } from "../lib/emotion-blends.js";
import { EmotionalState } from "../lib/emotional-state.js";

describe("Nuancen-Erkennung (Tier 1)", () => {
  it("erkennt gratitude in deutschem Text", () => {
    const r = inferEmotionalValence("Ich bin so dankbar für deine Hilfe");
    assert.strictEqual(r.emotionalDominant, "gratitude");
    assert.ok(r.nuances.length > 0, "Sollte Nuancen haben");
    assert.strictEqual(r.nuances[0].label, "gratitude");
    assert.ok(r.nuances[0].intensity > 0, "Sollte Intensität > 0 haben");
    assert.ok(r.nuances[0].confidence > 0, "Sollte Confidence > 0 haben");
  });

  it("erkennt relief", () => {
    const r = inferEmotionalValence("Endlich ist die Prüfung vorbei, ich bin erleichtert");
    const labels = r.nuances.map((n) => n.label);
    assert.ok(labels.includes("relief"), `Sollte relief enthalten, hat: ${labels.join(", ")}`);
  });

  it("erkennt multiple Nuancen", () => {
    const r = inferEmotionalValence("Ich bin dankbar und erleichtert");
    const labels = r.nuances.map((n) => n.label);
    assert.ok(labels.includes("gratitude"), `Sollte gratitude enthalten, hat: ${labels.join(", ")}`);
    assert.ok(labels.includes("relief"), `Sollte relief enthalten, hat: ${labels.join(", ")}`);
  });

  it("erkennt disgust als 8. Dimension", () => {
    const r = inferEmotionalValence("Das ist ekelhaft und widerlich");
    assert.strictEqual(r.emotionalDominant, "disgust");
    assert.ok(r.disgust > 0.5, `disgust sollte > 0.5 sein, ist ${r.disgust}`);
  });

  it("gibt leeres nuances-Array zurück, wenn keine Nuancen erkannt", () => {
    const r = inferEmotionalValence("Das Wetter ist heute bewölkt");
    assert.deepStrictEqual(r.nuances, []);
  });
});

describe("Blend-Detection", () => {
  it("erkennt bittersweet bei joy + sadness + farewell", () => {
    const r = inferEmotionalValence("I am happy but sad to say goodbye");
    assert.ok(r.complexEmotion, "Sollte einen Blend erkennen");
    assert.strictEqual(r.complexEmotion.label, "bittersweet");
    assert.ok(r.complexEmotion.confidence > 0.4, `Confidence sollte > 0.4 sein, ist ${r.complexEmotion.confidence}`);
    assert.strictEqual(r.complexEmotion.evidence.semantic_trigger, "goodbye");
  });

  it("erkennt schadenfreude bei joy + anger + failure", () => {
    const r = inferEmotionalValence("He failed and I am happy and angry about it");
    assert.ok(r.complexEmotion, "Sollte einen Blend erkennen");
    assert.strictEqual(r.complexEmotion.label, "schadenfreude");
  });

  it("erkennt love bei trust + joy", () => {
    const r = inferEmotionalValence("I am happy and I trust you completely");
    assert.ok(r.complexEmotion, "Sollte einen Blend erkennen");
    assert.strictEqual(r.complexEmotion.label, "love");
  });

  it("erkennt contempt bei anger + disgust", () => {
    const r = inferEmotionalValence("You are disgusting and I hate you");
    assert.ok(r.complexEmotion, "Sollte einen Blend erkennen");
    assert.strictEqual(r.complexEmotion.label, "contempt");
  });

  it("gibt null zurück, wenn keine Blend-Bedingungen erfüllt", () => {
    const blend = detectBlend({ joy: 0.9 }, "I am very happy");
    assert.strictEqual(blend, null);
  });

  it("erfordert semantischen Trigger oder sehr hohe Intensität", () => {
    // Nur joy + sadness ohne Trigger bei niedriger Intensität = kein bittersweet
    const blend = detectBlend({ joy: 0.4, sadness: 0.4 }, "I feel mixed");
    assert.strictEqual(blend, null);

    // Aber bei sehr hoher Intensität (>= 0.5) wird es erkannt
    const blendHigh = detectBlend({ joy: 0.6, sadness: 0.6 }, "I feel very mixed");
    assert.ok(blendHigh, "Sollte bei hoher Intensität erkannt werden");
    assert.strictEqual(blendHigh.label, "bittersweet");
  });
});

describe("emotionEmoji", () => {
  it("gibt Emoji für Nuancen zurück", () => {
    assert.strictEqual(emotionEmoji("gratitude"), "🙏");
    assert.strictEqual(emotionEmoji("relief"), "😌");
    assert.strictEqual(emotionEmoji("shame"), "😳");
  });

  it("gibt Emoji für Blends zurück", () => {
    assert.strictEqual(emotionEmoji("bittersweet"), "🥺");
    assert.strictEqual(emotionEmoji("schadenfreude"), "😈");
  });

  it("gibt Emoji für disgust zurück", () => {
    assert.strictEqual(emotionEmoji("disgust"), "🤢");
  });

  it("gibt Fallback-Emoji zurück", () => {
    assert.strictEqual(emotionEmoji("unknown"), "😐");
  });
});

describe("EmotionalState mit Nuancen", () => {
  it("speichert Nuancen aus Memory-Valenz", () => {
    const state = new EmotionalState();
    state.updateFromRecalledMemory({
      joy: 0.6,
      gratitude: 0.5,
      nuances: [{ label: "gratitude", intensity: 0.8 }],
      emotionalIntensity: 0.7,
    });

    const desc = state.describeMood();
    assert.ok(desc.nuances.includes("gratitude"), `Sollte gratitude enthalten, hat: ${desc.nuances.join(", ")}`);
  });

  it("wendet emotion-spezifischen Decay an", () => {
    const state = new EmotionalState();
    state.current.surprise = 0.9;
    state.current.sadness = 0.9;
    state.lastUpdateAt = Date.now() - 10 * 60 * 1000; // 10 Minuten zurück

    state._applyDecay();

    // surprise sollte stärker abgeklungen sein als sadness
    assert.ok(state.current.surprise < state.current.sadness,
      `surprise(${state.current.surprise}) sollte < sadness(${state.current.sadness}) sein`);
  });
});

describe("Backward Compatibility", () => {
  it("Legacy-Format enthält alle 8 Dimensionen", () => {
    const r = inferEmotionalValence("Das ist gut");
    assert.ok("joy" in r, "Sollte joy haben");
    assert.ok("trust" in r, "Sollte trust haben");
    assert.ok("anticipation" in r, "Sollte anticipation haben");
    assert.ok("sadness" in r, "Sollte sadness haben");
    assert.ok("disgust" in r, "Sollte disgust haben");
    assert.ok("anger" in r, "Sollte anger haben");
    assert.ok("fear" in r, "Sollte fear haben");
    assert.ok("surprise" in r, "Sollte surprise haben");
  });

  it("serializeEmotionalValence bleibt kompatibel", () => {
    const r = inferEmotionalValence("Ich bin glücklich");
    const serialized = serializeEmotionalValence(r);
    const deserialized = deserializeEmotionalValence(serialized);
    assert.ok(deserialized.joy > 0, `joy sollte > 0 sein, ist ${deserialized.joy}`);
  });
});

function serializeEmotionalValence(valence) {
  const parts = [];
  for (const dim of ["joy", "trust", "anticipation", "sadness", "disgust", "anger", "fear", "surprise"]) {
    const v = valence?.[dim] ?? 0;
    if (v > 0) parts.push(`${dim}:${v.toFixed(2)}`);
  }
  return parts.join(",");
}

function deserializeEmotionalValence(str) {
  const valence = {};
  for (const dim of ["joy", "trust", "anticipation", "sadness", "disgust", "anger", "fear", "surprise"]) {
    valence[dim] = 0;
  }
  if (!str || typeof str !== "string") return valence;

  for (const part of str.split(",")) {
    const [key, val] = part.split(":");
    if (key && val) {
      const n = Number.parseFloat(val);
      if (Number.isFinite(n)) valence[key] = Math.max(0, Math.min(1, n));
    }
  }
  return valence;
}
