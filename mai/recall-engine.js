/**
 * @fileoverview RecallEngine — emotion-boosted memory retrieval.
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
 * Computes emotional similarity between two EmotionScores.
 * @param {import('./emotion-score.js').EmotionScore|null} e1
 * @param {import('./emotion-score.js').EmotionScore|null} e2
 * @returns {number} similarity in [0, 1]
 */
function emotionalSimilarity(e1, e2) {
  if (!e1 || !e2) {
    return 0;
  }
  const vadCosine = vadCosineSimilarity(e1, e2);
  // Normalize from [-1,1] to [0,1]
  const vadScore = (vadCosine + 1) / 2;

  const emotionMatch =
    e1.primary_emotion && e1.primary_emotion === e2.primary_emotion ? 1 : 0;

  const valenceMatch = 1 - Math.abs((e1.valence ?? 0) - (e2.valence ?? 0)) / 2;

  return 0.5 * vadScore + 0.3 * emotionMatch + 0.2 * valenceMatch;
}

/**
 * Retrieves and ranks memories using semantic + emotional scoring.
 */
export class RecallEngine {
  /**
   * @param {Object} params
   * @param {Object} params.db — LanceDB adapter (or mock for testing)
   * @param {Object} params.emotionEngine — EmotionEngine instance
   */
  constructor({ db, emotionEngine }) {
    this.db = db;
    this.emotionEngine = emotionEngine;
  }

  /**
   * Retrieves top-K engrams ranked by combined semantic and emotional similarity.
   * @param {string} query — text query
   * @param {import('./emotion-score.js').EmotionScore|null} [currentEmotion=null]
   * @param {number} [topK=10]
   * @param {number} [emotionBoostFactor=0.3] — weight given to emotional similarity
   * @returns {Promise<{engram:Engram, score:number}[]>}
   */
  async retrieve(query, currentEmotion = null, topK = 10, emotionBoostFactor = 0.3) {
    // PLACEHOLDER: Real LanceDB vector search would go here:
    // const vectorResults = await this.db.search(query).limit(topK * 2).execute();
    // For this module we simulate with an empty result set so the scoring logic
    // remains fully implemented and ready for integration.
    /** @type {{engram:Engram, semanticScore:number}[]} */
    const vectorResults = [];

    const boost = Math.max(0, Math.min(1, emotionBoostFactor));
    const now = Date.now();

    const scored = vectorResults.map((result) => {
      const engram = result.engram;
      const semantic = result.semanticScore ?? 0;
      const emotional = currentEmotion
        ? emotionalSimilarity(engram.emotion, currentEmotion)
        : 0;
      const combined = (1 - boost) * semantic + boost * emotional;
      return { engram, score: combined };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);

    // Update access stats on returned engrams
    for (const { engram } of top) {
      engram.decay_access_count += 1;
      engram.decay_last_accessed = now;
    }

    return top;
  }
}
