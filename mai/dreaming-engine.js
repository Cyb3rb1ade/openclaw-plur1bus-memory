/**
 * @fileoverview DreamingEngine — REM-style consolidation with emotion amplification.
 */

import { Engram } from './engram-emotion.js';

/**
 * Performs REM-style consolidation on engrams, amplifying emotionally salient memories.
 */
export class DreamingEngine {
  /**
   * @param {Object} params
   * @param {Object} params.emotionEngine — EmotionEngine instance
   */
  constructor({ emotionEngine }) {
    this.emotionEngine = emotionEngine;
  }

  /**
   * Consolidates a batch of engrams based on emotional profiles.
   * @param {Engram[]} engrams
   * @returns {Engram[]} the consolidated engrams (mutated in place)
   */
  consolidate(engrams) {
    for (const engram of engrams) {
      if (!engram.emotion) {
        continue;
      }
      const { intensity, valence } = engram.emotion;

      if (intensity > 0.7) {
        this._amplify(engram);
      }

      if (valence > 0.3) {
        this._createPositiveAssociations(engram);
      }

      if (valence < -0.3) {
        this._handleNegative(engram);
      }
    }
    return engrams;
  }

  /**
   * Amplifies an engram by extending its half-life and boosting access count.
   * @param {Engram} engram
   * @private
   */
  _amplify(engram) {
    engram.halfLifeMultiplier *= 1.5;
    engram.decay_access_count += 1;
  }

  /**
   * Creates positive associations for an engram.
   * Placeholder: in a full implementation this would spawn associative edges.
   * @param {Engram} engram
   * @private
   */
  _createPositiveAssociations(engram) {
    // Placeholder: spawn positive associative edges or tags
    if (!engram.marks.includes('::positive')) {
      engram.marks.push('::positive');
    }
  }

  /**
   * Handles negative-valence engrams during consolidation.
   * If intensity is very high, marks the engram with a deep-processing suffix.
   * @param {Engram} engram
   * @private
   */
  _handleNegative(engram) {
    const intensity = engram.emotion?.intensity ?? 0;
    if (intensity > 0.8 && !engram.marks.includes('::deep')) {
      engram.marks.push('::deep');
    }
  }
}
