/**
 * adapter/openclaw/plugin.js — the OpenClaw plugin's register().
 *
 * createHostServices(api) -> createEngine(host, config) -> the nine
 * register-*.js modules, in the order index.js called them. Registration
 * order per host event list is a contract (adapter/openclaw/README.md): the
 * control-health gateway_start/gateway_stop pair (inside registerChatCommands)
 * stays between the Obsidian bridge pair and the Neo service pair, the recall
 * before_prompt_build handler is the last one registered, agent_end runs
 * capture -> reply-outcome -> turn-route cleanup, and
 * registerGatewayShutdownServices(...) is the last registration.
 *
 * Every OpenClaw-only construction input reaches the engine as
 * host.capabilities (built here); every registration below reads the engine's
 * objects through internalsOf(engine), the transitional seam PR-14 removes.
 * The registration statements are the old index.js register() statements,
 * moved verbatim in M1b-1 Task 13b. The recall, capture and tool contexts
 * are the engine's registration views (internals.recallContext,
 * captureContext, toolContext), spread here with `api`.
 */

import { handleObsidianBridgeCommand } from "../../lib/obsidian-control-room.js";
import { resolveDefaultArchiveDir, shareCard } from "../../lib/telegram-commands/memory-edit.js";
import { setHostSdkLoader } from "../../lib/host-sdk-loader.js";
import { loadOpenClawPluginSdkRuntime } from "../../lib/setup/feature-cron-plugin-runtime.js";
import { reconcileUnsafeDirectCronsWithService, runDeferredFeatureCronBootstrap, inspectCronNativeCapabilities, makeReactionsCapabilityChecker, resolveNeoHooksConfig } from "./host-probes.js";
import { t } from "../../lib/i18n.js";
import { checkWikiAuth, parseWikiCommandInput, runWikiCommand } from "../../lib/wiki-command.js";
import { describeDirectSessionRoute as describeOperatorDirectSession } from "../../lib/memory-request-context.js";
import { safeAgentId } from "../../lib/sql-safety.js";
import { registerOpenClawMemoryEmbeddingProviders } from "../../lib/providers/openclaw-memory-embedding-adapters.js";
import { isBackgroundTurn, shouldSkipAutoRecallForInternalTurn } from "../../lib/runtime-scheduler.js";
import { withLlmCallContext } from "../../lib/llm-result-cache.js";
import { completePendingReplyOutcomes, lastMessageText, recordAgentReplyForOutcome, sessionKeyFrom } from "../../lib/reply-outcome-tracking.js";
import { registerTurnRouteHooks } from "./register-turn-route.js";
import { registerMaintenanceHook } from "./register-maintenance-hook.js";
import { registerRecallHook } from "./register-recall-hook.js";
import { agentContextFromCommand } from "./turn-principal.js";
import { registerCaptureHook } from "./register-capture-hook.js";
import { registerChatCommands, registerSkillProposalListener } from "./register-commands.js";
import { registerPromptSupplements } from "./register-prompt-supplements.js";
import { registerMemoryTools, registerMemoryCapability } from "./register-tools.js";
import { registerDeferredFeatureCronBootstrap, registerUnsafeDirectCronGuard } from "./register-cron.js";
import { registerGatewayShutdownServices, registerNeoServiceLifecycle, registerNeoWorkerWarmUp, registerObsidianBridgeLifecycle } from "./register-gateway.js";
import { CORRECTION_PREVIEW_CHARS } from "../../engine/runtime/constants.js";
import { callLlm } from "../../engine/runtime/llm-calls.js";
import { makeQuerySummarizer } from "../../engine/runtime/env-config.js";
import { applyEpistemicStatusToLanceDb } from "../../engine/store/memory-db.js";
import { buildMaintenanceNudges, completePendingConfirmation, findNeoRecord, guardUnsafeDirectCronTurn, parseConfirmationCommand, rememberPendingConfirmation, resolveConfirmationIdentity } from "../../engine/commands/command-helpers.js";
import { createEngine } from "../../engine/create-engine.js";
import { internalsOf } from "../../engine/internals.js";
import { createHostServices } from "../../lib/host-services.js";
import { shouldCoordinateLocalModelGeneration, configMutationLogNotice } from "../../lib/runtime-shutdown.js";
import { createOpenClawSkillWorkshopClient } from "../../lib/setup/skill-workshop-plugin-runtime.js";
import { createOpenClawEmbeddingSelectionMutator } from "../../lib/reembedding/runtime-config.js";
import { deliverCriticalButtonPush } from "../../lib/critical-button-delivery.js";
import { boundTelegramAccountId } from "../../lib/setup/feature-cron-plan.js";

/**
 * The OpenClaw plugin's register(): validate the test-injection dependencies,
 * build HostServices and the engine, then register every host surface.
 *
 * @param {object} api OpenClaw plugin API.
 * @param {object} [registrationDependencies] Test-injection dependencies
 *   (importRouting, commandRuntimeHooks, hostEvents, skillWorkshop,
 *   handleObsidianBridgeCommand, shareCard) — the contract register() always had —
 *   plus `engineInternals`, test-only: forwarded as createEngine's
 *   `testOptions.internals` (e.g. a stub embedder), so it reaches every
 *   registration that reads the engine's objects.
 * @returns {void}
 */
export function registerPlur1bus(api, registrationDependencies = {}) {
  if (!registrationDependencies || typeof registrationDependencies !== "object" || Array.isArray(registrationDependencies)) {
    throw new TypeError("plugin registration dependencies must be an object");
  }
  const {
    importRouting,
    commandRuntimeHooks = null,
    hostEvents,
    skillWorkshop: registeredSkillWorkshop,
    handleObsidianBridgeCommand: registeredObsidianCommandHandler = handleObsidianBridgeCommand,
    shareCard: registeredShareCard = shareCard,
    engineInternals,
  } = registrationDependencies;
  if (importRouting !== undefined && typeof importRouting !== "function") {
    throw new TypeError("importRouting must be a function");
  }
  if (commandRuntimeHooks !== null && (typeof commandRuntimeHooks !== "object" || Array.isArray(commandRuntimeHooks))) {
    throw new TypeError("commandRuntimeHooks must be an object when provided");
  }
  if (hostEvents !== undefined && (hostEvents === null || typeof hostEvents.emit !== "function")) {
    throw new TypeError("hostEvents must expose emit(name, payload) when provided");
  }
  if (registeredObsidianCommandHandler !== handleObsidianBridgeCommand && typeof registeredObsidianCommandHandler !== "function") {
    throw new TypeError("handleObsidianBridgeCommand must be a function when provided");
  }
  if (typeof registeredShareCard !== "function") {
    throw new TypeError("shareCard must be a function when provided");
  }
  if (engineInternals !== undefined && (engineInternals === null || typeof engineInternals !== "object" || Array.isArray(engineInternals))) {
    throw new TypeError("engineInternals must be an object when provided");
  }
  if (
    registeredSkillWorkshop !== undefined
    && registeredSkillWorkshop !== null
    && (typeof registeredSkillWorkshop !== "object" || Array.isArray(registeredSkillWorkshop))
  ) {
    throw new TypeError("skillWorkshop must be an object when provided");
  }
  setHostSdkLoader(loadOpenClawPluginSdkRuntime);
  // 7.16.10: Der Critical Push kommt nur dann mit Telegram-Knöpfen, wenn der
  // Klick-Handler beim Host registriert ist (registerChatCommands setzt
  // ready); sonst bleibt es beim Text.
  const criticalButtonState = { ready: false };
  // The capabilities below are built — inspectCronNativeCapabilities runs,
  // the skill-workshop client and the reactions checker are constructed —
  // before createEngine resolves and validates the plugin config. The old
  // register() ran them after its first config reads; an invalid config now
  // still probes once, then throws with zero registrations (a Task 13b
  // deviation, recorded in Task 13c).
  const host = createHostServices(api, {
    events: hostEvents,
    ...(importRouting ? { routing: importRouting } : {}),
    capabilities: {
      registrationMode: api.registrationMode,
      coordinatesLocalModelGeneration: shouldCoordinateLocalModelGeneration(api),
      resolvePath: (value) => api.resolvePath(value),
      cronDirectDispatchReady: process.env.NODE_TEST_CONTEXT
        ? true
        : inspectCronNativeCapabilities(api),
      skillWorkshop: registeredSkillWorkshop !== undefined
        ? registeredSkillWorkshop
        : (
            typeof api.registerGatewayMethod === "function" && typeof api.registerCli === "function"
              ? createOpenClawSkillWorkshopClient()
              : null
          ),
      detectReactions: makeReactionsCapabilityChecker(api),
      createEmbeddingSelectionMutator: () => createOpenClawEmbeddingSelectionMutator({ api }),
      configMutationNotice: configMutationLogNotice(api),
      resolveNeoHooksConfig: (commandConfig) => resolveNeoHooksConfig(api, commandConfig),
      commandRuntimeHooks,
      handleObsidianBridgeCommand: registeredObsidianCommandHandler,
      // MemoryOps archive-first backups stay where /forget and /correct have
      // always put them (~/.openclaw/memory/_archive, or under OPENCLAW_HOME).
      memoryArchiveDir: resolveDefaultArchiveDir,
      // 7.16.10: classify-recent (engine/jobs/internal-job-bodies.js) sendet
      // den Critical Push hierüber als eine Telegram-Nachricht je Karte mit
      // Annehmen/Ablehnen. Ziel ist das Zustellziel des eigenen Crons
      // (commandCtx.resolveCronDelivery, Cron-Dienst im Gateway-Kontext), das
      // Bot-Konto die eindeutige Telegram-Bindung des Agenten. null, solange
      // der Klick-Handler nicht registriert ist.
      pushCriticalButtons: async ({ agentId, result, commandCtx, warning }) => {
        if (!criticalButtonState.ready) return null;
        const cronDelivery = typeof commandCtx?.resolveCronDelivery === "function"
          ? await commandCtx.resolveCronDelivery()
          : null;
        return deliverCriticalButtonPush({
          agentId,
          result,
          config: api.config,
          delivery: cronDelivery
            ? { ...cronDelivery, accountId: cronDelivery.accountId || boundTelegramAccountId(agentId, api.config) }
            : null,
          loadAdapter: (channel) => api.runtime?.channel?.outbound?.loadAdapter?.(channel),
          warning,
          logger: host.logger,
        });
      },
    },
  });
  const engine = createEngine(host, api.pluginConfig || {}, engineInternals ? { internals: engineInternals } : {});
  const internals = internalsOf(engine);
  const {
    REPLY_OUTCOME_SYNC_LOG_MS,
    activeEmbeddingFingerprintId,
    autoCapture,
    autoRecall,
    automaticWorkspacePolicyDecision,
    baseDbPath,
    bridgeService,
    cfg,
    closeResources,
    collectSkillWorkshopDashboard,
    commandBodies,
    configuredObsidianWorkspaces,
    confirmationIndex,
    confirmationStore,
    controlHealth,
    coordinatesLocalModelGeneration,
    cronDirectDispatchReady,
    dashboardSkillAction,
    dimensions,
    embeddings,
    emitCommandRuntimeHook,
    emotionalPool,
    gcEnabled,
    getMemoryTurnRoutes,
    getNeoStore,
    hostRoutingLoader,
    llmResultCache,
    memoryDbAdapter,
    memoryWorkspaceAliases,
    mergingEnabled,
    modelPreparationCoordinator,
    namespaceLayout,
    neoCfg,
    neoEnabled,
    neoRequester,
    neoRoot,
    neoWorkerRuntime,
    neoWorkspaceAliases,
    normalizedEmbeddingCfg,
    obsidianBridgeCfg,
    obsidianBridgeEnabled,
    obsidianVaultsConfirmed,
    openClawSkillWorkshop,
    pool,
    recallQueryLlmCfg,
    reembeddingConfigMutationAvailable,
    reembeddingCoordinator,
    reembeddingStateStore,
    reembeddingSwitchRecovery,
    reembeddingSwitchRuntime,
    replyOutcomeDynamics,
    replyOutcomeEnabled,
    replyOutcomeMaxAgeMs,
    replyOutcomeMaxAssistantChars,
    replyOutcomeMaxFeedbackLogEntries,
    replyOutcomeMaxMemoryIds,
    replyOutcomeMaxOutcomeLogEntries,
    replyOutcomeMaxReplyChars,
    requiresActiveSharedModelOwner,
    reranker,
    rerankerCfg,
    resolveCommandLocale,
    resolveCommandLocaleRecall,
    runNeoGlobalSearch,
    schicht15Enabled,
    scopedEmbeddingServer,
    sessionWorkspaceKeys,
    sharedMemoryPool,
    skillActivationDeps,
    temporalContextEnabled,
    turnRouteState,
    vectorDim,
    wikiLlmCfg,
    workspacePolicyGuard,
    workspacePolicyStore,
    runPlur1busCommand: runPlur1busCommandWithIdentity,
  } = internals;

  // 1. The memory-slot runtime (first registration, as before).
  registerMemoryCapability(internals, api);
  // 2. The unsafe direct feature-cron guard.
  registerUnsafeDirectCronGuard({ api, cronDirectDispatchReady, guardUnsafeDirectCronTurn });
  // 3. OpenClaw memory embedding providers.
  registerOpenClawMemoryEmbeddingProviders(api, cfg, requiresActiveSharedModelOwner
    ? { scopedEmbeddingIpc: { stateRoot: baseDbPath, fingerprintId: activeEmbeddingFingerprintId } }
    : {});
  // 4. Neo worker warm-up (lone gateway_start).
  registerNeoWorkerWarmUp({ api, host, neoWorkerRuntime });
  // 5. skill_proposal_changed.
  registerSkillProposalListener({ api, ...internals });
  // 6. Obsidian bridge lifecycle.
  if (obsidianBridgeEnabled) {
    registerObsidianBridgeLifecycle({ api, bridgeService, host, obsidianBridgeCfg });
  }
  // 7. Deferred feature-cron bootstrap.
  registerDeferredFeatureCronBootstrap({
    api,
    baseDbPath,
    cfg,
    cronDirectDispatchReady,
    host,
    reconcileUnsafeDirectCronsWithService,
    runDeferredFeatureCronBootstrap,
  });
  // 8. Prompt supplements.
  registerPromptSupplements({
    api,
    embeddings,
    findNeoRecord,
    getNeoStore,
    host,
    neoCfg,
    neoEnabled,
    neoRequester,
    neoRoot,
    neoWorkspaceAliases,
    runNeoGlobalSearch,
    sessionWorkspaceKeys,
  });
  // 9. The chat-command surface (it registers the control-health
  // gateway_start/gateway_stop pair), then 10. the Neo service pair.
  {
    // Every chat command is also reachable as operator (`openclaw plur1bus-command`),
    // bound to a named direct chat session. The registry keeps the same specs
    // the host receives, so both paths run the identical handler.
    const pluginCommandHandlers = new Map();
    const registerPluginCommand = (spec) => {
      if (spec && typeof spec.name === "string" && typeof spec.handler === "function") {
        pluginCommandHandlers.set(spec.name.toLowerCase(), spec);
      }
      return api.registerCommand(spec);
    };

    if (typeof api.registerCommand === "function") {
      const runPlur1busCommand = (commandCtx, prefixTokens = [], opts = {}) =>
        runPlur1busCommandWithIdentity(commandCtx, prefixTokens, { agentContext: agentContextFromCommand(commandCtx), ...opts });
      // Operator path for chat commands: `/name args` runs the registered
      // handler with the same identity-bound context the channel would build
      // for that direct chat (channel, account, peer, sender = peer). The
      // session key must name a direct chat of the requested agent; the
      // handler's own authorization (allowedUserIds, confirmations) applies
      // unchanged, so this grants nothing the chat owner could not do.
      const runOperatorCommand = async ({ agentId, sessionKey, command, locale }) => {
        const trimmed = String(command || "").trim();
        const match = /^\/([A-Za-z0-9_-]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
        if (!match) throw new Error("command must look like /name [args]");
        const spec = pluginCommandHandlers.get(match[1].toLowerCase());
        if (!spec) throw new Error(`unknown PLUR1BUS command /${match[1]}`);
        const direct = describeOperatorDirectSession(sessionKey, await hostRoutingLoader());
        if (!direct) throw new Error("session key must name a direct chat session (agent:<id>:<channel>:<account>:direct:<peer>)");
        if (direct.agentId !== safeAgentId(agentId)) throw new Error("session key belongs to a different agent");
        // The host hands every command its workspaceDir; several handlers
        // read it straight off the context (tone hint, vault paths).
        const workspaceDir = await host.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config, direct.agentId);
        const commandCtx = {
          agentId: direct.agentId,
          sessionKey: direct.sessionKey,
          channel: direct.channel,
          accountId: direct.accountId,
          from: `${direct.channel}:${direct.peerId}`,
          senderId: direct.peerId,
          chatType: "private",
          workspaceDir,
          config: api.config,
          args: (match[2] || "").trim(),
          commandBody: trimmed,
          origin: "operator",
          source: "cli",
        };
        // 7.12.24: Ohne Chatverlauf fiel die Sprache auf Englisch zurueck.
        // resolveLocale nimmt ctx.lang vor der Nachrichten-Erkennung.
        const operatorLang = (typeof locale === "string" && locale.trim())
          || (typeof cfg.language === "string" && cfg.language.trim())
          || "";
        if (operatorLang) commandCtx.lang = operatorLang;
        const result = await spec.handler(commandCtx);
        const text = typeof result === "string" ? result : result?.text;
        return { text: typeof text === "string" && text.length > 0 ? text : "NO_REPLY" };
      };
      // PR-03g: every chat-command registration below this point — and,
      // for M1a, the six user-facing command bodies and the four
      // auth/locale helpers they share — lives in
      // adapter/openclaw/register-commands.js. The ten returned bindings go
      // into the engine's shared commandBodies object (engine/create-engine.js),
      // so PR-03f's thunks keep resolving at command time.
      const {
        runMemoryCommand,
        runForgetCommand,
        runCorrectCommand,
        runCriticalCommand,
        runStatusCommand,
        runFeatureToggle,
        checkArgsLength,
        checkAuth,
        resolveDenialLocale,
        resolveRegisteredMemoryContext,
      } = registerChatCommands({
        CORRECTION_PREVIEW_CHARS,
        activeEmbeddingFingerprintId,
        api,
        applyEpistemicStatusToLanceDb,
        baseDbPath,
        cfg,
        collectSkillWorkshopDashboard,
        completePendingConfirmation,
        configuredObsidianWorkspaces,
        confirmationIndex,
        confirmationStore,
        controlHealth,
        criticalButtonState,
        cronDirectDispatchReady,
        dashboardSkillAction,
        dimensions,
        embeddings,
        emitCommandRuntimeHook,
        emotionalPool,
        engineMemory: engine.memory,
        host,
        hostRoutingLoader,
        llmResultCache,
        makeQuerySummarizer,
        memoryDbAdapter,
        memoryWorkspaceAliases,
        mergingEnabled,
        modelPreparationCoordinator,
        namespaceLayout,
        normalizedEmbeddingCfg,
        obsidianVaultsConfirmed,
        openClawSkillWorkshop,
        parseConfirmationCommand,
        pool,
        recallQueryLlmCfg,
        reembeddingConfigMutationAvailable,
        reembeddingCoordinator,
        reembeddingStateStore,
        reembeddingSwitchRuntime,
        registerPluginCommand,
        // Test seam only (tests/b13-share-runtime.test.js): a production
        // registration shares through engine.memory.share.
        registeredShareCard: registeredShareCard === shareCard ? null : registeredShareCard,
        rememberPendingConfirmation,
        reranker,
        rerankerCfg,
        resolveCommandLocale,
        resolveConfirmationIdentity,
        runOperatorCommand,
        runPlur1busCommand,
        sharedMemoryPool,
        skillActivationDeps,
        vectorDim,
        workspacePolicyGuard,
        workspacePolicyStore,
      });
      Object.assign(commandBodies, {
        runMemoryCommand,
        runForgetCommand,
        runCorrectCommand,
        runCriticalCommand,
        runStatusCommand,
        runFeatureToggle,
        checkArgsLength,
        checkAuth,
        resolveDenialLocale,
        resolveRegisteredMemoryContext,
      });
      registerPluginCommand({
        name: "wiki",
        description: "PLUR1BUS — Wiki durchsuchen, hinzufügen, löschen",
        acceptsArgs: true,
        channels: ["telegram", "discord", "slack", "mattermost"],
        handler: async (ctx) => {
          const parsed = parseWikiCommandInput(ctx?.args);
          if (!parsed.ready) {
            const { lang, tone } = resolveCommandLocale(ctx);
            return {
              text: t(parsed.responseKey, {
                lang,
                tone,
                vars: parsed.responseVars,
              }),
            };
          }

          const memoryCtx = await resolveRegisteredMemoryContext(ctx);
          const requestNow = Date.now();
          const denied = checkWikiAuth(memoryCtx, cfg, {
            destructive: parsed.destructive,
            chatKind: memoryCtx.chatKind,
            localeCtx: ctx,
          });
          if (denied) return denied;

          const wikiAgentId = memoryCtx.agentId;
          const sessionRuntime = ctx?.runtimeContext?.llm;
          return runWikiCommand({ ...ctx, args: parsed.args }, {
            pool,
            embeddings,
            reranker,
            callLlm,
            cfg,
            api,
            ctx: memoryCtx,
            now: requestNow,
            workspaceDir: memoryCtx.workspaceDir,
            workspaceAliases: memoryWorkspaceAliases,
            llmCfg: mergingEnabled ? withLlmCallContext(
              wikiLlmCfg,
              wikiAgentId,
              "wiki",
              { runtimeLlm: sessionRuntime },
            ) : null,
          });
        },
      });
    }

    registerNeoServiceLifecycle({ api, host, neoEnabled, neoRoot, neoWorkerRuntime });
  }

  // ========================================================================
  // Auto-Capture: Speichere User-Nachrichten automatisch
  // ========================================================================

  if (autoCapture) {
    host.logger.info(`memory-lancedb-namespaced: enabling autoCapture`);

    registerCaptureHook({ api, ...internals.captureContext, captureTurn: internals.getCaptureTurn() });
  }

  // Reply-based Outcome Tracking: Assistant-Antwort an das Pending-Outcome anhängen.
  if (replyOutcomeEnabled && typeof api.on === "function") {
    api.on("agent_end", (event, ctx) => {
      const background = isBackgroundTurn(event, ctx);
      if (background || !ctx?.workspaceDir) return;
      if (!automaticWorkspacePolicyDecision(event, ctx).allowed) return;
      const assistantText = lastMessageText(event.messages || [], ["assistant"]);
      if (!assistantText) return;
      try {
        recordAgentReplyForOutcome(ctx.workspaceDir, {
          agentId: ctx?.agentId || "default",
          sessionKey: sessionKeyFrom(event, ctx),
          assistantText,
          now: Date.now(),
          maxAssistantChars: replyOutcomeMaxAssistantChars,
        });
      } catch (err) {
        host.logger.warn(`reply-outcome-tracking: recording agent reply failed: ${String(err)}`);
      }
    });
  }

  // ========================================================================
  // Tools (per-Agent via Factory)
  // ========================================================================

  registerMemoryTools({ api, ...internals.toolContext, toolFactory: internals.getToolFactory() });

  // Reply-based Outcome Tracking: vor dem Recall die vorherige Pending-Antwort abschließen.
  if (replyOutcomeEnabled && typeof api.on === "function") {
    api.on("before_prompt_build", async (event, ctx) => {
      const skipInternalRecall = shouldSkipAutoRecallForInternalTurn(event, ctx);
      if (!ctx?.workspaceDir || !event?.prompt || skipInternalRecall) return;
      if (!automaticWorkspacePolicyDecision(event, ctx).allowed) return;
      const outcomeAgentId = ctx?.agentId || "default";
      const startedAt = Date.now();
      try {
        // 7.12.30: Der Host fuehrt die Handler nacheinander aus; dieser lief vor
        // dem Recall und wartete auf bis zu zwoelf LanceDB-Updates. Jetzt bleiben
        // nur Klassifikation und Log-Dateien hier, die DB-Arbeit geht in die
        // Warteschlange und startet nach dem Recall (siehe replyOutcomeDynamics).
        const completed = await completePendingReplyOutcomes(ctx.workspaceDir, {
          agentId: outcomeAgentId,
          sessionKey: sessionKeyFrom(event, ctx),
          workspaceKey: ctx?.workspaceKey || ctx?.workspaceDir || null,
          replyText: event.prompt,
          dbPool: pool,
          applyDynamics: true,
          dynamicsScheduler: (run, meta) => replyOutcomeDynamics.enqueue(outcomeAgentId, run, meta),
          logger: host.logger,
          maxAgeMs: replyOutcomeMaxAgeMs,
          maxMemoryIds: replyOutcomeMaxMemoryIds,
          maxReplyChars: replyOutcomeMaxReplyChars,
          maxAssistantChars: replyOutcomeMaxAssistantChars,
          maxOutcomeLogEntries: replyOutcomeMaxOutcomeLogEntries,
          maxFeedbackLogEntries: replyOutcomeMaxFeedbackLogEntries,
        });
        const ms = Date.now() - startedAt;
        if (Array.isArray(completed) && completed.length > 0) {
          const line = `reply-outcome: completed outcomes=${completed.length} memoryIds=${completed.reduce((sum, entry) => sum + (entry.memoryIds?.length || 0), 0)} syncMs=${ms} queued=${replyOutcomeDynamics.pending(outcomeAgentId)} agent=${outcomeAgentId}`;
          if (ms >= REPLY_OUTCOME_SYNC_LOG_MS) host.logger.info(line); else host.logger.debug(line);
        }
      } catch (err) {
        host.logger.warn(`reply-outcome-tracking: completing pending outcomes failed: ${String(err)}`);
      }
    });
  }

  if (autoRecall) {
    registerTurnRouteHooks({ api, host, autoRecall, getMemoryTurnRoutes, turnRouteState });

    registerRecallHook({
      api,
      ...internals.recallContext,
    });
  } else if (neoEnabled || schicht15Enabled || gcEnabled) {
    // Auto-recall is off — record hook dispatch and run non-recall maintenance/nudges only.
    registerMaintenanceHook({
      api,
      host,
      automaticWorkspacePolicyDecision,
      buildMaintenanceNudges,
      gcEnabled,
      getNeoStore,
      neoEnabled,
      pool,
      resolveCommandLocaleRecall,
      schicht15Enabled,
      stateDir: host.stateDir,
      temporalContextEnabled,
    });
  }

  // Manual tools remain available regardless of autoCapture/autoRecall:
  // memory_store, memory_recall, memory_forget and knowledge_update are not
  // controlled by the automatic hook opt-outs above. Lifecycle ownership is
  // intentionally registered after every hook/capability registration and
  // independently of the optional chat-command surface.
  registerGatewayShutdownServices({
    api,
    closeResources,
    coordinatesLocalModelGeneration,
    embeddings,
    modelPreparationCoordinator,
    reembeddingSwitchRecovery,
    scopedEmbeddingServer,
  });
}
