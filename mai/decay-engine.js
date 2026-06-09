/**
 * @fileoverview DecayEngine — emotion-aware forgetting and revival logic.
 */

import { Engram } from './engram-emotion.js';

/**
 * Computes cosine similarity between two VAD vectors.
 * @param {{valence:number, arousal:number, dominance:number}} a
 * @param {{valence:number, arousal:number, dominance:number}} b
 * @returns {number} similarity in [-1, 1]
 */
function vadCosineSimilarity(a, b) {
  const v1 = [a.valence ?? 0, a.arousal ?? 0, a.dominance ?? 0];
  const v2 = [b.valence ?? 0, b.arousal ?? 0, b.dominance ?? 0];
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const mag1 = Math.sqrt(v1[0] ** 2 + v1[1] ** 2 + v1[2] ** 2);
  const mag2 = Math.sqrt(v2[0] ** 2 + v2[1] ** 2 + v2[2] ** 2);
  if (mag1 === 0 || mag2 === 0) {
    return 0;
  }
  return dot / (mag1 * mag2);
}

/**
 * Manages exponential decay, forgetting thresholds, and emotional revival.
 */
export class DecayEngine {
  /**
   * @param {Object} [params]
   * @param {number} [params.k=2.0] — intensity scaling factor for half-life
   * @param {number} [params.accessBoost=1.2] — per-access half-life multiplier base
   */
  constructor({ k = 2.0, accessBoost = 1.2 } = {}) {
    this.k = k;
    this.accessBoost = accessBoost;
  }

  /**
   * Computes the probability that an engram is still retained.
   * @param {Engram} engram
   * @param {number|null} [currentTime=null] — timestamp in ms; defaults to Date.now()
   * @returns {number} retention probability in [0, 1]
   */
  computeRetentionProbability(engram, currentTime = null) {
    const now = currentTime ?? Date.now();
    const halfLife = engram.computeDecayHalfLife(this.k);
    const ageMs = now - engram.created_at;
    const ageHours = ageMs / (1000 * 60 * 60);
    const accessMultiplier = this.accessBoost ** engram.decay_access_count;
    const effectiveHalfLife = halfLife * accessMultiplier;
    if (effectiveHalfLife <= 0) {
      return 0;
    }
    return 0.5 ** (ageHours / effectiveHalfLife);
  }

  /**
   * Determines whether an engram should be forgotten.
   * @param {Engram} engram
   * @param {number} [threshold=0.1]
   * @returns {boolean}
   */
  shouldForget(engram, threshold = 0.1) {
    const probability = this.computeRetentionProbability(engram);
    return probability < threshold;
  }

  /**
   * Filters a list of engrams to those that should be forgotten.
   * @param {Engram[]} engrams
   * @param {number} [threshold=0.1]
   * @returns {Engram[]}
   */
  getForgettableEngrams(engrams, threshold = 0.1) {
    return engrams.filter((e) => this.shouldForget(e, threshold));
  }

  /**
   * Revives an engram if it is emotionally similar to a trigger emotion.
   * @param {Engram} engram
   * @param {import('./emotion-score.js').EmotionScore} triggerEmotion
   * @param {number} [similarityThreshold=0.7]
   * @returns {boolean} true if the engram was revived
   */
  reviveIfEmotionallyRelevant(engram, triggerEmotion, similarityThreshold = 0.7) {
    if (!engram.emotion || !triggerEmotion) {
      return false;
    }
    const similarity = vadCosineSimilarity(engram.emotion, triggerEmotion);
    if (similarity > similarityThreshold) {
      engram.decay_access_count += 3;
      engram.decay_last_accessed = Date.now();
      // half-life is recomputed dynamically via computeDecayHalfLife on next call
      return true;
    }
    return false;
  }
}
