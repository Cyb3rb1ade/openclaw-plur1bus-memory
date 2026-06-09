/**
 * lib/emotion.js — Emotions-Inferenz für PLUR1BUS Memories.
 *
 * **v2** — Wrapper um das 3-Tier Emotion-System (mai/):
 *   Tier 1: NRC-Lexikon (deterministisch, ~0.01ms)
 *   Tier 2: Transformer/Keyword-Fallback (~0.01ms Stub)
 *   Tier 3: LLM (OpenAI-kompatibel, JSON-Output)
 *
 * Die Legacy-API (inferEmotionalValence, serializeEmotionalValence,
 * deserializeEmotionalValence, emotionEmoji) bleibt erhalten.
 * Neue Funktion: inferEmotionalValenceAsync für volle 3-Tier-Analyse.
 */

import { EmotionEngine } from "./emotion-engine.js";
import { EmotionScore } from "./emotion-score.js";

export const EMOTION_DIMENSIONS = [
  "joy",
  "trust",
  "anticipation",
  "sadness",
  "anger",
  "fear",
  "surprise",
];

// Lazy-init Engine (Tier 1 ist synchron, Tiers 2+3 async)
let _engine = null;
function getEngine() {
  if (!_engine) {
    _engine = new EmotionEngine({
      tier1: { language: "de" },
      tier2: { modelName: "j-hartmann/emotion-english-distilroberta-base" },
      tier3: { model: "gpt-4o-mini" },
    });
  }
  return _engine;
}

/**
 * Mappt einen EmotionScore (VAD + primary_emotion) auf das Legacy-Format
 * mit 7 Plutchik-Dimensionen.
 */
function emotionScoreToLegacy(score) {
  const primary = score.primary_emotion || "neutral";
  const labels = score.emotion_labels || {};

  const legacy = {
    joy: 0,
    trust: 0,
    anticipation: 0,
    sadness: 0,
    anger: 0,
    fear: 0,
    surprise: 0,
    emotionalIntensity: clamp01(score.intensity ?? 0),
    emotionalDominant: primary,
  };

  // Verteile die emotion_labels auf die 7 Dimensionen
  for (const dim of EMOTION_DIMENSIONS) {
    if (labels[dim] !== undefined) {
      legacy[dim] = clamp01(labels[dim]);
    }
  }

  // Primary emotion bekommt mindestens die Intensität
  if (EMOTION_DIMENSIONS.includes(primary)) {
    legacy[primary] = Math.max(legacy[primary], legacy.emotionalIntensity);
  }

  return legacy;
}

/**
 * Pattern-basierte Emotions-Inferenz (Tier 1 only, synchron).
 *
 * @param {string} text
 * @param {string} category — Memory-Kategorie (optional, wird nicht mehr genutzt)
 * @param {Array} reactionSignals — Neo Reaction-Signale (optional, wird nicht mehr genutzt)
 * @returns {{joy:number, trust:number, anticipation:number, sadness:number, anger:number, fear:number, surprise:number, emotionalIntensity:number, emotionalDominant:string}}
 */
export function inferEmotionalValence(text, category = "", reactionSignals = []) {
  try {
    const engine = getEngine();
    const score = engine._t1.classify(text, "user");
    return emotionScoreToLegacy(score);
  } catch (e) {
    // Fallback: alles neutral
    return {
      joy: 0, trust: 0, anticipation: 0, sadness: 0,
      anger: 0, fear: 0, surprise: 0,
      emotionalIntensity: 0, emotionalDominant: "neutral",
    };
  }
}

/**
 * Asynchrone 3-Tier Emotions-Inferenz (Tier 1 → 2 → 3).
 *
 * @param {string} text
 * @param {"user" | "assistant"} [source]
 * @param {1|2|3|null} [forceTier]
 * @returns {Promise<{joy:number, trust:number, anticipation:number, sadness:number, anger:number, fear:number, surprise:number, emotionalIntensity:number, emotionalDominant:string}>}
 */
export async function inferEmotionalValenceAsync(text, source = "user", forceTier = null) {
  try {
    const engine = getEngine();
    const score = await engine.analyze(text, source, forceTier);
    return emotionScoreToLegacy(score);
  } catch (e) {
    // Fallback zu synchronem Tier 1
    return inferEmotionalValence(text);
  }
}

/**
 * Serialisiert eine Valenz zu einem LanceDB-kompatiblen String.
 */
export function serializeEmotionalValence(valence) {
  const parts = [];
  for (const dim of EMOTION_DIMENSIONS) {
    const v = valence?.[dim] ?? 0;
    if (v > 0) parts.push(`${dim}:${v.toFixed(2)}`);
  }
  return parts.join(",");
}

/**
 * Deserialisiert einen Valenz-String zurück zu einem Objekt.
 */
export function deserializeEmotionalValence(str) {
  const valence = {};
  for (const dim of EMOTION_DIMENSIONS) valence[dim] = 0;
  if (!str || typeof str !== "string") return valence;

  for (const part of str.split(",")) {
    const [key, val] = part.split(":");
    if (key && val && EMOTION_DIMENSIONS.includes(key)) {
      const n = Number.parseFloat(val);
      if (Number.isFinite(n)) valence[key] = clamp01(n);
    }
  }
  return valence;
}

/**
 * Berechnet die Cosine-Similarity zwischen zwei Valenz-Vektoren.
 * Rückgabe in [-1, 1].
 */
export function valenceCosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const dim of EMOTION_DIMENSIONS) {
    const av = a?.[dim] ?? 0;
    const bv = b?.[dim] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Gibt ein Emoji für eine dominante Emotion zurück.
 */
export function emotionEmoji(dominant) {
  const map = {
    joy: "😊",
    trust: "🤝",
    anticipation: "👀",
    sadness: "😔",
    anger: "😤",
    fear: "😰",
    surprise: "😲",
    neutral: "😐",
  };
  return map[dominant] || "😐";
}

// Re-exportiere die neuen Klassen für direkten Zugriff
export { EmotionEngine } from "./emotion-engine.js";
export { EmotionScore } from "./emotion-score.js";
