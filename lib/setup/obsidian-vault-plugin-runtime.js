/**
 * Obsidian vault setup surface.
 *
 * The confirmation flow in lib/obsidian-vault-confirmation-flow.js has always
 * been able to bind a vault to an owner, but nothing reachable by a user ever
 * called it: every install kept the bridge enabled and permanently pending.
 * This module is the missing surface — detect what is there, adopt an existing
 * vault or create a new one, then redeem the one-time confirmation.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  confirmVaultConfirmation,
  prepareVaultConfirmation,
} from "../obsidian-vault-confirmation-flow.js";
import { detectObsidianVaults } from "./feature-profiles.js";
import { loadOpenClawGatewayRuntime } from "./feature-cron-plugin-runtime.js";

export const OBSIDIAN_VAULT_GATEWAY_METHODS = Object.freeze({
  detect: "plur1bus.obsidian.detect",
  prepare: "plur1bus.obsidian.prepare",
  confirm: "plur1bus.obsidian.confirm",
});
export const OBSIDIAN_VAULT_CLI_COMMAND = "plur1bus-obsidian";

const VAULT_MARKERS = Object.freeze(["workspace.json", "app.json"]);

/** Reject anything that is not a plain absolute path we may create or adopt. */
export function normalizeVaultPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("vault path is required");
  }
  const candidate = resolve(value.trim());
  if (!isAbsolute(candidate)) throw new Error("vault path must be absolute");
  if (candidate === "/" || candidate.split("/").filter(Boolean).length < 2) {
    throw new Error("refusing to treat a filesystem root as a vault");
  }
  return candidate;
}

/** True when the directory carries an Obsidian marker file. */
export function isObsidianVault(vaultPath) {
  const obsidianDir = join(vaultPath, ".obsidian");
  return VAULT_MARKERS.some((marker) => existsSync(join(obsidianDir, marker)));
}

/**
 * What the operator can choose from: whether Obsidian left any vault behind,
 * and where those vaults are.
 */
export function describeVaultCandidates(obsidianBridgeCfg = {}) {
  const { detected, vaultPaths } = detectObsidianVaults(obsidianBridgeCfg);
  return {
    obsidianDetected: detected,
    vaultPaths: [...vaultPaths],
    // Without a vault the operator has to pick a path; with one they still
    // decide between adopting it and creating a separate one.
    nextAction: detected ? "choose_existing_or_create" : "create",
  };
}

/** Adopt a directory that already is a vault. */
export function adoptExistingVault(rawPath) {
  const vaultPath = normalizeVaultPath(rawPath);
  if (!existsSync(vaultPath)) throw new Error(`vault path does not exist: ${vaultPath}`);
  if (!statSync(vaultPath).isDirectory()) throw new Error(`vault path is not a directory: ${vaultPath}`);
  if (!isObsidianVault(vaultPath)) {
    throw new Error(`no Obsidian vault at ${vaultPath}: neither .obsidian/workspace.json nor .obsidian/app.json`);
  }
  return { vaultPath, created: false };
}

/**
 * Create a vault Obsidian will recognise. An existing vault is adopted rather
 * than overwritten, so running this twice is safe.
 */
export function createVault(rawPath) {
  const vaultPath = normalizeVaultPath(rawPath);
  if (existsSync(vaultPath) && isObsidianVault(vaultPath)) {
    return { vaultPath, created: false };
  }
  if (existsSync(vaultPath) && !statSync(vaultPath).isDirectory()) {
    throw new Error(`vault path is not a directory: ${vaultPath}`);
  }
  const obsidianDir = join(vaultPath, ".obsidian");
  mkdirSync(obsidianDir, { recursive: true, mode: 0o700 });
  const appConfig = join(obsidianDir, "app.json");
  if (!existsSync(appConfig)) {
    writeFileSync(appConfig, `${JSON.stringify({ attachmentFolderPath: "attachments" }, null, 2)}\n`, { mode: 0o600 });
  }
  return { vaultPath, created: true };
}

/**
 * Gateway handlers. `prepare` never writes a receipt; only `confirm` does, and
 * only against the exact one-time callback it was handed.
 */
export function createObsidianVaultHandlers({
  baseDbPath,
  confirmationStore,
  resolveSessionMemoryContext,
  getObsidianBridgeConfig = () => ({}),
} = {}) {
  if (typeof baseDbPath !== "string" || !baseDbPath) throw new Error("baseDbPath is required");
  if (!(confirmationStore instanceof Map)) throw new TypeError("confirmationStore must be a Map");
  if (typeof resolveSessionMemoryContext !== "function") {
    throw new TypeError("resolveSessionMemoryContext must be a function");
  }

  // The host hands a gateway method one context object ({ params, respond, … }),
  // not the params themselves, and the CLI names the session key `session`.
  // Both shapes are accepted here; the agent id falls back to the key's
  // `agent:<id>:` prefix so the resolver never sees an empty id.
  const paramsOf = (input) => {
    const raw = input && typeof input === "object" && input.params && typeof input.params === "object"
      ? input.params
      : (input && typeof input === "object" ? input : {});
    const sessionKey = typeof raw.sessionKey === "string" && raw.sessionKey
      ? raw.sessionKey
      : (typeof raw.session === "string" ? raw.session : undefined);
    const fromKey = typeof sessionKey === "string" ? /^agent:([^:]+):/.exec(sessionKey)?.[1] : undefined;
    const agentId = typeof raw.agentId === "string" && raw.agentId ? raw.agentId : fromKey;
    return { ...raw, sessionKey, agentId };
  };

  return {
    detect: async () => describeVaultCandidates(getObsidianBridgeConfig()),

    prepare: async (input = {}) => {
      const params = paramsOf(input);
      const memoryCtx = await resolveSessionMemoryContext(params);
      const { vaultPath, created } = params.create === true
        ? createVault(params.vaultPath)
        : adoptExistingVault(params.vaultPath);
      const prepared = prepareVaultConfirmation({
        baseDbPath,
        memoryCtx,
        vaultPath,
        confirmationStore,
      });
      if (prepared.ok !== true) return { ok: false, reason: prepared.reason, vaultPath, created };
      return {
        ok: true,
        vaultPath,
        created,
        callbackData: prepared.callbackData,
        expiresAt: prepared.expiresAt,
      };
    },

    confirm: async (input = {}) => {
      const params = paramsOf(input);
      const memoryCtx = await resolveSessionMemoryContext(params);
      const vaultPath = normalizeVaultPath(params.vaultPath);
      return confirmVaultConfirmation({
        callbackData: params.callbackData,
        confirmationStore,
        baseDbPath,
        memoryCtx,
        vaultPath,
      });
    },
  };
}

/** Register the gateway methods and the operator CLI. */
export function registerObsidianVaultRuntime({
  api,
  baseDbPath,
  confirmationStore,
  resolveSessionMemoryContext,
  getObsidianBridgeConfig,
  loadGatewayRuntime = loadOpenClawGatewayRuntime,
} = {}) {
  if (typeof api?.registerGatewayMethod !== "function") {
    throw new Error("OpenClaw registerGatewayMethod capability unavailable for the Obsidian vault surface");
  }
  if (typeof api?.registerCli !== "function") {
    throw new Error("OpenClaw registerCli capability unavailable for the Obsidian vault surface");
  }
  const handlers = createObsidianVaultHandlers({
    baseDbPath,
    confirmationStore,
    resolveSessionMemoryContext,
    getObsidianBridgeConfig,
  });

  api.registerGatewayMethod(OBSIDIAN_VAULT_GATEWAY_METHODS.detect, handlers.detect, { scope: "operator.read" });
  api.registerGatewayMethod(OBSIDIAN_VAULT_GATEWAY_METHODS.prepare, handlers.prepare, { scope: "operator.write" });
  api.registerGatewayMethod(OBSIDIAN_VAULT_GATEWAY_METHODS.confirm, handlers.confirm, { scope: "operator.write" });

  api.registerCli(
    ({ program }) => {
      program
        .command(OBSIDIAN_VAULT_CLI_COMMAND)
        .description("Detect, adopt, or create the Obsidian vault PLUR1BUS mirrors into")
        .argument("<operation>", "detect, use, create, or confirm")
        .requiredOption("--session <key>", "OpenClaw session key")
        .option("--path <vaultPath>", "absolute vault path for use, create, and confirm")
        .option("--token <callbackData>", "one-time confirmation handed out by use or create")
        .action(async (operation, options) => {
          const gatewayRuntime = await loadGatewayRuntime();
          const call = (method, params) => gatewayRuntime.callGatewayFromCli(method, params);
          const session = options.session;
          if (operation === "detect") {
            return call(OBSIDIAN_VAULT_GATEWAY_METHODS.detect, { session });
          }
          if (operation === "use" || operation === "create") {
            return call(OBSIDIAN_VAULT_GATEWAY_METHODS.prepare, {
              session,
              vaultPath: options.path,
              create: operation === "create",
            });
          }
          if (operation === "confirm") {
            return call(OBSIDIAN_VAULT_GATEWAY_METHODS.confirm, {
              session,
              vaultPath: options.path,
              callbackData: options.token,
            });
          }
          throw new Error(`unknown operation: ${String(operation)}`);
        });
    },
    {
      descriptors: [{
        name: OBSIDIAN_VAULT_CLI_COMMAND,
        description: "Detect, adopt, or create the Obsidian vault PLUR1BUS mirrors into",
        hasSubcommands: false,
        machineOutput: () => true,
      }],
    },
  );
  return handlers;
}
