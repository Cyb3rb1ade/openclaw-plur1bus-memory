/**
 * NarrativeEngine — detects emotional arcs across a session of EmotionScores.
 *
 * Maps sequences of emotional states to canonical narrative shapes.
 */

import { EmotionScore } from "./emotion-score.js";

export class NarrativeEngine {
  /**
   * @param {Object} options
   * @param {MoodTracker} options.moodTracker — optional, for context (not required for arc detection)
   */
  constructor({ moodTracker } = {}) {
    this.moodTracker = moodTracker ?? null;
  }

  /**
   * Detect the dominant emotional arc in a session.
   * @param {EmotionScore[]} sessionEmotions — chronological array of scores
   * @returns {{arc:string, confidence:number, description:string}}
   */
  detectArc(sessionEmotions) {
    if (!Array.isArray(sessionEmotions) || sessionEmotions.length < 3) {
      return { arc: "flat", confidence: 1.0, description: "Not enough data to detect an arc." };
    }

    const checks = [
      { name: "cinderella", fn: this._isCinderella },
      { name: "man_in_hole", fn: this._isManInHole },
      { name: "ichabod", fn: this._isIchabod },
      { name: "rags_to_riches", fn: this._isRagsToRiches },
      { name: "riches_to_rags", fn: this._isRichesToRags },
    ];

    for (const { name, fn } of checks) {
      const result = fn.call(this, sessionEmotions);
      if (result.match) {
        return {
          arc: name,
          confidence: result.confidence,
          description: result.description,
        };
      }
    }

    return {
      arc: "flat",
      confidence: 0.8,
      description: "No clear emotional arc detected; the session remains relatively level.",
    };
  }

  /**
   * Rags to riches: negative → positive trajectory.
   */
  _isRagsToRiches(scores) {
    const start = this._avgValence(scores.slice(0, 3));
    const end = this._avgValence(scores.slice(-3));
    const match = start < -0.2 && end > 0.2 && end > start + 0.3;
    return {
      match,
      confidence: match ? Math.min(1.0, (end - start) / 1.5) : 0,
      description: "A journey from negative emotion to a positive resolution.",
    };
  }

  /**
   * Riches to rags: positive → negative trajectory.
   */
  _isRichesToRags(scores) {
    const start = this._avgValence(scores.slice(0, 3));
    const end = this._avgValence(scores.slice(-3));
    const match = start > 0.2 && end < -0.2 && start > end + 0.3;
    return {
      match,
      confidence: match ? Math.min(1.0, (start - end) / 1.5) : 0,
      description: "A decline from positive emotion into negativity.",
    };
  }

  /**
   * Ichabod: high intensity → sudden crash (valence and intensity drop).
   */
  _isIchabod(scores) {
    const peakIdx = scores.reduce((best, s, i) => (s.intensity > scores[best].intensity ? i : best), 0);
    const peak = scores[peakIdx];
    const after = scores.slice(peakIdx + 1, peakIdx + 4);
    if (after.length < 2) return { match: false, confidence: 0, description: "" };

    const avgAfterValence = this._avgValence(after);
    const avgAfterIntensity = after.reduce((s, e) => s + e.intensity, 0) / after.length;
    const match = peak.intensity > 0.7 && avgAfterValence < -0.3 && avgAfterIntensity < 0.3;
    return {
      match,
      confidence: match ? peak.intensity : 0,
      description: "A sudden emotional high followed by a sharp crash.",
    };
  }

  /**
   * Cinderella: up → down → up (V-shaped recovery with final high).
   */
  _isCinderella(scores) {
    const len = scores.length;
    const first = this._avgValence(scores.slice(0, Math.ceil(len / 3)));
    const mid = this._avgValence(scores.slice(Math.floor(len / 3), Math.floor((2 * len) / 3)));
    const last = this._avgValence(scores.slice(Math.floor((2 * len) / 3)));
    const match = first > 0.1 && mid < -0.1 && last > 0.2 && last > first;
    return {
      match,
      confidence: match ? Math.min(1.0, (last - mid) / 1.0) : 0,
      description: "A rise, a fall, and a triumphant recovery.",
    };
  }

  /**
   * Man in hole: fall → recovery (starts okay, drops, then recovers).
   */
  _isManInHole(scores) {
    const len = scores.length;
    const first = this._avgValence(scores.slice(0, Math.ceil(len / 3)));
    const mid = this._avgValence(scores.slice(Math.floor(len / 3), Math.floor((2 * len) / 3)));
    const last = this._avgValence(scores.slice(Math.floor((2 * len) / 3)));
    const match = first > -0.1 && mid < -0.2 && last > -0.1 && last > mid + 0.3;
    return {
      match,
      confidence: match ? Math.min(1.0, (last - mid) / 1.0) : 0,
      description: "A stumble into negativity followed by a climb back out.",
    };
  }

  /**
   * Average valence of a slice of scores.
   * @param {EmotionScore[]} slice
   * @returns {number}
   */
  _avgValence(slice) {
    if (slice.length === 0) return 0;
    return slice.reduce((s, e) => s + e.valence, 0) / slice.length;
  }
}
