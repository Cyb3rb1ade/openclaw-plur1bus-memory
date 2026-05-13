import { DEFAULT_LOCAL_RERANKER_MODEL } from "./dimensions.js";

function resolveEnvVars(value) {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    if (envVar === "OPENCLAW_HOME" && !process.env.OPENCLAW_HOME) {
      return `${process.env.HOME || "."}/.openclaw`;
    }
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    return v.replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  });
}

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
    this.cacheDir = cfg.cacheDir ? resolveEnvVars(cfg.cacheDir) : undefined;
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

