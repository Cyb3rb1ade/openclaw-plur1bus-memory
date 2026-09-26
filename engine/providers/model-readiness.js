/**
 * engine/providers/model-readiness.js — reranker readiness probe, pure
 * ModelReadiness derivation, and Engine.models (E4 Task 3).
 *
 * createRerankerProbe() mirrors createEmbeddingProbe()'s coalescing/memoize
 * semantics (engine/providers/embedding-service.js) but exercises the
 * reranker instead: one in-flight provider call shared by concurrent
 * callers, memoized on success, `refresh: true` queues one new call behind
 * a running one, each caller races its own `signal`. It never throws for a
 * provider failure (the result says `ok: false`) and never leaks a raw
 * provider error message into anything a client could see — that goes to
 * `logger.warn` only.
 */
import { raceAbort } from "../../lib/abort.js";

/** Fixed probe query and documents; ruling E4-R1: both real reranker
 * providers return `relevance_score`, passed through unmapped by
 * embeddingService.rerank(), so a hit's score is read as `score ??
 * relevance_score`. */
export const RERANK_PROBE_QUERY = "plur1bus reranker probe";
const PROBE_DOCUMENTS = Object.freeze(["plur1bus probe document one", "plur1bus probe document two"]);

/**
 * @param {object} deps
 * @param {() => object | null} deps.getReranker Returns the current reranker provider, or null when disabled.
 * @param {{ warn(message: string): void }} deps.logger
 * @param {() => number} [deps.clock]
 * @returns {{ probe(opts?: { signal?: AbortSignal, refresh?: boolean }): Promise<object>, lastAttempt(): object | null, pending(): boolean }}
 */
export function createRerankerProbe({ getReranker, logger, clock = Date.now }) {
  /** @type {{ promise: Promise<object>, started: boolean } | null} The newest provider call, running or queued. */
  let inFlight = null;
  /** @type {object | null} Result of the last successful probe. */
  let memoized = null;
  /** @type {object | null} Result of the last completed probe, ok or failed. */
  let lastCompleted = null;

  function runProbe() {
    const t0 = clock();
    const failed = (error) => {
      const result = { ok: false, error, cached: false, durationMs: clock() - t0, checkedAt: clock() };
      lastCompleted = result;
      return result;
    };
    return (async () => {
      const reranker = getReranker();
      if (!reranker) return failed("provider-failed");
      let hits;
      try {
        hits = await reranker.rerank(RERANK_PROBE_QUERY, PROBE_DOCUMENTS, 1);
      } catch (error) {
        logger.warn(`reranker.probe: provider failed: ${error?.message ?? error}`);
        return failed("provider-failed");
      }
      if (!Array.isArray(hits)) return failed("invalid-result");
      const valid = hits.every((hit) => {
        const score = hit?.score ?? hit?.relevance_score;
        return Number.isInteger(hit?.index) && hit.index >= 0 && hit.index < PROBE_DOCUMENTS.length && Number.isFinite(score);
      });
      if (!valid) return failed("invalid-result");
      const result = { ok: true, cached: false, durationMs: clock() - t0, checkedAt: clock() };
      memoized = result;
      lastCompleted = result;
      return result;
    })();
  }

  /** Start a provider call now, or queue it behind `after` (the call currently in flight). */
  function launch(after) {
    const entry = { promise: null, started: false };
    const run = () => {
      entry.started = true;
      return runProbe();
    };
    entry.promise = (after ? after.then(run, run) : run()).finally(() => {
      if (inFlight === entry) inFlight = null;
    });
    inFlight = entry;
    return entry;
  }

  async function probe(opts = {}) {
    const refresh = opts.refresh === true;
    if (!refresh && memoized) return { ...memoized, cached: true };
    const callerStart = clock();
    let entry = inFlight;
    if (!entry) entry = launch(null);
    else if (refresh && entry.started) entry = launch(entry.promise);
    try {
      return await raceAbort(entry.promise, opts.signal);
    } catch {
      return { ok: false, error: "aborted", cached: false, durationMs: clock() - callerStart, checkedAt: clock() };
    }
  }

  return {
    probe,
    /** Last completed probe, ok or failed (never an abort), or null. */
    lastAttempt: () => lastCompleted,
    /** true while a provider call is running or queued. */
    pending: () => inFlight !== null,
  };
}

/**
 * Pure: derive a ModelReadiness (types/engine.d.ts) from a probe's
 * `lastAttempt()` and `pending()`.
 *
 * @param {object} deps
 * @param {() => object | null} deps.lastAttempt
 * @param {() => boolean} deps.pending
 * @param {boolean} [deps.disabled]
 * @returns {object} ModelReadiness.
 */
export function readinessOf({ lastAttempt, pending, disabled = false }) {
  if (disabled) return { state: "disabled", warming: false, checkedAt: null };
  const warming = pending();
  const attempt = lastAttempt();
  if (!attempt) return { state: "loading", warming, checkedAt: null };
  if (attempt.ok) return { state: "ready", warming, checkedAt: attempt.checkedAt };
  return { state: "failed", warming, checkedAt: attempt.checkedAt, error: attempt.error };
}

/**
 * @param {object} deps
 * @param {{ probe: Function, lastAttempt: Function, pending: Function }} deps.embeddingProbe
 * @param {{ probe: Function, lastAttempt: Function, pending: Function }} deps.rerankerProbe
 * @param {() => object} deps.getIdentity
 * @param {() => object | null} deps.getReranker
 * @param {() => string | null} deps.getRerankerProvider
 * @returns {object} ModelsService (types/engine.d.ts).
 */
export function createModelsService({ embeddingProbe, rerankerProbe, getIdentity, getReranker, getRerankerProvider }) {
  function status() {
    return {
      embedder: { ...readinessOf(embeddingProbe), identity: getIdentity() },
      reranker: { ...readinessOf({ ...rerankerProbe, disabled: getReranker() == null }), provider: getRerankerProvider() },
    };
  }

  async function warm(opts) {
    const reranker = getReranker();
    await Promise.all([embeddingProbe.probe(opts), reranker ? rerankerProbe.probe(opts) : null]);
    return status();
  }

  return Object.freeze({ status, warm });
}
