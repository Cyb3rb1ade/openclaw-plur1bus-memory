/**
 * lib/providers/reranker-chained.js — Chained Reranker mit Fallback.
 *
 * Versucht zuerst den Primary-Provider (z.B. Cohere).
 * Bei Fehler → Fallback-Provider (z.B. local-transformers).
 */

export class ChainedRerankerProvider {
  constructor(primary, fallback, logger) {
    this.id = `chained:${primary.id}->${fallback.id}`;
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
  }

  async rerank(query, documents, topN) {
    try {
      return await this.primary.rerank(query, documents, topN);
    } catch (err) {
      this.logger?.warn?.(`reranker primary (${this.primary.id}) failed: ${String(err)}. Trying fallback (${this.fallback.id})...`);
      return await this.fallback.rerank(query, documents, topN);
    }
  }
}
