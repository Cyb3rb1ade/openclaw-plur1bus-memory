/**
 * lib/runtime-pressure-gate.js — runtime memory pressure classification.
 *
 * Classifies process RSS against configurable warning/critical thresholds.
 * Used by the background memory scheduler to shed low-priority work before
 * the process runs into swap, GC thrash, or LanceDB timeouts.
 */

const GiB = 1024 * 1024 * 1024;

export const DEFAULT_PRESSURE_THRESHOLDS = {
  rssWarningBytes: 3 * GiB, // 3221225472
  rssCriticalBytes: 4.5 * GiB, // 4831838208
};

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function normalizePressureThresholds(opts = {}) {
  return {
    rssWarningBytes: toPositiveInt(opts.rssWarningBytes, DEFAULT_PRESSURE_THRESHOLDS.rssWarningBytes),
    rssCriticalBytes: toPositiveInt(opts.rssCriticalBytes, DEFAULT_PRESSURE_THRESHOLDS.rssCriticalBytes),
  };
}

/**
 * Check current runtime memory pressure.
 * @param {Object} [opts]
 * @param {number} [opts.rssWarningBytes]
 * @param {number} [opts.rssCriticalBytes]
 * @returns {{level: "ok"|"warning"|"critical", reason: string, rssBytes: number, heapUsedBytes: number, thresholdBytes: number}}
 */
export function checkRuntimePressure(opts = {}) {
  const { rssWarningBytes, rssCriticalBytes } = normalizePressureThresholds(opts);
  const mem = process.memoryUsage();
  const rssBytes = typeof mem.rss === "number" ? mem.rss : 0;
  const heapUsedBytes = typeof mem.heapUsed === "number" ? mem.heapUsed : 0;

  if (rssBytes >= rssCriticalBytes) {
    return {
      level: "critical",
      reason: `RSS ${(rssBytes / GiB).toFixed(2)} GiB >= critical ${(rssCriticalBytes / GiB).toFixed(2)} GiB (heapUsed ${(heapUsedBytes / GiB).toFixed(2)} GiB)`,
      rssBytes,
      heapUsedBytes,
      thresholdBytes: rssCriticalBytes,
    };
  }

  if (rssBytes >= rssWarningBytes) {
    return {
      level: "warning",
      reason: `RSS ${(rssBytes / GiB).toFixed(2)} GiB >= warning ${(rssWarningBytes / GiB).toFixed(2)} GiB (heapUsed ${(heapUsedBytes / GiB).toFixed(2)} GiB)`,
      rssBytes,
      heapUsedBytes,
      thresholdBytes: rssWarningBytes,
    };
  }

  return {
    level: "ok",
    reason: `RSS ${(rssBytes / GiB).toFixed(2)} GiB below warning ${(rssWarningBytes / GiB).toFixed(2)} GiB`,
    rssBytes,
    heapUsedBytes,
    thresholdBytes: rssWarningBytes,
  };
}
