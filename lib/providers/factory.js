import { OpenAIEmbeddingProvider } from "./embedding-openai.js";
import { LocalTransformersEmbeddingProvider } from "./embedding-local-transformers.js";
import { CohereRerankerProvider } from "./reranker-cohere.js";
import { LocalTransformersRerankerProvider } from "./reranker-local-transformers.js";
import { ChainedRerankerProvider } from "./reranker-chained.js";
import { resolveApiKey } from "./env.js";

export function createEmbeddingProvider(normalizedCfg) {
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersEmbeddingProvider({
      ...normalizedCfg.local,
      dimensions: normalizedCfg.dimensions,
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
        model: normalizedCfg.fallbackModel || "BAAI/bge-reranker-v2-m3",
      });
      return new ChainedRerankerProvider(primary, fallback, logger);
    }
    // No local fallback requested — but ChainedRerankerProvider constructor reads
    // fallback.id, so we cannot pass null directly (crashes). Use a stub id-only
    // object, then null out .fallback. Task 6.1 will fix ChainedRerankerProvider properly.
    const chained = new ChainedRerankerProvider(primary, { id: "none" }, logger);
    chained.fallback = null;
    return chained;
  }
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersRerankerProvider(normalizedCfg.local || normalizedCfg);
  }
  return null;
}
