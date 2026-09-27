/**
 * engine/store/fragment-compactor.js — bounded LanceDB fragment compaction
 * between consolidate-daily runs (E5 Task 6, `runtime.lancedbCompaction`).
 *
 * Every add()/update() writes a LanceDB fragment. Only consolidate-daily ran
 * optimize(), and it is off by default, so an install that never schedules it
 * never compacts: capture and recall latency grow with every turn
 * (lib/lancedb-optimize.js: 352 fragments → vector search 191 ms, 23 ms after
 * optimize). The compactor counts table writes per agent, checks the fragment
 * count every `checkEveryWrites` writes and every `checkIntervalMs`, and runs
 * the db-adapter's optimizeTable once an agent's table reaches
 * `fragmentThreshold` fragments.
 *
 * Checks run one at a time per compactor (a FIFO chain). The db-adapter's
 * process-wide optimize lock (one per table path) keeps this compactor, other
 * engines in the same process, consolidate-daily and the dashboard runner
 * from optimizing one table at the same time; the compactor asks it to skip
 * rather than wait when the table is already being optimized.
 *
 * `enabled: false` is the only off switch: `dailyConsolidation.lancedbOptimize
 * .enabled` governs the nightly job only.
 */

export const DEFAULT_LANCEDB_COMPACTION = Object.freeze({
  enabled: true,
  fragmentThreshold: 64,
  checkEveryWrites: 16,
  checkIntervalMs: 600_000,
  timeoutMs: 60_000,
});

const MINIMUMS = Object.freeze({
  fragmentThreshold: 8,
  checkEveryWrites: 1,
  checkIntervalMs: 60_000,
  timeoutMs: 10_000,
});

const DEFAULT_KEEP_VERSIONS_HOURS = 24;

/**
 * Validated copy of runtime.lancedbCompaction merged over the defaults
 * (out-of-range or non-integer values → default).
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULT_LANCEDB_COMPACTION}
 */
export function resolveLancedbCompaction(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const resolved = {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_LANCEDB_COMPACTION.enabled,
  };
  for (const [key, minimum] of Object.entries(MINIMUMS)) {
    const value = source[key];
    resolved[key] = Number.isInteger(value) && value >= minimum ? value : DEFAULT_LANCEDB_COMPACTION[key];
  }
  return Object.freeze(resolved);
}

/**
 * @typedef {object} CompactionOutcome
 * @property {string} agentId
 * @property {"skipped"|"compacted"|"failed"} action
 * @property {string} [reason] "disabled" | "closed" | "below-threshold" | "no-table" | "busy" | the adapter's failure reason
 * @property {number|null} fragmentsBefore
 * @property {number|null} fragmentsAfter
 * @property {number} ms
 */

/**
 * @param {object} options
 * @param {unknown} options.config Raw `runtime.lancedbCompaction`.
 * @param {(agentId: string) => Promise<number|null>} options.fragmentCount
 * @param {(agentId: string, opts: object) => Promise<{ok: boolean, reason?: string, conflict?: boolean, busy?: boolean}>} options.optimize
 * @param {number} options.keepVersionsHours Versions older than this are pruned by optimize.
 * @param {{warn?: Function, debug?: Function}} options.logger
 * @param {() => number} [options.clock]
 * @param {{setInterval: Function, clearInterval: Function}} [options.timers]
 * @returns {{noteWrite(agentId: string): void, check(agentId: string): Promise<CompactionOutcome>, compactNow(agentId: string): Promise<CompactionOutcome>, close(): Promise<void>}}
 */
export function createFragmentCompactor({
  config,
  fragmentCount,
  optimize,
  keepVersionsHours,
  logger,
  clock = Date.now,
  timers = { setInterval, clearInterval },
}) {
  const settings = resolveLancedbCompaction(config);
  const keepHours = Number.isFinite(keepVersionsHours) && keepVersionsHours > 0 ? keepVersionsHours : DEFAULT_KEEP_VERSIONS_HOURS;
  /** Writes since the agent's last compaction; the stand-in when stats are unavailable. */
  const writesSinceCompaction = new Map();
  /** All writes seen per agent; its keys are the agents the timer checks. */
  const totalWrites = new Map();
  /** agentId → { promise, force } of the check queued or running for it. */
  const inFlight = new Map();
  let chain = Promise.resolve();
  let closed = false;
  let closing = null;

  const outcome = (agentId, action, reason, started, fragmentsBefore = null, fragmentsAfter = null) => ({
    agentId,
    action,
    ...(reason ? { reason } : {}),
    fragmentsBefore,
    fragmentsAfter,
    ms: Math.max(0, clock() - started),
  });

  const safeCount = async (agentId) => {
    try {
      const n = await fragmentCount(agentId);
      return typeof n === "number" && Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };

  async function runCheck(agentId, force) {
    const started = clock();
    if (closed) return outcome(agentId, "skipped", "closed", started);
    const fragmentsBefore = await safeCount(agentId);
    const n = fragmentsBefore ?? (writesSinceCompaction.get(agentId) ?? 0);
    if (!force && n < settings.fragmentThreshold) {
      return outcome(agentId, "skipped", "below-threshold", started, fragmentsBefore);
    }
    if (closed) return outcome(agentId, "skipped", "closed", started, fragmentsBefore);
    let result;
    try {
      result = await optimize(agentId, {
        cleanupOlderThan: new Date(clock() - keepHours * 3_600_000),
        timeoutMs: settings.timeoutMs,
        maxAttempts: 3,
        retryDelayMs: 1_000,
        ifBusy: "skip",
        quietConflicts: true,
      });
    } catch (err) {
      result = { ok: false, reason: String(err?.message || err) };
    }
    if (result?.ok) {
      writesSinceCompaction.set(agentId, 0);
      const fragmentsAfter = await safeCount(agentId);
      return outcome(agentId, "compacted", null, started, fragmentsBefore, fragmentsAfter);
    }
    const reason = String(result?.reason || "unknown");
    if (reason === "no-table" || result?.busy === true) {
      return outcome(agentId, "skipped", result?.busy === true ? "busy" : "no-table", started, fragmentsBefore);
    }
    if (result?.conflict === true) {
      // Lost to concurrent writes on all attempts; the next check retries.
      logger?.debug?.(`plur1bus-compaction: optimize for '${agentId}' lost to concurrent writes, retrying at the next check`);
    } else {
      logger?.warn?.(`plur1bus-compaction: optimize failed for '${agentId}': ${reason}`);
    }
    return outcome(agentId, "failed", reason, started, fragmentsBefore);
  }

  function schedule(agentId, force) {
    const started = clock();
    if (closed) return Promise.resolve(outcome(agentId, "skipped", "closed", started));
    if (!settings.enabled) return Promise.resolve(outcome(agentId, "skipped", "disabled", started));
    const existing = inFlight.get(agentId);
    if (existing) {
      // A forced run behind a plain check must still compact.
      return force && !existing.force ? existing.promise.then(() => schedule(agentId, true)) : existing.promise;
    }
    const promise = chain.then(() => runCheck(agentId, force));
    const entry = { promise, force };
    inFlight.set(agentId, entry);
    chain = promise.then(() => {}, () => {});
    const clear = () => { if (inFlight.get(agentId) === entry) inFlight.delete(agentId); };
    promise.then(clear, clear);
    return promise;
  }

  const check = (agentId) => schedule(agentId, false);
  const compactNow = (agentId) => schedule(agentId, true);

  const runInBackground = (agentId) => {
    check(agentId).catch((err) => {
      logger?.warn?.(`plur1bus-compaction: check failed for '${agentId}': ${String(err?.message || err)}`);
    });
  };

  let timer = null;
  if (settings.enabled) {
    timer = timers.setInterval(() => {
      if (closed) return;
      for (const agentId of totalWrites.keys()) runInBackground(agentId);
    }, settings.checkIntervalMs);
    timer?.unref?.();
  }

  function noteWrite(agentId) {
    if (closed || !settings.enabled) return;
    if (typeof agentId !== "string" || agentId === "") return;
    writesSinceCompaction.set(agentId, (writesSinceCompaction.get(agentId) ?? 0) + 1);
    const total = (totalWrites.get(agentId) ?? 0) + 1;
    totalWrites.set(agentId, total);
    if (total % settings.checkEveryWrites === 0) runInBackground(agentId);
  }

  function close() {
    if (closing) return closing;
    closed = true;
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
    closing = chain.then(() => {});
    return closing;
  }

  return { noteWrite, check, compactNow, close };
}
