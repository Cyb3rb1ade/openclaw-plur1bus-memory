import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { safeAgentId } from "../sql-safety.js";

const PLUGIN_ID = "memory-lancedb-namespaced";
const CAPTURE_SEGMENT = `${sep}tmp${sep}plugin-captures${sep}`;

/**
 * Pfad des Cron-Runners, der in die Feature-Crons geschrieben wird.
 *
 * Seit OpenClaw 2026.9.6 laedt der Gateway Plugins aus Capture-Kopien unter
 * `<state>/tmp/plugin-captures/…`, je Plugin-Generation eine neue, und raeumt
 * alte Kopien weg. Die Crons ueberleben diese Kopien. Wird das Plugin aus einer
 * Kopie geladen, zeigt der Pfad deshalb auf die feste Installation
 * `<state>/extensions/memory-lancedb-namespaced/…` desselben State-Verzeichnisses,
 * sofern es sie gibt. Am 24.09.2026 hatten 31 von 40 Crons einen geloeschten
 * Capture-Pfad und liefen mit MODULE_NOT_FOUND ins Leere.
 * @param {string} loadedPath Runner-Pfad relativ zum Ladeort des Moduls.
 * @param {(path: string) => boolean} [exists]
 * @returns {string}
 */
export function stableFeatureCronRunnerPath(loadedPath, exists = existsSync) {
  const index = loadedPath.indexOf(CAPTURE_SEGMENT);
  if (index < 0) return loadedPath;
  const stateDir = loadedPath.slice(0, index);
  const installed = join(stateDir, "extensions", PLUGIN_ID, "scripts", "run-feature-cron.mjs");
  return exists(installed) ? installed : loadedPath;
}

export const FEATURE_CRON_RUNNER_PATH = stableFeatureCronRunnerPath(
  fileURLToPath(new URL("../../scripts/run-feature-cron.mjs", import.meta.url)),
);

const NATIVE_FEATURES = new Set([
  "persona-evolve",
  // Model-frei wie die uebrigen. Fehlte er hier, konnte der Installer den
  // bestehenden agentTurn-Job weder als nativen Job erkennen noch umbauen —
  // er lief deshalb jahrelang ueber das Modell in den 300s-Timeout.
  "auto-accept-stale",
  // Geplanter Abnehmer fuer die Neo-Embedding-Warteschlange: der Hook-Drain
  // ist seit 7.12.20 bewusst auf den Rest des Capture-Budgets begrenzt.
  "embedding-drain",
  "emotion-refine",
  "afterthought",
  "consolidate-daily",
  "classify-recent",
  "rem-dream",
  "skill-miner",
  "discover-semantic-links",
  "gc-run",
]);

function validateFeature(feature) {
  if (typeof feature !== "string" || !NATIVE_FEATURES.has(feature)) {
    throw new Error("unknown PLUR1BUS feature cron");
  }
  return feature;
}

function validateFeatureCommand(feature, command) {
  const expected = `/plur1bus internal ${feature}`;
  if (command !== expected) {
    throw new Error(`unexpected PLUR1BUS feature cron command for ${feature}`);
  }
  return command;
}

/** Build the exact model-free package runner argv for one shipped feature cron. */
export function buildNativeFeatureCommandArgv({ agentId, feature, command }) {
  const safeAgent = safeAgentId(agentId);
  const safeFeature = validateFeature(feature);
  validateFeatureCommand(safeFeature, command);
  return [
    process.execPath,
    FEATURE_CRON_RUNNER_PATH,
    "--agent",
    safeAgent,
    "--feature",
    safeFeature,
  ];
}

function nativeParams(spec, fallbackAgentId) {
  const agentId = spec?.agentId ?? spec?.agent ?? fallbackAgentId;
  return {
    agentId,
    feature: spec?.feature,
    command: spec?.command ?? spec?.message,
  };
}

/** Return true only for the byte-exact native payload PLUR1BUS itself generates. */
export function isNativeFeatureCommandPayload(payload, spec) {
  if (payload?.kind !== "command" || !Array.isArray(payload.argv)) return false;
  try {
    return JSON.stringify(payload.argv) === JSON.stringify(
      buildNativeFeatureCommandArgv(nativeParams(spec, spec?.agentId)),
    );
  } catch {
    return false;
  }
}

/** Plan an idempotent agentTurn-to-native-command migration for one owned job. */
export function planNativeFeaturePayloadMigration(job, spec) {
  if (typeof job?.id !== "string" || job.id.length === 0) return null;
  const params = nativeParams(spec, job?.agentId);
  const commandArgv = buildNativeFeatureCommandArgv(params);
  if (isNativeFeatureCommandPayload(job.payload, params)) return null;
  return {
    id: job.id,
    name: job.name ?? "",
    commandArgv,
  };
}

/** Extract the exact registered command from a PLUR1BUS native payload. */
export function commandFromNativeFeaturePayload(payload, agentId) {
  for (const feature of NATIVE_FEATURES) {
    const command = `/plur1bus internal ${feature}`;
    if (isNativeFeatureCommandPayload(payload, { agentId, feature, command })) return command;
  }
  return "";
}
