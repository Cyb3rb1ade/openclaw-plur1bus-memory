/**
 * lib/emotion.js — Emotions-Inferenz für PLUR1BUS Memories.
 *
 * **v3** — Wrapper um das 3-Tier Emotion-System (mai/):
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
import { detectBlend } from "./emotion-blends.js";

/** 8 Plutchik-Dimensionen (v3: disgust ergänzt) */
export const EMOTION_DIMENSIONS = [
  "joy",
  "trust",
  "anticipation",
  "sadness",
  "disgust",
  "anger",
  "fear",
  "surprise",
];

// Lazy-init Engine (Tier 1 ist synchron, Tiers 2+3 async)
let _engine = null;
let _emotionConfig = null;

export function setEmotionConfig(config) {
  _emotionConfig = config || {};
  _engine = null; // Force re-init with new config
}

export function getEmotionConfig() {
  return _emotionConfig || {};
}

function getEngine() {
  if (!_engine) {
    const cfg = _emotionConfig || {};
    _engine = new EmotionEngine({
      tier1: { language: "de" },
      tier2: {
        modelName: "j-hartmann/emotion-english-distilroberta-base",
        enabled: cfg.t2?.enabled !== false,
      },
      tier3: {
        model: cfg.t3?.model || "kimi-for-coding",
        enabled: cfg.t3?.enabled === true,
        apiKey: cfg.t3?.apiKey || null,
        baseUrl: cfg.t3?.baseUrl || null,
        callLlm: cfg.t3?.callLlm || null,
        timeoutMs: cfg.t3?.timeoutMs ?? 4000,
      },
      escalationConfidence: cfg.escalationConfidence,
    });
  }
  return _engine;
}

/**
 * Mappt einen EmotionScore (VAD + primary_emotion) auf das Legacy-Format
 * mit 8 Plutchik-Dimensionen.
 */
function emotionScoreToLegacy(score) {
  const primary = score.primary_emotion || "neutral";
  const labels = score.emotion_labels || {};

  const legacy = {
    joy: 0,
    trust: 0,
    anticipation: 0,
    sadness: 0,
    disgust: 0,
    anger: 0,
    fear: 0,
    surprise: 0,
    emotionalIntensity: clamp01(score.intensity ?? 0),
    emotionalDominant: primary,
    // v3: Nuancen und Blends
    nuances: score.nuances || [],
    complexEmotion: score.complex_emotion || null,
    blendFactors: score.blend_factors || {},
    emotionalContext: score.emotional_context || null,
  };

  // Verteile die emotion_labels auf die 8 Dimensionen
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
 * @returns {{joy:number, trust:number, anticipation:number, sadness:number, disgust:number, anger:number, fear:number, surprise:number, emotionalIntensity:number, emotionalDominant:string, nuances:Array, complexEmotion:object|null, blendFactors:object, emotionalContext:object|null}}
 */
export function inferEmotionalValence(text, category = "", reactionSignals = []) {
  try {
    const engine = getEngine();
    const score = engine._t1.classify(text, "user");

    // Enrich with blend detection (sync version)
    const blend = detectBlend(score.emotion_labels, text);
    if (blend) {
      score.complex_emotion = blend;
      score.blend_factors = blend.evidence.base_blend;
    }

    return emotionScoreToLegacy(score);
  } catch (e) {
    // Fallback: alles neutral
    return {
      joy: 0, trust: 0, anticipation: 0, sadness: 0, disgust: 0,
      anger: 0, fear: 0, surprise: 0,
      emotionalIntensity: 0, emotionalDominant: "neutral",
      nuances: [], complexEmotion: null, blendFactors: {}, emotionalContext: null,
    };
  }
}

/**
 * Resolved config.tier ("t1" | "t2" | "t3" | "auto") zu forceTier (1|2|3|null).
 * @param {object} cfg
 * @returns {1|2|3|null}
 */
function resolveForceTier(cfg) {
  const tier = cfg?.tier || "auto";
  if (tier === "t1") return 1;
  if (tier === "t2") return 2;
  if (tier === "t3") return 3;
  return null; // auto → Engine-Default-Routing
}

/**
 * Asynchrone 3-Tier Emotions-Inferenz (Tier 1 → 2 → 3).
 *
 * @param {string} text
 * @param {"user" | "assistant"} [source]
 * @param {1|2|3|null} [forceTier] — überschreibt config.tier
 * @param {{agentId?: string}} [context] — provider context with the real agentId when available
 * @returns {Promise<{joy:number, trust:number, anticipation:number, sadness:number, disgust:number, anger:number, fear:number, surprise:number, emotionalIntensity:number, emotionalDominant:string, nuances:Array, complexEmotion:object|null, blendFactors:object, emotionalContext:object|null}>}
 */
export async function inferEmotionalValenceAsync(text, source = "user", forceTier = null, context = {}) {
  try {
    const engine = getEngine();
    const effectiveForceTier = forceTier ?? resolveForceTier(_emotionConfig);
    const score = await engine.analyze(text, source, effectiveForceTier, context);
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
 * Gibt ein Emoji für eine dominante Emotion oder Nuance zurück.
 */
export function emotionEmoji(dominant) {
  const map = {
    // Basisemotionen
    joy: "😊",
    trust: "🤝",
    anticipation: "👀",
    sadness: "😔",
    disgust: "🤢",
    anger: "😤",
    fear: "😰",
    surprise: "😲",
    neutral: "😐",
    // Nuancen
    relief: "😌",
    pride: "🦁",
    gratitude: "🙏",
    nostalgia: "📸",
    loneliness: "🌑",
    resentment: "😒",
    awe: "🌌",
    contempt: "😏",
    guilt: "😣",
    shame: "😳",
    hope: "🌅",
    envy: "👀",
    compassion: "💝",
    curiosity: "🤔",
    boredom: "😑",
    excitement: "🤩",
    love: "❤️",
    disappointment: "😞",
    embarrassment: "😅",
    serenity: "🧘",
    // Blends
    bittersweet: "🥺",
    schadenfreude: "😈",
    suspense: "😬",
    fiero: "🏆",
  };
  return map[dominant] || "😐";
}

// Re-exportiere die neuen Klassen und Blend-Detection für direkten Zugriff
export { EmotionEngine } from "./emotion-engine.js";
export { EmotionScore } from "./emotion-score.js";
export { detectBlend, detectTransition } from "./emotion-blends.js";
