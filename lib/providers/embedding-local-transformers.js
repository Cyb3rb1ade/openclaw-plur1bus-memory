import { DEFAULT_LOCAL_E5_DIMENSIONS, DEFAULT_LOCAL_E5_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";
import { createEmbeddingCache } from "../embedding-cache.js";

function vectorFromOutput(output) {
  if (output?.data && typeof output.data.length === "number") return Array.from(output.data);
  if (Array.isArray(output)) return Array.isArray(output[0]) ? output[0].map(Number) : output.map(Number);
  if (typeof output?.tolist === "function") {
    const list = output.tolist();
    return Array.isArray(list?.[0]) ? list[0].map(Number) : list.map(Number);
  }
  throw new Error("local embedding output shape is unsupported");
}

export class LocalTransformersEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model || DEFAULT_LOCAL_E5_MODEL;
    this.dim = Number(cfg.dimensions || DEFAULT_LOCAL_E5_DIMENSIONS);
    this.queryPrefix = cfg.queryPrefix ?? "query: ";
    this.passagePrefix = cfg.passagePrefix ?? "passage: ";
    this.cacheDir = cfg.cacheDir ? resolveEnvVars(cfg.cacheDir, { groups: ["localPath"], label: "local model cacheDir" }) : undefined;
    this._pipeline = null;
    this._cache = cfg.embeddingCacheEnabled === false ? null : createEmbeddingCache({
      maxEntries: cfg.cacheMaxEntries || 128,
      ttlMs: cfg.cacheTtlMs || 300000,
      coalesce: cfg.embeddingCacheCoalesce !== false,
      persist: cfg.embeddingCachePersist === true,
      persistDebug: cfg.embeddingCachePersistDebug === true,
      metrics: cfg.embeddingCacheMetrics === true,
      scope: cfg.embeddingCacheScope || "agent",
      maxBytes: cfg.embeddingCacheMaxBytes,
      cacheBasePath: cfg.cacheBasePath,
      provider: this.id,
      model: this.model,
      dimensions: this.dim,
      logger: cfg.logger,
    });
  }

  dimensions() {
    return this.dim;
  }

  async _getPipeline() {
    if (!this._pipeline) {
      let mod;
      try {
        mod = await import("@huggingface/transformers");
      } catch (e) {
        throw new Error(
          "local-transformers embedding provider requires optional dependency @huggingface/transformers. " +
          "Install it for this plugin or switch embedding.provider to openai/openai-compatible. " +
          `Import failed: ${e.message}`
        );
      }
      if (this.cacheDir && mod.env) mod.env.cacheDir = this.cacheDir;
      this._pipeline = await mod.pipeline("feature-extraction", this.model);
    }
    return this._pipeline;
  }

  _validateDim(vec) {
    if (this.dim && vec.length !== this.dim) {
      throw new Error(`Local embedding dimension mismatch for ${this.model}: expected ${this.dim}, got ${vec.length}`);
    }
    return vec;
  }

  async _computeBatch(texts, purpose = "passage") {
    const extractor = await this._getPipeline();
    const prefix = purpose === "query" ? this.queryPrefix : this.passagePrefix;
    const input = Array.isArray(texts) ? texts : [texts];
    const vectors = [];
    for (const text of input) {
      const output = await extractor(`${prefix}${text}`, { pooling: "mean", normalize: true });
      vectors.push(this._validateDim(vectorFromOutput(output)));
    }
    return vectors;
  }

  async _embedBatchForPurpose(texts, purpose = "passage", options = {}) {
    const input = Array.isArray(texts) ? texts : [texts];
    if (input.length === 0) return [];
    if (!this._cache) return this._computeBatch(input, purpose);
    return this._cache.getMany(input, {
      provider: this.id,
      model: `${this.model}:${purpose}`,
      dimensions: this.dim,
      agentId: options.agentId,
    }, (missing) => this._computeBatch(missing, purpose));
  }

  embedBatch(texts, _retries = 3, options = {}) {
    return this._embedBatchForPurpose(texts, "passage", options);
  }

  async embedRaw(text, purpose = "passage", _retries = 3, options = {}) {
    const [vector] = await this._embedBatchForPurpose([text], purpose, options);
    return vector;
  }

  embedQuery(text, options) {
    return this.embedRaw(text, "query", 3, options);
  }

  embedPassage(text, options) {
    return this.embedRaw(text, "passage", 3, options);
  }

  embed(text, options) {
    return this.embedPassage(text, options);
  }
}
