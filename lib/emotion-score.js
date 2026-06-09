/**
 * mai/emotion-score.js — Universal emotion representation for PLUR1BUS.
 *
 * VAD-based emotion score with validation, serialization, and vector output.
 * v2: Added nuances, complex_emotion, emotional_context, blend_factors.
 */

export class EmotionScore {
  /**
   * @param {object} props
   * @param {number} [props.valence] — -1 (negativ) bis +1 (positiv)
   * @param {number} [props.arousal] — -1 (ruhig) bis +1 (aufgeregt)
   * @param {number} [props.dominance] — -1 (ohnmächtig) bis +1 (mächtig)
   * @param {number} [props.intensity] — 0.0 bis 1.0
   * @param {string} [props.primary_emotion]
   * @param {string|null} [props.secondary_emotion]
   * @param {object} [props.emotion_labels]
   * @param {"de"|"en"|"mixed"|"unknown"} [props.language]
   * @param {"user"|"assistant"} [props.source]
   * @param {1|2|3} [props.tier_used]
   * @param {number} [props.confidence] — 0.0 bis 1.0
   * @param {Date|number|string} [props.timestamp]
   * @param {Nuance[]} [props.nuances] — detected emotional nuances
   * @param {ComplexEmotion|null} [props.complex_emotion] — detected blend
   * @param {EmotionalContext|null} [props.emotional_context] — mini context window
   * @param {object} [props.blend_factors] — base emotion shares for blends
   */
  constructor(props = {}) {
    this.valence = props.valence ?? 0.0;
    this.arousal = props.arousal ?? 0.0;
    this.dominance = props.dominance ?? 0.0;
    this.intensity = props.intensity ?? 0.0;
    this.primary_emotion = props.primary_emotion ?? "neutral";
    this.secondary_emotion = props.secondary_emotion ?? null;
    this.emotion_labels = props.emotion_labels ?? {};
    this.language = props.language ?? "unknown";
    this.source = props.source ?? "user";
    this.tier_used = props.tier_used ?? 1;
    this.confidence = props.confidence ?? 1.0;

    // v2 fields
    this.nuances = props.nuances ?? [];
    this.complex_emotion = props.complex_emotion ?? null;
    this.emotional_context = props.emotional_context ?? null;
    this.blend_factors = props.blend_factors ?? {};

    const ts = props.timestamp;
    if (ts instanceof Date) {
      this.timestamp = ts;
    } else if (typeof ts === "number") {
      this.timestamp = new Date(ts);
    } else if (typeof ts === "string") {
      this.timestamp = new Date(ts);
    } else {
      this.timestamp = new Date();
    }

    this._validate();
  }

  _validate() {
    for (const field of ["valence", "arousal", "dominance"]) {
      const val = this[field];
      if (val < -1.0 || val > 1.0) {
        throw new Error(`${field} must be in [-1, 1], got ${val}`);
      }
    }
    if (this.intensity < 0.0 || this.intensity > 1.0) {
      throw new Error(`intensity must be in [0, 1], got ${this.intensity}`);
    }
    if (this.confidence < 0.0 || this.confidence > 1.0) {
      throw new Error(`confidence must be in [0, 1], got ${this.confidence}`);
    }

    // Validate nuances
    if (Array.isArray(this.nuances)) {
      for (const n of this.nuances) {
        if (n.intensity !== undefined && (n.intensity < 0 || n.intensity > 1)) {
          throw new Error(`nuance intensity must be in [0, 1], got ${n.intensity}`);
        }
        if (n.confidence !== undefined && (n.confidence < 0 || n.confidence > 1)) {
          throw new Error(`nuance confidence must be in [0, 1], got ${n.confidence}`);
        }
      }
    }

    // Validate complex_emotion
    if (this.complex_emotion) {
      const ce = this.complex_emotion;
      if (ce.confidence !== undefined && (ce.confidence < 0 || ce.confidence > 1)) {
        throw new Error(`complex_emotion confidence must be in [0, 1], got ${ce.confidence}`);
      }
    }
  }

  toDict() {
    const dict = {
      valence: round4(this.valence),
      arousal: round4(this.arousal),
      dominance: round4(this.dominance),
      intensity: round4(this.intensity),
      primary_emotion: this.primary_emotion,
      secondary_emotion: this.secondary_emotion,
      emotion_labels: roundDict(this.emotion_labels),
      language: this.language,
      source: this.source,
      tier_used: this.tier_used,
      confidence: round4(this.confidence),
      timestamp: this.timestamp.toISOString(),
    };

    if (this.nuances.length > 0) {
      dict.nuances = this.nuances;
    }
    if (this.complex_emotion) {
      dict.complex_emotion = this.complex_emotion;
    }
    if (this.emotional_context) {
      dict.emotional_context = this.emotional_context;
    }
    if (Object.keys(this.blend_factors).length > 0) {
      dict.blend_factors = roundDict(this.blend_factors);
    }

    return dict;
  }

  /**
   * @param {object} data
   * @returns {EmotionScore}
   */
  static fromDict(data) {
    const copy = { ...data };
    delete copy.timestamp;
    return new EmotionScore(copy);
  }

  toVadVector() {
    return new Float32Array([this.valence, this.arousal, this.dominance]);
  }

  get isHighIntensity() {
    return this.intensity > 0.6;
  }

  get isAmbivalent() {
    return Math.abs(this.valence) < 0.2;
  }

  /**
   * Get the effective emotional label for display.
   * Prefers complex_emotion > primary_emotion > neutral.
   */
  get effectiveLabel() {
    if (this.complex_emotion?.label) {
      return this.complex_emotion.label;
    }
    if (this.primary_emotion && this.primary_emotion !== "neutral") {
      return this.primary_emotion;
    }
    if (this.nuances.length > 0) {
      return this.nuances[0].label;
    }
    return "neutral";
  }

  /**
   * Get all active emotion labels sorted by intensity.
   */
  get activeEmotions() {
    const entries = Object.entries(this.emotion_labels)
      .filter(([, v]) => v > 0.1)
      .sort((a, b) => b[1] - a[1]);
    return entries.map(([k, v]) => ({ label: k, intensity: v }));
  }
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function roundDict(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "number" ? round4(v) : v;
  }
  return out;
}

/**
 * @typedef {object} Nuance
 * @property {string} label
 * @property {number} [intensity]
 * @property {number} [confidence]
 * @property {string} [source]
 * @property {string} [language]
 */

/**
 * @typedef {object} ComplexEmotion
 * @property {string} label
 * @property {number} [confidence]
 * @property {object} [evidence]
 * @property {object} [evidence.base_blend]
 * @property {string} [evidence.semantic_trigger]
 * @property {string} [evidence.polarity_toward_target]
 */

/**
 * @typedef {object} EmotionalContext
 * @property {string} [previous_top_emotion]
 * @property {string} [previous_timestamp]
 * @property {string} [transition]
 * @property {string} [target_entity]
 */
