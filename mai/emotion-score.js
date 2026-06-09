/**
 * mai/emotion-score.js — Universal emotion representation for PLUR1BUS.
 *
 * VAD-based emotion score with validation, serialization, and vector output.
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
  }

  toDict() {
    return {
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
