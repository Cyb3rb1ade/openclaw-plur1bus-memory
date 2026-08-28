import {
  DEFAULT_COHERE_RERANK_MODEL,
  DEFAULT_LOCAL_E5_DIMENSIONS,
  DEFAULT_LOCAL_E5_MODEL,
  DEFAULT_LOCAL_MODEL_CACHE,
  DEFAULT_LOCAL_RERANKER_MODEL,
  FRESH_OPENAI_DEFAULT_MODEL,
  LEGACY_DEFAULT_MODEL,
  defaultDimensionForOpenAiModel,
  embeddingDimensionCapability,
  embeddingDimensionsForModel,
} from "./dimensions.js";
import { pinnedLocalModelProfile } from "./local-model-artifacts.js";
import { resolveEnvVars } from "./env.js";

function stripEmpty(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function validatedDimensions({ provider, model, configured, fallback }) {
  const dimensions = Number(configured ?? fallback);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error(`embedding dimensions for ${model} must be a positive integer`);
  }
  const capability = embeddingDimensionCapability({ provider, model });
  if (capability.mode === "fixed" && dimensions !== capability.defaultDimensions) {
    throw new Error(
      `${model} has fixed ${capability.defaultDimensions} dimensions; configured ${dimensions}`,
    );
  }
  if (
    capability.mode === "selectable"
    && (dimensions < capability.minDimensions || dimensions > capability.maxDimensions)
  ) {
    throw new Error(
      `${model} supports dimensions from ${capability.minDimensions} through ${capability.maxDimensions}; configured ${dimensions}`,
    );
  }
  if (capability.presetOnly === true && !capability.presets.includes(dimensions)) {
    throw new Error(
      `${model} supports only its declared dimensions: ${capability.presets.join(", ")}; configured ${dimensions}`,
    );
  }
  return dimensions;
}

/** Resolve the one local-model cache used for preparation, probes, and active providers.
 * @param {object} raw Raw embedding configuration, including optional local settings.
 * @returns {string} Allowlisted environment-expanded cache path.
 */
export function resolveLocalModelCacheDir(raw = {}) {
  return resolveEnvVars(raw.local?.cacheDir || raw.cacheDir || DEFAULT_LOCAL_MODEL_CACHE, {
    groups: ["localPath"],
    label: "local model cacheDir",
  });
}

/** Normalize one embedding configuration and bind explicit non-commercial acceptance.
 * @param {object} raw Raw plugin embedding configuration.
 * @param {{mode?: string, acceptNonCommercialLicense?: boolean}} [opts] Normalization context.
 * @returns {object} Closed effective embedding configuration.
 */
export function normalizeEmbeddingConfig(raw = {}, opts = {}) {
  const mode = opts.mode || "existing";
  const provider = raw.provider || (raw.baseUrl ? "openai-compatible" : raw.apiKey ? "openai-compatible" : "openai");
  if (provider === "local-transformers") {
    const local = raw.local || {};
    const model = stripEmpty(local.model) || DEFAULT_LOCAL_E5_MODEL;
    const profile = pinnedLocalModelProfile(model);
    if (profile?.role && profile.role !== "embedding") {
      throw new Error(`${model} is a pinned reranker, not an embedding model`);
    }
    const dimensions = validatedDimensions({
      provider,
      model,
      configured: local.dimensions ?? raw.dimensions,
      fallback: embeddingDimensionsForModel(model) || DEFAULT_LOCAL_E5_DIMENSIONS,
    });
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
        queryPrefix: local.queryPrefix ?? profile?.queryPrefix ?? "query: ",
        passagePrefix: local.passagePrefix ?? profile?.passagePrefix ?? "passage: ",
        cacheDir: resolveLocalModelCacheDir(raw),
        acceptNonCommercialLicense: opts.acceptNonCommercialLicense === true,
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
  const dimensions = validatedDimensions({
    provider,
    model,
    configured: raw.dimensions,
    fallback: embeddingDimensionsForModel(model) || defaultDimensionForOpenAiModel(model),
  });
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
