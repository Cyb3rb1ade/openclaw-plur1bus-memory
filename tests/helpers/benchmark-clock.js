/**
 * Measures synchronous benchmark work in milliseconds.
 * @param {() => void} operation
 * @returns {number}
 */
export function measureCpuMilliseconds(operation) {
  const startedAt = process.cpuUsage();
  operation();
  const elapsed = process.cpuUsage(startedAt);
  return (elapsed.user + elapsed.system) / 1000;
}
