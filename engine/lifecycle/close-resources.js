/**
 * engine/lifecycle/close-resources.js — the engine's close path (spec 3.1).
 *
 * Was the body of shutdownOnce in lib/runtime-shutdown.js
 * (registerGatewayShutdown). Idempotent: every call returns the same promise.
 * The OpenClaw adapter still registers it as the host's runtime-lifecycle
 * cleanup and gateway_stop handler; Engine.close() races it against a budget.
 */

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
 * @param {{shutdown: () => Promise<void>}|null} [options.scopedEmbeddingServer]
 * @param {{shutdown: () => Promise<void>}|null} [options.embeddings]
 * @param {{shutdown: () => Promise<void>}|null} [options.reranker]
 * @param {{shutdown: () => Promise<void>}|null} [options.modelPreparationCoordinator]
 * @param {{shutdown: () => Promise<void>}|null} [options.reembeddingCoordinator]
 * @param {{beginCleanup: () => void, releaseModels: () => Promise<void>}|null} [options.localModelGeneration]
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
  scopedEmbeddingServer = null,
  embeddings = null,
  reranker = null,
  modelPreparationCoordinator = null,
  reembeddingCoordinator = null,
  localModelGeneration = null,
}) {
  let shutdownPromise = null;
  return function closeResources() {
    if (shutdownPromise) return shutdownPromise;
    localModelGeneration?.beginCleanup?.();
    shutdownPromise = (async () => {
      const cleanup = async (label, operation) => {
        try { await operation(); } catch (err) { logger.warn?.(`${label}: ${err?.message}`); }
      };
      const localModelResources = (async () => {
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
      const ordered = (async () => {
        await cleanup("memory-lancedb-namespaced: adapter shutdown failed", () => memoryDbAdapter.shutdown());
        await cleanup("memory-lancedb-namespaced: pool shutdown failed", () => pool.shutdown());
        if (sharedMemoryPool) {
          await cleanup("memory-lancedb-namespaced: shared pool shutdown failed", () => sharedMemoryPool.shutdown());
        }
        if (typeof clearTurnRoutes === "function") {
          await cleanup("memory-lancedb-namespaced: turn route shutdown failed", () => clearTurnRoutes());
        }
        await cleanup("metrics flush failed", () => flushMetrics());
        await cleanup("memory-lancedb-namespaced: LLM result cache shutdown failed", () => llmResultCache.close());
      })();
      await Promise.all([...immediate, ordered]);
    })();
    return shutdownPromise;
  };
}
