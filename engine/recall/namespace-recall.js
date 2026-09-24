/**
 * engine/recall/namespace-recall.js — the merged multi-namespace recall and its budget helpers.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { emitRetrievalLedger, mergeNamespaceRecallResults, runRecallPipeline } from "../../lib/recall-pipeline.js";
import { applyRecallBudget, resolveRecallBudget } from "../../lib/recall-budget.js";
import { createRecallDecisionTrace } from "../../lib/recall-decision-trace.js";
import { createRecallPhaseTimer } from "../../lib/recall-phase-timer.js";
import { TimeoutError } from "../../lib/with-timeout.js";
import { isAbortError } from "../../lib/abort.js";
import { trySafeWarn } from "../../lib/safe-logging.js";

function normalizeBoundedRecallInteger(value, fallback, minimum, maximum) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function resolveRuntimeRecallBudget(query, ceiling, adaptiveBudget) {
  const cap = normalizeBoundedRecallInteger(ceiling, 12, 1, 100);
  if (adaptiveBudget?.enabled !== true) return cap;
  const tokenBudgetPct = Number.isFinite(adaptiveBudget.tokenBudgetPct)
    ? Math.min(1, Math.max(0, adaptiveBudget.tokenBudgetPct))
    : 0.3;
  const resolved = resolveRecallBudget({
    promptLength: String(query || "").length,
    hasProjectSignals: /\b(project|plan|milestone|roadmap|deadline)\b/i.test(String(query || "")),
    maxPromptMemories: cap,
    tokenBudgetPct,
  });
  return Math.min(cap, Math.max(1, Math.floor(resolved.budget)));
}

function applyMergedRecallBudget(merged, budget) {
  const effectiveBudget = normalizeBoundedRecallInteger(budget, 12, 1, 100);
  const canonical = Array.isArray(merged.canonical) ? merged.canonical.slice(0, effectiveBudget) : [];
  const remainingBudget = Math.max(0, effectiveBudget - canonical.length);
  const memories = applyRecallBudget(merged.memories || [], { budget: remainingBudget }).selected;
  return { ...merged, canonical, memories };
}

/**
 * Runs one existing recall pipeline per leased namespace and merges only after
 * every child settled, so a failed namespace cannot expose partial results.
 *
 * @param {{namespace?: string|null, db: MemoryDB}[]} readDbs
 * @param {Object} baseParams
 * @param {Object|null|undefined} trace
 * @param {Object|null|undefined} phaseTimer
 * @param {{strictReadErrors?: boolean, onNamespacePhases?: ((namespace: string, completed: {phase: string, ms: number}[]) => void)|null}} [options]
 *   `onNamespacePhases`, when given, is called once per settled namespace
 *   with that namespace's own fine-grained phase list (embedding,
 *   vector_search, query_refinement, ...). It never writes into the shared
 *   `phaseTimer` — that timer is read by the scheduler's timeout log
 *   (`lib/runtime-scheduler.js`) and must keep seeing only the coarse
 *   "namespace-recall" block, exactly as it did before this option existed.
 * @returns {Promise<{queryVector: Array|undefined, canonical: Array, memories: Array, trace: Object|undefined}>}
 */
async function runMergedNamespaceRecall(
  readDbs,
  baseParams,
  trace,
  phaseTimer,
  { strictReadErrors = false, onNamespacePhases = null } = {},
) {
  if (!Array.isArray(readDbs) || readDbs.length === 0) {
    return { queryVector: undefined, canonical: [], memories: [], trace };
  }
  const providerEmbeddings = baseParams.embeddings;
  const embedOptions = baseParams.signal
    ? { agentId: baseParams.agentId, signal: baseParams.signal }
    : { agentId: baseParams.agentId };
  const requestEmbeddings = Object.freeze({
    embedQuery: (text) => typeof providerEmbeddings.embedQuery === "function"
      ? providerEmbeddings.embedQuery(text, embedOptions)
      : providerEmbeddings.embed(text, embedOptions),
    embed: (text) => providerEmbeddings.embed(text, embedOptions),
  });
  const timerConfig = phaseTimer?.summary?.() || {};
  phaseTimer?.start("namespace-recall");
  try {
    const requestNow = Date.now();
    const canonicalSourceIndex = readDbs.findIndex((source) => source.sourceKind === "private");
    const settled = await Promise.allSettled(readDbs.map(async ({ namespace, sourceKind, optional, db }, index) => {
      const childTrace = trace
        ? createNamespaceChildRecallTrace(trace, baseParams.query)
        : undefined;
      const childTimer = createRecallPhaseTimer({
        softBudgetMs: timerConfig.softBudgetMs,
        hardTimeoutMs: timerConfig.hardTimeoutMs,
        logger: baseParams.logger,
      });
      const childStrictReadErrors = readDbs.length === 1
        ? (strictReadErrors || baseParams.strictReadErrors === true)
        : optional !== true;
      const result = await runRecallPipeline({
        ...baseParams,
        embeddings: requestEmbeddings,
        dbTable: db.table,
        phaseTimer: childTimer,
        decisionTrace: childTrace,
        strictReadErrors: childStrictReadErrors,
        canonicalEnabled: index === canonicalSourceIndex ? baseParams.canonicalEnabled : false,
        retrievalLogger: null,
        deferFinalCap: true,
        candidateHardLimit: 100,
        now: requestNow,
      });
      if (typeof onNamespacePhases === "function") {
        onNamespacePhases(namespace, childTimer.summary().completed);
      }
      return { namespace, sourceKind, optional, result };
    }));
    const requiredSettled = settled.filter((result, index) => readDbs[index].optional !== true);
    const failure = combineNamespaceRecallFailures(requiredSettled);
    if (failure) throw failure;

    const namespaceResults = [];
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === "rejected") {
        trySafeWarn(baseParams.logger, `namespace-recall.${readDbs[index].namespace}`, result.reason);
        continue;
      }
      namespaceResults.push({
        namespace: result.value.namespace,
        sourceKind: result.value.sourceKind,
        ...result.value.result,
      });
    }
    let merged = mergeNamespaceRecallResults(namespaceResults, {
      maxOut: baseParams.topN,
      canonicalMaxItems: baseParams.canonicalMaxItems,
      dedupEnabled: baseParams.dedupEnabled,
      dedupJaccard: baseParams.dedupJaccard,
      trace,
    });
    if (baseParams.adaptiveBudget?.enabled !== false) {
      merged = applyMergedRecallBudget(merged, baseParams.budget);
    }
    emitRetrievalLedger({
      retrievalLogger: baseParams.retrievalLogger,
      logger: baseParams.logger,
      entry: {
        agentId: baseParams.agentId,
        workspaceKey: baseParams.workspaceKey,
        query: baseParams.query,
        resultsCount: merged.memories.length,
        selectedIds: merged.memories.map((memory) => memory.entry.id),
      },
    });
    return merged;
  } catch (error) {
    try {
      phaseTimer?.fail?.("namespace-recall", error);
    } catch (phaseTimerError) {
      trySafeWarn(baseParams.logger, "namespace-recall.phaseTimer", phaseTimerError);
    }
    throw error;
  } finally {
    phaseTimer?.end("namespace-recall");
  }
}

function combineNamespaceRecallFailures(settled) {
  const failures = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 0) return null;
  // Fix round 2: an aborted `raceAbort` (its own fresh error, distinct per
  // call — see lib/abort.js) carries `.settlement` exactly like a
  // `TimeoutError` and must be combined the same way, or a caller signal
  // shared across namespaces (runMergedNamespaceRecall reads private,
  // workspace and user concurrently) leaves every non-primary namespace's
  // LanceDB read still running on a released lease.
  const timeoutFailures = failures.filter((error) => (
    (error instanceof TimeoutError || isAbortError(error))
    && error.settlement
    && typeof error.settlement.then === "function"
  ));
  if (timeoutFailures.length === 0) return failures[0];
  const primary = timeoutFailures[0];
  const settlements = [...new Set(timeoutFailures.map((error) => error.settlement))];
  if (settlements.length > 1) {
    primary.settlement = settleAllNamespaceReads(settlements);
  }
  return primary;
}

async function settleAllNamespaceReads(settlements) {
  const outcomes = await Promise.allSettled(settlements);
  const failed = outcomes.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return outcomes.map((result) => result.value);
}

function createNamespaceChildRecallTrace(masterTrace, query) {
  const config = masterTrace?.config || {};
  return createRecallDecisionTrace({
    query,
    maxTextPreviewChars: config.maxTextPreviewChars,
    maxCandidates: config.maxCandidates,
    maxDecisions: config.maxDecisions,
    maxGuards: config.maxGuards,
    maxStoreDecisions: config.maxStoreDecisions,
    config,
  });
}

export { normalizeBoundedRecallInteger, resolveRuntimeRecallBudget, runMergedNamespaceRecall };
