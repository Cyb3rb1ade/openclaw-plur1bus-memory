import { DEFAULT_COHERE_RERANK_MODEL } from "./dimensions.js";
import { resolveApiKey } from "./env.js";

export class CohereRerankerProvider {
  constructor(cfg = {}) {
    this.id = "cohere";
    this.apiKeyRef = cfg.apiKey;
    this.apiKeyEnv = cfg.apiKeyEnv;
    this.credentialResolver = cfg.credentialResolver;
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
    this.model = cfg.model || DEFAULT_COHERE_RERANK_MODEL;
    // Honor the configured timeout (normalizeRerankerConfig default: 5000)
    // instead of the previous hardcoded 30s, which ignored config entirely.
    this.timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : 5000;
  }

  async _resolveApiKey() {
    if (this._resolvedApiKey) return this._resolvedApiKey;
    if (!this._apiKeyPromise) {
      this._apiKeyPromise = Promise.resolve().then(async () => {
        const apiKey = typeof this.credentialResolver === "function"
          ? await this.credentialResolver({
              value: this.apiKeyRef,
              apiKeyEnv: this.apiKeyEnv,
              defaultEnv: "COHERE_API_KEY",
              path: "plugins.entries.memory-lancedb-namespaced.config.reranker.apiKey",
            })
          : resolveApiKey(
              { apiKeyEnv: this.apiKeyEnv, apiKey: this.apiKeyRef },
              { defaultEnv: "COHERE_API_KEY", label: "Cohere reranker" },
            );
        if (typeof apiKey !== "string" || !apiKey.trim()) {
          throw new Error("Cohere reranker credential is unavailable");
        }
        this._resolvedApiKey = apiKey.trim();
        return this._resolvedApiKey;
      }).catch((error) => {
        this._apiKeyPromise = null;
        throw error;
      });
    }
    return this._apiKeyPromise;
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];
    const apiKey = await this._resolveApiKey();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
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

  /** Forget resolved credentials when the plugin runtime is disposed. */
  async shutdown() {
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
  }
}
