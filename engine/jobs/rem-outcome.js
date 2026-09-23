/**
 * engine/jobs/rem-outcome.js — REM run semantics over the ledger (PR-08).
 *
 * A REM job runs one pass per ACL partition. The job is incomplete when any
 * partition produced a report without the narrative it was expected to
 * produce (lib/dreaming/rem-dream.js leaves that week open); completion is
 * keyed by the partition's runKey and read from the ledger, not from
 * run-state.json.
 */

/**
 * @param {Array<{scope: string, result: object}>} remRuns
 * @param {{narrativeExpected: boolean, dryRun: boolean}} options
 * @returns {{outcome: "completed"|"incomplete"|"skipped", reason?: string, pendingKeys: string[]}}
 */
export function remJobOutcome(remRuns, { narrativeExpected, dryRun }) {
  const pendingKeys = [];
  let completed = 0;
  let firstSkipReason = null;
  for (const run of remRuns) {
    const result = run?.result;
    if (result?.report) {
      if (!dryRun && narrativeExpected && !result.report.narrative) pendingKeys.push(result.report.runKey);
      else completed += 1;
    } else if (result?.skipped && firstSkipReason === null) {
      firstSkipReason = result.reason || "skipped";
    }
  }
  if (pendingKeys.length > 0) return { outcome: "incomplete", reason: "no_narrative", pendingKeys };
  if (completed > 0) return { outcome: "completed", pendingKeys };
  return { outcome: "skipped", reason: firstSkipReason || "no_partition", pendingKeys };
}

/**
 * @param {object} store Owner-bound Neo store (a frozen plain object).
 * @param {{hasCompletedKey: Function, isAbandonedKey: Function, noteAbandonedKey: Function, markCompletedKey: Function}} jobCtx
 * @returns {object} The same store with completion routed through the ledger.
 */
export function ledgerBackedCompletion(store, jobCtx) {
  return Object.freeze({
    ...store,
    hasCompletedRun: async (runKey) => {
      if (jobCtx.isAbandonedKey(runKey)) {
        jobCtx.noteAbandonedKey(runKey);
        return true;
      }
      return jobCtx.hasCompletedKey(runKey);
    },
    markRunCompleted: async (runKey, meta, partition) => {
      jobCtx.markCompletedKey(runKey);
      return store.markRunCompleted(runKey, meta, partition);
    },
  });
}
