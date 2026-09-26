/**
 * engine/providers/embedding-service.js — EmbeddingService.probe() (E3 Task 3)
 * real, exercising the provider; Task 4 adds serve() logic to this same file.
 *
 * probe() answers whether the configured embedding provider is actually
 * loaded and producing usable vectors, without ever throwing on a provider
 * failure (the result says `ok: false`) and without leaking the provider's
 * raw error message into anything a client could see — that goes to
 * `logger.warn` only (global-constraints: typed failures carry fixed,
 * log-safe messages; raw exceptions never do).
 */
import { randomUUID } from "node:crypto";

import { raceAbort } from "../../lib/abort.js";

/** Fixed prefix of every probe text; the per-engine nonce and an incrementing
 * attempt counter keep it from ever hitting a persisted embedding cache. */
export const PROBE_TEXT_PREFIX = "plur1bus embedding probe";

/**
 * @param {object} deps
 * @param {() => object} deps.getEmbeddings Returns the current provider (has `embedQuery`).
 * @param {() => object} deps.getIdentity Returns an EmbeddingIdentity (types/engine.d.ts).
 * @param {{ warn(message: string): void }} deps.logger
 * @param {() => number} [deps.clock]
 * @param {string} [deps.nonce] Per-engine nonce distinguishing probe texts from real content.
 * @returns {{ probe(opts?: { signal?: AbortSignal, refresh?: boolean }): Promise<object>, lastResult(): object | null }}
 *   probe()'s and lastResult()'s result is an EmbeddingProbeResult (types/engine.d.ts).
 */
export function createEmbeddingProbe({ getEmbeddings, getIdentity, logger, clock = Date.now, nonce = randomUUID() }) {
  let attempt = 0;
  let inFlight = null;
  /** @type {object | null} EmbeddingProbeResult (types/engine.d.ts) of the last successful probe. */
  let memoized = null;

  function runProbe() {
    const t0 = clock();
    const identity = getIdentity();
    const text = `${PROBE_TEXT_PREFIX} ${nonce}:${attempt++}`;
    return (async () => {
      let vector;
      try {
        vector = await getEmbeddings().embedQuery(text);
      } catch (error) {
        logger.warn(`embedding.probe: provider failed: ${error?.message ?? error}`);
        return { ok: false, error: "provider-failed", cached: false, identity, durationMs: clock() - t0, checkedAt: clock() };
      }
      if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
        return { ok: false, error: "invalid-vector", cached: false, identity, durationMs: clock() - t0, checkedAt: clock() };
      }
      let allFinite = true;
      for (let i = 0; i < vector.length; i += 1) {
        if (!Number.isFinite(vector[i])) { allFinite = false; break; }
      }
      if (!allFinite) {
        return { ok: false, error: "invalid-vector", cached: false, identity, durationMs: clock() - t0, checkedAt: clock() };
      }
      if (vector.length !== identity.dimensions) {
        return { ok: false, error: "dimension-mismatch", cached: false, identity, durationMs: clock() - t0, checkedAt: clock() };
      }
      const result = { ok: true, cached: false, identity, durationMs: clock() - t0, checkedAt: clock() };
      memoized = result;
      return result;
    })();
  }

  async function probe(opts = {}) {
    if (opts.refresh !== true && memoized) return { ...memoized, cached: true };
    const callerStart = clock();
    if (!inFlight) {
      inFlight = runProbe().finally(() => { inFlight = null; });
    }
    const shared = inFlight;
    try {
      return await raceAbort(shared, opts.signal);
    } catch {
      const identity = getIdentity();
      return { ok: false, error: "aborted", cached: false, identity, durationMs: clock() - callerStart, checkedAt: clock() };
    }
  }

  return {
    probe,
    /** What E4 reads for model readiness; not wired to Engine.status() here. */
    lastResult: () => memoized,
  };
}
