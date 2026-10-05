/**
 * adapter/openclaw/obsidian-review-cron-commands.js — OpenClaw `cron add`
 * command strings for Obsidian morning/evening reviews.
 *
 * These builders import native feature-cron argv (`openclaw cron add`).
 * The engine's control-room handler takes them through context so engine/**
 * never reaches lib/setup/feature-cron-native.js.
 */
import { buildNativeFeatureCommandArgv, featureCronCommand } from "../../lib/setup/feature-cron-native.js";
import {
  normalizeObsidianControlRoomConfig,
  selectCommandWorkspaces,
  workspaceDisplayName,
} from "../../lib/obsidian-control-room.js";

function shellArg(value) {
  return `"${String(value || "").replace(/(["\\$`])/g, "\\$1")}"`;
}

function cronCommandFromSpec(spec) {
  const commandArgv = buildNativeFeatureCommandArgv({
    agentId: spec.agentId,
    feature: spec.feature,
    command: featureCronCommand(spec.feature),
  });
  const parts = [
    "openclaw cron add",
    `--name ${shellArg(spec.name)}`,
    `--agent ${shellArg(spec.agentId)}`,
    `--cron ${shellArg(spec.cron)}`,
    `--tz ${shellArg(spec.timezone)}`,
    "--exact",
    `--session ${spec.session}`,
    `--command-argv ${shellArg(JSON.stringify(commandArgv))}`,
    `--timeout-seconds ${spec.timeoutSeconds}`,
    "--output-max-bytes 65536",
  ];
  if (spec.channel) parts.push(`--channel ${shellArg(spec.channel)}`);
  if (spec.to) parts.push(`--to ${shellArg(spec.to)}`);
  if (spec.delivery === "announce") parts.push("--announce");
  return parts.map((part, index) => `${index === 0 ? part : `  ${part}`}${index < parts.length - 1 ? " \\" : ""}`).join("\n");
}

/**
 * Print the `openclaw cron add` command for the morning review of one agent.
 *
 * @param {object} [rawConfig]
 * @param {{agentId?: string}} [options]
 * @returns {string}
 */
export function printMorningReviewCronCommand(rawConfig = {}, options = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  return cronCommandFromSpec({
    name: "PLUR1BUS Morning Review",
    agentId: options.agentId || "main",
    feature: "morning-review",
    cron: cfg.morningReview.cron,
    timezone: cfg.morningReview.timezone,
    session: cfg.morningReview.session,
    delivery: "announce",
    timeoutSeconds: 900,
  });
}

/**
 * @param {object} [rawConfig]
 * @param {object} [options]
 * @returns {{ok: true, workspaces: number, jobs: object[]}}
 */
export function buildWorkspaceReviewCronJobs(rawConfig = {}, options = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  const workspaces = options.workspaces
    || selectCommandWorkspaces(rawConfig, options.commandPlan, options.context || {});
  const includeMorning = options.includeMorning !== false;
  const includeEvening = options.includeEvening !== false;
  const channel = options.channel || "";
  const to = options.to || "";
  const jobs = [];

  for (const workspace of workspaces) {
    const label = workspaceDisplayName(workspace);
    if (includeMorning) {
      const spec = {
        type: "morning",
        name: `PLUR1BUS Morning Review - ${label}`,
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
        cron: cfg.morningReview.cron,
        timezone: cfg.morningReview.timezone,
        session: cfg.morningReview.session,
        delivery: cfg.morningReview.delivery,
        channel,
        to,
        timeoutSeconds: 900,
        feature: "morning-review",
        message: "/plur1bus obsidian morning-review",
      };
      jobs.push({ ...spec, command: cronCommandFromSpec(spec) });
    }
    if (includeEvening) {
      const spec = {
        type: "evening_deep",
        name: `PLUR1BUS Evening Deep Review - ${label}`,
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
        cron: cfg.eveningReview.cron,
        timezone: cfg.eveningReview.timezone,
        session: cfg.eveningReview.session,
        delivery: cfg.eveningReview.delivery,
        channel,
        to,
        timeoutSeconds: 1200,
        feature: "evening-review",
        message: "/plur1bus obsidian evening-review",
      };
      jobs.push({ ...spec, command: cronCommandFromSpec(spec) });
    }
  }
  return { ok: true, workspaces: workspaces.length, jobs };
}
