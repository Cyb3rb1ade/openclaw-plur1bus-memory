import { DEFAULT_LOCAL_RERANKER_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";
import { safeDebug } from "../safe-logging.js";

function scoreFromOutput(output) {
  const row = Array.isArray(output) ? output[0] : output;
  if (typeof row?.score === "number") return row.score;
  if (Array.isArray(row) && typeof row[0]?.score === "number") return row[0].score;
  if (row?.data && typeof row.data[0] === "number") return row.data[0];
  if (typeof row === "number") return row;
  throw new Error("local reranker output shape is unsupported");
}

function scoresFromBatchOutput(output, expectedCount) {
  if (expectedCount === 1) return [scoreFromOutput(output)];

  if (Array.isArray(output) && output.length === expectedCount) {
    return output.map((row) => scoreFromOutput(row));
  }

  if (output?.data && Array.isArray(output.dims) && output.dims[0] === expectedCount) {
    const width = Number.isInteger(output.dims[1]) ? output.dims[1] : 1;
    const data = Array.from(output.data);
    return Array.from({ length: expectedCount }, (_, index) => Number(data[index * width]));
  }

  throw new Error("local reranker batch output shape is unsupported");
}

export class LocalTransformersRerankerProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model || DEFAULT_LOCAL_RERANKER_MODEL;
    this.cacheDir = cfg.cacheDir ? resolveEnvVars(cfg.cacheDir, { groups: ["localPath"], label: "local model cacheDir" }) : undefined;
    this.logger = cfg.logger;
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
    } catch (err) {
      safeDebug(this.logger, "local-transformers-reranker.pair-object-fallback", err);
      return scoreFromOutput(await classifier(`${query}\n\n${document}`));
    }
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];
    const classifier = await this._getPipeline();
    const pairs = documents.map((document) => ({ text: query, text_pair: document }));
    let scores;
    try {
      scores = scoresFromBatchOutput(await classifier(pairs), documents.length);
    } catch (err) {
      safeDebug(this.logger, "local-transformers-reranker.batch-fallback", err, { count: documents.length });
      scores = [];
      for (const document of documents) {
        scores.push(await this._scorePair(classifier, query, document));
      }
    }
    const scored = scores.map((score, index) => ({ index, relevance_score: score }));
    return scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, topN);
  }
}
