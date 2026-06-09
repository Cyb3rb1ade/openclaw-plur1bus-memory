/**
 * mai/engram-emotion.js — Engram model with emotion integration and decay logic.
 */

import { EmotionScore } from "./emotion-score.js";

/**
 * Represents a single memory engram with optional emotional annotation
 * and decay metadata.
 */
export class Engram {
  /**
   * @param {object} props
   * @param {string} [props.id]
   * @param {string} [props.content]
   * @param {number[]} [props.embedding]
   * @param {Date|number} [props.created_at]
   * @param {"user"|"assistant"} [props.source]
   * @param {string} [props.session_id]
   * @param {EmotionScore|null} [props.emotion]
   * @param {number} [props.base_half_life_hours]
   * @param {number} [props.decay_half_life_hours]
   * @param {Date|number|null} [props.decay_last_accessed]
   * @param {number} [props.decay_access_count]
   */
  constructor(props = {}) {
    this.id = props.id ?? "";
    this.content = props.content ?? "";
    this.embedding = props.embedding ?? [];
    this.created_at =
      props.created_at instanceof Date
        ? props.created_at
        : new Date(props.created_at ?? Date.now());
    this.source = props.source ?? "user";
    this.session_id = props.session_id ?? "";
    this.emotion = props.emotion ?? null;
    this.base_half_life_hours = props.base_half_life_hours ?? 168.0;
    this.decay_half_life_hours = props.decay_half_life_hours ?? 168.0;
    this.decay_last_accessed =
      props.decay_last_accessed instanceof Date
        ? props.decay_last_accessed
        : props.decay_last_accessed
          ? new Date(props.decay_last_accessed)
          : null;
    this.decay_access_count = props.decay_access_count ?? 0;
  }

  /**
   * Compute decay half-life using the emotion-modulated formula:
   *   H(e) = H_base * (1 + intensity² * k) * (1 + |valence| * 0.3)
   *
   * @param {number} [k=2.0] — intensity scaling constant
   * @returns {number} — updated decay_half_life_hours
   */
  computeDecayHalfLife(k = 2.0) {
    if (!this.emotion) {
      this.decay_half_life_hours = this.base_half_life_hours;
      return this.decay_half_life_hours;
    }

    const intensity = this.emotion.intensity ?? 0.0;
    const valence = this.emotion.valence ?? 0.0;

    this.decay_half_life_hours =
      this.base_half_life_hours *
      (1 + intensity ** 2 * k) *
      (1 + Math.abs(valence) * 0.3);

    return this.decay_half_life_hours;
  }

  /**
   * Serialize to a plain object matching the LanceDB engram schema.
   * @returns {object}
   */
  toLancedbRow() {
    const row = {
      id: this.id,
      content: this.content,
      embedding: Array.isArray(this.embedding)
        ? this.embedding
        : Array.from(this.embedding ?? []),
      created_at: this.created_at ? this.created_at.getTime() : 0,
      source: this.source,
      session_id: this.session_id,
      valence: 0.0,
      arousal: 0.0,
      dominance: 0.0,
      intensity: 0.0,
      primary_emotion: "",
      emotion_labels_json: "{}",
      emotion_language: "en",
      emotion_source: "unknown",
      emotion_tier: 0,
      emotion_confidence: 0.0,
      emotion_timestamp: 0,
      vad_vector: [0.0, 0.0, 0.0],
      decay_half_life_hours: this.decay_half_life_hours,
      decay_last_accessed: this.decay_last_accessed
        ? this.decay_last_accessed.getTime()
        : 0,
      decay_access_count: this.decay_access_count,
    };

    if (this.emotion) {
      const dict = this.emotion.toDict();
      row.valence = dict.valence ?? 0.0;
      row.arousal = dict.arousal ?? 0.0;
      row.dominance = dict.dominance ?? 0.0;
      row.intensity = dict.intensity ?? 0.0;
      row.primary_emotion = dict.primary_emotion ?? "";
      row.emotion_labels_json = JSON.stringify(dict.emotion_labels ?? {});
      row.emotion_language = dict.language ?? "en";
      row.emotion_source = dict.source ?? "unknown";
      row.emotion_tier = dict.tier_used ?? 0;
      row.emotion_confidence = dict.confidence ?? 0.0;
      row.emotion_timestamp = dict.timestamp ?? 0;
      row.vad_vector = Array.from(this.emotion.toVadVector());
    }

    return row;
  }

  /**
   * Deserialize a LanceDB row into an Engram instance.
   * @param {object} row
   * @returns {Engram}
   */
  static fromLancedbRow(row) {
    const props = {
      id: row.id ?? "",
      content: row.content ?? "",
      embedding: row.embedding ?? [],
      created_at: row.created_at ? new Date(Number(row.created_at)) : new Date(),
      source: row.source ?? "user",
      session_id: row.session_id ?? "",
      base_half_life_hours: row.decay_half_life_hours ?? 168.0,
      decay_half_life_hours: row.decay_half_life_hours ?? 168.0,
      decay_last_accessed: row.decay_last_accessed
        ? new Date(Number(row.decay_last_accessed))
        : null,
      decay_access_count: row.decay_access_count ?? 0,
    };

    const hasEmotion =
      row.primary_emotion || (row.emotion_timestamp && row.emotion_timestamp > 0);

    if (hasEmotion) {
      props.emotion = new EmotionScore({
        valence: row.valence ?? 0.0,
        arousal: row.arousal ?? 0.0,
        dominance: row.dominance ?? 0.0,
        intensity: row.intensity ?? 0.0,
        primary_emotion: row.primary_emotion ?? "",
        secondary_emotion: "",
        emotion_labels: (() => {
          try {
            return JSON.parse(row.emotion_labels_json || "{}");
          } catch {
            return {};
          }
        })(),
        language: row.emotion_language ?? "en",
        source: row.emotion_source ?? "unknown",
        tier_used: row.emotion_tier ?? 0,
        confidence: row.emotion_confidence ?? 0.0,
        timestamp: row.emotion_timestamp ?? 0,
      });
    } else {
      props.emotion = null;
    }

    return new Engram(props);
  }
}
