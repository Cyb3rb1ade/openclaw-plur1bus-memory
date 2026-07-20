/**
 * mai/tier3-llm.js — Tier-3 LLM-based emotion classifier.
 *
 * Uses an OpenAI-compatible chat client to obtain structured VAD emotion
 * scores. When no client is available, falls back to Tier-1 results or a
 * neutral baseline.
 *
 * v2: Lazy client initialization — client is created on first classify()
 * if apiKey is provided, avoiding top-level await in register().
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
   * @param {object} [options.openaiClient] — Pre-built OpenAI-compatible client
   * @param {string} [options.apiKey] — API key for lazy client init
   * @param {string} [options.baseUrl] — Base URL for lazy client init
   * @param {string} [options.model] — explicit model for the direct client path
   * @param {Function} [options.callLlm] — plugin-internal LLM fn (messages, context) => string; preferred over apiKey
   */
  constructor(options = {}) {
    this.client = options.openaiClient || null;
    this.apiKey = options.apiKey || null;
    this.baseUrl = options.baseUrl || null;
    this._callLlm = options.callLlm || null;
    this.model = !this._callLlm && typeof options.model === "string" && options.model.trim()
      ? options.model.trim()
      : undefined;
    this._initPromise = null;
  }

  /**
   * Lazily initialize the OpenAI client if apiKey is available.
   * @returns {Promise<object|null>}
   */
  async _ensureClient() {
    if (this.client) return this.client;
    if (!this.apiKey || !this.model) return null;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        const { default: OpenAI } = await import("openai");
        this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseUrl || undefined });
        return this.client;
      } catch (err) {
        return null;
      }
    })();

    return this._initPromise;
  }

  /**
   * Classify emotion using an LLM.
   *
   * @param {string} text
   * @param {"user" | "assistant"} [source]
   * @param {EmotionScore|null} [tier1Result] — fallback if LLM is unavailable or fails
   * @param {{agentId?: string}} [context] — provider context with agentId when available
   * @returns {Promise<EmotionScore>}
   */
  async classify(text, source = "user", tier1Result = null, context = {}) {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ];

    let responseText;
    if (this._callLlm) {
      try {
        responseText = (await this._callLlm(messages, context)) || "";
      } catch (err) {
        if (tier1Result) return tier1Result;
        return this._neutralFallback(source);
      }
    } else {
      if (!this.model) {
        if (tier1Result) return tier1Result;
        return this._neutralFallback(source);
      }
      const client = await this._ensureClient();
      if (!client) {
        if (tier1Result) return tier1Result;
        return this._neutralFallback(source);
      }
      try {
        const response = await client.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: 300,
        });
        responseText = response.choices?.[0]?.message?.content?.trim() || "";
      } catch (err) {
        if (tier1Result) return tier1Result;
        throw new Error(`Tier-3 LLM call failed: ${err.message}`, { cause: err });
      }
    }

    // Strip markdown code fences if present
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const jsonString = jsonMatch ? jsonMatch[0] : responseText;

    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      if (tier1Result) return tier1Result;
      throw new Error(`Tier-3 JSON parse failed: ${err.message}. Raw: ${responseText}`, { cause: err });
    }

    try {
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
    } catch (err) {
      if (tier1Result) return tier1Result;
      return this._neutralFallback(source);
    }
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
