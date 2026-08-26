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
import { pinnedLocalModelProfile } from "./local-model-artifacts.js";

function stripEmpty(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

export function normalizeEmbeddingConfig(raw = {}, opts = {}) {
  const mode = opts.mode || "existing";
  const provider = raw.provider || (raw.baseUrl ? "openai-compatible" : raw.apiKey ? "openai-compatible" : "openai");
  if (provider === "local-transformers") {
    const local = raw.local || {};
    const model = stripEmpty(local.model) || DEFAULT_LOCAL_E5_MODEL;
    const profile = pinnedLocalModelProfile(model);
    const dimensions = Number(local.dimensions || raw.dimensions || DEFAULT_LOCAL_E5_DIMENSIONS);
    const cacheMaxEntries = raw.embeddingCacheMaxEntries ?? raw.cacheMaxEntries;
    const cacheTtlMs = raw.embeddingCacheTtlMs ?? raw.cacheTtlMs;
    return {
      provider,
      id: provider,
      model,
      dimensions,
      local: {
        model,
        dimensions,
        revision: stripEmpty(local.revision) || profile?.revision,
        queryPrefix: local.queryPrefix ?? "query: ",
        passagePrefix: local.passagePrefix ?? "passage: ",
        cacheDir: local.cacheDir || raw.cacheDir || DEFAULT_LOCAL_MODEL_CACHE,
      },
      fallback: null,
      embeddingCacheEnabled: raw.embeddingCacheEnabled,
      cacheMaxEntries,
      cacheTtlMs,
      embeddingCachePersist: raw.embeddingCachePersist,
      embeddingCachePersistDebug: raw.embeddingCachePersistDebug,
      embeddingCacheCoalesce: raw.embeddingCacheCoalesce,
      embeddingCacheMetrics: raw.embeddingCacheMetrics,
      embeddingCacheScope: raw.embeddingCacheScope,
      embeddingCacheMaxBytes: raw.embeddingCacheMaxBytes,
    };
  }

  const model = stripEmpty(raw.model) || (mode === "fresh" ? FRESH_OPENAI_DEFAULT_MODEL : LEGACY_DEFAULT_MODEL);
  const dimensions = Number(raw.dimensions || embeddingDimensionsForModel(model) || defaultDimensionForOpenAiModel(model));
  const cacheMaxEntries = raw.embeddingCacheMaxEntries ?? raw.cacheMaxEntries;
  const cacheTtlMs = raw.embeddingCacheTtlMs ?? raw.cacheTtlMs;
  return {
    provider,
    id: provider,
    apiKey: raw.apiKey,
    apiKeyEnv: raw.apiKeyEnv,
    model,
    baseUrl: raw.baseUrl,
    dimensions,
    fallback: raw.fallback || null,
    embeddingCacheEnabled: raw.embeddingCacheEnabled,
    cacheMaxEntries,
    cacheTtlMs,
    embeddingCachePersist: raw.embeddingCachePersist,
    embeddingCachePersistDebug: raw.embeddingCachePersistDebug,
    embeddingCacheCoalesce: raw.embeddingCacheCoalesce,
    embeddingCacheMetrics: raw.embeddingCacheMetrics,
    embeddingCacheScope: raw.embeddingCacheScope,
    embeddingCacheMaxBytes: raw.embeddingCacheMaxBytes,
  };
}

export function normalizeRerankerConfig(raw = {}) {
  if (raw.provider === "disabled" || raw.enabled === false) {
    return { provider: "disabled", enabled: false, candidates: raw.candidates ?? 20 };
  }
  const provider = raw.provider || ((raw.apiKey || raw.apiKeyEnv) ? "cohere" : "disabled");
  const timeoutMs = raw.timeoutMs ?? 5000;
  const fallbackOnError = raw.fallbackOnError !== false;
  if (provider === "local-transformers") {
    const local = raw.local || {};
    const model = local.model || raw.model || DEFAULT_LOCAL_RERANKER_MODEL;
    const profile = pinnedLocalModelProfile(model);
    const fallbackProvider = raw.fallbackProvider ?? "disabled";
    const fallbackModel = fallbackProvider === "local-transformers"
      ? (raw.fallbackModel || DEFAULT_LOCAL_RERANKER_MODEL)
      : null;
    const fallbackProfile = pinnedLocalModelProfile(fallbackModel);
    return {
      provider,
      enabled: raw.enabled !== false,
      model,
      candidates: raw.candidates ?? 20,
      timeoutMs,
      fallbackOnError,
      fallbackProvider,
      fallbackModel,
      fallbackRevision: stripEmpty(raw.fallbackRevision) || fallbackProfile?.revision,
      fallbackCacheDir: raw.fallbackCacheDir || DEFAULT_LOCAL_MODEL_CACHE,
      local: {
        model,
        revision: stripEmpty(local.revision) || profile?.revision,
        dtype: stripEmpty(local.dtype),
        cacheDir: local.cacheDir || DEFAULT_LOCAL_MODEL_CACHE,
      },
    };
  }
  if (provider === "cohere") {
    const fallbackProvider = raw.fallbackProvider ?? "disabled";
    const fallbackModel = fallbackProvider === "local-transformers"
      ? (raw.fallbackModel || DEFAULT_LOCAL_RERANKER_MODEL)
      : null;
    const fallbackProfile = pinnedLocalModelProfile(fallbackModel);
    return {
      provider,
      enabled: raw.enabled !== false && !!(raw.apiKey || raw.apiKeyEnv),
      apiKey: raw.apiKey,
      apiKeyEnv: raw.apiKeyEnv,
      model: raw.model || DEFAULT_COHERE_RERANK_MODEL,
      candidates: raw.candidates ?? 20,
      timeoutMs,
      fallbackOnError,
      fallbackProvider,
      fallbackModel,
      fallbackRevision: stripEmpty(raw.fallbackRevision) || fallbackProfile?.revision,
      fallbackCacheDir: raw.fallbackCacheDir || DEFAULT_LOCAL_MODEL_CACHE,
    };
  }
  return { provider: "disabled", enabled: false, candidates: raw.candidates ?? 20 };
}
