/**
 * Register the bounded gateway-stop cleanup sequence for plugin-owned resources.
 * @param {object} api OpenClaw plugin API with `on` and `logger` members.
 * @param {object} dependencies Runtime resources to close.
 * @param {{shutdown: () => Promise<void>}} dependencies.memoryDbAdapter
 * @param {{shutdown: () => Promise<void>}} dependencies.pool
 * @param {() => Promise<void>} dependencies.flushMetrics
 * @param {{close: () => Promise<void>}} dependencies.llmResultCache
 * @returns {void}
 */
export function registerGatewayShutdown(api, {
  memoryDbAdapter,
  pool,
  flushMetrics,
  llmResultCache,
}) {
  if (typeof api.on !== "function") return;

  api.on("gateway_stop", async () => {
    try { await memoryDbAdapter.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: adapter shutdown failed: ${err?.message}`); }
    try { await pool.shutdown(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: pool shutdown failed: ${err?.message}`); }
    try { await flushMetrics(); } catch (err) { api.logger.warn?.(`metrics flush failed: ${err?.message}`); }
    try { await llmResultCache.close(); } catch (err) { api.logger.warn?.(`memory-lancedb-namespaced: LLM result cache shutdown failed: ${err?.message}`); }
  }, { timeoutMs: 30_000 });
}
