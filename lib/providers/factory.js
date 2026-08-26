import { OpenAIEmbeddingProvider } from "./embedding-openai.js";
import { LocalTransformersEmbeddingProvider } from "./embedding-local-transformers.js";
import { CohereRerankerProvider } from "./reranker-cohere.js";
import { LocalTransformersRerankerProvider } from "./reranker-local-transformers.js";
import { ChainedRerankerProvider } from "./reranker-chained.js";
import { resolveApiKey } from "./env.js";
import { DEFAULT_LOCAL_RERANKER_MODEL } from "./dimensions.js";

export function createEmbeddingProvider(normalizedCfg) {
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersEmbeddingProvider({
      ...normalizedCfg.local,
      dimensions: normalizedCfg.dimensions,
      embeddingCacheEnabled: normalizedCfg.embeddingCacheEnabled,
      cacheMaxEntries: normalizedCfg.cacheMaxEntries,
      cacheTtlMs: normalizedCfg.cacheTtlMs,
      embeddingCachePersist: normalizedCfg.embeddingCachePersist,
      embeddingCachePersistDebug: normalizedCfg.embeddingCachePersistDebug,
      embeddingCacheCoalesce: normalizedCfg.embeddingCacheCoalesce,
      embeddingCacheMetrics: normalizedCfg.embeddingCacheMetrics,
      embeddingCacheScope: normalizedCfg.embeddingCacheScope,
      embeddingCacheMaxBytes: normalizedCfg.embeddingCacheMaxBytes,
    });
  }
  const apiKey = resolveApiKey(normalizedCfg, { defaultEnv: "OPENAI_API_KEY", label: "OpenAI embedding" });
  return new OpenAIEmbeddingProvider({ ...normalizedCfg, apiKey });
}

export function createRerankerProvider(normalizedCfg, logger) {
  if (!normalizedCfg || normalizedCfg.provider === "disabled" || !normalizedCfg.enabled) {
    return null;
  }
  if (normalizedCfg.provider === "cohere") {
    const primary = new CohereRerankerProvider(normalizedCfg);
    const fallbackProvider = normalizedCfg.fallbackProvider ?? "disabled";
    if (fallbackProvider === "local-transformers") {
      const fallback = new LocalTransformersRerankerProvider({
        model: normalizedCfg.fallbackModel || DEFAULT_LOCAL_RERANKER_MODEL,
        revision: normalizedCfg.fallbackRevision,
        cacheDir: normalizedCfg.fallbackCacheDir,
        logger,
      });
      return new ChainedRerankerProvider(primary, fallback, logger);
    }
    return new ChainedRerankerProvider(primary, null, logger);
  }
  if (normalizedCfg.provider === "local-transformers") {
    const primary = new LocalTransformersRerankerProvider({
      ...(normalizedCfg.local || normalizedCfg),
      logger,
    });
    if (normalizedCfg.fallbackOnError !== false && normalizedCfg.fallbackProvider === "local-transformers") {
      if (normalizedCfg.fallbackModel === primary.model) {
        throw new Error("local reranker fallback model must differ from the primary model");
      }
      const fallback = new LocalTransformersRerankerProvider({
        model: normalizedCfg.fallbackModel,
        revision: normalizedCfg.fallbackRevision,
        cacheDir: normalizedCfg.fallbackCacheDir,
        logger,
      });
      return new ChainedRerankerProvider(primary, fallback, logger);
    }
    return primary;
  }
  return null;
}
