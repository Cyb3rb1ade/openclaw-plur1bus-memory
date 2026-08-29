/**
 * Measures synchronous benchmark work in milliseconds.
 * @param {() => void} operation
 * @returns {number}
 */
export function measureCpuMilliseconds(operation) {
  // Node 22.19+/24 expose per-thread CPU accounting. Prefer it so concurrent
  // V8 GC helpers or worker threads cannot be charged to a synchronous
  // benchmark on the main thread. Keep the process-wide fallback for the
  // package's older standalone Node 22 support window.
  const cpuUsage = typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage
    : process.cpuUsage;
  const startedAt = cpuUsage();
  operation();
  const elapsed = cpuUsage(startedAt);
  return (elapsed.user + elapsed.system) / 1000;
}
