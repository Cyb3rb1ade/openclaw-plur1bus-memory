import { DEFAULT_LOCAL_RERANKER_MODEL } from "./dimensions.js";
import { resolveEnvVars } from "./env.js";
import { safeDebug } from "../safe-logging.js";

export const JINA_RERANKER_MODEL = "jinaai/jina-reranker-v2-base-multilingual";
export const JINA_RERANKER_REVISION = "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9";
export const BGE_RERANKER_ONNX_MODEL = "woxpas-ai/bge-reranker-v2-m3-onnx";
export const BGE_RERANKER_ONNX_REVISION = "c44ebc43de724ae8816668bb44d2e728e17faa18";
export const BGE_RERANKER_ONNX_ARTIFACT = Object.freeze({
  path: "onnx/model_quantized.onnx",
  size: 569_986_762,
  sha256: "1ed01a24f6e639dbd0a18e74e47b394abb78e6adb13dd23f34f94a79623fb3d3",
});
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
  const config = await mod.AutoConfig.from_pretrained(cfg.model, {
    ...(options.cache_dir ? { cache_dir: options.cache_dir } : {}),
    revision: options.revision,
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
      const options = await prepareLocalRerankerPipelineOptions(mod, {
        model: this.model,
        cacheDir: this.cacheDir,
        revision: this.revision,
        dtype: this.dtype,
      });
      this._pipeline = await mod.pipeline("text-classification", this.model, options);
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
  }
}
