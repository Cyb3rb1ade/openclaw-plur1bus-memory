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
 * moved verbatim (tools .superpowers/sdd/…/task-13b-gen.mjs).
 */

import { handleObsidianBridgeCommand } from "../../lib/obsidian-control-room.js";
import { shareCard } from "../../lib/telegram-commands/memory-edit.js";
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
import { dbg, runSpeakerProposalPipeline } from "../../engine/runtime/debug-log.js";
import { CORRECTION_PREVIEW_CHARS, EPISODED_TURN_ID_MEMORY, MAX_POSTPROCESSING_RETRIES, MAX_PROMPT_REPLY_OUTCOME_READ_BYTES } from "../../engine/runtime/constants.js";
import { callLlm, callMergeCheck, withDeterministicLlmContext } from "../../engine/runtime/llm-calls.js";
import { generateSummary, makeQuerySummarizer, normalizedLlmErrorClass, summarizeForCapture } from "../../engine/runtime/env-config.js";
import { normalizeBoundedRecallInteger, resolveRuntimeRecallBudget, runMergedNamespaceRecall } from "../../engine/recall/namespace-recall.js";
import { applyEpistemicStatusToLanceDb, waitForTimeoutSettlement } from "../../engine/store/memory-db.js";
import { KNOWLEDGE_LOCK_FILE, appendCurationLog, readKnowledgePendingSnapshot, removeKnowledgePending, trackKnowledgePending } from "../../engine/knowledge/knowledge-pending.js";
import { appendConflictLog, buildMaintenanceNudges, completePendingConfirmation, findNeoRecord, formatKnownValidityLabel, guardUnsafeDirectCronTurn, parseConfirmationCommand, rememberPendingConfirmation, resolveConfirmationIdentity, textSuggestsGroupOrigin } from "../../engine/commands/command-helpers.js";
import { createEngine } from "../../engine/create-engine.js";
import { internalsOf } from "../../engine/internals.js";
import { createHostServices } from "../../lib/host-services.js";
import { shouldCoordinateLocalModelGeneration, configMutationLogNotice } from "../../lib/runtime-shutdown.js";
import { createOpenClawSkillWorkshopClient } from "../../lib/setup/skill-workshop-plugin-runtime.js";
import { createOpenClawEmbeddingSelectionMutator } from "../../lib/reembedding/runtime-config.js";

/**
 * The OpenClaw plugin's register(): validate the test-injection dependencies,
 * build HostServices and the engine, then register every host surface.
 *
 * @param {object} api OpenClaw plugin API.
 * @param {object} [registrationDependencies] Test-injection dependencies
 *   (importRouting, commandRuntimeHooks, hostEvents, skillWorkshop,
 *   handleObsidianBridgeCommand, shareCard) — the contract register() always had.
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
  if (
    registeredSkillWorkshop !== undefined
    && registeredSkillWorkshop !== null
    && (typeof registeredSkillWorkshop !== "object" || Array.isArray(registeredSkillWorkshop))
  ) {
    throw new TypeError("skillWorkshop must be an object when provided");
  }
  setHostSdkLoader(loadOpenClawPluginSdkRuntime);
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
      shareCard: registeredShareCard,
    },
  });
  const engine = createEngine(host, api.pluginConfig || {});
  const internals = internalsOf(engine);
  const {
    NEO_EMBED_TIMEOUT,
    NEO_HOOK_DRAIN_MARGIN_MS,
    NEO_HOOK_DRAIN_MIN_MS,
    NEO_RECALL_PRELUDE_LOG_MS,
    REPLY_OUTCOME_SYNC_LOG_MS,
    TTL_MAP,
    activeEmbeddingFingerprintId,
    adaptiveBudgetCfg,
    autoCapture,
    autoRecall,
    autoRecallMinScore,
    automaticWorkspacePolicyDecision,
    baseDbPath,
    bridgeService,
    candidateTopK,
    candidateVisibleForStore,
    canonicalEnabled,
    canonicalMaxItems,
    canonicalMinScore,
    captureSummaryLlmCfg,
    cfg,
    checkpointStore,
    classifyEmotionForStore,
    classifyHostIncognitoSession,
    closeResources,
    collectSkillWorkshopDashboard,
    commandBodies,
    configuredObsidianWorkspaces,
    confirmationIndex,
    confirmationStore,
    controlHealth,
    conversationInsightsLlmCfg,
    coordinatesLocalModelGeneration,
    cronDirectDispatchReady,
    dashboardSkillAction,
    dedupEnabled,
    dedupJaccard,
    detectReactionsCapabilityCached,
    dimensions,
    dreamEchoLlmCfg,
    dreamNarrativeCfg,
    dreamNarrativeLlmCfg,
    duplicateThreshold,
    durableMergeEpistemicMetadata,
    durableMergeLineage,
    durableMergeWriteKey,
    embeddings,
    emitCommandRuntimeHook,
    emotionIntensityHalfLifeFactor,
    emotionalPool,
    episodeExtractionLlmCfg,
    epistemicCutoffBoot,
    findSafeDuplicateForValidity,
    flashbulbEncodingEnabled,
    forgetThreshold,
    gcEnabled,
    getMemoryTurnRoutes,
    getNeoStore,
    halfLifeOverrides,
    hostRoutingLoader,
    jobs,
    llmResultCache,
    markNeoRecallInjection,
    maxPromptMemories,
    memoryAccountTopology,
    memoryDbAdapter,
    memoryTextContradictionLlmCfg,
    memoryWorkspaceAliases,
    mergingAutoApply,
    mergingEnabled,
    mergingLlmCfg,
    mergingThreshold,
    metaCognitionEnabled,
    metaCognitionIntervalMs,
    metaCognitionLlmReport,
    metaCognitionSessionThreshold,
    metaReflectionState,
    modelPreparationCoordinator,
    namespaceLayout,
    neoAgentEndBudgetMs,
    neoCfg,
    neoEmbeddingAutoDrainEnabled,
    neoEmbeddingDrainImpact,
    neoEmbeddingDrainMaxItems,
    neoEnabled,
    neoGlobalRecall,
    neoRequester,
    neoRoot,
    neoWorkerRuntime,
    neoWorkspaceAliases,
    normalizedEmbeddingCfg,
    obsidianBridgeCfg,
    obsidianBridgeEnabled,
    obsidianVaultsConfirmed,
    openClawSkillWorkshop,
    overlayLlmCfg,
    personaDirectiveMaxChars,
    personaVoiceLlmCfg,
    pool,
    queryRefinerEnabled,
    recallMinScore,
    recallQueryLlmCfg,
    reembeddingConfigMutationAvailable,
    reembeddingCoordinator,
    reembeddingStateStore,
    reembeddingSwitchRecovery,
    reembeddingSwitchRuntime,
    rememberNeoWorkspace,
    reminderAutoExtract,
    replyOutcomeDynamics,
    replyOutcomeEnabled,
    replyOutcomeMaxAgeMs,
    replyOutcomeMaxAssistantChars,
    replyOutcomeMaxFeedbackLogEntries,
    replyOutcomeMaxMemoryIds,
    replyOutcomeMaxOutcomeLogEntries,
    replyOutcomeMaxReplyChars,
    requiresActiveSharedModelOwner,
    rerankCandidates,
    reranker,
    rerankerCfg,
    resolveCommandLocale,
    resolveCommandLocaleRecall,
    resolveStoreScopeAccess,
    resolveTemperamentName,
    runMinimalBeforePromptMaintenance,
    runNeoGlobalSearch,
    runtimeScheduler,
    schicht15Enabled,
    schicht15LlmCfg,
    schicht15MaxPromotions,
    schicht15MinImportance,
    scopedEmbeddingServer,
    semanticCompressionCfg,
    semanticLensCfg,
    sessionWorkspaceKeys,
    sharedMemoryPool,
    skillActivationDeps,
    skillLedgerDirForAgent,
    skillMinerEnabled,
    snapshotNeoMessages,
    snapshotNeoString,
    softBudgetFallback,
    softBudgetMs,
    summaryMaxWords,
    temporalContextEnabled,
    tombstoneMemoryWithAudit,
    traceCfg,
    traceEnabled,
    traceInPrompt,
    turnRouteState,
    vectorDim,
    wikiLlmCfg,
    withDurableMerge,
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
        cronDirectDispatchReady,
        dashboardSkillAction,
        dimensions,
        embeddings,
        emitCommandRuntimeHook,
        emotionalPool,
        getNeoStore,
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
        registeredShareCard,
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

    registerCaptureHook({
      api,
      EPISODED_TURN_ID_MEMORY,
      MAX_POSTPROCESSING_RETRIES,
      NEO_HOOK_DRAIN_MARGIN_MS,
      NEO_HOOK_DRAIN_MIN_MS,
      baseDbPath,
      callLlm,
      captureSummaryLlmCfg,
      cfg,
      checkpointStore,
      classifyEmotionForStore,
      classifyHostIncognitoSession,
      conversationInsightsLlmCfg,
      dreamEchoLlmCfg,
      dreamNarrativeCfg,
      dreamNarrativeLlmCfg,
      duplicateThreshold,
      embeddings,
      emotionIntensityHalfLifeFactor,
      emotionalPool,
      episodeExtractionLlmCfg,
      epistemicCutoffBoot,
      flashbulbEncodingEnabled,
      generateSummary,
      getNeoStore,
      halfLifeOverrides,
      host,
      jobs,
      memoryWorkspaceAliases,
      mergingEnabled,
      metaCognitionEnabled,
      metaCognitionIntervalMs,
      metaCognitionLlmReport,
      metaCognitionSessionThreshold,
      metaReflectionState,
      neoAgentEndBudgetMs,
      neoCfg,
      neoEmbeddingAutoDrainEnabled,
      neoEmbeddingDrainImpact,
      neoEmbeddingDrainMaxItems,
      neoEnabled,
      neoRoot,
      neoWorkerRuntime,
      neoWorkspaceAliases,
      personaVoiceLlmCfg,
      pool,
      rememberNeoWorkspace,
      reminderAutoExtract,
      resolveTemperamentName,
      runSpeakerProposalPipeline,
      runtimeScheduler,
      skillMinerEnabled,
      snapshotNeoMessages,
      snapshotNeoString,
      summarizeForCapture,
      summaryMaxWords,
      textSuggestsGroupOrigin,
      vectorDim,
      waitForTimeoutSettlement,
      workspacePolicyGuard,
    });
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

  registerMemoryTools({
    KNOWLEDGE_LOCK_FILE,
    TTL_MAP,
    adaptiveBudgetCfg,
    api,
    appendConflictLog,
    appendCurationLog,
    baseDbPath,
    callLlm,
    callMergeCheck,
    candidateTopK,
    candidateVisibleForStore,
    canonicalEnabled,
    canonicalMaxItems,
    canonicalMinScore,
    cfg,
    classifyEmotionForStore,
    dbg,
    dedupEnabled,
    dedupJaccard,
    duplicateThreshold,
    durableMergeEpistemicMetadata,
    durableMergeLineage,
    durableMergeWriteKey,
    embeddings,
    emotionIntensityHalfLifeFactor,
    emotionalPool,
    epistemicCutoffBoot,
    findSafeDuplicateForValidity,
    flashbulbEncodingEnabled,
    forgetThreshold,
    formatKnownValidityLabel,
    generateSummary,
    getNeoStore,
    halfLifeOverrides,
    host,
    makeQuerySummarizer,
    maxPromptMemories,
    memoryWorkspaceAliases,
    mergingAutoApply,
    mergingEnabled,
    mergingLlmCfg,
    mergingThreshold,
    namespaceLayout,
    normalizeBoundedRecallInteger,
    normalizedLlmErrorClass,
    pool,
    queryRefinerEnabled,
    readKnowledgePendingSnapshot,
    recallMinScore,
    recallQueryLlmCfg,
    removeKnowledgePending,
    rerankCandidates,
    reranker,
    rerankerCfg,
    resolveRuntimeRecallBudget,
    resolveStoreScopeAccess,
    runMergedNamespaceRecall,
    runtimeScheduler,
    schicht15Enabled,
    schicht15LlmCfg,
    schicht15MaxPromotions,
    schicht15MinImportance,
    sharedMemoryPool,
    softBudgetFallback,
    softBudgetMs,
    summaryMaxWords,
    tombstoneMemoryWithAudit,
    traceCfg,
    traceEnabled,
    trackKnowledgePending,
    withDeterministicLlmContext,
    withDurableMerge,
    workspacePolicyGuard,
  });

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
      MAX_PROMPT_REPLY_OUTCOME_READ_BYTES,
      NEO_EMBED_TIMEOUT,
      NEO_RECALL_PRELUDE_LOG_MS,
      adaptiveBudgetCfg,
      autoRecallMinScore,
      automaticWorkspacePolicyDecision,
      buildMaintenanceNudges,
      callLlm,
      candidateTopK,
      canonicalEnabled,
      canonicalMaxItems,
      canonicalMinScore,
      cfg,
      checkpointStore,
      dbg,
      dedupEnabled,
      dedupJaccard,
      detectReactionsCapabilityCached,
      embeddings,
      emotionalPool,
      gcEnabled,
      getMemoryTurnRoutes,
      getNeoStore,
      host,
      hostRoutingLoader,
      makeQuerySummarizer,
      markNeoRecallInjection,
      maxPromptMemories,
      memoryAccountTopology,
      memoryTextContradictionLlmCfg,
      memoryWorkspaceAliases,
      mergingEnabled,
      namespaceLayout,
      neoEnabled,
      neoGlobalRecall,
      neoRequester,
      neoWorkerRuntime,
      normalizeBoundedRecallInteger,
      normalizedLlmErrorClass,
      overlayLlmCfg,
      personaDirectiveMaxChars,
      personaVoiceLlmCfg,
      pool,
      queryRefinerEnabled,
      recallQueryLlmCfg,
      // Test-only hook (Task 19 fix round): the golden-prefix probe sets
      // `api.__recallTimingSinkForTests` on its stub api object so it can
      // read the pipeline's per-phase timings; no real OpenClaw host ever
      // sets this property, so `recallTimingSink` is always `null` here in
      // production and `createPromptContextAssembler` treats it as a no-op.
      recallTimingSink: api.__recallTimingSinkForTests ?? null,
      replyOutcomeDynamics,
      replyOutcomeEnabled,
      replyOutcomeMaxAssistantChars,
      replyOutcomeMaxMemoryIds,
      rerankCandidates,
      reranker,
      rerankerCfg,
      resolveCommandLocaleRecall,
      resolveRuntimeRecallBudget,
      runMergedNamespaceRecall,
      runMinimalBeforePromptMaintenance,
      runNeoGlobalSearch,
      runtimeScheduler,
      schicht15Enabled,
      semanticCompressionCfg,
      semanticLensCfg,
      sharedMemoryPool,
      skillLedgerDirForAgent,
      skillMinerEnabled,
      softBudgetFallback,
      softBudgetMs,
      summaryMaxWords,
      temporalContextEnabled,
      traceCfg,
      traceEnabled,
      traceInPrompt,
      workspacePolicyGuard,
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
