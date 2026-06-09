/**
 * lib/metrics-debounce.js
 *
 * In-memory accumulator + debounced flush for metrics writes.
 * Keeps hot-path recall fast by batching disk writes.
 */

/**
 * Creates a metrics debouncer that accumulates metrics in memory
 * and flushes them to disk after a debounce interval.
 *
 * @param {object} options
 * @param {function} options.flushFn — async (workspaceDir, metrics) => void
 * @param {number} [options.debounceMs=5000] — flush interval
 * @param {function} [options.onError] — (error) => void, called on flush failure
 */
export function createMetricsDebouncer({ flushFn, debounceMs = 5000, onError } = {}) {
  if (typeof flushFn !== "function") {
    throw new TypeError("flushFn is required");
  }

  const accumulators = new Map(); // workspaceDir → metrics
  let timer = null;
  let flushing = false;

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, debounceMs);
  }

  /**
   * Accumulate metrics for a workspace.
   * @param {string} workspaceDir
   * @param {object} metrics
   */
  function accumulate(workspaceDir, metrics) {
    if (!workspaceDir) return;
    const existing = accumulators.get(workspaceDir) || {};
    accumulators.set(workspaceDir, {
      ...existing,
      ...metrics,
      lastRun: Date.now(),
    });
    scheduleFlush();
  }

  /**
   * Flush all accumulated metrics immediately.
   * Safe to call multiple times; will not double-flush.
   */
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (flushing) return;
    if (accumulators.size === 0) return;

    flushing = true;
    const entries = Array.from(accumulators.entries());
    accumulators.clear();

    for (const [workspaceDir, metrics] of entries) {
      try {
        await flushFn(workspaceDir, metrics);
      } catch (err) {
        if (typeof onError === "function") {
          try { onError(err); } catch (_) {}
        }
        // Swallow — recall must never block on metrics
      }
    }

    flushing = false;
  }

  /**
   * Stop the debouncer and flush remaining metrics.
   */
  async function stop() {
    await flush();
  }

  return { accumulate, flush, stop };
}
