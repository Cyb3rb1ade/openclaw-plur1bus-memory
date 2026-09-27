/**
 * engine/recall/recall-params.js — the automatic recall's pipeline parameters.
 *
 * Moved out of engine/recall/assemble-prompt-context.js (E5 Task 9), where it
 * was built inline as `_autoRecallBaseParams`, so the per-turn recall and the
 * warm-only path hand `runMergedNamespaceRecall` the same object.
 */

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
 * @returns {Record<string, any>} The pipeline parameters.
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
  };
}
