/**
 * engine/capture/post-turn-work.js — Light-Traum and episode extraction
 * shared by capture (inline or queued) and the post-turn-refine job.
 *
 * Hosts that revoke caller identity after the turn refuse plugin LLM calls
 * made from capture. Those hosts set runtime.deferPostTurnLlm and declare
 * host.capabilities.postTurnRefineScheduled so capture can enqueue the work
 * for the post-turn-refine job. The engine default is inline
 * (deferPostTurnLlm=false).
 */

/** Fixed log reason when defer is on but the host has not scheduled the drain. */
export const POST_TURN_REFINE_UNSCHEDULED_REASON = "post-turn-refine-unscheduled";

/**
 * Whether capture should enqueue light-dream and episode work.
 * Requires a true configured default or call-local override, and a host that
 * has scheduled `post-turn-refine`. Otherwise the inline path runs.
 *
 * @param {object} [cfg]
 * @param {object} [host]
 * @param {boolean} [override] Call-local choice; omitted keeps the configured default.
 * @returns {boolean}
 */
export function shouldDeferPostTurnLlm(cfg, host, override) {
  if ((typeof override === "boolean" ? override : cfg?.runtime?.deferPostTurnLlm) !== true) return false;
  if (host?.capabilities?.postTurnRefineScheduled === true) return true;
  const source = typeof override === "boolean" ? "capture option deferPostTurnLlm" : "runtime.deferPostTurnLlm";
  host?.logger?.warn?.(
    `memory-lancedb-namespaced: ${source}=true but post-turn-refine is not scheduled; running light dream and episodes inline (reason=${POST_TURN_REFINE_UNSCHEDULED_REASON})`,
  );
  return false;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { throwIfAborted } from "../../lib/abort.js";
import { lightDream, writeLightDreamToVault } from "../../lib/dreaming/light-dream.js";
import { recordLightDreamRun } from "../../lib/dreaming/dreaming-status-provider.js";
import { filterAlreadyEpisoded, mergeEpisodedTurnIds } from "../../lib/episode-watermark.js";
import { extractEpisodesWithState, writeEpisodeToVault } from "../../lib/episodes.js";
import { withLlmCallContext } from "../../lib/llm-result-cache.js";
import { resolveMemoryRequestContext } from "../../lib/memory-request-context.js";
import { EPISODED_TURN_ID_MEMORY } from "../runtime/constants.js";

/**
 * The hook-context fields the two post-turn runs read. Stored on the queue
 * entry so the cron can reconstruct the work without the original event.
 *
 * @param {object} [ctx]
 * @returns {object}
 */
export function postTurnContext(ctx = {}) {
  const pick = (value) => (typeof value === "string" || typeof value === "number" ? value : undefined);
  return {
    workspaceDir: pick(ctx?.workspaceDir),
    workspaceKey: pick(ctx?.workspaceKey),
    sessionKey: pick(ctx?.sessionKey),
    userId: pick(ctx?.userId),
    senderId: pick(ctx?.senderId),
    channel: pick(ctx?.channel),
    messageProvider: pick(ctx?.messageProvider),
    accountId: pick(ctx?.accountId ?? ctx?.channelContext?.accountId),
    chatId: pick(ctx?.chatId),
  };
}

/**
 * @param {object} deps engine capture/job context
 * @returns {{runLightDreamPostTurn: Function, runEpisodePostTurn: Function}}
 */
export function createPostTurnWorkers(deps) {
  const {
    embeddings,
    conversationInsightsLlmCfg,
    dreamNarrativeLlmCfg,
    dreamEchoLlmCfg,
    personaVoiceLlmCfg,
    skillMinerEnabled,
    mergingEnabled,
    callLlm,
    logger,
    dreamNarrativeCfg,
    resolveTemperamentName,
    cfg,
    memoryWorkspaceAliases,
    baseDbPath,
    emotionalPool,
    episodeExtractionLlmCfg,
  } = deps;

  const runLightDreamPostTurn = ({ agentId, ctx, neoStore, db, normalizedTurns, digestHash, processedDreams = [], signal = null }) => {
    let personaIdentityText = "";
    if (ctx?.workspaceDir) {
      for (const identityFile of ["SOUL.md", "IDENTITY.md", "AGENT.md"]) {
        try {
          personaIdentityText = readFileSync(join(ctx.workspaceDir, identityFile), "utf8").slice(0, 2000);
          break;
        } catch (_) { /* try next */ }
      }
    }
    let lightRequestContext = null;
    try {
      lightRequestContext = resolveMemoryRequestContext({
        agentId,
        workspaceDir: ctx?.workspaceDir,
        workspaceKey: ctx?.workspaceKey,
        userId: ctx?.userId ?? ctx?.senderId,
        channel: ctx?.channel ?? ctx?.messageProvider,
        accountId: ctx?.accountId ?? ctx?.channelContext?.accountId,
        chatId: ctx?.chatId,
      }, { workspaceAliases: memoryWorkspaceAliases });
    } catch (_) {
      lightRequestContext = null;
    }
    const lightAclBindings = lightRequestContext
      ? (lightRequestContext.userPrincipal
        ? { scope: "user", agentId: lightRequestContext.agentId, workspaceIdentity: "", ownerUserId: lightRequestContext.userPrincipal }
        : { scope: "workspace", agentId: lightRequestContext.agentId, workspaceIdentity: lightRequestContext.workspaceIdentity, ownerUserId: "" })
      : null;
    return lightDream({
      turns: normalizedTurns,
      neoStore,
      db,
      embeddings,
      insightLlmCfg: withLlmCallContext(
        conversationInsightsLlmCfg,
        agentId,
        "conversation-insights",
        { signal },
      ),
      narrativeLlmCfg: withLlmCallContext(
        dreamNarrativeLlmCfg,
        agentId,
        "dream-narrative",
        { signal },
      ),
      echoLlmCfg: withLlmCallContext(
        dreamEchoLlmCfg,
        agentId,
        "dream-echo",
        { signal },
      ),
      personaLlmCfg: (skillMinerEnabled || mergingEnabled) ? withLlmCallContext(
        personaVoiceLlmCfg,
        agentId,
        "persona-voice",
        { signal },
      ) : null,
      callLlm,
      logger,
      narrativeCfg: dreamNarrativeCfg,
      workspaceDir: ctx?.workspaceDir || null,
      temperamentName: resolveTemperamentName(agentId),
      personaSeedCfg: (cfg.personaVoice?.enabled ?? true) !== false
        ? { agentId, lang: cfg.language || "de", identityText: personaIdentityText }
        : null,
      requestContext: lightRequestContext,
      aclBindings: lightAclBindings,
      signal,
    }).then((dreamResult) => {
      throwIfAborted(signal, "light dream commit aborted");
      if (ctx?.workspaceDir) {
        throwIfAborted(signal, "light dream commit aborted");
        writeLightDreamToVault(dreamResult, ctx.workspaceDir, normalizedTurns);
      }
      const mergedDreams = [...processedDreams.slice(-100), digestHash];
      throwIfAborted(signal, "light dream commit aborted");
      neoStore.recordHook("agent_end", { processedDreams: mergedDreams });
      recordLightDreamRun({ baseDbPath, agentId }).catch((runErr) => {
        logger.debug?.(`memory-lancedb-namespaced: light dream run not recorded: ${String(runErr)}`);
      });
      return true;
    }).catch((dreamErr) => {
      logger.warn?.(`memory-lancedb-namespaced: light dream failed: ${String(dreamErr)}`);
      return false;
    });
  };

  const runEpisodePostTurn = ({ agentId, ctx, sessionKey, neoStore, normalizedTurns, digestHash, hooks, signal = null }) => {
    const processedEpisodes = hooks?.agent_end?.processedEpisodes || [];
    const episodedTurnIds = new Set(hooks?.agent_end?.episodedTurnIds || []);
    const openEpisodeState = hooks?.agent_end?.openEpisode || null;
    return extractEpisodesWithState(normalizedTurns, {
      episodedTurnIds,
      workspaceKey: ctx?.workspaceKey,
      workspaceDir: ctx?.workspaceDir,
      sessionKey: sessionKey || "",
      mood: (() => { try { return emotionalPool.describe(agentId); } catch (_) { return null; } })(),
      openEpisode: openEpisodeState,
      agentId,
      llmCfg: mergingEnabled ? withLlmCallContext(
        episodeExtractionLlmCfg,
        agentId,
        "episode-extraction",
        { signal },
      ) : null,
      callLlm,
      signal,
    }).then(async ({ episodes, openEpisode: nextOpenEpisode, continuedId }) => {
      throwIfAborted(signal, "episode commit aborted");
      const { fresh, skipped } = filterAlreadyEpisoded(episodes, episodedTurnIds);
      if (skipped > 0) {
        logger.info(`memory-lancedb-namespaced: ${skipped} bereits episodierte Spanne(n) uebersprungen (agent=${agentId})`);
      }
      const vaultPaths = new Map();
      if (fresh.length > 0) {
        throwIfAborted(signal, "episode commit aborted");
        if (typeof neoStore.appendEpisodesAsync === "function") await neoStore.appendEpisodesAsync(fresh);
        else neoStore.appendEpisodes(fresh);
        const continuedCount = fresh.filter((ep) => ep.id === continuedId).length;
        logger.info(`memory-lancedb-namespaced: ${fresh.length} episode(s) extracted for agent=${agentId} (continued=${continuedCount}, turns=${fresh.map((ep) => ep.turnCount).join("/")})`);
        if (ctx?.workspaceDir) {
          for (const ep of fresh) {
            throwIfAborted(signal, "episode commit aborted");
            const replacePath = continuedId && ep.id === continuedId ? openEpisodeState?.vaultPath || null : null;
            const written = writeEpisodeToVault(ep, ctx.workspaceDir, { replacePath });
            if (written?.written) vaultPaths.set(ep.id, written.path);
            else if (written?.error) logger.warn?.(`memory-lancedb-namespaced: episode card not written: ${written.error}`);
          }
        }
      }
      const mergedEpisodes = [...processedEpisodes.slice(-100), digestHash];
      throwIfAborted(signal, "episode commit aborted");
      const openEpisodeRecord = nextOpenEpisode
        ? { ...nextOpenEpisode, vaultPath: vaultPaths.get(nextOpenEpisode.id) || nextOpenEpisode.vaultPath || null }
        : null;
      neoStore.recordHook("agent_end", {
        processedEpisodes: mergedEpisodes,
        episodedTurnIds: mergeEpisodedTurnIds(episodedTurnIds, fresh, EPISODED_TURN_ID_MEMORY),
        openEpisode: openEpisodeRecord,
      });
      return true;
    }).catch((epErr) => {
      logger.warn?.(`memory-lancedb-namespaced: episode extraction failed: ${String(epErr)}`);
      return false;
    });
  };

  return { runLightDreamPostTurn, runEpisodePostTurn };
}
