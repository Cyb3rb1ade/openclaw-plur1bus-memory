/**
 * engine/providers/runtime-reranker.js — the runtime reranker provider factory.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { normalizeRerankerConfig } from "../../lib/providers/config-normalize.js";
import { DEFAULT_LOCAL_RERANKER_MODEL } from "../../lib/providers/dimensions.js";
import { CohereRerankerProvider } from "../../lib/providers/reranker-cohere.js";
import { LocalTransformersRerankerProvider } from "../../lib/providers/reranker-local-transformers.js";
import { ChainedRerankerProvider } from "../../lib/providers/reranker-chained.js";

// applyImportanceBoost, dedupResults, parseKnowledgeMd, getKnowledgeChunks,
// searchCanonical, runRecallPipeline kommen jetzt aus lib/recall-pipeline.js.
// stripFrontmatter, buildFrontmatter, withFrontmatter aus lib/frontmatter.js.

/**
 * Create the configured runtime reranker and bind local models to the host generation lifecycle.
 * @param {object} [rawRerankerCfg] Reranker configuration.
 * @param {object|null} [logger] OpenClaw logger.
 * @param {{credentialResolver?: Function, localModelGeneration?: object}} [runtimeOptions] Runtime dependencies.
 * @returns {{reranker: object|null, rerankerCfg: object}} Provider and normalized configuration.
 */
function createRuntimeRerankerProvider(rawRerankerCfg = {}, logger = null, {
  credentialResolver,
  localModelGeneration = null,
} = {}) {
  const rerankerCfg = normalizeRerankerConfig(rawRerankerCfg || {});
  let reranker = null;
  if (rerankerCfg.provider === "cohere" && rerankerCfg.enabled) {
    const primary = new CohereRerankerProvider({ ...rerankerCfg, credentialResolver });
    if ((rerankerCfg.fallbackProvider ?? "disabled") === "local-transformers") {
      const fallback = new LocalTransformersRerankerProvider({
        ...(rerankerCfg.local || {}),
        model: rerankerCfg.fallbackModel || rerankerCfg.local?.model || DEFAULT_LOCAL_RERANKER_MODEL,
        revision: rerankerCfg.fallbackRevision,
        cacheDir: rerankerCfg.fallbackCacheDir,
        logger,
        localModelGeneration,
      });
      reranker = new ChainedRerankerProvider(primary, fallback, logger);
    } else {
      reranker = new ChainedRerankerProvider(primary, null, logger);
    }
  } else if (rerankerCfg.provider === "local-transformers" && rerankerCfg.enabled) {
    const primary = new LocalTransformersRerankerProvider({
      ...(rerankerCfg.local || rerankerCfg),
      logger,
      localModelGeneration,
    });
    if (rerankerCfg.fallbackOnError !== false && rerankerCfg.fallbackProvider === "local-transformers") {
      if (rerankerCfg.fallbackModel === primary.model) {
        throw new Error("local reranker fallback model must differ from the primary model");
      }
      const fallback = new LocalTransformersRerankerProvider({
        model: rerankerCfg.fallbackModel,
        revision: rerankerCfg.fallbackRevision,
        cacheDir: rerankerCfg.fallbackCacheDir,
        logger,
        localModelGeneration,
      });
      reranker = new ChainedRerankerProvider(primary, fallback, logger);
    } else {
      reranker = primary;
    }
  }
  return { reranker, rerankerCfg };
}

export { createRuntimeRerankerProvider };
