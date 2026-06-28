/**
 * mai/emotion-engine.js — Core emotion analysis engine.
 *
 * Orchestrates Tier-1 (lexicon), Tier-2 (transformer), and Tier-3 (LLM)
 * classifiers with intelligent routing, stats tracking, and fallback handling.
 */

import { EmotionScore } from "./emotion-score.js";
import { Tier1LexiconClassifier } from "./tier1-lexicon.js";
import { Tier2TransformerClassifier } from "./tier2-transformer.js";
import { Tier3LLMClassifier } from "./tier3-llm.js";
import { detectBlend, detectTransition } from "./emotion-blends.js";

const TIER1_AMBIVALENCE_THRESHOLD = 0.2;
const TIER2_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Core emotion analysis engine with tiered routing.
 */
export class EmotionEngine {
  /**
   * @param {object} [config]
   * @param {object} [config.tier1] — options passed to Tier1LexiconClassifier
   * @param {object} [config.tier2] — options passed to Tier2TransformerClassifier
   * @param {object} [config.tier3] — options passed to Tier3LLMClassifier
   */
  constructor(config = {}) {
    this._config = config;
    this._tier1 = null;
    this._tier2 = null;
    this._tier3 = null;

    /** @type {boolean} — Budget-Gate: t3 darf nur laufen wenn explizit enabled + mindestens ein Provider */
    this._t3Enabled = config.tier3?.enabled === true && (!!config.tier3?.apiKey || !!config.tier3?.openaiClient || !!config.tier3?.callLlm);
    /** @type {boolean} — t2 kann disabled werden (z.B. wenn ONNX-Modell fehlt) */
    this._t2Enabled = config.tier2?.enabled !== false;

    /** @type {{ tier1: number, tier2: number, tier3: number, total_ms: number }} */
    this._stats = {
      tier1: 0,
      tier2: 0,
      tier3: 0,
      total_ms: 0,
    };

    /** @type {{ previous_top_emotion: string|null, previous_timestamp: string|null }} */
    this._context = {
      previous_top_emotion: null,
      previous_timestamp: null,
    };
  }

  /** @returns {Tier1LexiconClassifier} */
  get _t1() {
    if (!this._tier1) this._tier1 = new Tier1LexiconClassifier(this._config.tier1);
    return this._tier1;
  }

  /** @returns {Tier2TransformerClassifier} */
  get _t2() {
    if (!this._tier2) this._tier2 = new Tier2TransformerClassifier(this._config.tier2);
    return this._tier2;
  }

  /** @returns {Tier3LLMClassifier} */
  get _t3() {
    if (!this._tier3) {
      this._tier3 = new Tier3LLMClassifier({
        model: this._config.tier3?.model || "gpt-4o-mini",
        openaiClient: this._config.tier3?.openaiClient || null,
        apiKey: this._config.tier3?.apiKey || null,
        baseUrl: this._config.tier3?.baseUrl || null,
        callLlm: this._config.tier3?.callLlm || null,
      });
    }
    return this._tier3;
  }

  /**
   * Analyze text and return an EmotionScore.
   *
   * Routing logic:
   *   - forceTier=1 → tier1 only, fallback if null
   *   - forceTier=2 → tier2 only
   *   - forceTier=3 → tier3 only
   *   - Default:
   *     1. Try tier1.
   *     2. If tier1 returns null → tier2 → if tier2 confidence < 0.7 → tier3.
   *     3. If tier1 is ambivalent or confidence < 0.5 → tier2.
   *        If tier2 confidence > tier1.confidence + 0.2, use tier2.
   *        If tier2 confidence < 0.7, escalate to tier3.
   *     4. Else use tier1.
   *
   * @param {string} text
   * @param {"user" | "assistant"} [source]
   * @param {1|2|3|null} [forceTier]
   * @returns {Promise<EmotionScore>}
   */
  async analyze(text, source = "user", forceTier = null) {
    const start = Date.now();
    let result;

    if (forceTier === 1) {
      result = this._tier1Only(text, source);
    } else if (forceTier === 2) {
      result = this._tier2Only(text, source);
    } else if (forceTier === 3) {
      result = await this._tier3Only(text, source);
    } else {
      result = await this._defaultRouting(text, source);
    }

    // Enrich with blends and context
    result = this._enrichWithBlends(result, text);

    // Update context window for next call
    this._context.previous_top_emotion = result.primary_emotion;
    this._context.previous_timestamp = new Date().toISOString();

    const elapsed = Date.now() - start;
    this._stats.total_ms += elapsed;
    if (result.tier_used === 1) this._stats.tier1 += 1;
    else if (result.tier_used === 2) this._stats.tier2 += 1;
    else if (result.tier_used === 3) this._stats.tier3 += 1;

    return result;
  }

  /**
   * Enrich an EmotionScore with blend detection and transition context.
   *
   * @param {EmotionScore} score
   * @param {string} text
   * @returns {EmotionScore}
   */
  _enrichWithBlends(score, text) {
    const blend = detectBlend(score.emotion_labels, text, this._context);
    if (blend) {
      score.complex_emotion = blend;
      score.blend_factors = blend.evidence.base_blend;
    }

    const transition = detectTransition(score.primary_emotion, this._context);
    if (transition) {
      score.emotional_context = {
        previous_top_emotion: this._context.previous_top_emotion,
        previous_timestamp: this._context.previous_timestamp,
        transition,
        target_entity: null,
      };
    }

    return score;
  }

  /**
   * Tier-1 only with fallback.
   *
   * @param {string} text
   * @param {"user" | "assistant"} source
   * @returns {EmotionScore}
   */
  _tier1Only(text, source) {
    const r = this._t1.classify(text, source);
    if (r) return r;
    return this._fallbackScore(source);
  }

  /**
   * Tier-2 only.
   *
   * @param {string} text
   * @param {"user" | "assistant"} source
   * @returns {EmotionScore}
   */
  _tier2Only(text, source) {
    if (!this._t2Enabled) {
      return this._tier1Only(text, source);
    }
    return this._t2.classify(text, source);
  }

  /**
   * Tier-3 only.
   *
   * @param {string} text
   * @param {"user" | "assistant"} source
   * @returns {Promise<EmotionScore>}
   */
  async _tier3Only(text, source) {
    if (!this._t3Enabled) {
      return this._fallbackScore(source);
    }
    return this._t3.classify(text, source);
  }

  /**
   * Default multi-tier routing.
   *
   * @param {string} text
   * @param {"user" | "assistant"} source
   * @returns {Promise<EmotionScore>}
   */
  async _defaultRouting(text, source) {
    const t1 = this._t1.classify(text, source);

    // No tier1 match → tier2 → maybe tier3 (if enabled)
    if (!t1) {
      if (!this._t2Enabled) {
        return this._fallbackScore(source);
      }
      const t2 = this._t2.classify(text, source);
      if (t2.confidence >= TIER2_CONFIDENCE_THRESHOLD) {
        return t2;
      }
      if (this._t3Enabled) {
        return this._t3.classify(text, source, t2);
      }
      return t2; // t2 auch bei niedriger Confidence, wenn t3 nicht verfügbar
    }

    // Tier1 ambivalent or low confidence → try tier2
    const t1Ambivalent = Math.abs(t1.valence) < TIER1_AMBIVALENCE_THRESHOLD;
    const t1Weak = t1.confidence < 0.5;
    if (t1Ambivalent || t1Weak) {
      if (!this._t2Enabled) {
        return t1; // kein t2 verfügbar → bleibe bei t1
      }
      const t2 = this._t2.classify(text, source);
      if (t2.confidence > t1.confidence + 0.2) {
        if (t2.confidence >= TIER2_CONFIDENCE_THRESHOLD) {
          return t2;
        }
        if (this._t3Enabled) {
          return this._t3.classify(text, source, t2);
        }
        return t2;
      }
      // Tier2 not clearly better; escalate to tier3 if enabled, else stay with t1
      if (t2.confidence < TIER2_CONFIDENCE_THRESHOLD) {
        if (this._t3Enabled) {
          return this._t3.classify(text, source, t1);
        }
        return t1;
      }
    }

    return t1;
  }

  /**
   * Fallback score when all tiers fail or are unavailable.
   *
   * @param {"user" | "assistant"} source
   * @returns {EmotionScore}
   */
  _fallbackScore(source) {
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
      tier_used: 1,
      confidence: 0.0,
      timestamp: new Date(),
    });
  }

  /**
   * Get usage statistics with percentages and average latency.
   *
   * @returns {object}
   */
  get stats() {
    const total = this._stats.tier1 + this._stats.tier2 + this._stats.tier3;
    const avgMs = total > 0 ? this._stats.total_ms / total : 0;
    return {
      ...this._stats,
      total,
      pct_tier1: total > 0 ? Math.round((this._stats.tier1 / total) * 1000) / 10 : 0,
      pct_tier2: total > 0 ? Math.round((this._stats.tier2 / total) * 1000) / 10 : 0,
      pct_tier3: total > 0 ? Math.round((this._stats.tier3 / total) * 1000) / 10 : 0,
      avg_ms: Math.round(avgMs * 10) / 10,
    };
  }
}
