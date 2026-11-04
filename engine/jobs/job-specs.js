/**
 * engine/jobs/job-specs.js — the 19 engine-owned jobs (spec 3.3, contract JobName).
 *
 * Twelve carry a host cron default from lib/feature-cron-specs.js; six are
 * RPC/CLI features with no default schedule; light-dream runs from capture.
 * `phase` marks the dreaming phases the per-sweep breaker counts (Task 8).
 * `needsLlm` is informational: whether the job can reach an LLM route at all.
 */

import { REQUIRED_FEATURE_CRONS } from "../../lib/feature-cron-specs.js";

const JOB_TABLE = Object.freeze([
  ["persona-evolve", true, null],
  ["afterthought", true, null],
  ["consolidate-daily", true, "deep"],
  ["auto-accept-stale", false, null],
  ["embedding-drain", false, null],
  ["emotion-refine", true, null],
  ["post-turn-refine", true, null],
  ["classify-recent", true, null],
  ["rem-dream", true, "rem"],
  ["skill-miner", true, null],
  ["discover-semantic-links", false, null],
  ["gc-run", false, null],
  ["reminder-dispatch", false, null],
  ["feedback-report", false, null],
  ["proactive-check", false, null],
  ["meta-reflect", true, null],
  ["skill-benefit-backfill", true, null],
  ["episodes-rebuild", true, null],
  ["light-dream", true, "light"],
]);

// Jobs whose body reads, decides and writes state with no lock of its own
// (classify-recent's per-run maxPerDay budget and candidate list, the brake
// state files of persona-evolve and afterthought, ...). A second run for the
// same agent while one is in flight is skipped `already_running`, like a
// singleton's. Not `singleton`: that stays the cron-planning notion (one cron
// job for all agents), and it is per agent here.
const EXCLUSIVE_JOBS = new Set([
  "classify-recent",
  "afterthought",
  "persona-evolve",
  "auto-accept-stale",
  "emotion-refine",
]);

const CRON_BY_FEATURE = new Map(REQUIRED_FEATURE_CRONS.map((spec) => [spec.feature, spec]));

function defaultScheduleOf(cron) {
  if (cron.schedule.kind === "every") return Object.freeze({ kind: "every", expr: String(cron.schedule.everyMs) });
  return Object.freeze({
    kind: "cron",
    expr: cron.schedule.expr,
    ...(cron.timezone ? { timezone: cron.timezone } : {}),
  });
}

export const JOB_NAMES = Object.freeze(JOB_TABLE.map(([name]) => name));

export const INTERNAL_JOB_NAMES = Object.freeze(JOB_NAMES.filter((name) => name !== "light-dream"));

export const JOB_SPECS = Object.freeze(JOB_TABLE.map(([name, needsLlm, phase]) => {
  const cron = CRON_BY_FEATURE.get(name);
  return Object.freeze({
    name,
    needsLlm,
    singleton: cron?.singleton === true,
    exclusive: EXCLUSIVE_JOBS.has(name),
    ...(phase ? { phase } : {}),
    ...(cron ? { defaultSchedule: defaultScheduleOf(cron) } : {}),
  });
}));
