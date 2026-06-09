/**
 * mai/tier2-transformer.js — Tier-2 transformer-based emotion classifier.
 *
 * Intended to run an ONNX XLM-RoBERTa emotion model. In pure Node.js without
 * native ONNX bindings, this implementation provides a keyword-density fallback
 * that mimics transformer-style multi-label emotion scoring.
 *
 * Real ONNX integration points are marked with [ONNX-TODO] comments.
 */

import { EmotionScore } from "./emotion-score.js";

/**
 * Labels expected from the XLM-RoBERTa emotion classifier.
 * @type {string[]}
 */
const XLM_EMO_LABELS = [
  "anger",
  "disgust",
  "fear",
  "joy",
  "neutral",
  "sadness",
  "surprise",
];

/**
 * VAD mapping for Tier-2 (slightly adjusted from Tier-1).
 * @type {Record<string, {v: number, a: number, d: number}>}
 */
const EMOTION_VAD_T2 = {
  anger:    { v: -0.60, a: 0.60, d: 0.40 },
  disgust:  { v: -0.55, a: 0.25, d: 0.15 },
  fear:     { v: -0.64, a: 0.60, d: -0.30 },
  joy:      { v: 0.80, a: 0.40, d: 0.30 },
  neutral:  { v: 0.00, a: 0.00, d: 0.00 },
  sadness:  { v: -0.70, a: -0.20, d: -0.40 },
  surprise: { v: 0.20, a: 0.80, d: 0.10 },
};

/**
 * Keyword buckets used by the fallback density scorer.
 * Each label gets a set of representative tokens.
 * @type {Record<string, string[]>}
 */
const FALLBACK_KEYWORDS = {
  anger:    ["angry", "mad", "furious", "rage", "hate", "annoyed", "irritated", "wütend", "zornig", "ärger", "böse"],
  disgust:  ["disgust", "gross", "revulsion", "nasty", "vile", "sick", "ekel", "widerlich", "abscheu", "übel"],
  fear:     ["fear", "afraid", "scared", "terrified", "anxious", "panic", "angst", "ängstlich", "furcht", "panik"],
  joy:      ["joy", "happy", "glad", "delighted", "love", "wonderful", "glücklich", "freude", "froh", "begeistert", "toll"],
  neutral:  ["normal", "average", "standard", "usual", "okay", "ok", "fine", "normal", "durchschnittlich", "üblich"],
  sadness:  ["sad", "depressed", "grief", "sorrow", "miserable", "traurig", "trauer", "deprimiert", "elend", "kummer"],
  surprise: ["surprise", "shocked", "amazed", "astonished", "wow", "überraschung", "erstaunt", "schockiert", "plötzlich"],
};

/**
 * Tier-2 transformer-based emotion classifier.
 */
export class Tier2TransformerClassifier {
  /**
   * @param {object} [options]
   * @param {string} [options.modelName] — HuggingFace model id or local path
   * @param {string} [options.onnxDir] — directory containing ONNX artefacts
   */
  constructor(options = {}) {
    this.modelName = options.modelName || "j-hartmann/emotion-english-distilroberta-base";
    this.onnxDir = options.onnxDir || null;
    this._session = null; // [ONNX-TODO] onnxruntime.InferenceSession
  }

  /**
   * Detect whether the text is primarily German using common word heuristics.
   *
   * @param {string} text
   * @returns {"de" | "en" | "mixed"}
   */
  _detectLanguage(text) {
    const lower = text.toLowerCase();
    const germanMarkers = [
      "der", "die", "das", "und", "ist", "ein", "eine", "zu", "mit", "auf",
      "für", "von", "den", "dem", "nicht", "sich", "ich", "du", "er", "sie",
      "es", "wir", "ihr", "sie", "im", "an", "als", "auch", "bei", "noch",
      "nur", "so", "war", "wird", "hat", "haben", "werden", "kann", "muss",
    ];
    const hits = germanMarkers.filter((w) => lower.includes(` ${w} `) || lower.startsWith(`${w} `)).length;
    return hits >= 3 ? "de" : "en";
  }

  /**
   * [ONNX-TODO] Load the ONNX model into an InferenceSession.
   *
   * In a real deployment this would:
   *   1. Import `onnxruntime-node`
   *   2. Call `onnxruntime.InferenceSession.create(path)`
   *   3. Cache tokenizer (e.g. `transformers.AutoTokenizer`)
   *   4. Store session in `this._session`
   *
   * For now this is a no-op stub because native ONNX dependencies are not
   * bundled in the base plugin.
   */
  async loadModel() {
    // [ONNX-TODO] Implement when onnxruntime-node is available.
    // Example:
    //   const ort = await import("onnxruntime-node");
    //   this._session = await ort.InferenceSession.create(
    //     `${this.onnxDir}/model.onnx`
    //   );
    this._session = null;
  }

  /**
   * Classify emotion from raw text.
   *
   * When an ONNX session is unavailable, falls back to keyword-density
   * scoring that approximates transformer logits with a softmax.
   *
   * @param {string} text
   * @param {"user" | "assistant"} [source]
   * @returns {EmotionScore}
   */
  classify(text, source = "user") {
    // [ONNX-TODO] If this._session is present, run real ONNX inference:
    //   1. Tokenize text → input_ids, attention_mask
    //   2. Create ort.Tensor objects
    //   3. Run session.run({ input_ids, attention_mask })
    //   4. Apply softmax to logits
    //   5. Map argmax label → EmotionScore
    //
    // Until then, use the keyword-density fallback below.

    const words = text.toLowerCase().match(/\b\w+\b/g) || [];
    const lang = this._detectLanguage(text);

    // Count keyword hits per label
    const counts = {};
    for (const label of XLM_EMO_LABELS) {
      counts[label] = 0;
    }
    let totalHits = 0;
    for (const w of words) {
      for (const label of XLM_EMO_LABELS) {
        const keywords = FALLBACK_KEYWORDS[label] || [];
        if (keywords.includes(w)) {
          counts[label] += 1;
          totalHits += 1;
        }
      }
    }

    // If no keyword hits, bias slightly toward neutral so we still return a score
    if (totalHits === 0) {
      counts["neutral"] = 0.1;
      totalHits = 0.1;
    }

    // Softmax-like normalization
    const maxCount = Math.max(...Object.values(counts));
    const expScores = {};
    let sumExp = 0;
    for (const label of XLM_EMO_LABELS) {
      const score = Math.exp((counts[label] - maxCount));
      expScores[label] = score;
      sumExp += score;
    }

    const probs = {};
    for (const label of XLM_EMO_LABELS) {
      probs[label] = expScores[label] / sumExp;
    }

    // Primary = argmax, secondary = second best
    let primary = "neutral";
    let secondary = null;
    let best = -Infinity;
    let secondBest = -Infinity;
    for (const label of XLM_EMO_LABELS) {
      const p = probs[label];
      if (p > best) {
        secondBest = best;
        secondary = primary;
        best = p;
        primary = label;
      } else if (p > secondBest) {
        secondBest = p;
        secondary = label;
      }
    }
    if (best - secondBest > 0.3) secondary = null;

    const vad = EMOTION_VAD_T2[primary] || EMOTION_VAD_T2.neutral;

    // Intensity based on distance from neutral in VAD space
    const intensity = Math.min(
      1.0,
      Math.sqrt(vad.v * vad.v + vad.a * vad.a + vad.d * vad.d) / Math.sqrt(3)
    );

    // Confidence: higher when many keyword hits relative to text length
    const confidence = Math.min(
      1.0,
      (totalHits / Math.max(1, words.length)) * 1.5 + 0.2
    );

    return new EmotionScore({
      valence: vad.v,
      arousal: vad.a,
      dominance: vad.d,
      intensity,
      primary_emotion: primary,
      secondary_emotion: secondary,
      emotion_labels: probs,
      language: lang,
      source,
      tier_used: 2,
      confidence,
      timestamp: new Date(),
    });
  }
}
