// lib/continuity-gate.js
//
// Taste gate that prevents PLUR1BUS from surfacing spontaneous memory associations
// too frequently. Applies to both associative (graph-based) memories and REM patterns.

/**
 * ContinuityGate — stateless class checking whether a given association/pattern
 * should be surfaced given current session state.
 */
export class ContinuityGate {
  /**
   * @param {Object} opts
   * @param {number} opts.assocThreshold - min score for associative memories (default 0.75)
   * @param {number} opts.patternThreshold - min score for patterns (default 0.70)
   */
  constructor({ assocThreshold = 0.75, patternThreshold = 0.70 } = {}) {
    this.assocThreshold = assocThreshold;
    this.patternThreshold = patternThreshold;
  }

  /**
   * Checks whether a given association/pattern should be surfaced.
   *
   * @param {string} type - "associative" or "pattern"
   * @param {number} score - association/pattern strength (0..1)
   * @param {Object} sessionState - { associativeSurfacedCount, patternSurfacedCount, surfacedIds }
   * @param {Object} opts - additional checks (depth, vectorTopIds, emotionalTrajectory, currentRegister, id)
   * @returns {{ allow: boolean, reason: string }}
   */
  shouldSurface(type, score, sessionState, opts = {}) {
    if (type === "associative") {
      return this._checkAssociative(score, sessionState, opts);
    } else if (type === "pattern") {
      return this._checkPattern(score, sessionState, opts);
    }
    return { allow: false, reason: "invalid_type" };
  }

  /**
   * Checks associative memory surfacing rules.
   * @private
   */
  _checkAssociative(score, sessionState, opts) {
    // Check score threshold
    if (score <= this.assocThreshold) {
      return { allow: false, reason: "score_below_threshold" };
    }

    // Check rate limit: only 1 associative surface per session
    if ((sessionState.associativeSurfacedCount ?? 0) >= 1) {
      return { allow: false, reason: "rate_limit" };
    }

    // Check depth constraint (if provided)
    if (opts.depth !== undefined && opts.depth > 2) {
      return { allow: false, reason: "depth_too_deep" };
    }

    // Check if already in vector recall (if vectorTopIds provided)
    if (opts.vectorTopIds && Array.isArray(opts.vectorTopIds) && opts.id !== undefined) {
      if (opts.vectorTopIds.includes(opts.id)) {
        return { allow: false, reason: "already_in_vector_recall" };
      }
    }

    return { allow: true, reason: "ok" };
  }

  /**
   * Checks pattern surfacing rules.
   * @private
   */
  _checkPattern(score, sessionState, opts) {
    // Check score threshold
    if (score <= this.patternThreshold) {
      return { allow: false, reason: "score_below_threshold" };
    }

    // Check rate limit: only 1 pattern surface per session
    if ((sessionState.patternSurfacedCount ?? 0) >= 1) {
      return { allow: false, reason: "rate_limit" };
    }

    // Check emotional fit (if both trajectory and register provided)
    if (opts.emotionalTrajectory && opts.currentRegister) {
      if (this._checkEmotionalMismatch(opts.emotionalTrajectory, opts.currentRegister)) {
        return { allow: false, reason: "emotional_mismatch" };
      }
    }

    return { allow: true, reason: "ok" };
  }

  /**
   * Checks if emotionalTrajectory and currentRegister are strongly incompatible.
   * Returns true if they are mismatched (both high-intensity but opposite valence).
   * @private
   */
  _checkEmotionalMismatch(trajectory, register) {
    const negativeWords = ["grief", "conflict", "loss", "anger", "anguish"];
    const positiveWords = ["celebration", "joy", "triumph", "delight", "elation"];

    const trajectoryLower = String(trajectory).toLowerCase();
    const registerLower = String(register).toLowerCase();

    const hasNegativeTrajectory = negativeWords.some(w => trajectoryLower.includes(w));
    const hasPositiveRegister = positiveWords.some(w => registerLower.includes(w));
    const hasPositiveTrajectory = positiveWords.some(w => trajectoryLower.includes(w));
    const hasNegativeRegister = negativeWords.some(w => registerLower.includes(w));

    // Mismatch if high-intensity but opposite valence
    return (hasNegativeTrajectory && hasPositiveRegister) ||
           (hasPositiveTrajectory && hasNegativeRegister);
  }

  /**
   * Records a surface event, mutating sessionState counters.
   *
   * @param {Object} sessionState - { associativeSurfacedCount, patternSurfacedCount, surfacedIds }
   * @param {string} type - "associative" or "pattern"
   * @param {string|null} id - optional id to track as surfaced
   */
  record(sessionState, type, id = null) {
    if (type === "associative") {
      sessionState.associativeSurfacedCount = (sessionState.associativeSurfacedCount ?? 0) + 1;
    } else if (type === "pattern") {
      sessionState.patternSurfacedCount = (sessionState.patternSurfacedCount ?? 0) + 1;
    }

    if (id !== null && id !== undefined) {
      if (!sessionState.surfacedIds) {
        sessionState.surfacedIds = new Set();
      }
      sessionState.surfacedIds.add(id);
    }
  }
}
