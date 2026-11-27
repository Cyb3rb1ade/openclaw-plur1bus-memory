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

/**
 * Average CPU milliseconds of one run of `operation`, measured over `runs`
 * consecutive runs in a single interval.
 *
 * Use it for budgets below the CPU clock's resolution. On Windows the thread
 * and process CPU times advance in scheduler ticks (~15.6 ms): a sub-tick
 * operation reads either 0 or a whole tick, depending only on whether a tick
 * landed inside it. Averaging over `runs` bounds that quantisation error to
 * tick / runs while keeping CPU accounting (no scheduler pauses counted).
 * @param {() => void} operation
 * @param {number} runs
 * @returns {number}
 */
export function measureAverageCpuMilliseconds(operation, runs) {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError("runs must be a positive integer");
  return measureCpuMilliseconds(() => {
    for (let run = 0; run < runs; run++) operation();
  }) / runs;
}
