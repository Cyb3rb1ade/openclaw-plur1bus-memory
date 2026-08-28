import { DEFAULT_LOCAL_RERANKER_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";
import { safeDebug } from "../safe-logging.js";
import {
  BGE_RERANKER_PROFILE,
  JINA_RERANKER_PROFILE,
  ensurePinnedModelArtifacts,
  pinnedLocalModelProfile,
} from "./local-model-artifacts.js";

export const JINA_RERANKER_MODEL = JINA_RERANKER_PROFILE.model;
export const JINA_RERANKER_REVISION = JINA_RERANKER_PROFILE.revision;
export const JINA_RERANKER_ONNX_ARTIFACT = JINA_RERANKER_PROFILE.artifacts.find(
  (entry) => entry.path.startsWith("onnx/"),
);
export const BGE_RERANKER_ONNX_MODEL = BGE_RERANKER_PROFILE.model;
export const BGE_RERANKER_ONNX_REVISION = BGE_RERANKER_PROFILE.revision;
export const BGE_RERANKER_ONNX_ARTIFACT = BGE_RERANKER_PROFILE.artifacts.find(
  (entry) => entry.path.startsWith("onnx/"),
);
const JINA_RERANKER_ARCHITECTURE = "XLMRobertaForSequenceClassification";
const BGE_SOURCE_MODEL_WITHOUT_ONNX = "BAAI/bge-reranker-v2-m3";

const VERIFIED_LOCAL_RERANKER_PROFILES = new Map([
  [JINA_RERANKER_MODEL, {
    label: "Jina",
    revision: JINA_RERANKER_REVISION,
    architecture: JINA_RERANKER_ARCHITECTURE,
  }],
  [BGE_RERANKER_ONNX_MODEL, {
    label: "BGE",
    revision: BGE_RERANKER_ONNX_REVISION,
    architecture: JINA_RERANKER_ARCHITECTURE,
  }],
]);

/**
 * Build validated Transformers.js load options, including the narrowly scoped
 * Jina config repair required by its published model_type:null config.
 */
export async function prepareLocalRerankerPipelineOptions(mod, cfg = {}) {
  const options = {};
  if (cfg.cacheDir) options.cache_dir = cfg.cacheDir;
  if (cfg.revision) options.revision = cfg.revision;
  if (cfg.dtype) options.dtype = cfg.dtype;
  if (cfg.model === BGE_SOURCE_MODEL_WITHOUT_ONNX) {
    throw new Error(
      `${BGE_SOURCE_MODEL_WITHOUT_ONNX} is a source repository and does not publish ` +
      `onnx/model*.onnx; use ${BGE_RERANKER_ONNX_MODEL} instead.`,
    );
  }
  const profile = VERIFIED_LOCAL_RERANKER_PROFILES.get(cfg.model);
  if (!profile) return options;

  options.revision ??= profile.revision;
  options.dtype ??= "q8";
  if (options.cache_dir) options.local_files_only = true;
  const config = await mod.AutoConfig.from_pretrained(cfg.model, {
    ...(options.cache_dir ? { cache_dir: options.cache_dir } : {}),
    revision: options.revision,
    ...(options.local_files_only ? { local_files_only: true } : {}),
  });
  const architectures = Array.isArray(config?.architectures) ? config.architectures : [];
  const exactArchitecture = architectures.length === 1
    && architectures[0] === profile.architecture;
  const compatibleModelType = config?.model_type == null || config.model_type === "xlm-roberta";
  const labelEntries = config?.id2label && typeof config.id2label === "object"
    ? Object.entries(config.id2label)
    : [];
  const exactSingleLabel = labelEntries.length === 1
    && labelEntries[0][0] === "0"
    && labelEntries[0][1] === "LABEL_0";
  const oneLabelClassifier = config?.num_labels === 1
    || (config?.num_labels == null && exactSingleLabel);
  if (!exactArchitecture || !compatibleModelType || !oneLabelClassifier) {
    throw new Error(
      `${profile.label} reranker config must declare exactly ${profile.architecture}, ` +
      "model_type null/xlm-roberta, and num_labels=1; refusing an unknown model structure.",
    );
  }
  options.config = {
    ...config,
    model_type: "xlm-roberta",
    num_labels: 1,
    // Transformers.js 4.2 applies a one-class softmax by default, producing a
    // constant 1.0. Sigmoid preserves the raw-logit ordering for reranking.
    problem_type: "multi_label_classification",
  };
  return options;
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

async function scoresFromSequenceClassifier(classifier, query, documents) {
  const queries = documents.map(() => query);
  const modelInputs = classifier.tokenizer(queries, {
    text_pair: documents,
    padding: true,
    truncation: true,
  });
  const outputs = await classifier.model(modelInputs);
  const logits = outputs?.logits;
  const dims = Array.isArray(logits?.dims) ? logits.dims : [];
  const data = logits?.data;
  if (
    dims.length !== 2
    || dims[0] !== documents.length
    || dims[1] !== 1
    || (!Array.isArray(data) && !ArrayBuffer.isView(data))
    || data.length !== documents.length
  ) {
    throw new Error("local reranker sequence-classifier logits must have shape [documents, 1]");
  }
  return Array.from(data, (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("local reranker returned a non-finite logit");
    return sigmoid(numeric);
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
    this.revision = cfg.revision;
    this.dtype = cfg.dtype;
    this.logger = cfg.logger;
    this.profile = pinnedLocalModelProfile(this.model);
    if (this.profile && this.revision && this.revision !== this.profile.revision) {
      throw new Error(
        `verified local model revision for ${this.model} must be ${this.profile.revision}`,
      );
    }
    this.revision ||= this.profile?.revision;
    this._ensureModelArtifacts = cfg.ensureModelArtifacts || ensurePinnedModelArtifacts;
    this._loadTransformers = cfg.loadTransformers || (() => import("@huggingface/transformers"));
    this._pipeline = null;
    this._pipelinePromise = null;
    this._shutdownPromise = null;
    this._isShutdown = false;
    this._activeOperations = 0;
    this._operationDrainPromise = null;
    this._operationDrainResolve = null;
    this._localModelGeneration = cfg.localModelGeneration || null;
    const unregister = this._localModelGeneration?.registerResource?.(this, `reranker:${this.model}`);
    this._unregisterLocalModel = typeof unregister === "function" ? unregister : null;
  }

  _beginOperation() {
    if (this._isShutdown) {
      throw new Error("local-transformers reranker provider is shut down");
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
      throw new Error("local-transformers reranker provider is shut down");
    }
    if (this._pipeline) return this._pipeline;
    if (!this._pipelinePromise) {
      this._pipelinePromise = (async () => {
        await this._localModelGeneration?.beforeAcquire?.();
        if (this._isShutdown) {
          throw new Error("local-transformers reranker provider is shut down");
        }
        let mod;
        try {
          mod = await this._loadTransformers();
        } catch (e) {
          throw new Error(
            "local-transformers reranker requires optional dependency @huggingface/transformers. " +
            "Install it for this plugin, choose Cohere, or disable reranking. " +
            `Import failed: ${e.message}`
          );
        }
        if (this.cacheDir && mod.env) mod.env.cacheDir = this.cacheDir;
        if (this.profile && this.cacheDir) {
          await this._ensureModelArtifacts(this.profile, this.cacheDir, { logger: this.logger });
        }
        const options = await prepareLocalRerankerPipelineOptions(mod, {
          model: this.model,
          cacheDir: this.cacheDir,
          revision: this.revision,
          dtype: this.dtype,
        });
        this._pipeline = await mod.pipeline("text-classification", this.model, options);
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

  /** Dispose the Transformers.js model once when the host stops or reloads the plugin. */
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
      if (typeof pipeline?.dispose === "function") {
        try { await pipeline.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "local-transformers reranker provider shutdown failed");
      }
      this._unregisterLocalModel?.();
      this._unregisterLocalModel = null;
    })();
    return await this._shutdownPromise;
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
    const finish = this._beginOperation();
    try {
      const classifier = await this._getPipeline();
      let scores;
      if (typeof classifier?.tokenizer === "function" && typeof classifier?.model === "function") {
        scores = await scoresFromSequenceClassifier(classifier, query, documents);
      } else {
        const pairs = documents.map((document) => ({ text: query, text_pair: document }));
        try {
          scores = scoresFromBatchOutput(await classifier(pairs), documents.length);
        } catch (err) {
          safeDebug(this.logger, "local-transformers-reranker.batch-fallback", err, { count: documents.length });
          scores = [];
          for (const document of documents) {
            scores.push(await this._scorePair(classifier, query, document));
          }
        }
      }
      const scored = scores.map((score, index) => ({ index, relevance_score: score }));
      return scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, topN);
    } finally {
      finish();
    }
  }
}
