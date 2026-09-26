/**
 * lib/providers/reranker-chained.js — Chained Reranker mit Fallback.
 *
 * Versucht zuerst den Primary-Provider (z.B. Cohere).
 * Bei Fehler → Fallback-Provider (z.B. local-transformers) wenn konfiguriert.
 * fallback=null ist gültig (fallbackProvider="disabled") — kein Crash.
 */

export class ChainedRerankerProvider {
  constructor(primary, fallback, logger) {
    this.id = `chained:${primary.id}->${fallback ? fallback.id : "disabled"}`;
    this.primary = primary;
    this.fallback = fallback; // kann null sein wenn fallbackProvider="disabled"
    this.logger = logger;
    this._shutdownPromise = null;
  }

  async rerank(query, documents, topN, options) {
    try {
      return await this.primary.rerank(query, documents, topN, options);
    } catch (err) {
      // Stop after the first abort: an aborted signal means the caller (or
      // the rerank budget) is done waiting — trying a fallback provider on
      // the same signal would just abort again, and the pipeline's own
      // catch is what decides what to do with the abort, not this provider.
      if (options?.signal?.aborted) throw err;
      if (this.fallback) {
        this.logger?.warn?.(
          `reranker primary (${this.primary.id}) failed: ${String(err)}. ` +
          `Trying fallback (${this.fallback.id})...`
        );
        return await this.fallback.rerank(query, documents, topN, options);
      }
      // fallback=null → ohne Reranker weiterlaufen, kein Crash
      this.logger?.warn?.(
        `reranker primary (${this.primary.id}) failed: ${String(err)}. ` +
        `No fallback configured (fallbackProvider=disabled) — continuing without reranker.`
      );
      return []; // recall-pipeline behandelt [] als "kein Reranking"
    }
  }

  /** Shut down every distinct provider while preserving all cleanup failures. */
  async shutdown() {
    if (this._shutdownPromise) return await this._shutdownPromise;
    this._shutdownPromise = (async () => {
      const errors = [];
      const providers = [...new Set([this.primary, this.fallback].filter(Boolean))];
      for (const provider of providers) {
        if (typeof provider.shutdown !== "function") continue;
        try { await provider.shutdown(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "chained reranker shutdown failed");
    })();
    return await this._shutdownPromise;
  }
}
