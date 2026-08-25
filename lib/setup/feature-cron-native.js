import { safeAgentId } from "../sql-safety.js";

const NATIVE_FEATURE_COMMAND_TIMEOUT_SECONDS = 540;
const NATIVE_FEATURES = new Set([
  "persona-evolve",
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

/** Build the exact model-free Gateway CLI argv for one shipped feature cron. */
export function buildNativeFeatureCommandArgv({ agentId, feature, command }) {
  const safeAgent = safeAgentId(agentId);
  const safeFeature = validateFeature(feature);
  const safeCommand = validateFeatureCommand(safeFeature, command);
  return [
    "openclaw",
    "agent",
    "--agent",
    safeAgent,
    "--session-key",
    `agent:${safeAgent}:cron:plur1bus-${safeFeature}`,
    "--channel",
    "cron",
    "--message",
    safeCommand,
    "--timeout",
    String(NATIVE_FEATURE_COMMAND_TIMEOUT_SECONDS),
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

