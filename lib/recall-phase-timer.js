/**
 * lib/recall-phase-timer.js — lightweight per-recall phase timer.
 *
 * Tracks elapsed wall-clock time per recall invocation and per phase.
 * No memory text, query text, prompts, or vectors are retained.
 */

import { trySafeWarn } from "./safe-logging.js";

const DEFAULT_SOFT_BUDGET_MS = 35_000;
const DEFAULT_HARD_TIMEOUT_MS = 45_000;
const MAX_COMPLETED_PHASES = 32;

function sanitizeError() {
  // Phase summaries can flow into traces and diagnostics. Arbitrary error
  // messages may contain the query, memory text, or credentials, so retain
  // only a fixed classification here.
  return "phase failed";
}

/**
 * Create a bounded recall phase tracker that retains no error payload text.
 * @param {{softBudgetMs?: number, hardTimeoutMs?: number, logger?: object|null}} [options] Timer configuration.
 * @returns {object} Recall phase timer API.
 */
export function createRecallPhaseTimer({
  softBudgetMs = DEFAULT_SOFT_BUDGET_MS,
  hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS,
  logger = null,
} = {}) {
  const soft = Number.isFinite(softBudgetMs) && softBudgetMs > 0 ? softBudgetMs : DEFAULT_SOFT_BUDGET_MS;
  const hard = Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0 ? hardTimeoutMs : DEFAULT_HARD_TIMEOUT_MS;

  let firstStart = 0;
  let activePhaseValue = null;
  let phaseStart = 0;
  const completed = [];
  const errors = [];

  function pushCompleted(entry) {
    completed.push(entry);
    if (completed.length > MAX_COMPLETED_PHASES) {
      completed.shift();
    }
  }

  return {
    start(phase) {
      if (typeof phase !== "string" || phase.length === 0) return;
      if (firstStart === 0) firstStart = Date.now();
      // If a phase was already open, close it with the time spent so far.
      // This prevents leaking an active phase when callers nest incorrectly.
      if (activePhaseValue !== null && activePhaseValue !== phase) {
        pushCompleted({ phase: activePhaseValue, ms: Math.max(0, Date.now() - phaseStart) });
      }
      activePhaseValue = phase;
      phaseStart = Date.now();
    },

    end(phase) {
      if (typeof phase !== "string" || phase.length === 0) return;
      if (activePhaseValue === null || activePhaseValue !== phase) return;
      const ms = Math.max(0, Date.now() - phaseStart);
      pushCompleted({ phase, ms });
      activePhaseValue = null;
      phaseStart = 0;
    },

    fail(phase, error) {
      if (typeof phase !== "string" || phase.length === 0) return;
      const record = {
        phase,
        at: new Date().toISOString(),
        error: sanitizeError(error),
      };
      errors.push(record);
      if (errors.length > MAX_COMPLETED_PHASES) errors.shift();
      if (activePhaseValue === phase) {
        activePhaseValue = null;
        phaseStart = 0;
      }
      const warning = trySafeWarn(
        logger,
        "recall-phase-timer",
        new Error(record.error),
        { phase },
      );
      return warning;
    },

    elapsedMs() {
      if (firstStart === 0) return 0;
      return Math.max(0, Date.now() - firstStart);
    },

    isSoftBudgetExceeded() {
      return this.elapsedMs() > soft;
    },

    activePhase() {
      return activePhaseValue;
    },

    summary() {
      return {
        elapsedMs: this.elapsedMs(),
        softBudgetMs: soft,
        hardTimeoutMs: hard,
        activePhase: activePhaseValue,
        completed: completed.slice(),
        errors: errors.slice(),
        exceededBudget: this.isSoftBudgetExceeded(),
      };
    },
  };
}
