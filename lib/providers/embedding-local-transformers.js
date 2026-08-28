import { DEFAULT_LOCAL_E5_DIMENSIONS, DEFAULT_LOCAL_E5_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";
import { createEmbeddingCache } from "../embedding-cache.js";
import {
  JINA_EMBEDDING_PROFILE,
  ensurePinnedModelArtifacts,
  pinnedLocalModelProfile,
} from "./local-model-artifacts.js";

function exactArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function normalizeVector(vector) {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("local embedding returned a zero or non-finite vector");
  return vector.map((value) => value / norm);
}

function projectJinaRows(output, expectedCount, dimensions) {
  if (
    !output?.data
    || !Array.isArray(output.dims)
    || output.dims.length !== 2
    || output.dims[0] !== expectedCount
    || output.dims[1] !== JINA_EMBEDDING_PROFILE.outputDimensions
  ) {
    throw new Error("Jina embedding pooled output must have shape [batch, 1024]");
  }
  const data = Array.from(output.data, Number);
  return Array.from({ length: expectedCount }, (_, row) => {
    const start = row * JINA_EMBEDDING_PROFILE.outputDimensions;
    const projected = data.slice(start, start + dimensions);
    if (projected.length !== dimensions || projected.some((value) => !Number.isFinite(value))) {
      throw new Error("Jina embedding returned an invalid Matryoshka vector");
    }
    return normalizeVector(projected);
  });
}

async function createJinaEmbeddingExtractor(mod, {
  model,
  revision,
  cacheDir,
  dimensions,
}) {
  if (
    typeof mod?.AutoConfig?.from_pretrained !== "function"
    || typeof mod?.AutoTokenizer?.from_pretrained !== "function"
    || typeof mod?.AutoModel?.from_pretrained !== "function"
    || typeof mod?.Tensor !== "function"
    || typeof mod?.mean_pooling !== "function"
  ) throw new Error("Transformers.js Jina embedding capabilities are unavailable");
  const baseOptions = {
    ...(cacheDir ? { cache_dir: cacheDir } : {}),
    revision,
    ...(cacheDir ? { local_files_only: true } : {}),
  };
  const config = await mod.AutoConfig.from_pretrained(model, baseOptions);
  const compatible = exactArray(config?.architectures, ["XLMRobertaModel"])
    && (config?.model_type == null || config.model_type === "xlm-roberta")
    && config?.hidden_size === JINA_EMBEDDING_PROFILE.outputDimensions
    && exactArray(config?.lora_adaptations, JINA_EMBEDDING_PROFILE.taskAdaptations)
    && exactArray(config?.matryoshka_dimensions, JINA_EMBEDDING_PROFILE.matryoshkaDimensions);
  if (!compatible) {
    throw new Error(
      "Jina embedding config must declare exactly XLMRobertaModel, the verified task adapters, and 1024d Matryoshka outputs; refusing model drift.",
    );
  }
  const tokenizer = await mod.AutoTokenizer.from_pretrained(model, baseOptions);
  const loadedModel = await mod.AutoModel.from_pretrained(model, {
    ...baseOptions,
    dtype: JINA_EMBEDDING_PROFILE.dtype,
    config: { ...config, model_type: "xlm-roberta" },
    // The published fp16 graph triggers a broken SimplifiedLayerNormFusion in
    // the Node CPU optimizer. Disabling graph rewrites preserves the exact
    // published graph and is required for deterministic onnxruntime-node load.
    session_options: { graphOptimizationLevel: "disabled" },
  });
  const inputNames = loadedModel?.sessions?.model?.inputNames;
  if (!Array.isArray(inputNames) || !["input_ids", "attention_mask", "task_id"].every((name) => inputNames.includes(name))) {
    await loadedModel?.dispose?.();
    throw new Error("Jina embedding ONNX model must expose input_ids, attention_mask, and task_id");
  }
  const extractor = async (texts, { task } = {}) => {
    const input = Array.isArray(texts) ? texts : [texts];
    const taskName = task === "query" ? "retrieval.query" : "retrieval.passage";
    const taskId = JINA_EMBEDDING_PROFILE.taskAdaptations.indexOf(taskName);
    const modelInputs = await tokenizer(Array.isArray(texts) ? input : input[0], {
      padding: true,
      truncation: true,
    });
    modelInputs.task_id = new mod.Tensor("int64", [BigInt(taskId)], []);
    const outputs = await loadedModel(modelInputs);
    const hidden = outputs?.text_embeds
      ?? outputs?.last_hidden_state
      ?? outputs?.logits
      ?? outputs?.token_embeddings;
    if (!hidden) throw new Error("Jina embedding ONNX model did not return token embeddings");
    const pooled = mod.mean_pooling(hidden, modelInputs.attention_mask);
    const rows = projectJinaRows(pooled, input.length, dimensions);
    return Array.isArray(texts) ? rows : rows[0];
  };
  extractor.dispose = async () => { await loadedModel.dispose?.(); };
  return extractor;
}

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
    this.cacheDir = cfg.cacheDir ? resolveEnvVars(cfg.cacheDir, { groups: ["localPath"], label: "local model cacheDir" }) : undefined;
    this.profile = pinnedLocalModelProfile(this.model);
    if (this.profile?.role && this.profile.role !== "embedding") {
      throw new Error(`${this.model} is a pinned reranker, not an embedding model`);
    }
    this.queryPrefix = cfg.queryPrefix ?? this.profile?.queryPrefix ?? "query: ";
    this.passagePrefix = cfg.passagePrefix ?? this.profile?.passagePrefix ?? "passage: ";
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
    this._pipelinePromise = null;
    this._shutdownPromise = null;
    this._isShutdown = false;
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
    if (this._isShutdown) {
      throw new Error("local-transformers embedding provider is shut down");
    }
    if (this._pipeline) return this._pipeline;
    if (!this._pipelinePromise) {
      this._pipelinePromise = (async () => {
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
        this._pipeline = this.profile?.runtime === "jina-v3"
          ? await createJinaEmbeddingExtractor(mod, {
            model: this.model,
            revision: this.revision,
            cacheDir: this.cacheDir,
            dimensions: this.dim,
          })
          : await mod.pipeline("feature-extraction", this.model, pipelineOptions);
        return this._pipeline;
      })();
    }
    const pending = this._pipelinePromise;
    try {
      return await pending;
    } catch (error) {
      if (this._pipelinePromise === pending) this._pipelinePromise = null;
      throw error;
    }
  }

  /** Dispose model and cache resources once when the host stops or reloads the plugin. */
  async shutdown() {
    if (this._shutdownPromise) return await this._shutdownPromise;
    this._isShutdown = true;
    this._shutdownPromise = (async () => {
      const errors = [];
      if (this._pipelinePromise) {
        try { await this._pipelinePromise; } catch (error) { errors.push(error); }
      }
      const pipeline = this._pipeline;
      this._pipeline = null;
      this._pipelinePromise = null;
      if (typeof pipeline?.dispose === "function") {
        try { await pipeline.dispose(); } catch (error) { errors.push(error); }
      }
      if (typeof this._cache?.close === "function") {
        try { await this._cache.close(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "local-transformers embedding provider shutdown failed");
      }
    })();
    return await this._shutdownPromise;
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
    const taskOptions = this.profile?.runtime === "jina-v3" ? { task: purpose } : options;

    if (input.length === 1) {
      const output = await extractor(prefixed[0], taskOptions);
      return [this._validateDim(vectorFromOutput(output))];
    }

    try {
      const output = await extractor(prefixed, taskOptions);
      return vectorsFromBatchOutput(output, input.length).map((vector) => this._validateDim(vector));
    } catch (batchErr) {
      const vectors = [];
      for (const text of prefixed) {
        const output = await extractor(text, taskOptions);
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
