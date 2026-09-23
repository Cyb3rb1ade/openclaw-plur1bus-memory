/**
 * adapter/openclaw/turn-principal.js — the OpenClaw side of PR-06.
 *
 * The hook-identity resolution (reply_dispatch ticket + six-step proof in
 * resolveHostHookMemoryContext) and the cron string matching that index.js
 * used to do both live here now; the engine receives their results as an
 * explicit memory context / AgentContext.
 */

import { resolveHostHookPrincipal, resolveMemoryRequestContext } from "../../lib/memory-request-context.js";
import { isBackgroundTurn, shouldSkipAutoRecallForInternalTurn } from "../../lib/runtime-scheduler.js";

/**
 * Was engine/recall/assemble-prompt-context.js:165-192.
 * @param {{host: object, hostRoutingLoader: () => Promise<object>, getMemoryTurnRoutes: () => Promise<object|null>, memoryWorkspaceAliases: object, memoryAccountTopology: object}} ctx
 * @returns {(event: object, hookCtx: object) => Promise<{memoryCtx: object, trust: "proved"|"inferred"}>}
 */
export function createTurnPrincipalResolver({ host, hostRoutingLoader, getMemoryTurnRoutes, memoryWorkspaceAliases, memoryAccountTopology }) {
  return async function resolveTurnPrincipal(event, hookCtx) {
    const routingCapability = await hostRoutingLoader();
    const turnRoutes = await getMemoryTurnRoutes();
    if (turnRoutes) {
      return resolveHostHookPrincipal({
        ...hookCtx,
        runId: hookCtx?.runId ?? event?.runId,
        sessionKey: hookCtx?.sessionKey ?? event?.sessionKey,
        sessionId: hookCtx?.sessionId ?? event?.sessionId,
      }, {
        getSessionEntry: ({ agentId, sessionKey, readConsistency }) => host.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency }),
        workspaceAliases: memoryWorkspaceAliases,
        accountTopology: memoryAccountTopology,
        turnRoutes,
        routingCapability,
        logger: host.logger,
      });
    }
    return {
      trust: "inferred",
      memoryCtx: resolveMemoryRequestContext({
        agentId: hookCtx?.agentId,
        workspaceDir: hookCtx?.workspaceDir,
        channel: hookCtx?.messageProvider,
        chatId: hookCtx?.chatId,
        sessionKey: hookCtx?.sessionKey ?? event?.sessionKey,
        sessionId: hookCtx?.sessionId ?? event?.sessionId,
      }, { workspaceAliases: memoryWorkspaceAliases }),
    };
  };
}

/** Was index.js:6930-6936 (isCronCommandContext). */
export function agentContextFromCommand(commandCtx) {
  const channel = String(commandCtx?.channel || "").toLowerCase();
  const origin = String(commandCtx?.origin || commandCtx?.source || commandCtx?.kind || "").toLowerCase();
  const sessionKey = String(commandCtx?.sessionKey || "").toLowerCase();
  const cron = channel === "cron"
    || origin === "cron"
    || /^agent:[^:]+:cron(?::|$)/.test(sessionKey);
  return cron ? { origin: "cron", background: true } : { origin: "user", background: false };
}

/** The recall/capture turn classification, as an AgentContext. */
export function agentContextFromHook(event, hookCtx) {
  const background = isBackgroundTurn(event, hookCtx);
  const internal = shouldSkipAutoRecallForInternalTurn(event, hookCtx);
  return { origin: internal ? (background ? "cron" : "system") : "user", background };
}
