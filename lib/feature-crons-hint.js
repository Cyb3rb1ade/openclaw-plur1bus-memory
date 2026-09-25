/**
 * lib/feature-crons-hint.js — the feature-cron setup marker path, the
 * fail-open doctor/status hint derived from it, and the bootstrap script's
 * stdout parser. Was index.js:3254-3275 (featureCronsMarkerPath,
 * getFeatureCronsSetupHint), :287 (_featureCronsHintCache) and :3528-3552
 * (parseFeatureCronBootstrapLastPlanCreateCount).
 */

import { join } from "node:path";

import { readJsonSafe } from "./atomic-file.js";
import { featureCronsHintFromMarker } from "./setup/feature-cron-bootstrap.js";
import { PLUGIN_VERSION } from "./plugin-meta.js";

// Feature-cron setup hint cache: computed at most once per gateway process
// (see getFeatureCronsSetupHint below), fail-open, never throws.
// undefined = not yet computed; null = computed, no hint; string = hint text.
let _featureCronsHintCache;

/**
 * Path to the feature-cron setup marker file under baseDbPath (user-scoped,
 * same base the plugin already uses for everything else — never a
 * hardcoded system path), so this works identically for root and non-root
 * installs.
 */
export function featureCronsMarkerPath(baseDbPath) {
  return join(baseDbPath, ".feature-crons-setup.json");
}

/**
 * Fail-open, at-most-once-per-process, condition-derived doctor/status
 * hint: does the feature-cron setup marker show anything still worth
 * running? The marker is written by the gateway_start deferred bootstrap
 * (and/or a successful `/plur1bus setup crons`) — this function only
 * *reads* it, it never writes ("checked" and "resolved" must stay
 * distinct signals; see featureCronsHintFromMarker).
 */
export function getFeatureCronsSetupHint(baseDbPath) {
  if (_featureCronsHintCache !== undefined) return _featureCronsHintCache;
  try {
    const marker = readJsonSafe(featureCronsMarkerPath(baseDbPath), null);
    _featureCronsHintCache = featureCronsHintFromMarker(marker, PLUGIN_VERSION);
  } catch (_e) {
    _featureCronsHintCache = null;
  }
  return _featureCronsHintCache;
}

/** Forget the cached hint so the next read re-derives it (after a bootstrap run). */
export function resetFeatureCronsHintCache() {
  _featureCronsHintCache = undefined;
}

/**
 * Parse the deferred feature-cron setup script's `--json` stdout into the
 * marker-facing pending count.
 *
 * Rules:
 * - Explicit numeric `lastPlanCreateCount` from the script wins.
 * - Otherwise preserve the legacy normal-path calculation:
 *   failed creates + disabled delivery-needing creates.
 * - If stdout is empty, unparseable, or parses to a non-object, return `1`
 *   so the marker keeps the doctor/status hint visible instead of looking
 *   like a success marker.
 *
 * @param {string} stdout
 * @returns {number}
 */
export function parseFeatureCronBootstrapLastPlanCreateCount(stdout) {
  try {
    const parsed = typeof stdout === "string" && stdout.trim() ? JSON.parse(stdout.trim()) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return 1;
    }
    if (Number.isFinite(parsed.lastPlanCreateCount)) {
      return parsed.lastPlanCreateCount;
    }

    const failedCreates = Array.isArray(parsed.results)
      ? parsed.results.filter((r) => !r?.ok).length
      : 0;
    // Delivery-pflichtige Jobs, die mangels ableitbarem Ziel nur disabled
    // angelegt wurden, gelten weiterhin als "pending": der doctor/status-
    // Hinweis soll sichtbar bleiben, bis der Operator sie aktiviert hat
    // (README verspricht genau das).
    const disabledDeliveryCreates = Array.isArray(parsed.plan?.create)
      ? parsed.plan.create.filter((c) => c?.needsDelivery && c?.enabled === false).length
      : 0;
    return failedCreates + disabledDeliveryCreates;
  } catch (_e) {
    return 1;
  }
}
