/**
 * lib/setup/feature-cron-plan.js — pure planning logic for the feature-cron
 * self-setup (persona-evolve, afterthought). No I/O here — see
 * scripts/setup-feature-crons.mjs for the shell that executes the plan via
 * the `openclaw` CLI.
 *
 * Design:
 * - REQUIRED_FEATURE_CRONS mirrors the real `openclaw cron list --json` job
 *   shape (name + payload.message running "/plur1bus internal <job>"),
 *   observed on a live installation — see the field names below.
 * - planFeatureCrons() is idempotent: re-running it against the current
 *   `openclaw cron list --json` output never proposes a duplicate.
 * - Delivery-needing jobs (afterthought) default to created-but-disabled
 *   when no agent/account is known, with a hint on how to wire delivery —
 *   never silently deliver to nobody, never fail the install.
 */

export const REQUIRED_FEATURE_CRONS = [
  {
    name: "plur1bus persona-evolve",
    command: "/plur1bus internal persona-evolve",
    message: "/plur1bus internal persona-evolve",
    description: "Weekly persona-voice evolution proposal (low-traffic slot).",
    // Sunday 04:15 — low-traffic slot, mirrors the "0 4 * * 0"-style weekly
    // internal jobs already used for other maintenance crons on this install.
    schedule: { kind: "cron", expr: "15 4 * * 0" },
    needsDelivery: false,
  },
  {
    name: "plur1bus afterthought",
    command: "/plur1bus internal afterthought",
    // README delivery contract (grep "afterthought" README.md):
    // if the JSON result has a `text` field, send exactly that text as the
    // message; if `skipped` is true, output NOTHING.
    message:
      "/plur1bus internal afterthought\n\n" +
      "Delivery contract: the job returns JSON. If it has a `text` field, " +
      "send exactly that text as the message, verbatim, with no additional " +
      "commentary. If `skipped` is true, output NOTHING at all.",
    description: "Delayed follow-up job — runs every 30 minutes.",
    schedule: { kind: "every", everyMs: 30 * 60 * 1000 },
    needsDelivery: true,
  },
];

function normalize(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Does an existing cron job (as returned by `openclaw cron list --json`)
 * already cover this spec? Matches on job name (case-insensitive substring,
 * either direction) or on the job's agent-turn message containing the
 * spec's internal command — cron names are free-form, so the message match
 * is the more reliable idempotency signal.
 */
function matchesExisting(job, spec) {
  const jobName = normalize(job?.name);
  const specName = normalize(spec?.name);
  if (jobName && specName && (jobName.includes(specName) || specName.includes(jobName))) {
    return true;
  }
  const jobMessage = normalize(job?.payload?.message);
  const specCommand = normalize(spec?.command);
  if (jobMessage && specCommand && jobMessage.includes(specCommand)) {
    return true;
  }
  return false;
}

/**
 * Plan which REQUIRED_FEATURE_CRONS specs still need to be created against
 * a list of existing jobs (from `openclaw cron list --json`).
 *
 * @param {Array<object>} existingJobs
 * @param {Array<object>} specs
 * @param {{agent?: string|null, account?: string|null}} opts
 * @returns {{create: Array<object>, skip: Array<{spec: object, reason: string, existingJob?: object}>}}
 */
export function planFeatureCrons(existingJobs, specs, opts = {}) {
  const { agent = null, account = null } = opts || {};
  const jobs = Array.isArray(existingJobs) ? existingJobs : [];
  const create = [];
  const skip = [];

  for (const spec of specs) {
    const existingJob = jobs.find((job) => matchesExisting(job, spec));
    if (existingJob) {
      skip.push({ spec, reason: "already-exists", existingJob });
      continue;
    }

    const hasDeliveryTarget = Boolean(agent || account);
    const enabled = spec.needsDelivery ? hasDeliveryTarget : true;

    const planned = {
      name: spec.name,
      command: spec.command,
      message: spec.message,
      description: spec.description,
      schedule: spec.schedule,
      needsDelivery: spec.needsDelivery,
      enabled,
      agent,
      account,
    };

    if (spec.needsDelivery && !hasDeliveryTarget) {
      planned.hint =
        `Delivery not configured — created disabled. Enable with: ` +
        `openclaw cron edit --name "${spec.name}" --agent <id> --account <account> --announce, ` +
        `then: openclaw cron enable --name "${spec.name}"`;
    }

    create.push(planned);
  }

  return { create, skip };
}
