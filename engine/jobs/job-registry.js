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
import { appendDreamDiaryEntry } from "../../lib/dreaming/dream-diary.js";
import { createJobLedger } from "./job-ledger.js";
import { JOB_SPECS } from "./job-specs.js";

const EXIT = Symbol("plur1bus.job.exit");

export const BREAKER_PHASES = Object.freeze(new Set(["rem", "deep"]));

/** Original run plus two retries before a no-narrative REM key is abandoned. */
export const MAX_ATTEMPTS = 3;

/** rem/deep phases share this many LLM sessions per agent per sweep. */
export const BREAKER_LIMIT = 3;

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
 * How many consecutive `incomplete` rows for this job (matching the current
 * pendingKeys when both sides have keys to compare) immediately precede the
 * run about to finish. A `skipped` row (breaker, `already_processed`,
 * `abandoned`) neither counts nor breaks the streak; any other outcome does.
 * @param {Array<object>} rows Ledger snapshot, oldest first.
 * @param {string} job
 * @param {string[]} pendingKeys
 * @returns {number}
 */
function priorIncompleteStreak(rows, job, pendingKeys) {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.job !== job || row.outcome === "skipped") continue;
    if (row.outcome !== "incomplete") break;
    const rowKeys = Array.isArray(row.pendingKeys) ? row.pendingKeys : [];
    if (pendingKeys.length > 0 && rowKeys.length > 0 && !rowKeys.some((key) => pendingKeys.includes(key))) break;
    streak += 1;
  }
  return streak;
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
  const warnedLedgerUnwritable = new Set();

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
  // completes without throwing: a partial failure in `readAll`,
  // `orphanMarkers` or `append` must not permanently skip recovery for that
  // agent for the rest of the process's lifetime — the next `run()` retries
  // it. An undeletable marker is different (fix round 2): once its crash
  // row is durable (freshly appended, or already present from an earlier
  // pass), the marker itself is cosmetic — a `removeMarker` failure there is
  // "warn and continue", never blocking recovery, or every later `run()`
  // for that agent would redo — and re-fail — the same recovery pass
  // forever, permanently returning `ledger_unwritable` without ever
  // invoking the body again.
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
      try {
        ledger.removeMarker(marker.runId);
      } catch (removeError) {
        host.logger.warn(`plur1bus job ${marker.job ?? "unknown"}[${agentId}]: orphan marker ${marker.runId} is recorded but its marker could not be removed (harmless — it stays but is already accounted for): ${String(removeError?.message || removeError)}`);
      }
    }
    recovered.add(agentId);
  }

  function bind(name, body, { defaultInput = null } = {}) {
    if (!specs.has(name)) throw new TypeError(`unknown job: ${name}`);
    if (owners.has(name)) throw new Error(`job ${name} already has an owner`);
    if (typeof body !== "function") throw new TypeError(`job ${name} body must be a function`);
    owners.set(name, { body, defaultInput });
  }

  function jobContext(inflight, { signal, input, snapshot }) {
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
      setDiaryTarget: (dir, { timezone, disabled } = {}) => {
        inflight.diaryTarget = dir || null;
        inflight.diaryTimezone = timezone ?? null;
        inflight.diaryDisabled = disabled === true;
      },
      // Served from the one readAll() snapshot taken at the start of this
      // run() (after recovery), not a fresh ledger read per call — this
      // run's own row is not appended yet, so it is correctly absent here.
      hasCompletedKey: (key) => snapshot.some((row) => Array.isArray(row.keys) && row.keys.includes(key)),
      isAbandonedKey: (key) => snapshot.some((row) => row.outcome === "abandoned" && Array.isArray(row.pendingKeys) && row.pendingKeys.includes(key)),
      noteAbandonedKey: (key) => { if (key && !inflight.abandonedKeys.includes(key)) inflight.abandonedKeys.push(String(key)); },
    });
  }

  function finish(inflight, exit, error, ledger, snapshot = []) {
    let outcome = exit.outcome;
    let reason = exit.reason;
    if (ledger && outcome !== "skipped") {
      const streak = priorIncompleteStreak(snapshot, inflight.job, inflight.pendingKeys);
      inflight.attempt = streak + 1;
      if (outcome === "incomplete" && inflight.attempt >= MAX_ATTEMPTS) {
        outcome = "abandoned";
        reason = `abandoned_after_retries:${exit.reason || "incomplete"}`;
        if (inflight.diaryDisabled) {
          inflight.diary = { written: false, reason: "diary_disabled" };
        } else {
          const diary = appendDreamDiaryEntry({
            workspaceDir: inflight.diaryTarget,
            narrative: `${inflight.job} run abandoned after ${inflight.attempt} attempts: ${exit.reason || "incomplete"}.`,
            mode: "rem",
            timezone: inflight.diaryTimezone,
            now: clock,
            logger: host.logger,
          });
          inflight.diary = { written: diary.written === true, ...(diary.reason ? { reason: diary.reason } : {}) };
        }
      }
    }
    if (outcome === "skipped" && exit.reason === "already_processed" && inflight.abandonedKeys.length > 0) {
      reason = "abandoned";
    }
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
      outcome,
      ...(reason ? { reason } : {}),
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
      abandonedKeys: [],
      diary: undefined,
      diaryTarget: null,
      diaryTimezone: null,
      diaryDisabled: false,
    };
    // `ledgerFor` (and, inside it, `safeAgentId`) can throw on an invalid
    // agentId, so it lives inside this try too — run() must always resolve
    // to a JobRun, never reject, whatever went wrong with the ledger.
    let ledger = null;
    // One readAll() snapshot per run(), taken right after this run's own
    // marker is written (so its own row, appended only in finish(), is
    // never in it) and after recovery (so a crash row from *this* process's
    // first run for this agent is visible). Every key check and the breaker
    // count below is served from this snapshot, not a fresh ledger read per
    // call (owner addendum, PR-08 = a).
    let snapshot = [];
    if (jobsRoot) {
      let markerWritten = false;
      try {
        ledger = ledgerFor(agentId);
        recoverOnce(agentId, ledger);
        ledger.writeMarker(inflight);
        markerWritten = true;
        snapshot = ledger.readAll();
      } catch (writeError) {
        // A throw after the marker was actually written (e.g. readAll()
        // fails on a subsequent read) must not leave a marker with no row
        // behind it: that marker would otherwise be mistaken for a crash at
        // the next process start, even though this run never invoked its
        // body. Best-effort only — if removal also fails, recovery's normal
        // crash-row handling still covers it.
        if (markerWritten) {
          try {
            ledger.removeMarker(inflight.runId);
          } catch {
            // ignored — recovery covers a leftover marker on next start
          }
        }
        const message = `plur1bus job ${name}[${agentId}]: ledger unwritable, not running: ${String(writeError?.message || writeError)}`;
        // A broken ledger root is a standing condition, not a per-run event:
        // warn once per agent, then drop to debug so a repeatedly-firing
        // cron does not spam warn on every tick (fix round 2).
        if (warnedLedgerUnwritable.has(agentId)) {
          host.logger.debug(message);
        } else {
          warnedLedgerUnwritable.add(agentId);
          host.logger.warn(message);
        }
        return finish(inflight, jobExit("failed", "ledger_unwritable", undefined), writeError, null);
      }
    }
    // rem/deep share a per-agent, per-sweep breaker of BREAKER_LIMIT LLM
    // sessions, counted from the snapshot taken above — a pre-skipped call
    // (e.g. an outer disabled-feature check) never counted as a session and
    // must not be blocked by one either.
    if (ledger && BREAKER_PHASES.has(spec.phase) && !preSkip) {
      const sweep = sweepKey(inflight.startedAt);
      const sessions = snapshot.filter((row) => row.sweep === sweep && row.llmSession === true && BREAKER_PHASES.has(row.phase)).length;
      if (sessions >= BREAKER_LIMIT) {
        return finish(inflight, jobExit("skipped", "circuit_open", {
          text: JSON.stringify({ job: name, skipped: true, reason: "circuit_open" }, null, 2),
        }), null, ledger, snapshot);
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
          const value = await owner.body(name, jobContext(inflight, { signal, input: resolved, snapshot }));
          exit = value && value[EXIT] ? value : jobExit("completed", undefined, value);
        }
      }
    } catch (thrown) {
      error = thrown;
      exit = jobExit("failed", `error:${thrown?.name || "Error"}`, undefined);
    }
    return finish(inflight, exit, error, ledger, snapshot);
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
