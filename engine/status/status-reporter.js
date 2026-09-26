/**
 * engine/status/status-reporter.js — assembles `EngineStatus` (types/engine.d.ts,
 * contract 1.8.0) from the ledger-derived job health (Task 2), model readiness
 * (Task 3), an optional host journal-backlog capability, and the shared-memory
 * pool's own support() (E4 Task 4).
 *
 * `status()` is read-only and cheap by global constraint: it never creates a
 * directory, opens LanceDB, loads a model or calls a provider, and never
 * rejects — every dependency that could throw or hang is guarded so a broken
 * ledger, a broken models service or a slow/throwing host capability degrades
 * to a safe default instead of failing the whole call.
 */
import { isAbortError, raceAbort } from "../../lib/abort.js";
import { readinessOf } from "../providers/model-readiness.js";

/** Cap on waiting for `host.capabilities.journalBacklog()` (global constraint: "capped at 50 ms"). */
export const JOURNAL_BACKLOG_TIMEOUT_MS = 50;

/**
 * Pure: derive `EngineStatus.degraded` from a `ModelsStatus` (Task 3), in the
 * order fixed by the `EngineStatus.degraded` doc comment (types/engine.d.ts):
 * embedder failed, then embedder loading, then reranker failed, then reranker
 * loading; first match wins, otherwise null. A disabled reranker never
 * degrades the status.
 *
 * @param {{embedder: {state: string}, reranker: {state: string}}} models
 * @returns {{reason: string, capability: string} | null}
 */
export function degradedFromModels(models) {
  if (models.embedder.state === "failed") return { reason: "model-failed", capability: "embedding" };
  if (models.embedder.state === "loading") return { reason: "models-warming", capability: "embedding" };
  if (models.reranker.state === "failed") return { reason: "model-failed", capability: "reranker" };
  if (models.reranker.state === "loading") return { reason: "models-warming", capability: "reranker" };
  return null;
}

/**
 * Validate a host `journalBacklog()` result into `JournalBacklog | null`
 * (types/engine.d.ts): `entries` a non-negative safe integer, `oldestAt` a
 * finite number or null, no other key kept. Anything else is invalid.
 *
 * @param {unknown} value
 * @returns {{entries: number, oldestAt: number | null} | null}
 */
export function normalizeJournalBacklog(value) {
  if (!value || typeof value !== "object") return null;
  const { entries, oldestAt } = value;
  if (!Number.isSafeInteger(entries) || entries < 0) return null;
  if (oldestAt !== null && !Number.isFinite(oldestAt)) return null;
  return { entries, oldestAt: oldestAt === null ? null : oldestAt };
}

/** `readinessOf` inputs equivalent to "no probe has ever run" — the fallback used when `models.status()` throws. */
const NEVER_PROBED = Object.freeze({ lastAttempt: () => null, pending: () => false });

/**
 * @param {object} deps
 * @param {{health(): object}} deps.jobs `JobsHealth` source (Task 2).
 * @param {{status(): object}} deps.models `ModelsStatus` source (Task 3).
 * @param {() => object} [deps.getIdentity] The engine's own embedding-identity
 *   getter (`embeddingService.identities()[0]`), read only as a fallback when
 *   `models.status()` itself throws — `EngineStatus.models.embedder.identity`
 *   is non-nullable, so the fallback still needs a real `EmbeddingIdentity`.
 * @param {{support(): object}} deps.sharedMemoryPool
 * @param {{current(): string | null}} deps.storeMigrator
 * @param {string} deps.expectedSchema
 * @param {{size: number}} deps.openedAgents
 * @param {{capabilities?: {journalBacklog?: Function}, logger: {debug: Function}}} deps.host
 * @param {string} deps.contract
 * @returns {{status(): Promise<object>}} Never rejects.
 */
export function createStatusReporter({ jobs, models, getIdentity, sharedMemoryPool, storeMigrator, expectedSchema, openedAgents, host, contract }) {
  const loggedJournalReasons = new Set();
  const logJournalUnavailable = (reason) => {
    if (loggedJournalReasons.has(reason)) return;
    loggedJournalReasons.add(reason);
    host?.logger?.debug?.(`engine.status: journal backlog unavailable: ${reason}`);
  };

  function safeJobsHealth() {
    try {
      return jobs.health();
    } catch (error) {
      host?.logger?.debug?.(`engine.status: jobs.health() failed: ${error?.message ?? error}`);
      return { ledger: "unavailable", agents: [] };
    }
  }

  /** Best-effort `EmbeddingIdentity` for the models.status() fallback below — never throws. */
  function safeFallbackIdentity() {
    try {
      const identity = getIdentity?.();
      if (identity && typeof identity === "object") return identity;
    } catch (error) {
      host?.logger?.debug?.(`engine.status: fallback identity getter failed: ${error?.message ?? error}`);
    }
    return { fingerprintId: "unknown", provider: "unknown", model: "unknown", dimensions: 0 };
  }

  function safeModelsStatus() {
    try {
      return models.status();
    } catch (error) {
      host?.logger?.debug?.(`engine.status: models.status() failed: ${error?.message ?? error}`);
      const readiness = readinessOf(NEVER_PROBED);
      return { embedder: { ...readiness, identity: safeFallbackIdentity() }, reranker: { ...readiness, provider: null } };
    }
  }

  async function journalBacklog() {
    const capability = host?.capabilities?.journalBacklog;
    if (typeof capability !== "function") return null;
    // `AbortSignal.timeout()`'s own internal timer is unref'd: with a
    // never-settling capability and nothing else keeping the event loop
    // alive (a one-shot CLI's status() call, or this file's own test in
    // isolation), the timer can be skipped entirely and the awaited promise
    // never settles. A plain ref'd `setTimeout` that aborts a controller
    // fires unconditionally and is cleared in `finally` either way.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("journal backlog timed out", "TimeoutError")), JOURNAL_BACKLOG_TIMEOUT_MS);
    let raw;
    try {
      raw = await raceAbort(Promise.resolve().then(() => capability()), controller.signal);
    } catch (error) {
      logJournalUnavailable(isAbortError(error) ? "timed out" : `threw: ${error?.message ?? error}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (raw === null) return null;
    const normalized = normalizeJournalBacklog(raw);
    if (normalized === null) logJournalUnavailable("invalid shape");
    return normalized;
  }

  async function status() {
    const jobsHealth = safeJobsHealth();
    const modelsStatus = safeModelsStatus();
    let journal = null;
    let sharedMemory = { supported: false, mode: "unavailable", reason: "platform" };
    try {
      journal = await journalBacklog();
    } catch (error) {
      // journalBacklog() itself guards every rejection path above; this is
      // only a last-resort net so a bug in that guard cannot fail status().
      host?.logger?.debug?.(`engine.status: journal backlog assembly failed: ${error?.message ?? error}`);
    }
    try {
      sharedMemory = sharedMemoryPool.support();
    } catch (error) {
      host?.logger?.debug?.(`engine.status: sharedMemoryPool.support() failed: ${error?.message ?? error}`);
    }
    return {
      ready: true,
      degraded: degradedFromModels(modelsStatus),
      agents: openedAgents.size,
      contract,
      storeSchema: { current: storeMigrator.current(), expected: expectedSchema },
      jobs: jobsHealth,
      models: modelsStatus,
      journal,
      sharedMemory,
    };
  }

  return Object.freeze({ status });
}
