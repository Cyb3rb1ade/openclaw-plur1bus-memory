import { DEFAULT_LOCAL_E5_DIMENSIONS, DEFAULT_LOCAL_E5_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";
import { createEmbeddingCache } from "../embedding-cache.js";
import {
  ensurePinnedModelArtifacts,
  pinnedLocalModelProfile,
} from "./local-model-artifacts.js";

function vectorFromOutput(output) {
  if (output?.data && typeof output.data.length === "number") return Array.from(output.data);
  if (Array.isArray(output)) return Array.isArray(output[0]) ? output[0].map(Number) : output.map(Number);
  if (typeof output?.tolist === "function") {
    const list = output.tolist();
    return Array.isArray(list?.[0]) ? list[0].map(Number) : list.map(Number);
  }
  throw new Error("local embedding output shape is unsupported");
}

function vectorsFromBatchOutput(output, expectedCount) {
  if (expectedCount === 1) return [vectorFromOutput(output)];

  if (output?.data && Array.isArray(output.dims) && output.dims[0] === expectedCount && Number.isInteger(output.dims[1])) {
    const width = output.dims[1];
    const data = Array.from(output.data);
    return Array.from({ length: expectedCount }, (_, index) =>
      data.slice(index * width, (index + 1) * width).map(Number)
    );
  }

  if (typeof output?.tolist === "function") {
    const list = output.tolist();
    if (Array.isArray(list) && list.length === expectedCount && Array.isArray(list[0])) {
      return list.map((row) => row.map(Number));
    }
  }

  if (Array.isArray(output) && output.length === expectedCount) {
    return output.map((row) => vectorFromOutput(row));
  }

  throw new Error("local embedding batch output shape is unsupported");
}

export class LocalTransformersEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model || DEFAULT_LOCAL_E5_MODEL;
    this.dim = Number(cfg.dimensions || DEFAULT_LOCAL_E5_DIMENSIONS);
    this.queryPrefix = cfg.queryPrefix ?? "query: ";
    this.passagePrefix = cfg.passagePrefix ?? "passage: ";
    this.cacheDir = cfg.cacheDir ? resolveEnvVars(cfg.cacheDir, { groups: ["localPath"], label: "local model cacheDir" }) : undefined;
    this.profile = pinnedLocalModelProfile(this.model);
    if (this.profile && cfg.revision && cfg.revision !== this.profile.revision) {
      throw new Error(
        `verified local model revision for ${this.model} must be ${this.profile.revision}`,
      );
    }
    this.revision = cfg.revision || this.profile?.revision;
    this._ensureModelArtifacts = cfg.ensureModelArtifacts || ensurePinnedModelArtifacts;
    this._loadTransformers = cfg.loadTransformers || (() => import("@huggingface/transformers"));
    this.logger = cfg.logger;
    this._pipeline = null;
    this._cache = cfg.embeddingCacheEnabled === false ? null : createEmbeddingCache({
      maxEntries: cfg.cacheMaxEntries ?? 128,
      ttlMs: cfg.cacheTtlMs ?? 300000,
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
        mod = await this._loadTransformers();
      } catch (e) {
        throw new Error(
          "local-transformers embedding provider requires optional dependency @huggingface/transformers. " +
          "Install it for this plugin or switch embedding.provider to openai/openai-compatible. " +
          `Import failed: ${e.message}`,
          { cause: e },
        );
      }
      if (this.cacheDir && mod.env) mod.env.cacheDir = this.cacheDir;
      if (this.profile && this.cacheDir) {
        await this._ensureModelArtifacts(this.profile, this.cacheDir, { logger: this.logger });
      }
      const pipelineOptions = {
        ...(this.cacheDir ? { cache_dir: this.cacheDir } : {}),
        ...(this.revision ? { revision: this.revision } : {}),
        ...(this.profile && this.cacheDir ? { local_files_only: true } : {}),
      };
      this._pipeline = await mod.pipeline("feature-extraction", this.model, pipelineOptions);
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
    const prefixed = input.map((text) => `${prefix}${text}`);
    const options = { pooling: "mean", normalize: true };

    if (input.length === 1) {
      const output = await extractor(prefixed[0], options);
      return [this._validateDim(vectorFromOutput(output))];
    }

    try {
      const output = await extractor(prefixed, options);
      return vectorsFromBatchOutput(output, input.length).map((vector) => this._validateDim(vector));
    } catch (batchErr) {
      const vectors = [];
      for (const text of prefixed) {
        const output = await extractor(text, options);
        vectors.push(this._validateDim(vectorFromOutput(output)));
      }
      return vectors;
    }
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
