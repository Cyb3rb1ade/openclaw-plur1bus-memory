/**
 * engine/identity/principal.js — PR-06 (spec 3.4).
 *
 * `Principal` is what a host proves about the speaker; the engine's memory
 * layers want the frozen request context lib/memory-request-context.js has
 * always produced. This is the constructor between them. "inferred" keeps
 * exactly the fallback the OpenClaw hook path has always used when its ticket
 * proof fails: the agent's own context, no user scope.
 */

import { listRouteProviders, normalizeChatKind, registerRouteProvider, resolveMemoryRequestContext } from "../../lib/memory-request-context.js";
import { safeDebug } from "../../lib/safe-logging.js";

export const DEFAULT_CHANNELS = Object.freeze(["telegram", "discord", "slack", "mattermost"]);

// A user principal is always this module's own stable hash shape
// (stableIdentityHash's sha256 hex digest, lib/memory-request-context.js);
// nothing else is a proof of anything, and trusting it verbatim would let a
// forged Principal name any pool it likes.
const USER_PRINCIPAL_FORMAT = /^user:v1:[0-9a-f]{64}$/;

/**
 * @param {object} principal Principal (types/engine.d.ts).
 * @param {{workspaceDir?: string, sessionKey?: string, sessionId?: string, workspaceAliases?: object, logger?: object}} [facts]
 * @returns {object} Frozen memory request context with `trust`.
 */
export function memoryContextFromPrincipal(principal, { workspaceDir, sessionKey, sessionId, workspaceAliases, logger = null } = {}) {
  const options = workspaceAliases ? { workspaceAliases } : {};
  let base;
  try {
    base = resolveMemoryRequestContext({ agentId: principal?.agentId, workspaceDir, sessionKey, sessionId }, options);
  } catch (error) {
    if (principal?.trust === "proved") throw error;
    base = resolveMemoryRequestContext({ agentId: principal?.agentId }, options);
  }
  const inferred = () => Object.freeze({ ...base, userPrincipal: "", trust: "inferred" });
  if (principal?.trust !== "proved") return inferred();

  // Fix round 1 (security review): a "proved" Principal still comes from a
  // caller, not from resolveHostHookPrincipal's own ticket proof, so every
  // field it claims gets the same defence-in-depth the lib applies to a
  // caller-supplied commandCtx — an invalid claim degrades the whole context
  // to "inferred" (agent-private) rather than trusting the bad field.
  const rawUser = typeof principal.user === "string" ? principal.user : "";
  if (rawUser && !USER_PRINCIPAL_FORMAT.test(rawUser)) {
    safeDebug(logger, "principal.invalid-user", new Error("proved principal's user does not match the stable-hash format"));
    return inferred();
  }
  const rawChannel = typeof principal.channel === "string" ? principal.channel.toLowerCase() : "";
  if (rawChannel && !listRouteProviders().includes(rawChannel)) {
    safeDebug(logger, "principal.unknown-channel", new Error("proved principal named a channel outside the registered vocabulary"));
    return inferred();
  }

  // The claimed workspace is resolved through the same canonical resolver
  // resolveMemoryRequestContext itself uses (aliases apply, and naming a
  // workspace that disagrees with the host's own workspaceDir throws
  // "conflicting workspace identity" exactly as it would for a directly
  // supplied commandCtx) — a proved principal cannot simply overwrite
  // workspaceIdentity with an unverified claim.
  const workspaceScoped = typeof principal.workspace === "string" && principal.workspace
    ? resolveMemoryRequestContext({ agentId: principal.agentId, workspaceId: principal.workspace, workspaceDir, sessionKey, sessionId }, options)
    : base;

  return Object.freeze({
    ...base,
    workspaceId: workspaceScoped.workspaceIdentity,
    workspaceIdentity: workspaceScoped.workspaceIdentity,
    userPrincipal: rawUser,
    channel: rawChannel,
    accountId: String(principal.accountId || ""),
    chatId: String(principal.chat?.id || ""),
    chatKind: normalizeChatKind(principal.chat?.kind),
    trust: "proved",
  });
}

/**
 * @param {object} memoryCtx Frozen memory request context.
 * @param {"proved"|"inferred"} trust
 * @returns {object} Principal.
 */
export function principalFromMemoryContext(memoryCtx, trust) {
  return Object.freeze({
    agentId: memoryCtx.agentId,
    workspace: memoryCtx.workspaceIdentity || "",
    ...(memoryCtx.userPrincipal ? { user: memoryCtx.userPrincipal } : {}),
    channel: memoryCtx.channel || "",
    accountId: memoryCtx.accountId || "",
    chat: Object.freeze({ id: memoryCtx.chatId || "", kind: memoryCtx.chatKind || "direct" }),
    trust: trust === "proved" ? "proved" : "inferred",
  });
}

/** @returns {{register: (name: string) => string, has: (name: string) => boolean, list: () => string[]}} */
export function createChannelRegistry() {
  return Object.freeze({
    register: (name) => registerRouteProvider(name),
    has: (name) => listRouteProviders().includes(String(name || "").toLowerCase()),
    list: () => listRouteProviders(),
  });
}
