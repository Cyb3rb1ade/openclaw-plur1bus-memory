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
 * @param {{shutdown: () => Promise<void>}} [dependencies.reembeddingCoordinator]
 * @returns {void}
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
  reembeddingCoordinator = null,
}) {
  if (typeof api.on !== "function") return;

  api.on("gateway_stop", async () => {
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
}
