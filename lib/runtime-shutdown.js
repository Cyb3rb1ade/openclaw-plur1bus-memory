import { safeWarn } from "./safe-logging.js";

/**
 * Register the bounded gateway-stop cleanup sequence for plugin-owned resources.
 * @param {object} api OpenClaw plugin API with `on` and `logger` members.
 * @param {object} dependencies Runtime resources to close.
 * @param {{shutdown: () => Promise<void>}} dependencies.memoryDbAdapter
 * @param {{shutdown: () => Promise<void>}} dependencies.pool
 * @param {{shutdown: () => Promise<void>}} [dependencies.sharedMemoryPool]
 * @param {(() => Promise<void>)|null} [dependencies.clearTurnRoutes] Clear an initialized turn registry without creating one.
 * @param {() => Promise<void>} dependencies.flushMetrics
 * @param {{close: () => Promise<void>}} dependencies.llmResultCache
 * @param {{shutdown: () => Promise<void>}} [dependencies.embeddings]
 * @param {{shutdown: () => Promise<void>}} [dependencies.reranker]
 * @param {{shutdown: () => Promise<void>}} [dependencies.modelPreparationCoordinator]
 * @param {{shutdown: () => Promise<void>}} [dependencies.reembeddingCoordinator]
 * @returns {boolean} Whether gateway-stop ownership was registered.
 */
export function registerGatewayShutdown(api, {
  memoryDbAdapter,
  pool,
  sharedMemoryPool = null,
  clearTurnRoutes = null,
  flushMetrics,
  llmResultCache,
  embeddings = null,
  reranker = null,
  modelPreparationCoordinator = null,
  reembeddingCoordinator = null,
}) {
  if (typeof api.on !== "function") return false;

  api.on("gateway_stop", async () => {
    if (typeof modelPreparationCoordinator?.shutdown === "function") {
      try { await modelPreparationCoordinator.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: model preparation shutdown failed: ${err?.message}`); }
    }
    if (typeof reembeddingCoordinator?.shutdown === "function") {
      try { await reembeddingCoordinator.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: reembedding coordinator shutdown failed: ${err?.message}`); }
    }
    try { await memoryDbAdapter.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: adapter shutdown failed: ${err?.message}`); }
    try { await pool.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: pool shutdown failed: ${err?.message}`); }
    if (sharedMemoryPool) {
      try { await sharedMemoryPool.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: shared pool shutdown failed: ${err?.message}`); }
    }
    if (typeof clearTurnRoutes === "function") {
      try { await clearTurnRoutes(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: turn route shutdown failed: ${err?.message}`); }
    }
    try { await flushMetrics(); } catch (err) { api.logger.warn?.(`metrics flush failed: ${err?.message}`); }
    try { await llmResultCache.close(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: LLM result cache shutdown failed: ${err?.message}`); }
    if (typeof embeddings?.shutdown === "function") {
      try { await embeddings.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: embedding provider shutdown failed: ${err?.message}`); }
    }
    if (typeof reranker?.shutdown === "function") {
      try { await reranker.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: reranker shutdown failed: ${err?.message}`); }
    }
  }, { timeoutMs: 30_000 });
  return true;
}

/**
 * Start optional model preparation only after its gateway-stop owner exists.
 * @param {object} api OpenClaw plugin API with an optional logger.
 * @param {object} options Lifecycle gate and coordinator.
 * @param {boolean} options.lifecycleRegistered Whether gateway-stop ownership exists.
 * @param {{start: () => Promise<object>}|null} [options.coordinator] Preparation coordinator.
 * @returns {boolean} Whether background preparation was scheduled.
 */
export function startModelPreparationAfterLifecycle(api, {
  lifecycleRegistered,
  coordinator = null,
}) {
  if (!coordinator) return false;
  if (!lifecycleRegistered) {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: model preparation disabled because the OpenClaw gateway lifecycle capability is unavailable",
    );
    return false;
  }
  void coordinator.start().then((snapshot) => {
    if (snapshot?.state === "ready") {
      api.logger?.info?.(
        `memory-lancedb-namespaced: local embedding preparation ready (${snapshot.model}, ${snapshot.dimensions}d)`,
      );
    }
  }).catch((error) => {
    safeWarn(api.logger, "model-preparation.start", error);
  });
  return true;
}
