/**
 * engine/recall/warm-recall-path.js — the warm-only recall (E5 Task 9).
 *
 * `RecallQuery.warmOnly` runs the heavy, read-only part of a recall so the
 * next real recall finds warm caches (the embedder, the neo worker, the
 * LanceDB handles and pages, the reranker): the neo prelude reads, the query
 * embedding(s), a read-only LanceDB open, the vector search, the graph
 * expansion and the rerank. It writes nothing.
 *
 * What it leaves out, compared with the per-turn recall in
 * assemble-prompt-context.js: the neo injection mark and hook counter, the
 * start-notice consume, the write-db lease and GC, fast-bernd, emotion
 * inference and the mood files, the retrieval ledger, overlays and
 * contradictions, the pending reply outcome, the cooldown files, the skill
 * presentation ledger, the activity file, reminder updates, the canonical
 * cache and graph metrics (`readOnly`), the query summarizer (an LLM call).
 * The assembler adds the rest: no events, no recall cache, no reply-outcome
 * kick.
 */

import { isAbortError } from "../../lib/abort.js";
import { computeUseAssociative } from "../../lib/recall-pipeline.js";
import { withAccessReadDbs } from "../../lib/shared-memory.js";
import { readNeoPrelude } from "./neo-prelude.js";
import { autoRecallParams } from "./recall-params.js";
import { recallResult } from "./recall-result.js";

/**
 * Build the warm path from the recall context.
 *
 * The caller has already started the `prelude` phase on `timer`; this path
 * ends it. The result carries no blocks: a warm recall injects nothing.
 *
 * @param {Record<string, any>} ctx The recall context (`internals.recallContext` members).
 * @returns {(event: Record<string, any>, hookCtx: Record<string, any>, opts: {signal: AbortSignal, memoryCtx: object, timer: object}) => Promise<object>} Resolves a RecallResult with `blocks: []` and `degraded: null`, or `degraded.reason === "warm-failed"`.
 */
export function createWarmRecallPath(ctx) {
  const {
    NEO_EMBED_TIMEOUT,
    cfg,
    embeddings,
    host,
    neoEnabled,
    neoGlobalRecall,
    neoRequester,
    neoWorkerRuntime,
    peekNeoStore,
    pool,
    runMergedNamespaceRecall,
    runNeoGlobalSearch,
    sharedMemoryPool,
    workspacePolicyGuard,
  } = ctx;

  return async function warmRecall(event, hookCtx, { signal, memoryCtx, timer }) {
    try {
      if (!memoryCtx) throw new Error("memoryCtx is required");
      if (!workspacePolicyGuard.automatic(memoryCtx).allowed) {
        timer.end("prelude");
        return recallResult();
      }
      const prompt = String(event?.prompt || "");
      if (neoEnabled) {
        // Spawns the worker thread if it is not running yet; writes no file.
        try { neoWorkerRuntime?.warmUp?.(); } catch (_) { /* best-effort */ }
        if (prompt.length >= 5) {
          const prelude = { startedAt: Date.now(), windowMs: 0, embedMs: 0, embedTimedOut: false, globalMs: 0, lanesMs: 0 };
          try {
            await readNeoPrelude({
              neoStore: peekNeoStore(hookCtx, event),
              requester: neoRequester(hookCtx, event),
              prompt,
              embeddings,
              embedTimeoutMs: neoGlobalRecall.embedTimeoutMs,
              timeoutSymbol: NEO_EMBED_TIMEOUT,
              runNeoGlobalSearch,
              logger: host.logger,
              prelude,
            });
          } catch (neoErr) {
            host.logger.debug(`plur1bus-neo: warm recall prelude failed: ${String(neoErr)}`);
          }
        }
      }
      timer.end("prelude");
      if (prompt.length < 5) return recallResult();
      signal.throwIfAborted();
      const agentId = memoryCtx.agentId;
      await withAccessReadDbs(pool, sharedMemoryPool, agentId, { ...memoryCtx, logger: host.logger }, async (leased) => {
        const readDbs = [];
        for (const entry of leased) {
          const initialized = await entry.db.init();
          if (initialized !== false && entry.db.table) readDbs.push(entry);
        }
        // An agent without a table: nothing to warm, and nothing is created.
        if (readDbs.length === 0) return;
        let graphEdges = [];
        try { graphEdges = peekNeoStore(hookCtx, event).readGraphEdges(5_000); } catch (_e) { graphEdges = []; }
        const continuityCfg = cfg.continuityEngine || {};
        const assocCfg = continuityCfg.associativeRecall || {};
        const useAssociative = computeUseAssociative(continuityCfg.enabled !== false, assocCfg);
        await runMergedNamespaceRecall(
          readDbs,
          autoRecallParams(ctx, {
            query: prompt,
            timer,
            signal,
            workspaceDir: hookCtx?.workspaceDir,
            workspaceKey: hookCtx?.workspaceKey || hookCtx?.workspaceDir || null,
            agentId,
            memoryCtx,
            graphEdges,
            emotionalState: null,
            decisionTrace: null,
            useAssociative,
            assocCfg,
            querySummarizer: null,
            retrievalLogger: null,
            readOnly: true,
          }),
          null,
          timer,
          { strictReadErrors: false, onNamespacePhases: () => {} },
        );
      }, { readOnly: true });
      return recallResult({ blocks: [] });
    } catch (error) {
      // No-op when the prelude already ended.
      timer.end("prelude");
      if (signal.aborted || isAbortError(error)) throw error;
      const detail = String(error?.message || error).slice(0, 200);
      host.logger.debug(`memory-lancedb-namespaced: warm recall failed for agent=${memoryCtx?.agentId || hookCtx?.agentId || "default"}: ${detail}`);
      return recallResult({ degraded: { reason: "warm-failed", capability: "recall", detail } });
    }
  };
}
