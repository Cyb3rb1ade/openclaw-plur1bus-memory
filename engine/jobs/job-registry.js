/**
 * engine/jobs/job-registry.js — PR-07 (spec 3.3).
 *
 * One owner per job name. A body returns its output (the command reply) for
 * a completed run, or `jobCtx.skip(...)` / `jobCtx.incomplete(...)` for the
 * other exits; a throw is a failed run. Every run resolves to a JobRun.
 */

import { randomUUID } from "node:crypto";

import { emitEngineEvent } from "../events.js";
import { JOB_SPECS } from "./job-specs.js";

const EXIT = Symbol("plur1bus.job.exit");

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
 * @param {{host: object, idFactory?: () => string}} options
 */
export function createJobRegistry({ host, idFactory = () => randomUUID() } = {}) {
  const specs = new Map(JOB_SPECS.map((spec) => [spec.name, spec]));
  const owners = new Map();
  const clock = () => (typeof host?.clock === "function" ? host.clock() : Date.now());

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

  function finish(inflight, exit, error) {
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
    return finish(inflight, exit, error);
  }

  return Object.freeze({
    list: () => [...specs.values()],
    bind,
    run,
    history: async () => [],
  });
}
