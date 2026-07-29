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

/**
 * Doctor/status hint, derived purely from marker contents — never from
 * "have we shown this before" bookkeeping. Returns a hint string when
 * setup has never run, ran under an older plugin version, or ran but
 * couldn't create everything it planned (lastPlanCreateCount > 0), or is
 * missing a numeric lastPlanCreateCount for the current plugin version;
 * returns null when the marker is fresh, current-version, and reports
 * nothing left to create.
 *
 * @param {{pluginVersion?: string, lastPlanCreateCount?: number}|null|undefined} marker
 * @param {string} pluginVersion
 * @returns {string|null}
 */
export function featureCronsHintFromMarker(marker, pluginVersion) {
  if (!marker || typeof marker !== "object") {
    return "Feature-Crons prüfen: node scripts/setup-feature-crons.mjs oder /plur1bus setup crons";
  }
  if (marker.pluginVersion !== pluginVersion) {
    return "Feature-Crons prüfen: node scripts/setup-feature-crons.mjs oder /plur1bus setup crons";
  }
  if (!Number.isFinite(marker.lastPlanCreateCount)) {
    return "Feature-Crons prüfen: node scripts/setup-feature-crons.mjs oder /plur1bus setup crons";
  }
  if (typeof marker.lastPlanCreateCount === "number" && marker.lastPlanCreateCount > 0) {
    return "Feature-Crons prüfen: node scripts/setup-feature-crons.mjs oder /plur1bus setup crons";
  }
  return null;
}
