/**
 * lib/providers/rerank-signal.js — the single owner of a rerank timeout (PR-09).
 *
 * The recall pipeline builds one signal per rerank from the caller's signal and
 * the configured budget and hands it to the provider, whose HTTP request or
 * model call is driven by it. A provider called directly (no signal) builds its
 * own — still exactly one timer.
 */

/**
 * @param {AbortSignal|null|undefined} callerSignal
 * @param {number} timeoutMs Budget; <= 0 or non-finite means "no timer".
 * @returns {AbortSignal|undefined}
 */
export function rerankSignal(callerSignal, timeoutMs) {
  const budget = Number(timeoutMs);
  const timer = Number.isFinite(budget) && budget > 0 ? AbortSignal.timeout(budget) : null;
  if (timer && callerSignal) return AbortSignal.any([callerSignal, timer]);
  return timer ?? callerSignal ?? undefined;
}
