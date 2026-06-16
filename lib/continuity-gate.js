// lib/continuity-gate.js
//
// Taste gate that prevents PLUR1BUS from surfacing spontaneous memory associations
// too frequently. Applies to both associative (graph-based) memories and REM patterns.

import { addTraceDecision, addTraceGuard } from "./recall-decision-trace.js";

/**
 * ContinuityGate — stateless class checking whether a given association/pattern
 * should be surfaced given current session state.
 */
export class ContinuityGate {
  /**
   * @param {Object} opts
   * @param {number} opts.assocThreshold - min score for associative memories (default 0.75)
   * @param {number} opts.patternThreshold - min score for patterns (default 0.70)
   * @param {number} opts.maxAssociations - max associative surfaces per session (default 1)
   * @param {number} opts.maxPatterns - max pattern surfaces per session (default 1)
   */
  constructor({
    assocThreshold = 0.75,
    patternThreshold = 0.70,
    maxAssociations = 1,
    maxPatterns = 1,
  } = {}) {
    this.assocThreshold = assocThreshold;
    this.patternThreshold = patternThreshold;
    this.maxAssociations = maxAssociations;
    this.maxPatterns = maxPatterns;
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
    return { allow: false, reason: "invalid_type", traceDetail: { type } };
  }

  /**
   * Checks associative memory surfacing rules.
   * @private
   */
  _checkAssociative(score, sessionState, opts) {
    // Check score threshold
    if (score <= this.assocThreshold) {
      return {
        allow: false,
        reason: "score_below_threshold",
        traceDetail: { score, threshold: this.assocThreshold },
      };
    }

    // Check rate limit: respect maxAssociations per session
    if ((sessionState.associativeSurfacedCount ?? 0) >= this.maxAssociations) {
      return {
        allow: false,
        reason: "rate_limit",
        traceDetail: { score, maxAssociations: this.maxAssociations, surfacedCount: sessionState.associativeSurfacedCount ?? 0 },
      };
    }

    // Check depth constraint (if provided)
    if (opts.depth !== undefined && opts.depth > 2) {
      return {
        allow: false,
        reason: "depth_too_deep",
        traceDetail: { score, depth: opts.depth, maxDepth: 2 },
      };
    }

    // Check if already in vector recall (if vectorTopIds provided)
    if (opts.vectorTopIds && Array.isArray(opts.vectorTopIds) && opts.id !== undefined) {
      if (opts.vectorTopIds.includes(opts.id)) {
        return {
          allow: false,
          reason: "already_in_vector_recall",
          traceDetail: { score, id: opts.id, vectorTopIds: opts.vectorTopIds },
        };
      }
    }

    return { allow: true, reason: "ok", traceDetail: { score, threshold: this.assocThreshold, depth: opts.depth } };
  }

  /**
   * Checks pattern surfacing rules.
   * @private
   */
  _checkPattern(score, sessionState, opts) {
    // Check score threshold
    if (score <= this.patternThreshold) {
      return {
        allow: false,
        reason: "score_below_threshold",
        traceDetail: { score, threshold: this.patternThreshold },
      };
    }

    // Check rate limit: respect maxPatterns per session
    if ((sessionState.patternSurfacedCount ?? 0) >= this.maxPatterns) {
      return {
        allow: false,
        reason: "rate_limit",
        traceDetail: { score, maxPatterns: this.maxPatterns, surfacedCount: sessionState.patternSurfacedCount ?? 0 },
      };
    }

    // Check emotional fit (if both trajectory and register provided)
    if (opts.emotionalTrajectory && opts.currentRegister) {
      if (this._checkEmotionalMismatch(opts.emotionalTrajectory, opts.currentRegister)) {
        return {
          allow: false,
          reason: "emotional_mismatch",
          traceDetail: { score, emotionalTrajectory: opts.emotionalTrajectory, currentRegister: opts.currentRegister },
        };
      }
    }

    return { allow: true, reason: "ok", traceDetail: { score, threshold: this.patternThreshold } };
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

/**
 * Stateless helper: filter associative (graph-sourced) candidates through the
 * ContinuityGate, respecting maxAssociations per recall session.
 *
 * @param {Array} candidates - memory items (may include canonical/vector items)
 * @param {{ maxAssociations?: number, sessionState?: Object }} opts
 * @returns {Array} filtered items; non-graph items pass through unchanged
 */
export function filterAssociativeCandidates(candidates, { maxAssociations = 1, assocThreshold = 0, sessionState = {}, decisionTrace = null } = {}) {
  const gate = new ContinuityGate({ assocThreshold, maxAssociations });
  const result = [];
  for (const item of candidates ?? []) {
    if (item?.graphSource === "graph") {
      const assocScore = item.relevanceScore ?? item.associatedScore ?? item.associationStrength ?? 0;
      if ((sessionState.associativeSurfacedCount ?? 0) >= maxAssociations) {
        if (decisionTrace) {
          addTraceDecision(decisionTrace, {
            memoryId: item.id,
            action: "rejection",
            stage: "continuity-gate",
            reason: "rate_limit",
            finalScore: assocScore,
          });
          addTraceGuard(decisionTrace, {
            name: "continuity-gate",
            passed: false,
            reason: "rate_limit",
            memoryId: item.id,
          });
        }
        continue;
      }
      const decision = gate.shouldSurface("associative", assocScore, sessionState, {
        depth: item.depth,
        id: item.id,
      });
      if (decisionTrace) {
        if (decision.allow) {
          addTraceDecision(decisionTrace, {
            memoryId: item.id,
            action: "inclusion",
            stage: "continuity-gate",
            reason: decision.reason,
            finalScore: assocScore,
            scoreBreakdown: decision.traceDetail,
          });
        } else {
          addTraceDecision(decisionTrace, {
            memoryId: item.id,
            action: "rejection",
            stage: "continuity-gate",
            reason: decision.reason,
            finalScore: assocScore,
            scoreBreakdown: decision.traceDetail,
          });
          addTraceGuard(decisionTrace, {
            name: "continuity-gate",
            passed: false,
            reason: decision.reason,
            memoryId: item.id,
          });
        }
      }
      if (!decision.allow) {
        continue;
      }
      gate.record(sessionState, "associative", item.id);
      result.push(item);
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Stateless helper: filter a matched pattern through the ContinuityGate,
 * respecting maxPatterns per recall session.
 *
 * @param {{pattern: object, score: number, triggerIds: string[]}|null} matchedPattern
 * @param {{ maxPatterns?: number, sessionState?: Object }} opts
 * @returns {typeof matchedPattern|null}
 */
export function filterPatternCandidates(matchedPattern, { maxPatterns = 1, currentRegister = null, sessionState = {}, decisionTrace = null } = {}) {
  if (!matchedPattern?.pattern) {
    return null;
  }
  if ((sessionState.patternSurfacedCount ?? 0) >= maxPatterns) {
    if (decisionTrace) {
      const patternId = matchedPattern.pattern.id ?? matchedPattern.pattern.patternKey ?? "unknown";
      addTraceDecision(decisionTrace, {
        memoryId: patternId,
        action: "rejection",
        stage: "continuity-gate-pattern",
        reason: "rate_limit",
        finalScore: matchedPattern.score ?? 1.0,
      });
      addTraceGuard(decisionTrace, {
        name: "continuity-gate-pattern",
        passed: false,
        reason: "rate_limit",
        memoryId: patternId,
      });
    }
    return null;
  }
  const gate = new ContinuityGate({ patternThreshold: 0, maxPatterns });
  const decision = gate.shouldSurface("pattern", matchedPattern.score ?? 1.0, sessionState, {
    emotionalTrajectory: matchedPattern.pattern.emotionalTrajectory,
    currentRegister,
  });
  const patternId = matchedPattern.pattern.id ?? matchedPattern.pattern.patternKey ?? "unknown";
  if (decisionTrace) {
    if (decision.allow) {
      addTraceDecision(decisionTrace, {
        memoryId: patternId,
        action: "inclusion",
        stage: "continuity-gate-pattern",
        reason: decision.reason,
        finalScore: matchedPattern.score ?? 1.0,
        scoreBreakdown: decision.traceDetail,
      });
    } else {
      addTraceDecision(decisionTrace, {
        memoryId: patternId,
        action: "rejection",
        stage: "continuity-gate-pattern",
        reason: decision.reason,
        finalScore: matchedPattern.score ?? 1.0,
        scoreBreakdown: decision.traceDetail,
      });
      addTraceGuard(decisionTrace, {
        name: "continuity-gate-pattern",
        passed: false,
        reason: decision.reason,
        memoryId: patternId,
      });
    }
  }
  if (!decision.allow) {
    return null;
  }
  gate.record(sessionState, "pattern", matchedPattern.pattern.id ?? matchedPattern.pattern.patternKey ?? null);
  return matchedPattern;
}
