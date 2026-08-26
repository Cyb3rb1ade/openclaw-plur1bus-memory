import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { safeAgentId } from "../sql-safety.js";

export const FEATURE_CRON_GATEWAY_METHOD = "plur1bus.feature.run";
export const FEATURE_CRON_CLI_COMMAND = "plur1bus-feature-cron";

const FEATURE_CRON_TIMEOUT_MS = 540_000;
const FEATURE_CRON_NAMES = new Set([
  "persona-evolve",
  "afterthought",
  "consolidate-daily",
  "classify-recent",
  "rem-dream",
  "skill-miner",
  "discover-semantic-links",
  "gc-run",
]);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Validate the complete untrusted Gateway request for one feature cron. */
export function validateFeatureCronRequest(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("invalid PLUR1BUS feature cron request");
  }
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== "agentId" || keys[1] !== "feature") {
    throw new Error("invalid PLUR1BUS feature cron request fields");
  }
  const agentId = safeAgentId(params.agentId);
  if (typeof params.feature !== "string" || !FEATURE_CRON_NAMES.has(params.feature)) {
    throw new Error("unknown PLUR1BUS feature cron");
  }
  return { agentId, feature: params.feature };
}

/** Parse the exact package-runner argument shape without accepting carrier commands. */
export function parseFeatureCronRunnerArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) {
    throw new Error("invalid PLUR1BUS feature cron runner arguments");
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag === "--agent" ? "agentId" : flag === "--feature" ? "feature" : null;
    if (!key || Object.hasOwn(values, key) || typeof value !== "string" || value.length === 0) {
      throw new Error("invalid PLUR1BUS feature cron runner arguments");
    }
    values[key] = value;
  }
  if (!Object.hasOwn(values, "agentId") || !Object.hasOwn(values, "feature")) {
    throw new Error("invalid PLUR1BUS feature cron runner arguments");
  }
  return validateFeatureCronRequest(values);
}

/** Validate the command handler result before it crosses the cron stdout boundary. */
export function validateFeatureCronReplyPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string") {
    throw new Error("PLUR1BUS feature cron handler returned an invalid ReplyPayload");
  }
  return value;
}

/** Create the public Gateway RPC handler used by model-free feature crons. */
export function createFeatureCronGatewayHandler({ runFeatureCommand, config, logger } = {}) {
  if (typeof runFeatureCommand !== "function") {
    throw new Error("runFeatureCommand is required");
  }
  return async ({ params, respond }) => {
    try {
      const { agentId, feature } = validateFeatureCronRequest(params);
      const reply = validateFeatureCronReplyPayload(await runFeatureCommand({
        args: `internal ${feature}`,
        agentId,
        channel: "cron",
        origin: "cron",
        source: "cron",
        sessionKey: `agent:${agentId}:cron:plur1bus-${feature}`,
        config,
      }));
      respond(true, { reply });
    } catch (error) {
      const message = errorMessage(error);
      logger?.warn?.(`memory-lancedb-namespaced: feature cron RPC failed: ${message}`);
      respond(false, undefined, {
        code: "plur1bus_feature_cron_error",
        message,
      });
    }
  };
}

function manifestFromEntry(entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return null;
  let current;
  try {
    current = dirname(realpathSync(entryPath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest?.name === "openclaw") return manifestPath;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findOpenClawPackageManifest(entryPath = process.argv[1]) {
  const entryManifest = manifestFromEntry(entryPath);
  if (entryManifest) return entryManifest;
  throw new Error(
    "could not resolve the active OpenClaw package from its process entrypoint; "
      + "the public openclaw/plugin-sdk/gateway-runtime capability is unavailable",
  );
}

/** Load OpenClaw's public Gateway CLI SDK from the active host package. */
export async function loadOpenClawGatewayRuntime(options = {}) {
  const manifestPath = options.packageManifestPath
    ? realpathSync(options.packageManifestPath)
    : findOpenClawPackageManifest(options.entryPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.name !== "openclaw") {
    throw new Error("resolved package does not provide the OpenClaw Gateway runtime capability");
  }
  const hostRequire = createRequire(manifestPath);
  const gatewayRuntimePath = hostRequire.resolve("openclaw/plugin-sdk/gateway-runtime");
  return import(pathToFileURL(gatewayRuntimePath).href);
}

/** Execute one feature cron through the plugin Gateway RPC and print only ReplyPayload.text. */
export async function executeFeatureCronCli({
  agentId,
  feature,
  callGateway,
  write = (chunk) => process.stdout.write(chunk),
}) {
  const request = validateFeatureCronRequest({ agentId, feature });
  if (typeof callGateway !== "function") throw new Error("Gateway RPC capability unavailable");
  const response = await callGateway(
    FEATURE_CRON_GATEWAY_METHOD,
    { timeout: String(FEATURE_CRON_TIMEOUT_MS), json: true },
    request,
    { progress: false, scopes: ["operator.write"] },
  );
  const reply = validateFeatureCronReplyPayload(response?.reply);
  write(`${reply.text}\n`);
  return reply;
}

/** Register the Beta-era public RPC and CLI surfaces for model-free feature crons. */
export function registerFeatureCronNativeDispatch({
  api,
  runFeatureCommand,
  loadGatewayRuntime = loadOpenClawGatewayRuntime,
  write,
}) {
  if (typeof api?.registerGatewayMethod !== "function") {
    throw new Error("OpenClaw registerGatewayMethod capability unavailable");
  }
  if (typeof api?.registerCli !== "function") {
    throw new Error("OpenClaw registerCli capability unavailable");
  }

  api.registerGatewayMethod(
    FEATURE_CRON_GATEWAY_METHOD,
    createFeatureCronGatewayHandler({
      runFeatureCommand,
      config: api.config,
      logger: api.logger,
    }),
    { scope: "operator.write" },
  );
  api.registerCli(
    ({ program }) => {
      program
        .command(FEATURE_CRON_CLI_COMMAND)
        .description("Run one PLUR1BUS feature cron without an agent/model turn")
        .requiredOption("--agent <id>", "PLUR1BUS agent id")
        .requiredOption("--feature <name>", "PLUR1BUS feature cron name")
        .action(async (options) => {
          const gatewayRuntime = await loadGatewayRuntime();
          await executeFeatureCronCli({
            agentId: options.agent,
            feature: options.feature,
            callGateway: gatewayRuntime.callGatewayFromCli,
            ...(write ? { write } : {}),
          });
        });
    },
    {
      descriptors: [{
        name: FEATURE_CRON_CLI_COMMAND,
        description: "Run one PLUR1BUS feature cron without an agent/model turn",
        hasSubcommands: false,
        machineOutput: () => true,
      }],
    },
  );
}
