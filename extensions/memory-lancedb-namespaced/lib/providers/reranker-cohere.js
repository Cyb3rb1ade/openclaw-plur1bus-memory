import { DEFAULT_COHERE_RERANK_MODEL } from "./dimensions.js";

function resolveEnvVars(value) {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    return v.replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  });
}

export class CohereRerankerProvider {
  constructor(cfg = {}) {
    this.id = "cohere";
    this.apiKeyRef = cfg.apiKey;
    this.model = cfg.model || DEFAULT_COHERE_RERANK_MODEL;
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];
    const apiKey = resolveEnvVars(this.apiKeyRef);
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
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${err}`);
    }
    return (await response.json()).results;
  }
}

