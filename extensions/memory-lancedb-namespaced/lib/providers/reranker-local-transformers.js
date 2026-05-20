import { DEFAULT_LOCAL_RERANKER_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";

function scoreFromOutput(output) {
  const row = Array.isArray(output) ? output[0] : output;
  if (typeof row?.score === "number") return row.score;
  if (Array.isArray(row) && typeof row[0]?.score === "number") return row[0].score;
  if (row?.data && typeof row.data[0] === "number") return row.data[0];
  if (typeof row === "number") return row;
  throw new Error("local reranker output shape is unsupported");
}

export class LocalTransformersRerankerProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model || DEFAULT_LOCAL_RERANKER_MODEL;
    this.cacheDir = cfg.cacheDir ? resolveEnvVars(cfg.cacheDir, { groups: ["localPath"], label: "local model cacheDir" }) : undefined;
    this._pipeline = null;
  }

  async _getPipeline() {
    if (!this._pipeline) {
      let mod;
      try {
        mod = await import("@huggingface/transformers");
      } catch (e) {
        throw new Error(
          "local-transformers reranker requires optional dependency @huggingface/transformers. " +
          "Install it for this plugin, choose Cohere, or disable reranking. " +
          `Import failed: ${e.message}`
        );
      }
      if (this.cacheDir && mod.env) mod.env.cacheDir = this.cacheDir;
      this._pipeline = await mod.pipeline("text-classification", this.model);
    }
    return this._pipeline;
  }

  async _scorePair(classifier, query, document) {
    try {
      return scoreFromOutput(await classifier({ text: query, text_pair: document }));
    } catch (_) {
      return scoreFromOutput(await classifier(`${query}\n\n${document}`));
    }
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];
    const classifier = await this._getPipeline();
    const scored = [];
    for (let i = 0; i < documents.length; i++) {
      scored.push({ index: i, relevance_score: await this._scorePair(classifier, query, documents[i]) });
    }
    return scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, topN);
  }
}
