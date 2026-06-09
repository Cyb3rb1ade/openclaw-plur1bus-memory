/**
 * mai/edge-emotion.js — Graph edge with emotional resonance weighting.
 */

import { EmotionScore } from "./emotion-score.js";

/**
 * Represents a directed edge between two engrams in the memory graph.
 * Supports emotion-aware weight computation.
 */
export class Edge {
  /**
   * @param {object} props
   * @param {string} [props.source_id]
   * @param {string} [props.target_id]
   * @param {"temporal"|"semantic"|"emotional"|"associative"} [props.edge_type]
   * @param {number} [props.weight] — base weight in [0, 1]
   * @param {number} [props.emotion_weight]
   * @param {string|null} [props.shared_emotion]
   * @param {number} [props.emotional_resonance]
   */
  constructor(props = {}) {
    this.source_id = props.source_id ?? "";
    this.target_id = props.target_id ?? "";
    this.edge_type = props.edge_type ?? "associative";
    this.weight = props.weight ?? 0.0;
    this.emotion_weight = props.emotion_weight ?? 1.0;
    this.shared_emotion = props.shared_emotion ?? null;
    this.emotional_resonance = props.emotional_resonance ?? 0.0;
  }

  /**
   * Compute emotion-weighted edge strength from two EmotionScore objects.
   *
   * Algorithm:
   *   1. VAD cosine similarity
   *   2. Same-primary-emotion bonus (1.3×)
   *   3. Intensity multiplier: 1.0 + (intensity₁ × intensity₂) × 0.5
   *   4. weight = min(1.0, weight × emotion_weight)
   *
   * @param {EmotionScore|null} sourceEmotion
   * @param {EmotionScore|null} targetEmotion
   * @returns {number} — computed emotion_weight
   */
  computeEmotionWeight(sourceEmotion, targetEmotion) {
    if (!sourceEmotion || !targetEmotion) {
      this.emotional_resonance = 0.0;
      this.emotion_weight = 1.0;
      this.shared_emotion = null;
      this.weight = Math.min(1.0, this.weight * this.emotion_weight);
      return this.emotion_weight;
    }

    const v1 = sourceEmotion.toVadVector();
    const v2 = targetEmotion.toVadVector();

    let dot = 0.0;
    let norm1 = 0.0;
    let norm2 = 0.0;
    for (let i = 0; i < 3; i++) {
      dot += v1[i] * v2[i];
      norm1 += v1[i] * v1[i];
      norm2 += v2[i] * v2[i];
    }
    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    const cosineSim =
      norm1 > 0 && norm2 > 0 ? dot / (norm1 * norm2) : 0.0;

    const primary1 = sourceEmotion.primary_emotion ?? "";
    const primary2 = targetEmotion.primary_emotion ?? "";
    const samePrimary = primary1.length > 0 && primary1 === primary2;
    const primaryBonus = samePrimary ? 1.3 : 1.0;

    const intensity1 = sourceEmotion.intensity ?? 0.0;
    const intensity2 = targetEmotion.intensity ?? 0.0;
    const intensityMultiplier = 1.0 + intensity1 * intensity2 * 0.5;

    this.emotional_resonance = cosineSim;
    this.emotion_weight = cosineSim * primaryBonus * intensityMultiplier;
    this.shared_emotion = samePrimary ? primary1 : null;
    this.weight = Math.min(1.0, this.weight * this.emotion_weight);

    return this.emotion_weight;
  }
}
