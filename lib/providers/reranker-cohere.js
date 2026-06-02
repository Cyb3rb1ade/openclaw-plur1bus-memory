import { DEFAULT_COHERE_RERANK_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";

export class CohereRerankerProvider {
  constructor(cfg = {}) {
    this.id = "cohere";
    this.apiKeyRef = cfg.apiKey;
    this.model = cfg.model || DEFAULT_COHERE_RERANK_MODEL;
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];
    const apiKey = resolveEnvVars(this.apiKeyRef, { groups: ["cohere"], label: "Cohere reranker" });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("https://api.cohere.com/v2/rerank", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents,
          top_n: topN,
          return_documents: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Cohere rerank failed (${response.status}): ${err}`);
      }
      return (await response.json()).results;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
