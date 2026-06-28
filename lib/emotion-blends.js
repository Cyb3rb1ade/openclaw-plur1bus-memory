/**
 * lib/emotion-blends.js — Emotional blend detection for PLUR1BUS.
 *
 * Detects complex emotions (blends) from base emotion combinations,
 * semantic triggers, and optional context transitions.
 *
 * Blends are NOT just "2 emotions active". They require:
 *   - Base emotion combination
 *   - Semantic trigger (contextual clue)
 *   - Confidence threshold
 *   - Optional: previous emotional state for transitions like relief
 */

/**
 * Blend rule definition.
 * @typedef {object} BlendRule
 * @property {string} label — blend name
 * @property {string[]} requiredEmotions — base emotions that must be present
 * @property {number} minIntensity — minimum intensity for each required emotion
 * @property {string[]} [semanticTriggers] — keywords that suggest this blend
 * @property {string} [transitionFrom] — previous emotion for transition-based blends (e.g. relief needs fear)
 * @property {number} confidenceBoost — bonus confidence when triggers match
 */

/** @type {BlendRule[]} */
const BLEND_RULES = [
  {
    label: "bittersweet",
    requiredEmotions: ["joy", "sadness"],
    minIntensity: 0.25,
    semanticTriggers: ["farewell", "goodbye", "last", "final", "memories", "erinnerung", "abschied", "letztes"],
    confidenceBoost: 0.15,
  },
  {
    label: "schadenfreude",
    requiredEmotions: ["joy", "anger"],
    minIntensity: 0.25,
    semanticTriggers: ["failed", "screwed up", "got what", "deserved", "karma", "scheitern", "versagen", "verdient", "selbst schuld"],
    confidenceBoost: 0.20,
  },
  {
    label: "awe",
    requiredEmotions: ["surprise", "fear"],
    minIntensity: 0.25,
    semanticTriggers: ["overwhelming", "magnificent", "immense", "grand", "gewaltig", "überwältigend", "mächtig", "ehrfurcht"],
    confidenceBoost: 0.15,
  },
  {
    label: "melancholy",
    requiredEmotions: ["sadness", "trust"],
    minIntensity: 0.20,
    semanticTriggers: ["past", "used to", "once", "remember when", "früher", "damals", "einst", "frühere"],
    confidenceBoost: 0.15,
  },
  {
    label: "suspense",
    requiredEmotions: ["anticipation", "fear"],
    minIntensity: 0.25,
    semanticTriggers: ["waiting", "what if", "about to", "edge", "spannt", "was wäre wenn", "gleich passiert"],
    confidenceBoost: 0.15,
  },
  {
    label: "love",
    requiredEmotions: ["trust", "joy"],
    minIntensity: 0.35,
    semanticTriggers: ["love", "adore", "heart", "cherish", "liebe", "verehren", "herz", "zusammen"],
    confidenceBoost: 0.10,
  },
  {
    label: "contempt",
    requiredEmotions: ["anger", "disgust"],
    minIntensity: 0.25,
    semanticTriggers: ["beneath", "pathetic", "inferior", "lächerlich", "minderwertig", "verachtung"],
    confidenceBoost: 0.15,
  },
  {
    label: "fiero",
    requiredEmotions: ["joy", "trust"],
    minIntensity: 0.30,
    semanticTriggers: ["overcame", "defeated", "won", "achieved", "überwunden", "geschafft", "sieg", "erfolg"],
    confidenceBoost: 0.20,
  },
  {
    label: "relief",
    requiredEmotions: ["joy"],
    minIntensity: 0.30,
    transitionFrom: "fear",
    semanticTriggers: ["phew", "finally", "over", "safe", "geschafft", "vorbei", "sicher", "zum glück"],
    confidenceBoost: 0.20,
  },
  {
    label: "disappointment",
    requiredEmotions: ["sadness", "anticipation"],
    minIntensity: 0.25,
    semanticTriggers: ["expected", "hoped", "would be", "thought it", "erwartet", "gehofft", "gedacht"],
    confidenceBoost: 0.15,
  },
  {
    label: "nostalgia",
    requiredEmotions: ["joy", "sadness"],
    minIntensity: 0.20,
    semanticTriggers: ["childhood", "old days", "remember", "used to", "kindheit", "alte zeiten", "damals", "früher"],
    confidenceBoost: 0.20,
  },
];

function normalizeText(text) {
  return typeof text === "string" ? text : "";
}

/**
 * Detect emotional blends from emotion labels, text, and optional context.
 *
 * @param {object} emotionLabels — { emotion: intensity, ... }
 * @param {string} text — original text for semantic trigger matching
 * @param {object|null} context — { previous_top_emotion: string }
 * @returns {object|null} — blend object or null
 */
export function detectBlend(emotionLabels, text, context = null) {
  if (!emotionLabels || Object.keys(emotionLabels).length === 0) return null;

  const lowerText = normalizeText(text).toLowerCase();
  let bestBlend = null;
  let bestConfidence = 0;

  for (const rule of BLEND_RULES) {
    // Check required emotions
    const present = rule.requiredEmotions.filter((emo) => {
      const intensity = emotionLabels[emo] || 0;
      return intensity >= rule.minIntensity;
    });

    // For transition-based blends (e.g. relief), check previous emotion
    if (rule.transitionFrom) {
      const hasCurrent = present.length >= 1;
      const hasTransition = context?.previous_top_emotion === rule.transitionFrom;
      if (!hasCurrent || !hasTransition) continue;
    } else {
      // Standard: need at least 2 required emotions, or all if only 2 defined
      const minRequired = rule.requiredEmotions.length >= 2 ? 2 : rule.requiredEmotions.length;
      if (present.length < minRequired) continue;
    }

    // Calculate base confidence from emotion intensities
    let confidence = present.reduce((sum, emo) => sum + (emotionLabels[emo] || 0), 0) / present.length;

    // Check semantic triggers
    let triggerMatch = null;
    if (rule.semanticTriggers) {
      for (const trigger of rule.semanticTriggers) {
        if (lowerText.includes(trigger)) {
          confidence += rule.confidenceBoost;
          triggerMatch = trigger;
          break;
        }
      }
    }

    // Transition boost
    if (rule.transitionFrom && context?.previous_top_emotion === rule.transitionFrom) {
      confidence += 0.15;
    }

    confidence = Math.min(1.0, confidence);

    // Threshold: mit Trigger = 0.45, ohne Trigger = 0.5 (starke Emotionen nötig)
    const threshold = triggerMatch ? 0.45 : 0.5;
    if (confidence < threshold) continue;

    if (confidence > bestConfidence) {
      bestConfidence = confidence;

      // Build blend_factors from required emotions
      const blendFactors = {};
      for (const emo of rule.requiredEmotions) {
        blendFactors[emo] = emotionLabels[emo] || 0;
      }
      // Add transition source if applicable
      if (rule.transitionFrom) {
        blendFactors[rule.transitionFrom] = emotionLabels[rule.transitionFrom] || 0.3;
      }

      bestBlend = {
        label: rule.label,
        confidence: Math.round(confidence * 1000) / 1000,
        evidence: {
          base_blend: blendFactors,
          semantic_trigger: triggerMatch || "co_occurrence",
          polarity_toward_target: inferPolarity(rule.label),
        },
      };
    }
  }

  return bestBlend;
}

/**
 * Infer polarity direction for a blend.
 */
function inferPolarity(blendLabel) {
  const negative = ["schadenfreude", "contempt", "resentment", "disappointment"];
  const positive = ["love", "fiero", "relief", "gratitude", "pride"];
  if (negative.includes(blendLabel)) return "negative";
  if (positive.includes(blendLabel)) return "positive";
  return "mixed";
}

/**
 * Detect emotional transition from context.
 *
 * @param {string} currentPrimary
 * @param {object|null} context
 * @returns {string|null}
 */
export function detectTransition(currentPrimary, context) {
  if (!context?.previous_top_emotion) return null;
  const prev = context.previous_top_emotion;
  if (prev === currentPrimary) return null;
  return `${prev}_to_${currentPrimary}`;
}
