import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { runtimeIfUsable } from "../runtime-shutdown.js";
import { safeAgentId } from "../sql-safety.js";

export const FEATURE_CRON_GATEWAY_METHOD = "plur1bus.feature.run";
export const FEATURE_CRON_CLI_COMMAND = "plur1bus-feature-cron";
// Operator-Pfad fuer Chat-Kommandos: Die 26 Kommandos waren nur ueber einen
// angebundenen Kanal erreichbar (ein Cron mit --message geht ans Modell,
// `openclaw message` sendet nur als Bot). Am 09.09.2026 musste ein Mensch
// jeden Befehl per Telegram tippen, um ihn zu pruefen. Dieser RPC fuehrt ein
// ganzes Kommando im Gateway aus, gebunden an eine benannte Direktsitzung.
export const PLUGIN_COMMAND_GATEWAY_METHOD = "plur1bus.command.run";
export const PLUGIN_COMMAND_CLI_COMMAND = "plur1bus-command";
const PLUGIN_COMMAND_MAX_CHARS = 100_000;

const FEATURE_CRON_TIMEOUT_MS = 540_000;
const FEATURE_CRON_NAMES = new Set([
  "persona-evolve",
  // Model-frei wie die uebrigen: der Job liest unbestaetigte Critical-Karten
  // und markiert sie, ohne ein LLM anzufassen. Fehlte er hier, blieb als
  // einzige Cron-Form der agentTurn — und der schickte "/plur1bus internal
  // auto-accept-stale" an das Modell statt in den nativen Dispatch, was
  // zuverlaessig in den 300s-Timeout lief (neun Laeufe in Folge, alle Agenten).
  "auto-accept-stale",
  // Wartungslauf, ebenfalls model-frei: arbeitet die Neo-Embedding-Warteschlange
  // ab, die der Nebenjob nach der Erfassung nie aufholt. Ohne diesen Griff gab
  // es keine Moeglichkeit, einen Rueckstand gezielt abzubauen.
  "embedding-drain",
  "emotion-refine",
  // Diese vier hatten weder Cron noch Kommandozeilenzugang: erreichbar waren
  // sie nur ueber ein Chat-Kommando, und das gibt es nur mit angebundenem
  // Kanal. Damit liessen sie sich weder betreiben noch pruefen. Alle vier
  // brauchen `workspaceDir`, das dieser Pfad seit 7.12.9 aufloest.
  "reminder-dispatch",
  "feedback-report",
  "proactive-check",
  "meta-reflect",
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
export function createFeatureCronGatewayHandler({ runFeatureCommand, config, logger, resolveWorkspaceDir } = {}) {
  if (typeof runFeatureCommand !== "function") {
    throw new Error("runFeatureCommand is required");
  }
  return async ({ params, respond }) => {
    try {
      const { agentId, feature } = validateFeatureCronRequest(params);
      // Ohne workspaceDir uebersprang sich afterthought bei jedem Lauf still
      // ("missing_workspace", der Cron meldete trotzdem ok) und persona-evolve
      // warf "The path argument must be of type string. Received undefined".
      // Der Chat-Pfad liefert das Verzeichnis aus dem Kommandokontext; dieser
      // RPC-Pfad hat nur die agentId und muss es selbst aufloesen.
      let workspaceDir;
      if (typeof resolveWorkspaceDir === "function") {
        try {
          const resolved = await resolveWorkspaceDir(config, agentId);
          if (typeof resolved === "string" && resolved) workspaceDir = resolved;
        } catch (error) {
          logger?.warn?.(`memory-lancedb-namespaced: feature cron workspace unresolved for agent=${agentId}: ${errorMessage(error)}`);
        }
      }
      if (!workspaceDir) {
        logger?.warn?.(`memory-lancedb-namespaced: feature cron ${feature} runs without a workspace dir for agent=${agentId}; workspace-bound features will skip`);
      }
      const reply = validateFeatureCronReplyPayload(await runFeatureCommand({
        args: `internal ${feature}`,
        agentId,
        channel: "cron",
        origin: "cron",
        source: "cron",
        sessionKey: `agent:${agentId}:cron:plur1bus-${feature}`,
        config,
        ...(workspaceDir ? { workspaceDir } : {}),
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

function manifestFromPath(pathValue) {
  if (typeof pathValue !== "string" || pathValue.length === 0) return null;
  const executableNames = process.platform === "win32"
    ? ["openclaw.cmd", "openclaw.exe", "openclaw"]
    : ["openclaw"];
  for (const directory of pathValue.split(delimiter)) {
    // An empty PATH element means cwd. Do not search it for a privileged cron
    // runner: the active host CLI must live in an explicit PATH directory.
    if (!directory) continue;
    for (const executableName of executableNames) {
      const executablePath = join(directory, executableName);
      try {
        accessSync(executablePath, constants.X_OK);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EACCES") continue;
        throw error;
      }
      const manifestPath = manifestFromEntry(executablePath);
      if (manifestPath) return manifestPath;
    }
  }
  return null;
}

function findOpenClawPackageManifest({
  entryPath = process.argv[1],
  pathValue = process.env.PATH,
} = {}) {
  const entryManifest = manifestFromEntry(entryPath);
  if (entryManifest) return entryManifest;
  const pathManifest = manifestFromPath(pathValue);
  if (pathManifest) return pathManifest;
  throw new Error(
    "could not resolve the active OpenClaw package from its process entrypoint or executable PATH; "
      + "the public openclaw/plugin-sdk/gateway-runtime capability is unavailable",
  );
}

/**
 * Load OpenClaw's public Gateway CLI SDK from the active host package.
 *
 * @param {{packageManifestPath?: string, entryPath?: string, pathValue?: string}} [options]
 * @returns {Promise<object>}
 */
export async function loadOpenClawGatewayRuntime(options = {}) {
  return loadOpenClawPluginSdkRuntime("gateway-runtime", options);
}

/** Load one allowlisted public Plugin SDK subpath from the active OpenClaw host package. */
export async function loadOpenClawPluginSdkRuntime(subpath, options = {}) {
  // memory-host-events: the host's public event log, used by the dream diary
  // bridge to report a completed dream the way memory-core does.
  if (!new Set(["gateway-runtime", "secret-input-runtime", "memory-host-events"]).has(subpath)) {
    throw new Error("unsupported OpenClaw Plugin SDK runtime capability");
  }
  const manifestPath = options.packageManifestPath
    ? realpathSync(options.packageManifestPath)
    : findOpenClawPackageManifest(options);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.name !== "openclaw") {
    throw new Error("resolved package does not provide the requested OpenClaw Plugin SDK capability");
  }
  const hostRequire = createRequire(manifestPath);
  const runtimePath = hostRequire.resolve(`openclaw/plugin-sdk/${subpath}`);
  return import(pathToFileURL(runtimePath).href);
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

/** Validate the complete untrusted Gateway request for one operator-run chat command. */
export function validatePluginCommandRequest(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("invalid PLUR1BUS command request");
  }
  const keys = Object.keys(params).sort();
  if (keys.length !== 3 || keys[0] !== "agentId" || keys[1] !== "command" || keys[2] !== "sessionKey") {
    throw new Error("invalid PLUR1BUS command request fields");
  }
  const agentId = safeAgentId(params.agentId);
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (!sessionKey || sessionKey.length > 512) throw new Error("invalid PLUR1BUS command session");
  const command = typeof params.command === "string" ? params.command.trim() : "";
  if (!command.startsWith("/") || command.length > PLUGIN_COMMAND_MAX_CHARS) {
    throw new Error("invalid PLUR1BUS command");
  }
  return { agentId, sessionKey, command };
}

function createPluginCommandGatewayHandler({ runOperatorCommand, logger } = {}) {
  if (typeof runOperatorCommand !== "function") throw new Error("runOperatorCommand is required");
  return async ({ params, respond }) => {
    try {
      const request = validatePluginCommandRequest(params);
      const reply = validateFeatureCronReplyPayload(await runOperatorCommand(request));
      respond(true, { reply });
    } catch (error) {
      const message = errorMessage(error);
      logger?.warn?.(`memory-lancedb-namespaced: operator command RPC failed: ${message}`);
      respond(false, undefined, { code: "plur1bus_command_error", message });
    }
  };
}

/** Execute one chat command as operator through the plugin Gateway RPC and print only ReplyPayload.text. */
export async function executePluginCommandCli({
  agentId,
  sessionKey,
  command,
  callGateway,
  write = (chunk) => process.stdout.write(chunk),
}) {
  const request = validatePluginCommandRequest({ agentId, sessionKey, command });
  if (typeof callGateway !== "function") throw new Error("Gateway RPC capability unavailable");
  const response = await callGateway(
    PLUGIN_COMMAND_GATEWAY_METHOD,
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
  runOperatorCommand = null,
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
      resolveWorkspaceDir: (cfg, agentId) => runtimeIfUsable(api)?.agent?.resolveAgentWorkspaceDir?.(cfg, agentId),
    }),
    { scope: "operator.write" },
  );
  if (typeof runOperatorCommand === "function") {
    api.registerGatewayMethod(
      PLUGIN_COMMAND_GATEWAY_METHOD,
      createPluginCommandGatewayHandler({ runOperatorCommand, logger: api.logger }),
      { scope: "operator.write" },
    );
    api.registerCli(
      ({ program }) => {
        program
          .command(PLUGIN_COMMAND_CLI_COMMAND)
          .description("Run one PLUR1BUS chat command as operator, bound to a direct chat session")
          .requiredOption("--agent <id>", "PLUR1BUS agent id")
          .requiredOption("--session <key>", "direct chat session key (agent:<id>:<channel>:<account>:direct:<peer>)")
          .argument("<command...>", "the command line, e.g. /memory diese Woche")
          .action(async (commandParts, options) => {
            const gatewayRuntime = await loadGatewayRuntime();
            await executePluginCommandCli({
              agentId: options.agent,
              sessionKey: options.session,
              command: commandParts.join(" "),
              callGateway: gatewayRuntime.callGatewayFromCli,
              ...(write ? { write } : {}),
            });
          });
      },
      {
        descriptors: [{
          name: PLUGIN_COMMAND_CLI_COMMAND,
          description: "Run one PLUR1BUS chat command as operator, bound to a direct chat session",
          hasSubcommands: false,
          machineOutput: () => true,
        }],
      },
    );
  }
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
