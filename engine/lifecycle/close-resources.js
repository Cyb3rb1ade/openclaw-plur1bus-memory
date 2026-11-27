/**
 * engine/lifecycle/close-resources.js — the engine's close path (spec 3.1).
 *
 * Was the body of shutdownOnce in lib/runtime-shutdown.js
 * (registerGatewayShutdown). Idempotent: every call returns the same promise.
 * The OpenClaw adapter still registers it as the host's runtime-lifecycle
 * cleanup and gateway_stop handler; Engine.close() races it against a budget.
 */

import { describeError } from "../../lib/log-redact.js";

/**
 * Build the idempotent resource closer.
 *
 * @param {object} options The resources registerGatewayShutdown received, plus `logger`.
 * @param {{warn?: (message: string) => void}} options.logger Where a failed step is reported.
 * @param {{shutdown: () => Promise<void>}} options.memoryDbAdapter
 * @param {{shutdown: () => Promise<void>}} options.pool
 * @param {{shutdown: () => Promise<void>}|null} [options.sharedMemoryPool]
 * @param {(() => Promise<void>)|null} [options.clearTurnRoutes] Clear an initialized turn registry without creating one.
 * @param {() => Promise<void>} options.flushMetrics
 * @param {{close: () => Promise<void>}} options.llmResultCache
 * @param {{shutdown: () => Promise<void>}|null} [options.embeddingServer] EmbeddingService.serve()'s server; stopped first.
 * @param {{shutdown: () => Promise<void>}|null} [options.scopedEmbeddingServer]
 * @param {{shutdown: () => Promise<void>}|null} [options.embeddings]
 * @param {{shutdown: () => Promise<void>}|null} [options.reranker]
 * @param {{shutdown: () => Promise<void>}|null} [options.modelPreparationCoordinator]
 * @param {{shutdown: () => Promise<void>}|null} [options.reembeddingCoordinator]
 * @param {{beginCleanup: () => void, releaseModels: () => Promise<void>}|null} [options.localModelGeneration]
 * @param {{release: () => Promise<void>}|null} [options.neoWorker] The engine's neo worker lease; released after the pool shutdown.
 * @param {{close: () => Promise<void>}|null} [options.fragmentCompactor] The LanceDB fragment compactor; closed (its running optimize awaited) before the db-adapter shutdown, because it optimizes through that adapter; the pair runs beside the other ordered steps.
 * @returns {() => Promise<void>} The closer; the second and later calls return the first call's promise.
 */
export function createResourceCloser({
  logger,
  memoryDbAdapter,
  pool,
  sharedMemoryPool = null,
  clearTurnRoutes = null,
  flushMetrics,
  llmResultCache,
  embeddingServer = null,
  scopedEmbeddingServer = null,
  embeddings = null,
  reranker = null,
  modelPreparationCoordinator = null,
  reembeddingCoordinator = null,
  localModelGeneration = null,
  neoWorker = null,
  fragmentCompactor = null,
}) {
  let shutdownPromise = null;
  return function closeResources() {
    if (shutdownPromise) return shutdownPromise;
    localModelGeneration?.beginCleanup?.();
    shutdownPromise = (async () => {
      const cleanup = async (label, operation) => {
        try { await operation(); } catch (err) { logger.warn?.(`${label}: ${describeError(err)}`); }
      };
      const localModelResources = (async () => {
        if (typeof embeddingServer?.shutdown === "function") {
          await cleanup(
            "memory-lancedb-namespaced: served embedding IPC shutdown failed",
            () => embeddingServer.shutdown(),
          );
        }
        if (typeof scopedEmbeddingServer?.shutdown === "function") {
          await cleanup(
            "memory-lancedb-namespaced: scoped embedding IPC shutdown failed",
            () => scopedEmbeddingServer.shutdown(),
          );
        }
        if (typeof embeddings?.shutdown === "function") {
          await cleanup(
            "memory-lancedb-namespaced: embedding provider shutdown failed",
            () => embeddings.shutdown(),
          );
        }
        if (typeof reranker?.shutdown === "function") {
          await cleanup(
            "memory-lancedb-namespaced: reranker shutdown failed",
            () => reranker.shutdown(),
          );
        }
        if (typeof localModelGeneration?.releaseModels === "function") {
          await cleanup(
            "memory-lancedb-namespaced: local model generation shutdown failed",
            () => localModelGeneration.releaseModels(),
          );
        }
      })();
      const immediate = [
        typeof modelPreparationCoordinator?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: model preparation shutdown failed", () => modelPreparationCoordinator.shutdown())
          : null,
        typeof reembeddingCoordinator?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: reembedding coordinator shutdown failed", () => reembeddingCoordinator.shutdown())
          : null,
        localModelResources,
      ].filter(Boolean);
      // The compactor optimizes through the db-adapter, so the adapter shuts
      // down only after the compactor closed (R8). The pair runs as its own
      // branch: a long-running optimize must not hold back the pool, neo,
      // metrics and cache steps below (Task 6 fix round 1, I2).
      const adapterBranch = (async () => {
        if (typeof fragmentCompactor?.close === "function") {
          await cleanup("plur1bus-compaction: compactor close failed", () => fragmentCompactor.close());
        }
        await cleanup("memory-lancedb-namespaced: adapter shutdown failed", () => memoryDbAdapter.shutdown());
      })();
      const ordered = (async () => {
        await cleanup("memory-lancedb-namespaced: pool shutdown failed", () => pool.shutdown());
        if (typeof neoWorker?.release === "function") {
          await cleanup("plur1bus-neo: worker release failed", () => neoWorker.release());
        }
        if (sharedMemoryPool) {
          await cleanup("memory-lancedb-namespaced: shared pool shutdown failed", () => sharedMemoryPool.shutdown());
        }
        if (typeof clearTurnRoutes === "function") {
          await cleanup("memory-lancedb-namespaced: turn route shutdown failed", () => clearTurnRoutes());
        }
        await cleanup("metrics flush failed", () => flushMetrics());
        await cleanup("memory-lancedb-namespaced: LLM result cache shutdown failed", () => llmResultCache.close());
      })();
      await Promise.all([...immediate, adapterBranch, ordered]);
    })();
    return shutdownPromise;
  };
}
