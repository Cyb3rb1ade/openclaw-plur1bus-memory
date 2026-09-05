import { resolve as resolvePath } from "node:path";

import { DEFAULT_LOCAL_E5_DIMENSIONS, DEFAULT_LOCAL_E5_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";
import { createEmbeddingCache } from "../embedding-cache.js";
import { safeDebug } from "../safe-logging.js";
import {
  JINA_EMBEDDING_PROFILE,
  JINA_V5_NANO_EMBEDDING_PROFILE,
  assertPinnedModelLicenseAccepted,
  ensurePinnedModelArtifacts,
  pinnedLocalModelProfile,
} from "./local-model-artifacts.js";
import { createSharedLocalModelLease } from "./local-transformers-shared-pool.js";

/** Default per-text token cap for the pinned local Jina runtimes. */
export const DEFAULT_LOCAL_MAX_TOKENS = 512;

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

function embeddingPipelineIdentity({ model, revision, dimensions, cacheDir, profile, maxTokens }) {
  return JSON.stringify({
    schemaVersion: 1,
    role: "embedding",
    model,
    revision: revision || null,
    dimensions,
    cacheDir: cacheDir || null,
    runtime: profile?.runtime || "feature-extraction",
    dtype: profile?.dtype || null,
    maxTokens: maxTokens ?? null,
    artifacts: (profile?.artifacts || []).map(({ path, sha256 }) => ({ path, sha256 })),
  });
}

async function disposeInferenceValues(...values) {
  const seen = new Set();
  const errors = [];
  const visit = async (value) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
    seen.add(value);
    if (typeof value.dispose === "function") {
      try {
        await value.dispose();
      } catch (error) {
        errors.push(error);
      }
      return;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) await visit(child);
  };
  for (const value of values) await visit(value);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "local embedding inference cleanup failed");
}

async function projectAndDispose(output, project) {
  let operationError = null;
  try {
    return project(output);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await disposeInferenceValues(output);
    } catch (cleanupError) {
      if (operationError) {
        throw new AggregateError(
          [operationError, cleanupError],
          "local embedding projection and inference cleanup failed",
        );
      }
      throw cleanupError;
    }
  }
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
  maxTokens,
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
    // Preserve the verified converted graph exactly. Graph rewrites previously
    // made the upstream fp16 export non-deterministic in onnxruntime-node.
    session_options: { graphOptimizationLevel: "disabled" },
  });
  const session = loadedModel?.sessions?.model;
  const inputNames = session?.inputNames;
  const taskMetadata = session?.inputMetadata?.find((entry) => entry?.name === "task_id");
  if (!Array.isArray(inputNames) || !["input_ids", "attention_mask", "task_id"].every((name) => inputNames.includes(name))) {
    await loadedModel?.dispose?.();
    throw new Error("Jina embedding ONNX model must expose input_ids, attention_mask, and task_id");
  }
  if (
    taskMetadata?.isTensor !== true
    || taskMetadata?.type !== "int64"
    || !Array.isArray(taskMetadata?.shape)
    || taskMetadata.shape.length !== 1
  ) {
    await loadedModel?.dispose?.();
    throw new Error("Jina embedding ONNX task_id must be a rank-1 int64 tensor");
  }
  const extractor = async (texts, { task } = {}) => {
    const input = Array.isArray(texts) ? texts : [texts];
    const taskName = task === "query" ? "retrieval.query" : "retrieval.passage";
    const taskId = JINA_EMBEDDING_PROFILE.taskAdaptations.indexOf(taskName);
    let modelInputs;
    let outputs;
    let pooled;
    let operationError = null;
    try {
      modelInputs = await tokenizer(Array.isArray(texts) ? input : input[0], {
        padding: true,
        truncation: true,
        max_length: maxTokens,
      });
      modelInputs.task_id = new mod.Tensor("int64", [BigInt(taskId)], [1]);
      outputs = await loadedModel(modelInputs);
      const hidden = outputs?.text_embeds
        ?? outputs?.last_hidden_state
        ?? outputs?.logits
        ?? outputs?.token_embeddings;
      if (!hidden) throw new Error("Jina embedding ONNX model did not return token embeddings");
      pooled = mod.mean_pooling(hidden, modelInputs.attention_mask);
      const rows = projectJinaRows(pooled, input.length, dimensions);
      return Array.isArray(texts) ? rows : rows[0];
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await disposeInferenceValues(pooled, outputs, modelInputs);
      } catch (cleanupError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, cleanupError],
            "Jina embedding inference and cleanup failed",
          );
        }
        throw cleanupError;
      }
    }
  };
  extractor.dispose = async () => { await loadedModel.dispose?.(); };
  return extractor;
}

function projectJinaV5Rows(output, expectedCount, dimensions) {
  const width = JINA_V5_NANO_EMBEDDING_PROFILE.outputDimensions;
  if (
    !output?.data
    || !Array.isArray(output.dims)
    || output.dims.length !== 2
    || output.dims[0] !== expectedCount
    || output.dims[1] !== width
  ) {
    throw new Error("Jina v5 embedding pooled output must have shape [batch, 768]");
  }
  const data = Array.from(output.data, Number);
  return Array.from({ length: expectedCount }, (_, row) => {
    const projected = data.slice(row * width, row * width + dimensions);
    if (projected.length !== dimensions || projected.some((value) => !Number.isFinite(value))) {
      throw new Error("Jina v5 embedding returned an invalid Matryoshka vector");
    }
    return normalizeVector(projected);
  });
}

/**
 * Last-token pooling over the hidden states, as the published usage does: the
 * hidden state of the last position whose attention mask is set. Works for
 * either padding side because it scans the mask instead of assuming a side.
 */
function lastTokenPool(hidden, attentionMask, mod) {
  if (!Array.isArray(hidden?.dims) || hidden.dims.length !== 3) {
    throw new Error("Jina v5 embedding hidden states must have shape [batch, sequence, hidden]");
  }
  const [batch, sequence, width] = hidden.dims;
  if (!Array.isArray(attentionMask?.dims) || attentionMask.dims[0] !== batch || attentionMask.dims[1] !== sequence) {
    throw new Error("Jina v5 embedding attention mask does not match the hidden states");
  }
  const pooled = new Float32Array(batch * width);
  for (let row = 0; row < batch; row += 1) {
    let last = -1;
    for (let position = 0; position < sequence; position += 1) {
      if (Number(attentionMask.data[row * sequence + position]) === 1) last = position;
    }
    if (last < 0) throw new Error("Jina v5 embedding input row has no attended token");
    const start = (row * sequence + last) * width;
    for (let index = 0; index < width; index += 1) pooled[row * width + index] = Number(hidden.data[start + index]);
  }
  return new mod.Tensor("float32", pooled, [batch, width]);
}

/**
 * Jina v5 Text Nano: EuroBERT encoder whose ONNX export emits the normalized
 * `sentence_embedding` (last-token pooled) next to the hidden states. Queries
 * and documents are distinguished by the text prefixes the caller applies from
 * the profile; the graph takes only input_ids and attention_mask.
 */
async function createJinaV5EmbeddingExtractor(mod, {
  model,
  revision,
  cacheDir,
  dimensions,
  maxTokens,
}) {
  if (
    typeof mod?.AutoConfig?.from_pretrained !== "function"
    || typeof mod?.AutoTokenizer?.from_pretrained !== "function"
    || typeof mod?.AutoModel?.from_pretrained !== "function"
    || typeof mod?.Tensor !== "function"
  ) throw new Error("Transformers.js Jina v5 embedding capabilities are unavailable");
  const profile = JINA_V5_NANO_EMBEDDING_PROFILE;
  const baseOptions = {
    ...(cacheDir ? { cache_dir: cacheDir } : {}),
    revision,
    ...(cacheDir ? { local_files_only: true } : {}),
  };
  const config = await mod.AutoConfig.from_pretrained(model, baseOptions);
  const compatible = exactArray(config?.architectures, ["EuroBertModel"])
    && config?.model_type === "eurobert"
    && config?.hidden_size === profile.outputDimensions;
  if (!compatible) {
    throw new Error(
      "Jina v5 embedding config must declare exactly EuroBertModel (eurobert) with 768 hidden units; refusing model drift.",
    );
  }
  const tokenizer = await mod.AutoTokenizer.from_pretrained(model, baseOptions);
  const loadedModel = await mod.AutoModel.from_pretrained(model, {
    ...baseOptions,
    dtype: profile.dtype,
    // Same policy as the v3 path: run the verified graph exactly as published.
    session_options: { graphOptimizationLevel: "disabled" },
  });
  const session = loadedModel?.sessions?.model;
  const inputNames = session?.inputNames;
  if (!Array.isArray(inputNames) || !["input_ids", "attention_mask"].every((name) => inputNames.includes(name))) {
    await loadedModel?.dispose?.();
    throw new Error("Jina v5 embedding ONNX model must expose input_ids and attention_mask");
  }
  const extractor = async (texts) => {
    const input = Array.isArray(texts) ? texts : [texts];
    let modelInputs;
    let outputs;
    let pooled;
    let operationError = null;
    try {
      modelInputs = await tokenizer(Array.isArray(texts) ? input : input[0], {
        padding: true,
        truncation: true,
        max_length: maxTokens,
      });
      outputs = await loadedModel(modelInputs);
      const sentence = outputs?.sentence_embedding;
      if (sentence?.data && Array.isArray(sentence.dims) && sentence.dims.length === 2) {
        pooled = sentence;
      } else {
        const hidden = outputs?.last_hidden_state ?? outputs?.token_embeddings;
        if (!hidden) throw new Error("Jina v5 embedding ONNX model returned neither sentence_embedding nor hidden states");
        pooled = lastTokenPool(hidden, modelInputs.attention_mask, mod);
      }
      const rows = projectJinaV5Rows(pooled, input.length, dimensions);
      return Array.isArray(texts) ? rows : rows[0];
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await disposeInferenceValues(pooled, outputs, modelInputs);
      } catch (cleanupError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, cleanupError],
            "Jina v5 embedding inference and cleanup failed",
          );
        }
        throw cleanupError;
      }
    }
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

/** Revision-pinned local embedding provider with bounded cache and license gates. */
export class LocalTransformersEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model || DEFAULT_LOCAL_E5_MODEL;
    this.dim = Number(cfg.dimensions || DEFAULT_LOCAL_E5_DIMENSIONS);
    const expandedCacheDir = cfg.cacheDir
      ? resolveEnvVars(cfg.cacheDir, { groups: ["localPath"], label: "local model cacheDir" })
      : undefined;
    this.cacheDir = expandedCacheDir ? resolvePath(expandedCacheDir) : undefined;
    this.profile = pinnedLocalModelProfile(this.model);
    this.acceptNonCommercialLicense = cfg.acceptNonCommercialLicense === true;
    if (this.profile?.role && this.profile.role !== "embedding") {
      throw new Error(`${this.model} is a pinned reranker, not an embedding model`);
    }
    this.queryPrefix = cfg.queryPrefix ?? this.profile?.queryPrefix ?? "query: ";
    this.passagePrefix = cfg.passagePrefix ?? this.profile?.passagePrefix ?? "passage: ";
    // Jina v5 tells queries and documents apart only by these prefixes. A
    // config block copied from the v3 profile (empty prefixes) would silently
    // embed everything as untyped text; refuse it like a wrong revision.
    if (
      this.profile?.runtime === "jina-v5"
      && (this.queryPrefix !== this.profile.queryPrefix || this.passagePrefix !== this.profile.passagePrefix)
    ) {
      throw new Error(
        `${this.model} requires queryPrefix ${JSON.stringify(this.profile.queryPrefix)} and passagePrefix ${JSON.stringify(this.profile.passagePrefix)}`,
      );
    }
    if (this.profile && cfg.revision && cfg.revision !== this.profile.revision) {
      throw new Error(
        `verified local model revision for ${this.model} must be ${this.profile.revision}`,
      );
    }
    this.revision = cfg.revision || this.profile?.revision;
    // Token cap per text for the pinned Jina runtimes. Both models accept 8192
    // tokens, and the ONNX runtime materializes attention for the longest
    // text of a batch times the batch size: a single 15,000-character card
    // drove the process past 40 GB and into the OOM killer during the
    // 7.11.0 lab run, and one capped batch of the longest cards still parked
    // 1.7 GB (nano) to 3.4 GB (v3) in the arena at 1024 tokens. Memory cards
    // are summaries; 512 tokens cover the 90th percentile several times over.
    const configuredMaxTokens = cfg.maxTokens ?? this.profile?.maxTokens ?? DEFAULT_LOCAL_MAX_TOKENS;
    if (!Number.isSafeInteger(configuredMaxTokens) || configuredMaxTokens < 32 || configuredMaxTokens > 8192) {
      throw new Error(`local embedding maxTokens must be an integer between 32 and 8192, got ${configuredMaxTokens}`);
    }
    this.maxTokens = configuredMaxTokens;
    this._ensureModelArtifacts = cfg.ensureModelArtifacts || ensurePinnedModelArtifacts;
    this._loadTransformers = cfg.loadTransformers || (() => import("@huggingface/transformers"));
    this.logger = cfg.logger;
    this._pipeline = null;
    this._pipelinePromise = null;
    this._shutdownPromise = null;
    this._isShutdown = false;
    this._activeOperations = 0;
    this._operationDrainPromise = null;
    this._operationDrainResolve = null;
    this._localModelGeneration = cfg.localModelGeneration || null;
    this._sharedModelOwner = cfg.sharedModelOwner === true;
    this._sharedModelLease = cfg.sharedModelPool === true
      ? createSharedLocalModelLease({
          key: embeddingPipelineIdentity({
            model: this.model,
            revision: this.revision,
            dimensions: this.dim,
            cacheDir: this.cacheDir,
            profile: this.profile,
            maxTokens: this.maxTokens,
          }),
          owner: this._sharedModelOwner,
          requireOwner: cfg.sharedModelRequireOwner === true,
          activationManagedOwner: cfg.sharedModelActivationManaged === true,
        })
      : null;
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
    const unregister = this._localModelGeneration?.registerResource?.(this, `embedding:${this.model}`);
    this._unregisterLocalModel = typeof unregister === "function" ? unregister : null;
  }

  dimensions() {
    return this.dim;
  }

  /** Attach an activation-owned full runtime before scoped providers may load its shared model. */
  async activateSharedModelOwner() {
    if (!this._sharedModelOwner || !this._sharedModelLease) return false;
    if (this._isShutdown) {
      throw new Error("local-transformers embedding provider is shut down");
    }
    return await this._sharedModelLease.activate();
  }

  _beginOperation() {
    if (this._isShutdown) {
      throw new Error("local-transformers embedding provider is shut down");
    }
    this._activeOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this._activeOperations -= 1;
      if (this._activeOperations === 0 && this._operationDrainResolve) {
        const resolve = this._operationDrainResolve;
        this._operationDrainResolve = null;
        this._operationDrainPromise = null;
        resolve();
      }
    };
  }

  async _drainOperations() {
    if (this._activeOperations === 0) return;
    if (!this._operationDrainPromise) {
      this._operationDrainPromise = new Promise((resolve) => {
        this._operationDrainResolve = resolve;
      });
    }
    await this._operationDrainPromise;
  }

  async _getPipeline() {
    if (this._isShutdown) {
      throw new Error("local-transformers embedding provider is shut down");
    }
    assertPinnedModelLicenseAccepted(this.profile, this.acceptNonCommercialLicense);
    if (this._pipeline) return this._pipeline;
    if (!this._pipelinePromise) {
      this._pipelinePromise = (async () => {
        await this._localModelGeneration?.beforeAcquire?.();
        if (this._isShutdown) {
          throw new Error("local-transformers embedding provider is shut down");
        }
        const loadPipeline = async () => {
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
            await this._ensureModelArtifacts(this.profile, this.cacheDir, {
              acceptNonCommercialLicense: this.acceptNonCommercialLicense,
              logger: this.logger,
            });
          }
          const pipelineOptions = {
            ...(this.cacheDir ? { cache_dir: this.cacheDir } : {}),
            ...(this.revision ? { revision: this.revision } : {}),
            ...(this.profile && this.cacheDir ? { local_files_only: true } : {}),
          };
          const extractorOptions = {
            model: this.model,
            revision: this.revision,
            cacheDir: this.cacheDir,
            dimensions: this.dim,
            maxTokens: this.maxTokens,
          };
          if (this.profile?.runtime === "jina-v3") return await createJinaEmbeddingExtractor(mod, extractorOptions);
          if (this.profile?.runtime === "jina-v5") return await createJinaV5EmbeddingExtractor(mod, extractorOptions);
          return await mod.pipeline("feature-extraction", this.model, pipelineOptions);
        };
        this._pipeline = this._sharedModelLease
          ? await this._sharedModelLease.acquire(loadPipeline)
          : await loadPipeline();
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
      await this._drainOperations();
      if (this._pipelinePromise) {
        try { await this._pipelinePromise; } catch (error) { errors.push(error); }
      }
      const pipeline = this._pipeline;
      this._pipeline = null;
      this._pipelinePromise = null;
      if (this._sharedModelLease) {
        try { await this._sharedModelLease.release(); } catch (error) { errors.push(error); }
      } else if (typeof pipeline?.dispose === "function") {
        try { await pipeline.dispose(); } catch (error) { errors.push(error); }
      }
      if (typeof this._cache?.close === "function") {
        try { await this._cache.close(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "local-transformers embedding provider shutdown failed");
      }
      this._unregisterLocalModel?.();
      this._unregisterLocalModel = null;
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
    const finishSharedOperation = this._sharedModelLease?.beginOperation();
    const prefix = purpose === "query" ? this.queryPrefix : this.passagePrefix;
    const input = Array.isArray(texts) ? texts : [texts];
    const prefixed = input.map((text) => `${prefix}${text}`);
    const options = { pooling: "mean", normalize: true };
    // v3 selects its task adapter here; v5 is told apart by the prefixes above
    // and its extractor takes no options; the generic pipeline pools itself.
    const taskOptions = this.profile?.runtime === "jina-v3"
      ? { task: purpose }
      : this.profile?.runtime === "jina-v5" ? {} : options;
    try {
      if (input.length === 1) {
        const output = await extractor(prefixed[0], taskOptions);
        return await projectAndDispose(output, (value) => [this._validateDim(vectorFromOutput(value))]);
      }

      try {
        const output = await extractor(prefixed, taskOptions);
        return await projectAndDispose(
          output,
          (value) => vectorsFromBatchOutput(value, input.length).map((vector) => this._validateDim(vector)),
        );
      } catch (batchErr) {
        safeDebug(this.logger, "local-transformers-embedding.batch-fallback", batchErr, { count: input.length });
        const vectors = [];
        for (const text of prefixed) {
          const output = await extractor(text, taskOptions);
          vectors.push(await projectAndDispose(output, (value) => this._validateDim(vectorFromOutput(value))));
        }
        return vectors;
      }
    } finally {
      finishSharedOperation?.();
    }
  }

  async _embedBatchForPurpose(texts, purpose = "passage", options = {}) {
    const finish = this._beginOperation();
    try {
      assertPinnedModelLicenseAccepted(this.profile, this.acceptNonCommercialLicense);
      const input = Array.isArray(texts) ? texts : [texts];
      if (input.length === 0) return [];
      if (!this._cache) return await this._computeBatch(input, purpose);
      return await this._cache.getMany(input, {
        provider: this.id,
        model: `${this.model}:${purpose}`,
        dimensions: this.dim,
        agentId: options.agentId,
      }, (missing) => this._computeBatch(missing, purpose));
    } finally {
      finish();
    }
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
