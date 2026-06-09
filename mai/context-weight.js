/**
 * ContextWeightManager — ranks and selects engrams for context windows
 * using emotional weighting and greedy token budgeting.
 */

export class ContextWeightManager {
  /**
   * @param {Object} [options]
   * @param {number} [options.baseContextLimit=4000] — default token budget
   */
  constructor({ baseContextLimit = 4000 } = {}) {
    this.baseContextLimit = baseContextLimit;
  }

  /**
   * Compute emotional + recency weights for a list of engrams.
   *
   * Expected engram shape:
   *   { content: string, emotion: EmotionScore|null, resonance?: number, accessedAt?: number }
   *
   * @param {Array<Object>} engrams
   * @param {import("./emotion-score.js").EmotionScore|null} [currentEmotion]
   * @returns {Array<[Object, number]>} — [(engram, weight), ...] sorted descending
   */
  weightEngrams(engrams, currentEmotion = null) {
    const now = Date.now();
    const scored = engrams.map((engram) => {
      const e = engram.emotion;
      const intensity = e?.intensity ?? 0;
      const valence = e?.valence ?? 0;
      const resonance = engram.resonance ?? 0;
      const ageMs = now - (engram.accessedAt ?? now);
      const recency = Math.max(0, 1 - ageMs / (1000 * 60 * 60 * 24)); // decay over 24h

      let weight =
        1.0 +
        intensity * 0.5 +
        resonance * 0.3 +
        Math.abs(valence) * 0.2 +
        recency * 0.3;

      if (currentEmotion && e) {
        // Boost if engram emotion aligns with current emotion
        const similarity =
          1 - Math.abs(currentEmotion.valence - e.valence) / 2;
        weight += similarity * 0.2;
      }

      return [engram, weight];
    });

    scored.sort((a, b) => b[1] - a[1]);
    return scored;
  }

  /**
   * Greedily select engrams to fit within a token budget.
   *
   * Uses a rough heuristic of ~4 characters per token.
   *
   * @param {Array<Object>} engrams
   * @param {import("./emotion-score.js").EmotionScore|null} [currentEmotion]
   * @param {number} [maxTokens=2000]
   * @returns {Array<Object>} — selected engrams in priority order
   */
  selectContextWindow(engrams, currentEmotion = null, maxTokens = 2000) {
    const weighted = this.weightEngrams(engrams, currentEmotion);
    const selected = [];
    let tokensUsed = 0;

    for (const [engram, weight] of weighted) {
      const content = engram.content ?? "";
      const estimatedTokens = Math.ceil(content.length / 4);
      if (tokensUsed + estimatedTokens > maxTokens) {
        continue;
      }
      selected.push(engram);
      tokensUsed += estimatedTokens;
    }

    return selected;
  }
}
