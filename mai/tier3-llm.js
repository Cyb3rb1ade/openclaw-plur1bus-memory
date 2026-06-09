/**
 * mai/tier3-llm.js — Tier-3 LLM-based emotion classifier.
 *
 * Uses an OpenAI-compatible chat client to obtain structured VAD emotion
 * scores. When no client is available, falls back to Tier-1 results or a
 * neutral baseline.
 */

import { EmotionScore } from "./emotion-score.js";

/**
 * System prompt requesting structured JSON emotion analysis.
 * Supports both German and English inputs.
 */
const SYSTEM_PROMPT = `
You are an expert emotion analyst. Analyze the emotional content of the user's message.
Respond ONLY with a JSON object containing these exact fields:
- valence: number in [-1, 1] (negative to positive)
- arousal: number in [-1, 1] (calm to excited)
- dominance: number in [-1, 1] (powerless to powerful)
- intensity: number in [0, 1] (strength of emotional signal)
- primary_emotion: string (one of: anger, disgust, fear, joy, neutral, sadness, surprise, trust, anticipation)
- secondary_emotion: string or null
- emotion_labels: object mapping emotion names to confidence scores (0-1)
- confidence: number in [0, 1] (your certainty in this analysis)
- language: "de", "en", or "mixed"

Keep the JSON compact and valid. Do not include markdown formatting or explanations.
`.trim();

/**
 * Tier-3 LLM-based emotion classifier.
 */
export class Tier3LLMClassifier {
  /**
   * @param {object} options
   * @param {object} [options.openaiClient] — OpenAI-compatible client with chat.completions.create()
   * @param {string} [options.model] — model name to use (default: "gpt-4o-mini")
   */
  constructor(options = {}) {
    this.client = options.openaiClient || null;
    this.model = options.model || "gpt-4o-mini";
  }

  /**
   * Classify emotion using an LLM.
   *
   * @param {string} text
   * @param {"user" | "assistant"} [source]
   * @param {EmotionScore|null} [tier1Result] — fallback if LLM is unavailable or fails
   * @returns {Promise<EmotionScore>}
   */
  async classify(text, source = "user", tier1Result = null) {
    if (!this.client) {
      if (tier1Result) return tier1Result;
      return this._neutralFallback(source);
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ];

    let responseText;
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0,
        max_tokens: 300,
      });
      responseText = response.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      if (tier1Result) return tier1Result;
      throw new Error(`Tier-3 LLM call failed: ${err.message}`);
    }

    // Strip markdown code fences if present
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const jsonString = jsonMatch ? jsonMatch[0] : responseText;

    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      if (tier1Result) return tier1Result;
      throw new Error(`Tier-3 JSON parse failed: ${err.message}. Raw: ${responseText}`);
    }

    return new EmotionScore({
      valence: parsed.valence ?? 0.0,
      arousal: parsed.arousal ?? 0.0,
      dominance: parsed.dominance ?? 0.0,
      intensity: parsed.intensity ?? 0.0,
      primary_emotion: parsed.primary_emotion || "neutral",
      secondary_emotion: parsed.secondary_emotion || null,
      emotion_labels: parsed.emotion_labels || {},
      language: parsed.language || "unknown",
      source,
      tier_used: 3,
      confidence: parsed.confidence ?? 0.8,
      timestamp: new Date(),
    });
  }

  /**
   * Neutral fallback when no client and no tier1 result.
   *
   * @param {"user" | "assistant"} source
   * @returns {EmotionScore}
   */
  _neutralFallback(source) {
    return new EmotionScore({
      valence: 0.0,
      arousal: 0.0,
      dominance: 0.0,
      intensity: 0.0,
      primary_emotion: "neutral",
      secondary_emotion: null,
      emotion_labels: { neutral: 1.0 },
      language: "unknown",
      source,
      tier_used: 3,
      confidence: 0.0,
      timestamp: new Date(),
    });
  }
}
