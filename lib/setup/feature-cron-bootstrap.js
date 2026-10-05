/**
 * lib/setup/feature-cron-bootstrap.js — pure decision logic for the
 * gateway_start deferred feature-cron bootstrap and the doctor/status hint.
 *
 * No I/O here: index.js owns reading/writing the marker file (via
 * lib/atomic-file.js) and spawning scripts/setup-feature-crons.mjs. These
 * helpers just answer "should we run?" / "should we hint?" given the
 * current marker contents, so the tricky throttle/condition logic is
 * unit-testable without booting the gateway.
 *
 * Marker shape (written by the bootstrap after a run):
 *   { pluginVersion: string, lastRunAt: string (ISO), lastPlanCreateCount: number }
 */

const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

/**
 * Should the deferred gateway_start bootstrap actually invoke
 * scripts/setup-feature-crons.mjs right now?
 *
 * Runs when there is no record of a prior run, the plugin version has
 * changed since the last recorded run (an update may need new crons), or
 * the last recorded run is stale (>= 20h old) — otherwise skipped, so a
 * gateway that restarts frequently doesn't re-spawn the setup script on
 * every restart.
 *
 * @param {{pluginVersion?: string, lastRunAt?: string}|null|undefined} marker
 * @param {{now?: number, pluginVersion: string}} opts
 * @returns {boolean}
 */
export function shouldRunCronBootstrap(marker, { now = Date.now(), pluginVersion } = {}) {
  if (!marker || typeof marker !== "object") return true;
  if (marker.pluginVersion !== pluginVersion) return true;
  if (Number.isFinite(marker.lastPlanCreateCount) && marker.lastPlanCreateCount > 0) return true;

  const lastRunAt = marker.lastRunAt ? Date.parse(marker.lastRunAt) : NaN;
  if (!Number.isFinite(lastRunAt)) return true;

  return now - lastRunAt >= TWENTY_HOURS_MS;
}

export { featureCronsHintFromMarker } from "../feature-crons-hint.js";

const JOB_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,95}$/;

function jobLabels(entries, pick) {
  return (Array.isArray(entries) ? entries : [])
    .map(pick)
    .filter((name) => typeof name === "string" && JOB_LABEL_RE.test(name));
}

/**
 * One log line saying what an unfinished bootstrap run wanted to do: planned
 * creates and updates, failed calls, or the early-exit reason. Job names only,
 * never payloads or error text. Since 7.18.8: every gateway start reported
 * `planCreateCount=1` without saying which job (02.10.2026).
 * @param {object|null} result Parsed `setup-feature-crons.mjs --json` output.
 * @returns {string|null} null when there is nothing pending to explain.
 */
export function describeFeatureCronBootstrapResult(result) {
  if (!result || typeof result !== "object") return null;
  const parts = [];
  if (typeof result.reason === "string" && JOB_LABEL_RE.test(result.reason)) parts.push(`reason=${result.reason}`);
  const creates = jobLabels(result.plan?.create, (job) => job?.name);
  if (creates.length) parts.push(`create=[${creates.join(", ")}]`);
  const updates = jobLabels(result.plan?.update, (update) => update?.name);
  if (updates.length) parts.push(`update=[${updates.join(", ")}]`);
  const failed = jobLabels((result.results || []).filter((entry) => entry && entry.ok === false), (entry) => entry.job);
  if (failed.length) parts.push(`failed=[${failed.join(", ")}]`);
  return parts.length ? parts.join(" ") : null;
}
