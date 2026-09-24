/**
 * adapter/openclaw/register-tools.js
 *
 * Hands the engine's tool factory to OpenClaw. `api.registerTool` is called
 * unguarded, exactly as index.js:7672 did, and the `names` metadata travels
 * with it verbatim: OpenClaw's allowlist discovery reads that array to learn
 * the five tool names a *factory* registration would otherwise hide
 * (tests/tool-registration-metadata.test.js pins it against
 * openclaw.plugin.json's `contracts.tools`).
 */

import { createMemoryTools } from "../../engine/tools/memory-tools.js";
import { createMemoryHostRuntime } from "../../lib/setup/memory-host-runtime.js";
import { withAccessReadDbs } from "../../lib/shared-memory.js";
import { resolveMemoryRequestContext } from "../../lib/memory-request-context.js";
import { createRecallPhaseTimer } from "../../lib/recall-phase-timer.js";
import { resolveRuntimeRecallBudget, runMergedNamespaceRecall } from "../../engine/recall/namespace-recall.js";

/**
 * @param {object} ctx Registration context: the engine's tool view plus
 *   `api`, and `toolFactory` — the engine's tool factory, shared with
 *   Engine.tools.
 * @returns {void}
 */
export function registerMemoryTools(ctx) {
  ctx.api.registerTool(ctx.toolFactory ?? createMemoryTools(ctx), {
    names: ["memory_recall", "memory_search", "memory_store", "memory_forget", "knowledge_update"],
  });
}

/**
 * Hand OpenClaw the memory-slot runtime (was index.js register()'s first
 * registration). The runtime's dependencies are closures over the engine's
 * objects, resolved when the host actually calls.
 *
 * @param {object} internals EngineInternals (engine/internals.js).
 * @param {object} api OpenClaw plugin API.
 * @returns {void}
 */
export function registerMemoryCapability(internals, api) {
  const {
    adaptiveBudgetCfg,
    baseDbPath,
    candidateTopK,
    canonicalMaxItems,
    canonicalMinScore,
    controlHealth,
    dedupEnabled,
    dedupJaccard,
    embeddings,
    host,
    memoryDbAdapter,
    model,
    normalizedEmbeddingCfg,
    pool,
    recallMinScore,
    rerankCandidates,
    reranker,
    rerankerCfg,
    runtimeScheduler,
    sharedMemoryPool,
    softBudgetFallback,
    softBudgetMs,
    summaryMaxWords,
  } = internals;
  if (typeof api.registerMemoryCapability === "function") {
    // The host asks the memory-slot owner for a runtime; without it the
    // Memory page reports "memory plugin unavailable". Everything the
    // runtime touches is built by createEngine() before this runs, and the
    // dependencies are closures that resolve when the host actually calls.
    const memoryHostRuntime = createMemoryHostRuntime({
      logger: host.logger,
      hostConfig: () => host.runtime?.config?.current?.() ?? api.config ?? {},
      dbPath: () => baseDbPath,
      provider: () => ({
        provider: normalizedEmbeddingCfg.provider,
        model: normalizedEmbeddingCfg.model || model,
      }),
      embed: (text) => embeddings.embed(text),
      cardCount: async (forAgentId) => {
        const snapshot = await controlHealth.snapshot();
        const entry = snapshot?.cards?.byAgent?.find((item) => item.id === forAgentId);
        return Number.isSafeInteger(entry?.cards) ? entry.cards : null;
      },
      readCard: ({ agentId: forAgentId, cardId }) => memoryDbAdapter.getCard(forAgentId, cardId),
      // Host-originated searches carry no session, workspace identity or
      // user principal, so this reads the agent's private partition only.
      recall: async ({ agentId: forAgentId, query, limit, signal }) => {
        const memoryCtx = resolveMemoryRequestContext({ agentId: forAgentId });
        return withAccessReadDbs(pool, sharedMemoryPool, forAgentId, { ...memoryCtx, logger: host.logger }, async (readDbs) => {
          const initialized = [];
          for (const entry of readDbs) {
            const ok = await entry.db.init();
            if (ok !== false && entry.db.table) initialized.push(entry);
          }
          if (initialized.length === 0) return [];
          const phaseTimer = createRecallPhaseTimer({
            softBudgetMs,
            hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs,
            logger: host.logger,
          });
          const { memories } = await runMergedNamespaceRecall(initialized, {
            query,
            embeddings,
            topN: limit,
            budget: resolveRuntimeRecallBudget(query, limit, adaptiveBudgetCfg),
            adaptiveBudget: adaptiveBudgetCfg,
            recallMinScore,
            dedupEnabled,
            dedupJaccard,
            canonicalEnabled: false,
            canonicalMinScore,
            canonicalMaxItems,
            reranker,
            rerankCandidates,
            candidateTopK,
            rerankerTimeoutMs: rerankerCfg.timeoutMs ?? 5000,
            rerankerFallbackOnError: rerankerCfg.fallbackOnError !== false,
            summaryMaxWords,
            logger: host.logger,
            agentId: forAgentId,
            memoryCtx,
            workspaceKey: null,
            phaseTimer,
            softBudgetFallback,
            queryRefinerEnabled: false,
            associativeEnabled: false,
            ...(signal ? { signal } : {}),
          }, undefined, phaseTimer, { strictReadErrors: false });
          return memories;
        });
      },
    });
    api.registerMemoryCapability({
      deterministicRecallToolName: "memory_recall",
      supportsPrivateTranscriptRecall: false,
      runtime: memoryHostRuntime,
    });
  } else {
    host.logger.info(
      "memory-lancedb-namespaced: OpenClaw registerMemoryCapability API unavailable; legacy tool and hook surfaces remain active.",
    );
  }
}
