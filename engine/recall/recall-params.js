/**
 * engine/recall/recall-params.js — the automatic recall's pipeline parameters.
 *
 * Moved out of engine/recall/assemble-prompt-context.js (E5 Task 9), where it
 * was built inline as `_autoRecallBaseParams`, so the per-turn recall and the
 * warm-only path hand `runMergedNamespaceRecall` the same object.
 */

import { cleanQueryForEmbedding } from "../../lib/embedding-text.js";
import { normalizeMemorySessionKey, resolveSessionEchoCutoff } from "../../lib/recall-pipeline.js";

/**
 * The automatic recall's rules for one turn (7.20.10, createAutoRecallPolicy
 * in lib/recall-pipeline.js): prompt echoes and memories of the running
 * conversation that are still in context are left out, the rest is weighted
 * by quality. The context boundary comes from `event.messages` (the last
 * compaction, else the last 6 h). memory_recall/memory_search never pass it.
 *
 * @param {Record<string, any>} ctx The recall context (`qualityWeightingCfg`).
 * @param {Record<string, any>} event The before_prompt_build event (`prompt`, `messages`, `sessionKey`).
 * @param {Record<string, any>|undefined} hookCtx The hook context (`sessionKey`).
 * @param {number} [now] Clock for the 6 h fallback window.
 * @returns {{query: string, sessionKey: string, sessionContextSince: number, qualityWeighting: object, mergeTurnParts: boolean, now: number}}
 */
export function autoRecallPolicyOptionsFor(ctx, event, hookCtx, now = Date.now()) {
  return {
    query: event?.prompt,
    sessionKey: normalizeMemorySessionKey(hookCtx?.sessionKey || event?.sessionKey),
    sessionContextSince: resolveSessionEchoCutoff(event?.messages, { now }).since,
    qualityWeighting: ctx.qualityWeightingCfg,
    // 7.21.1: recall.mergeTurnParts (Standard an) und die Bezugszeit für das
    // Alter der Assistenten-Antworten.
    mergeTurnParts: ctx.cfg?.recall?.mergeTurnParts !== false,
    now,
  };
}

/**
 * The parameter object for `runMergedNamespaceRecall` / `runRecallPipeline`
 * on the automatic recall path. Engine-wide settings come from `ctx`; the
 * per-call values (and the per-call collaborators, e.g. the query summarizer
 * and the retrieval logger) come from the second argument.
 *
 * @param {Record<string, any>} ctx The recall context (engine settings).
 * @param {object} call Per-call values.
 * @param {string} call.query The prompt.
 * @param {object} call.timer The recall's phase timer.
 * @param {AbortSignal} call.signal The scheduled job's signal.
 * @param {string|undefined} call.workspaceDir Workspace root (KNOWLEDGE.md).
 * @param {string|null} call.workspaceKey Workspace key for the retrieval ledger.
 * @param {string} call.agentId Agent id.
 * @param {object} call.memoryCtx The request's memory context.
 * @param {object[]} call.graphEdges Neo graph edges for the associative spread.
 * @param {object|null} call.emotionalState The agent's emotional state, or null.
 * @param {object|null} call.decisionTrace The recall decision trace, or null.
 * @param {boolean} call.useAssociative Whether the associative spread runs.
 * @param {Record<string, any>} call.assocCfg `continuityEngine.associativeRecall`.
 * @param {Function|null} call.querySummarizer Long-query summarizer (an LLM call), or null.
 * @param {Function|null} call.retrievalLogger Retrieval-ledger writer, or null.
 * @param {boolean} [call.readOnly] Persist nothing (no canonical cache, no graph metrics).
 * @param {object|null} [call.autoRecallPolicy] 7.20.10: autoRecallPolicyOptionsFor() of this turn.
 * @param {number|null} [call.embedDeadlineAt] 7.21.1: latest instant (epoch ms)
 *   the pipeline waits for the query vector before it falls back.
 * @param {boolean} [call.keywordFallback] 7.21.1: keyword/recent fallback when
 *   the query vector is late or the embedding fails (per-turn recall only).
 * @returns {Record<string, any>} The pipeline parameters. `embeddingQuery`
 *   (7.20.10) is the prompt without host envelopes (cleanQueryForEmbedding);
 *   the query vector comes from it, rerank and echo check read `query`.
 */
export function autoRecallParams(ctx, {
  query,
  timer,
  signal,
  workspaceDir,
  workspaceKey,
  agentId,
  memoryCtx,
  graphEdges,
  emotionalState,
  decisionTrace,
  useAssociative,
  assocCfg,
  querySummarizer,
  retrievalLogger,
  readOnly = false,
  autoRecallPolicy = null,
  embedDeadlineAt = null,
  keywordFallback = false,
}) {
  const {
    adaptiveBudgetCfg,
    autoRecallMinScore,
    candidateTopK,
    canonicalEnabled,
    canonicalMaxItems,
    canonicalMinScore,
    dedupEnabled,
    dedupJaccard,
    embeddingCleanTextCfg,
    embeddings,
    host,
    maxPromptMemories,
    queryRefinerEnabled,
    rerankCandidates,
    reranker,
    rerankerCfg,
    resolveRuntimeRecallBudget,
    softBudgetFallback,
    summaryMaxWords,
  } = ctx;
  return {
    query,
    // Kanonische Treffer zusaetzlich zu maxPromptMemories (7.20.6).
    canonicalOutsideLimit: true,
    autoRecallPolicy,
    // 7.20.10: Anfragevektor ohne Hüllen (Transkript-Umschlag,
    // Zeitstempel, Metadaten); Rerank und Echo-Prüfung lesen weiter query.
    embeddingQuery: cleanQueryForEmbedding(query, embeddingCleanTextCfg),
    phaseTimer: timer,
    softBudgetFallback,
    embeddings,
    signal,
    workspaceDir,
    topN: maxPromptMemories,
    budget: resolveRuntimeRecallBudget(query, maxPromptMemories, adaptiveBudgetCfg),
    adaptiveBudget: adaptiveBudgetCfg,
    recallMinScore: autoRecallMinScore,
    dedupEnabled,
    dedupJaccard,
    canonicalEnabled,
    canonicalMinScore,
    canonicalMaxItems,
    reranker,
    rerankCandidates,
    candidateTopK,
    rerankerTimeoutMs: rerankerCfg.timeoutMs ?? 5000,
    rerankerFallbackOnError: rerankerCfg.fallbackOnError !== false,
    summaryMaxWords,
    querySummarizer,
    logger: host.logger,
    emotionalState,
    graphEdges,
    associativeEnabled: useAssociative,
    graphConfig: useAssociative ? {
      maxDepth: assocCfg.maxDepth ?? 2,
      maxNeighborsPerNode: assocCfg.maxNeighborsPerNode ?? 8,
      maxAssociatedResults: assocCfg.maxAssociatedResults ?? 40,
      minCumulativeRelevance: assocCfg.minCumulativeRelevance ?? 0.2,
      graphHydrationRelevanceThreshold: assocCfg.graphHydrationRelevanceThreshold ?? 0.25,
      graphIndex: { enabled: assocCfg.graphIndex?.enabled !== false },
    } : {},
    workspaceKey,
    agentId,
    memoryCtx,
    queryRefinerEnabled,
    decisionTrace,
    retrievalLogger,
    readOnly,
    embedDeadlineAt,
    keywordFallback,
  };
}
