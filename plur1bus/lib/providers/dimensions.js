export const LEGACY_DEFAULT_MODEL = "text-embedding-3-small";
export const FRESH_OPENAI_DEFAULT_MODEL = "text-embedding-3-large";
export const DEFAULT_OPENAI_DIMENSIONS = 3072;
export const DEFAULT_LOCAL_E5_MODEL = "intfloat/multilingual-e5-small";
export const DEFAULT_LOCAL_E5_DIMENSIONS = 384;
export const DEFAULT_LOCAL_MODEL_CACHE = "${OPENCLAW_HOME}/models/plur1bus";
export const DEFAULT_COHERE_RERANK_MODEL = "rerank-v3.5";
export const DEFAULT_LOCAL_RERANKER_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";

export const EMBEDDING_DIMENSIONS = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  [DEFAULT_LOCAL_E5_MODEL]: DEFAULT_LOCAL_E5_DIMENSIONS,
};

export function embeddingDimensionsForModel(model) {
  return EMBEDDING_DIMENSIONS[model] || null;
}

export function isOpenAiEmbeddingModel(model = "") {
  return !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
}

export function defaultDimensionForOpenAiModel(model = "") {
  if (model.includes("small") || model.includes("ada")) return 1536;
  return DEFAULT_OPENAI_DIMENSIONS;
}

