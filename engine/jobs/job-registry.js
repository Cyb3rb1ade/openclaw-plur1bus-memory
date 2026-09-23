/**
 * engine/jobs/job-registry.js — PR-07/PR-08 (spec 3.3).
 *
 * One owner per job name. A body returns its output (the command reply) for
 * a completed run, or `jobCtx.skip(...)` / `jobCtx.incomplete(...)` for the
 * other exits; a throw is a failed run. Every run resolves to a JobRun.
 *
 * Every run writes `<runId>.started` before invoking the body (Job ledger,
 * PR-08); every exit appends exactly one JobRun row and removes the marker.
 * A marker left behind with no matching row at the next start is recorded
 * as a `failed`/`crash` run before that start's own run proceeds.
 */

import { randomUUID } from "node:crypto";

import { emitEngineEvent } from "../events.js";
import { createJobLedger } from "./job-ledger.js";
import { JOB_SPECS } from "./job-specs.js";

const EXIT = Symbol("plur1bus.job.exit");

export const BREAKER_PHASES = Object.freeze(new Set(["rem", "deep"]));

/** @param {number} ms @returns {string} UTC day. */
export function sweepKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param {"completed"|"skipped"|"incomplete"|"failed"|"abandoned"} outcome
 * @param {string|undefined} reason
 * @param {unknown} output
 * @returns {{outcome: string, reason?: string, output: unknown}}
 */
export function jobExit(outcome, reason, output) {
  return { [EXIT]: true, outcome, reason, output };
}

/**
 * @param {{host: object, jobsRoot?: string|null, idFactory?: () => string}} options
 */
export function createJobRegistry({ host, jobsRoot = null, idFactory = () => randomUUID() } = {}) {
  const specs = new Map(JOB_SPECS.map((spec) => [spec.name, spec]));
  const owners = new Map();
  const clock = () => (typeof host?.clock === "function" ? host.clock() : Date.now());
  const ledgers = new Map();
  const recovered = new Set();

  function ledgerFor(agentId) {
    if (!jobsRoot) return null;
    let ledger = ledgers.get(agentId);
    if (!ledger) {
      ledger = createJobLedger({ root: jobsRoot, agentId, logger: host.logger });
      ledgers.set(agentId, ledger);
    }
    return ledger;
  }

  function rowOf(run) {
    return {
      ...run,
      sweep: sweepKey(run.startedAt),
      llmSession: BREAKER_PHASES.has(run.phase) && run.outcome !== "skipped",
    };
  }

  // Recovery scans a ledger for markers no run of *this process* wrote, so
  // it belongs at the first `run()` a process makes for that agent — never
  // again afterwards in that same process (a leftover marker from a later
  // in-process failure is picked up by the next *process* start, not by the
  // next call to `run()`; see the ledger append/removeMarker failure paths
  // in `finish()`). The agent is marked recovered only once the pass
  // completes without throwing: a partial failure here (e.g. `readAll` or
  // an append throws) must not permanently skip recovery for that agent for
  // the rest of the process's lifetime — the next `run()` retries it.
  function recoverOnce(agentId, ledger) {
    if (recovered.has(agentId)) return;
    const finished = new Set(ledger.readAll().map((row) => row.runId));
    for (const marker of ledger.orphanMarkers()) {
      if (!finished.has(marker.runId)) {
        const startedAt = Number.isFinite(marker.startedAt) ? marker.startedAt : clock();
        const finishedAt = clock();
        ledger.append(rowOf({
          runId: marker.runId,
          job: marker.job ?? "unknown",
          phase: marker.phase ?? null,
          agentId,
          // A corrupt (unreadable) marker carries no trustworthy trigger —
          // record it as unknown (`null`) rather than guessing "cron" and
          // masking the corruption; a marker that parsed fine but simply
          // lacks the field still defaults to "cron" as before.
          trigger: marker.corrupt ? null : (marker.trigger ?? "cron"),
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          outcome: "failed",
          reason: "crash",
          attempt: 1,
          cost: { ms: 0 },
          counts: {},
        }));
        host.logger.warn(marker.corrupt
          ? `plur1bus job ${marker.job ?? "unknown"}[${agentId}]: run ${marker.runId} left a corrupt (unreadable) marker with no ledger row; recorded as crash`
          : `plur1bus job ${marker.job ?? "unknown"}[${agentId}]: run ${marker.runId} left no ledger row; recorded as crash`);
      }
      ledger.removeMarker(marker.runId);
    }
    recovered.add(agentId);
  }

  function bind(name, body, { defaultInput = null } = {}) {
    if (!specs.has(name)) throw new TypeError(`unknown job: ${name}`);
    if (owners.has(name)) throw new Error(`job ${name} already has an owner`);
    if (typeof body !== "function") throw new TypeError(`job ${name} body must be a function`);
    owners.set(name, { body, defaultInput });
  }

  function jobContext(inflight, { signal, input }) {
    return Object.freeze({
      agentId: inflight.agentId,
      trigger: inflight.trigger,
      signal,
      input,
      logger: host.logger,
      skip: (reason, output) => jobExit("skipped", reason, output),
      incomplete: (reason, output) => jobExit("incomplete", reason, output),
      noteDiary: (result) => {
        inflight.diary = { written: result?.written === true, ...(result?.reason ? { reason: String(result.reason) } : {}) };
      },
      markCompletedKey: (key) => { if (key && !inflight.keys.includes(key)) inflight.keys.push(String(key)); },
      notePendingKey: (key) => { if (key && !inflight.pendingKeys.includes(key)) inflight.pendingKeys.push(String(key)); },
      setDiaryTarget: (dir) => { inflight.diaryTarget = dir || null; },
    });
  }

  function finish(inflight, exit, error, ledger) {
    const finishedAt = clock();
    const durationMs = Math.max(0, finishedAt - inflight.startedAt);
    const run = {
      runId: inflight.runId,
      job: inflight.job,
      phase: inflight.phase,
      agentId: inflight.agentId,
      trigger: inflight.trigger,
      startedAt: inflight.startedAt,
      finishedAt,
      durationMs,
      outcome: exit.outcome,
      ...(exit.reason ? { reason: exit.reason } : {}),
      attempt: inflight.attempt,
      cost: { ms: durationMs },
      counts: {},
      ...(inflight.keys.length ? { keys: [...inflight.keys] } : {}),
      ...(inflight.pendingKeys.length ? { pendingKeys: [...inflight.pendingKeys] } : {}),
      ...(inflight.pendingKeys.length || inflight.keys.length ? { idempotencyKey: inflight.pendingKeys[0] ?? inflight.keys[0] } : {}),
      ...(inflight.diary ? { diary: inflight.diary } : {}),
    };
    Object.defineProperty(run, "output", { value: exit.output, enumerable: false });
    if (error) Object.defineProperty(run, "error", { value: error, enumerable: false });
    if (ledger) {
      let appended = false;
      try {
        ledger.append(rowOf(run));
        appended = true;
      } catch (appendError) {
        host.logger.warn(`plur1bus job ${run.job}[${run.agentId}]: ledger append failed; the marker stays for crash recovery: ${String(appendError?.message || appendError)}`);
      }
      // Only attempt to clear the marker once the row it guards is actually
      // durable — clearing it after a failed append would let a crash
      // before the next append lose this run entirely.
      if (appended) {
        try {
          ledger.removeMarker(run.runId);
        } catch (removeError) {
          host.logger.warn(`plur1bus job ${run.job}[${run.agentId}]: ledger row was recorded but its start marker could not be removed (harmless — the next recovery pass sees the row and skips it): ${String(removeError?.message || removeError)}`);
        }
      }
    }
    if (run.outcome === "skipped") host.logger.info(`plur1bus job ${run.job}[${run.agentId}]: skipped (${run.reason})`);
    emitEngineEvent(host, "job.run", run);
    return run;
  }

  async function run(name, agentId, { signal, trigger = "manual", input, preSkip } = {}) {
    const spec = specs.get(name);
    if (!spec) throw new TypeError(`unknown job: ${name}`);
    const inflight = {
      runId: idFactory(),
      job: name,
      phase: spec.phase ?? null,
      agentId,
      trigger,
      startedAt: clock(),
      attempt: 1,
      keys: [],
      pendingKeys: [],
      diary: undefined,
      diaryTarget: null,
    };
    // `ledgerFor` (and, inside it, `safeAgentId`) can throw on an invalid
    // agentId, so it lives inside this try too — run() must always resolve
    // to a JobRun, never reject, whatever went wrong with the ledger.
    let ledger = null;
    if (jobsRoot) {
      try {
        ledger = ledgerFor(agentId);
        recoverOnce(agentId, ledger);
        ledger.writeMarker(inflight);
      } catch (writeError) {
        host.logger.warn(`plur1bus job ${name}[${agentId}]: ledger unwritable, not running: ${String(writeError?.message || writeError)}`);
        return finish(inflight, jobExit("failed", "ledger_unwritable", undefined), writeError, null);
      }
    }
    const owner = owners.get(name);
    let exit;
    let error = null;
    try {
      if (preSkip) {
        exit = jobExit("skipped", preSkip.reason, preSkip.output);
      } else if (!owner) {
        exit = jobExit("skipped", "no_owner", undefined);
      } else {
        const resolved = input ?? (owner.defaultInput ? await owner.defaultInput(agentId, name) : undefined);
        if (resolved?.preSkip) {
          exit = jobExit("skipped", resolved.preSkip.reason, resolved.preSkip.output);
        } else {
          const value = await owner.body(name, jobContext(inflight, { signal, input: resolved }));
          exit = value && value[EXIT] ? value : jobExit("completed", undefined, value);
        }
      }
    } catch (thrown) {
      error = thrown;
      exit = jobExit("failed", `error:${thrown?.name || "Error"}`, undefined);
    }
    return finish(inflight, exit, error, ledger);
  }

  return Object.freeze({
    list: () => [...specs.values()],
    bind,
    run,
    history: async (agentId, { job, since, limit } = {}) => {
      const ledger = ledgerFor(agentId);
      if (!ledger) return [];
      let rows = ledger.readAll();
      if (job) rows = rows.filter((row) => row.job === job);
      if (Number.isFinite(since)) rows = rows.filter((row) => row.startedAt >= since);
      rows.reverse();
      return Number.isInteger(limit) && limit >= 0 ? rows.slice(0, limit) : rows;
    },
  });
}
