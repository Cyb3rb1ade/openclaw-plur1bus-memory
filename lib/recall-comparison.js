import { projectRecallEntry } from "./recall-pipeline.js";
import { runMergedNamespaceRecall } from "../index.js";
import { createRecallDecisionTrace } from "./recall-decision-trace.js";
import { createFilteredReranker } from "./jev-recall-filter.js";
import { createRecallPhaseTimer } from "./recall-phase-timer.js";
import { safeAgentId } from "./sql-safety.js";
import { validateInput } from "./input-limits.js";

/**
 * Compare ANN sizes through the production namespace merge/budget on one snapshot.
 * Canonical-file/graph boosters are excluded so only candidate selection changes.
 * @param {object} options Query, at most 100 snapshot rows, scoped vector and providers.
 * @returns {Promise<Array<object>>} IDs, anchor coverage and timing; no memory plaintext.
 */
export async function compareRecallSnapshot({ query, rows, vector, agentId, workspaceId = null, reranker, jevFilter, expectedIds = [], rerankerTimeoutMs = 2500, softBudgetMs = 12000, rotation = 0 }) {
  safeAgentId(agentId);
  if (typeof query !== "string" || !validateInput(query, { required: true, maxLength: 10000, name: "benchmark query" }).ok) throw new Error("Invalid benchmark query");
  const snapshot = rows.slice(0, 100).map((row) => ({ ...projectRecallEntry(row), _distance: row._distance }));
  const variants = [{ name: "direct40", k: 40 }, { name: "direct50", k: 50 }, { name: "direct100", k: 100 }, { name: "jev100", k: 100, filter: true }];
  const ordered = [...variants.slice(rotation % 4), ...variants.slice(0, rotation % 4)];
  const output = [];
  for (const variant of ordered) {
    let filterMetrics = null, providerError = null, sentDocuments = 0, providerUsage = null;
    const base = {
      id: reranker.id,
      async rerank(q, docs, topN) {
        sentDocuments = docs.length;
        try {
          const result = await reranker.rerank(q, docs, topN);
          providerUsage = reranker.lastUsage ?? null;
          return result;
        }
        catch (error) { providerError = error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "provider_error"; throw error; }
      },
    };
    const selectedReranker = variant.filter && jevFilter ? createFilteredReranker(base, jevFilter, (m) => { filterMetrics = m; }) : base;
    let stageStarted = false, stageSettled = false;
    const observedReranker = {
      ...selectedReranker,
      async rerank(...args) {
        stageStarted = true;
        try { return await selectedReranker.rerank(...args); }
        finally { stageSettled = true; }
      },
    };
    const start = performance.now();
    const snapshotTable = { vectorSearch() { return { limit(n) { return { async toArray() { return structuredClone(snapshot.slice(0, n)); } }; } }; } };
    const result = await runMergedNamespaceRecall([
      { namespace: "agent-private", sourceKind: "private", db: { table: snapshotTable } },
    ], {
      query, agentId, workspaceId, embeddings: { async embedQuery() { return vector; } },
      topN: 15, budget: 15, candidateTopK: variant.k, rerankCandidates: variant.k,
      canonicalEnabled: false, associativeEnabled: false, dedupEnabled: true,
      reranker: observedReranker,
      // Keep the existing Cohere timeout; the optional Jev stage has its own bound.
      rerankerTimeoutMs: variant.filter ? rerankerTimeoutMs + 3000 : rerankerTimeoutMs,
      logger: { info() {}, warn() {} },
    }, createRecallDecisionTrace({ query }), createRecallPhaseTimer({ softBudgetMs }));
    const pipelineFallback = result.trace?.guards?.some((g) => g.name === "rerank" && g.passed === false) === true;
    if (pipelineFallback && !providerError) providerError = stageStarted && !stageSettled ? "timeout" : "pipeline_fallback";
    const selectedIds = result.memories.map((r) => r.entry.id);
    output.push({ variant: variant.name, candidateTopK: variant.k, elapsedMs: performance.now() - start, sentDocuments, providerError, pipelineFallback, providerUsage,
      filter: filterMetrics, filterAvailable: !variant.filter || Boolean(jevFilter), selectedIds,
      expectedHits: expectedIds.filter((id) => selectedIds.includes(id)).length,
      missingExpectedIds: expectedIds.filter((id) => !selectedIds.includes(id)),
    });
  }
  return variants.map((v) => output.find((r) => r.variant === v.name));
}
