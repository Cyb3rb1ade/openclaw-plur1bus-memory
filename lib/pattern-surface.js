/**
 * lib/pattern-surface.js
 *
 * Pattern surfacing with normalized overlap scoring.
 * Three exports:
 * 1. computePatternScore — Szymkiewicz-Simpson overlap coefficient with recency decay
 * 2. findBestPattern — async; returns highest-scoring pattern that passes gate
 * 3. formatPatternBlock — XML output with humility-framed text
 */

import { sanitizeMemoryTextForPrompt } from "./memory-context-sanitize.js";
import { ContinuityGate } from "./continuity-gate.js";

const MS_PER_WEEK = 7 * 24 * 3600 * 1000;

/**
 * Compute weeks elapsed since a pattern creation/week-of date.
 * Returns 0 for missing or unparseable dates.
 *
 * @param {string|number|Date} dateValue
 * @returns {number}
 */
function weeksSince(dateValue) {
  if (!dateValue) return 0;
  const createdTime = new Date(dateValue).getTime();
  if (Number.isNaN(createdTime)) return 0;
  return (Date.now() - createdTime) / MS_PER_WEEK;
}

/**
 * Compute pattern strength score using Szymkiewicz-Simpson overlap coefficient.
 *
 * The key insight: large patterns must NOT win just because they're large.
 * Normalize by the smaller set to penalize patterns with many members.
 *
 * @param {Object} pattern
 * @param {string[]} candidateIds - recalled memory IDs (current session context)
 * @param {number} weeksSince - weeks elapsed since pattern creation
 * @returns {number} score 0..1, or 0 if overlap < 2
 */
export function computePatternScore(pattern, candidateIds, weeksSince) {
  const memberIds = pattern.memberIds ?? [];

  // Guard against empty sets
  if (!memberIds || memberIds.length === 0 || !candidateIds || candidateIds.length === 0) {
    return 0;
  }

  const candidateSet = new Set(candidateIds);

  // Count overlapping IDs
  const overlapCount = memberIds.filter(id => candidateSet.has(id)).length;

  // Require minimum 2 overlaps
  if (overlapCount < 2) {
    return 0;
  }

  // Szymkiewicz-Simpson: overlap / min(set1Size, set2Size)
  // This normalizes against the smaller set, preventing large patterns from winning by size
  const overlapCoeff = overlapCount / Math.min(memberIds.length, candidateIds.length);

  // Recency factor: exponential decay with half-life at 12 weeks
  // At t=0: factor=1.0
  // At t=12: factor ≈ 0.368
  const recencyFactor = Math.exp(-weeksSince / 12);

  // Confidence from pattern; default 0.5
  const confidence = pattern.confidence ?? 0.5;

  return overlapCoeff * confidence * recencyFactor;
}

/**
 * Find the highest-scoring pattern that passes the gate.
 *
 * @async
 * @param {string[]} candidateIds - recalled memory IDs
 * @param {Object[]} patterns - array of pattern records
 * @param {ContinuityGate} gate - gate instance with shouldSurface() method
 * @param {Object} sessionState - { associativeSurfacedCount, patternSurfacedCount, surfacedIds }
 * @returns {Promise<{pattern, score, triggerIds} | null>}
 */
async function _findBestPattern(candidateIds, patterns, gate, sessionState) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return null;
  }

  // Filter out null/invalid patterns
  const validPatterns = patterns.filter(p => p && p.memberIds);

  if (validPatterns.length === 0) {
    return null;
  }

  // Score all patterns
  const scored = validPatterns.map(pattern => {
    const score = computePatternScore(pattern, candidateIds, weeksSince(pattern.createdAt || pattern.weekOf));
    return { pattern, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Find the first pattern that passes the gate
  for (const { pattern, score } of scored) {
    const decision = gate.shouldSurface("pattern", score, sessionState, {
      emotionalTrajectory: pattern.emotionalTrajectory,
      currentRegister: sessionState.currentRegister,
    });

    if (decision.allow) {
      // Extract trigger IDs (only those in pattern.memberIds)
      const memberIds = pattern.memberIds ?? [];
      const triggerIds = candidateIds.filter(id => memberIds.includes(id));

      // Record the surface event to increment rate limit counter
      gate.record(sessionState, "pattern", pattern.id ?? pattern.patternKey ?? null);

      return { pattern, score, triggerIds };
    }
  }

  // No pattern passed the gate
  return null;
}

/**
 * Public entrypoint supporting both the legacy positional signature and the
 * Inner Continuity Engine options object.
 *
 * @async
 * @param {string[]|{recentMemoryIds: string[], threshold?: number, patternRecords?: Object[]}} candidateIdsOrOptions
 * @param {Object[]} [patterns]
 * @param {ContinuityGate} [gate]
 * @param {Object} [sessionState]
 * @returns {Promise<{pattern, score, triggerIds} | null>}
 */
export async function findBestPattern(...args) {
  if (args.length === 1 && args[0] && typeof args[0] === "object" && Array.isArray(args[0].recentMemoryIds)) {
    const { recentMemoryIds, threshold = 0.7, patternRecords = [] } = args[0];
    const gate = new ContinuityGate({ patternThreshold: threshold, maxPatterns: 1 });
    const sessionState = {};
    return _findBestPattern(recentMemoryIds, patternRecords, gate, sessionState);
  }
  const [candidateIds, patterns, gate, sessionState] = args;
  return _findBestPattern(candidateIds, patterns, gate, sessionState);
}

/**
 * Format a pattern as an XML memory-continuity block.
 *
 * @param {Object} pattern - the pattern record
 * @param {string[]} triggerIds - overlapping memory IDs that triggered surfacing
 * @param {number} score - pattern score (0..1)
 * @returns {string} XML markup
 */
export function formatPatternBlock(pattern, triggerIds, score) {
  const weeksAgo = Math.round(weeksSince(pattern.createdAt || pattern.weekOf));

  const patternName = sanitizeMemoryTextForPrompt(pattern.patternName ?? "", 200);
  const patternDesc = sanitizeMemoryTextForPrompt(pattern.description ?? "", 400);

  // Construct the block with humility language
  // Must contain one of: "may connect", "partial", "I've noticed", "appeared across", "vague"
  let content = "";
  if (patternName) {
    content += `This may connect to a pattern I've noticed: "${patternName}".\n`;
  }

  if (patternDesc) {
    content += `${patternDesc}\n`;
  }

  content += `My memory of when this started is partial — it appeared across several conversations. I'm surfacing it because today's recalled memories overlap with it.`;

  // Attributes
  const triggerIdsStr = Array.isArray(triggerIds) ? triggerIds.join(",") : "";
  const confidenceStr = score.toFixed(2);

  return `<memory-continuity source="rem-pattern" confidence="${confidenceStr}" weeks-ago="${weeksAgo}" trigger-memory-ids="${triggerIdsStr}">
${content}
</memory-continuity>`;
}
