/**
 * engine/identity/principal.js — PR-06 (spec 3.4).
 *
 * `Principal` is what a host proves about the speaker; the engine's memory
 * layers want the frozen request context lib/memory-request-context.js has
 * always produced. This is the constructor between them. "inferred" keeps
 * exactly the fallback the OpenClaw hook path has always used when its ticket
 * proof fails: the agent's own context, no user scope.
 */

import { listRouteProviders, registerRouteProvider, resolveMemoryRequestContext } from "../../lib/memory-request-context.js";

export const DEFAULT_CHANNELS = Object.freeze(["telegram", "discord", "slack", "mattermost"]);

/**
 * @param {object} principal Principal (types/engine.d.ts).
 * @param {{workspaceDir?: string, sessionKey?: string, sessionId?: string, workspaceAliases?: object}} [facts]
 * @returns {object} Frozen memory request context with `trust`.
 */
export function memoryContextFromPrincipal(principal, { workspaceDir, sessionKey, sessionId, workspaceAliases } = {}) {
  const options = workspaceAliases ? { workspaceAliases } : {};
  let base;
  try {
    base = resolveMemoryRequestContext({ agentId: principal?.agentId, workspaceDir, sessionKey, sessionId }, options);
  } catch (error) {
    if (principal?.trust === "proved") throw error;
    base = resolveMemoryRequestContext({ agentId: principal?.agentId }, options);
  }
  if (principal?.trust !== "proved") {
    return Object.freeze({ ...base, userPrincipal: "", trust: "inferred" });
  }
  const workspace = typeof principal.workspace === "string" && principal.workspace ? principal.workspace : base.workspaceIdentity;
  return Object.freeze({
    ...base,
    workspaceId: workspace,
    workspaceIdentity: workspace,
    userPrincipal: typeof principal.user === "string" ? principal.user : "",
    channel: String(principal.channel || ""),
    accountId: String(principal.accountId || ""),
    chatId: String(principal.chat?.id || ""),
    chatKind: principal.chat?.kind || base.chatKind,
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
