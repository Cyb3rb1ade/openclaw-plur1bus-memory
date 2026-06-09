/**
 * EmotionalContagionGuard — detects sustained negative emotional drift and
 * recommends reframing or reset actions.
 */

import { EmotionScore } from "./emotion-score.js";

export class EmotionalContagionGuard {
  /**
   * @param {Object} [options]
   * @param {number} [options.negativeThreshold=-0.4] — valence below this counts as negative
   * @param {number} [options.consecutiveLimit=5] — how many recent scores to inspect
   * @param {number} [options.resetBoost=0.3] — suggested valence bump for reset action
   */
  constructor({
    negativeThreshold = -0.4,
    consecutiveLimit = 5,
    resetBoost = 0.3,
  } = {}) {
    this.negativeThreshold = negativeThreshold;
    this.consecutiveLimit = consecutiveLimit;
    this.resetBoost = resetBoost;
    /** @type {number[]} */
    this._recentValences = [];
  }

  /**
   * Inspect an incoming emotion and return a status recommendation.
   *
   * @param {EmotionScore} emotion
   * @returns {{status:string, action:string, message?:string, suggested_prefix?:string}}
   */
  check(emotion) {
    if (!(emotion instanceof EmotionScore)) {
      return { status: "ok", action: "none" };
    }

    this._recentValences.push(emotion.valence);
    if (this._recentValences.length > this.consecutiveLimit) {
      this._recentValences.shift();
    }

    const window = this._recentValences;
    if (window.length < this.consecutiveLimit) {
      return { status: "ok", action: "none" };
    }

    const allNegative = window.every((v) => v < this.negativeThreshold);
    if (!allNegative) {
      return { status: "ok", action: "none" };
    }

    const trend = this._computeTrend(window);
    if (trend < -0.2) {
      return {
        status: "critical",
        action: "reframe",
        message:
          "Sustained negative emotional trend detected. Immediate reframing recommended.",
        suggested_prefix:
          "The user has been experiencing a deepening negative emotional pattern. Gently reframe the conversation toward constructive ground.",
      };
    }

    return {
      status: "warning",
      action: "reset",
      message:
        "Consecutive negative emotions detected. Suggest a soft reset or topic shift.",
      suggested_prefix: `The user has shown ${this.consecutiveLimit} consecutive negative emotional signals. Introduce a gentle reset or shift topic to break the pattern.`,
    };
  }

  /**
   * Clear the internal valence tracker.
   */
  reset() {
    this._recentValences = [];
  }

  /**
   * Simple linear trend over the window (slope of best-fit line).
   * @param {number[]} values
   * @returns {number}
   */
  _computeTrend(values) {
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v, 0) / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - xMean;
      num += dx * (values[i] - yMean);
      den += dx * dx;
    }
    return den === 0 ? 0 : num / den;
  }
}
