import {
  DEFAULT_COHERE_RERANK_MODEL,
  DEFAULT_LOCAL_E5_DIMENSIONS,
  DEFAULT_LOCAL_E5_MODEL,
  DEFAULT_LOCAL_MODEL_CACHE,
  DEFAULT_LOCAL_RERANKER_MODEL,
  FRESH_OPENAI_DEFAULT_MODEL,
  LEGACY_DEFAULT_MODEL,
  defaultDimensionForOpenAiModel,
  embeddingDimensionsForModel,
} from "./dimensions.js";

function stripEmpty(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

export function normalizeEmbeddingConfig(raw = {}, opts = {}) {
  const mode = opts.mode || "existing";
  const provider = raw.provider || (raw.baseUrl ? "openai-compatible" : raw.apiKey ? "openai-compatible" : "openai");
  if (provider === "local-transformers") {
    const local = raw.local || {};
    const model = stripEmpty(local.model) || DEFAULT_LOCAL_E5_MODEL;
    const dimensions = Number(local.dimensions || raw.dimensions || DEFAULT_LOCAL_E5_DIMENSIONS);
    return {
      provider,
      id: provider,
      model,
      dimensions,
      local: {
        model,
        dimensions,
        queryPrefix: local.queryPrefix ?? "query: ",
        passagePrefix: local.passagePrefix ?? "passage: ",
        cacheDir: local.cacheDir || raw.cacheDir || DEFAULT_LOCAL_MODEL_CACHE,
      },
      fallback: null,
    };
  }

  const model = stripEmpty(raw.model) || (mode === "fresh" ? FRESH_OPENAI_DEFAULT_MODEL : LEGACY_DEFAULT_MODEL);
  const dimensions = Number(raw.dimensions || embeddingDimensionsForModel(model) || defaultDimensionForOpenAiModel(model));
  return {
    provider,
    id: provider,
    apiKey: raw.apiKey,
    model,
    baseUrl: raw.baseUrl,
    dimensions,
    fallback: raw.fallback || null,
  };
}

export function normalizeRerankerConfig(raw = {}) {
  if (raw.provider === "disabled" || raw.enabled === false) {
    return { provider: "disabled", enabled: false, candidates: raw.candidates ?? 20 };
  }
  const provider = raw.provider || (raw.apiKey ? "cohere" : "disabled");
  const timeoutMs = raw.timeoutMs ?? 5000;
  const fallbackOnError = raw.fallbackOnError !== false;
  if (provider === "local-transformers") {
    const local = raw.local || {};
    return {
      provider,
      enabled: raw.enabled !== false,
      model: local.model || raw.model || DEFAULT_LOCAL_RERANKER_MODEL,
      candidates: raw.candidates ?? 20,
      timeoutMs,
      fallbackOnError,
      local: {
        model: local.model || raw.model || DEFAULT_LOCAL_RERANKER_MODEL,
        cacheDir: local.cacheDir || DEFAULT_LOCAL_MODEL_CACHE,
      },
    };
  }
  if (provider === "cohere") {
    return {
      provider,
      enabled: raw.enabled !== false && !!raw.apiKey,
      apiKey: raw.apiKey,
      model: raw.model || DEFAULT_COHERE_RERANK_MODEL,
      candidates: raw.candidates ?? 20,
      timeoutMs,
      fallbackOnError,
    };
  }
  return { provider: "disabled", enabled: false, candidates: raw.candidates ?? 20 };
}

