/**
 * adapter/openclaw/register-commands.js
 *
 * Every PLUR1BUS chat command the plugin registers with OpenClaw: the 15
 * `plur1bus_*` aliases, the three top-level commands (/state, /enable,
 * /disable), the speaker, share and control-room surfaces, and — for M1a —
 * the six user-facing command bodies themselves (`runStatusCommand`,
 * `runFeatureToggle`, `runMemoryCommand`, `runForgetCommand`,
 * `runCorrectCommand`, `runCriticalCommand`) plus the four auth/locale
 * helpers they share. PR-04 splits the bodies out behind
 * `Engine.commands`/`Engine.runCommand`; until then they travel with their
 * registration rather than being cut apart by a second dependency pass
 * (engine-extraction.md §c, PR-03 "Out of scope").
 *
 * This is the adapter, so `api.` is allowed here; `engine/**` never sees it.
 */

import { randomUUID } from "node:crypto";
import { buildControlPlaneProjection } from "../../lib/control-plane-projection.js";
import { buildCriticalReplyCommand } from "../../lib/critical-reply-intent.js";
import { assignShortRefs, resolveShortRef, translateType } from "../../lib/critical-review.js";
import { readGcReport } from "../../lib/dashboard-operations.js";
import { largestKnownAgentCount, readPluginConfigFile } from "../../lib/dashboard-settings.js";
import { emotionEmoji } from "../../lib/emotion.js";
import { EPISTEMIC_STATUSES, isLegalEpistemicTransition, normalizeEpistemicStatus } from "../../lib/epistemic-status.js";
import { explainResults, renderExplanation } from "../../lib/explainability.js";
import { catalogModelIds, grantModelPermission } from "../../lib/featureModels.js";
import { recordFeedback } from "../../lib/feedback-log.js";
import { pickTone, resolveLocale, t } from "../../lib/i18n.js";
import { INPUT_LIMITS, validateCommandArgs, validateCorrectionText, validateSemanticCommandArgs } from "../../lib/input-limits.js";
import { sanitizeMemoryTextForPrompt } from "../../lib/memory-context-sanitize.js";
import { applyRetrievalReinforcement } from "../../lib/memory-dynamics.js";
import { resolveHostCommandMemoryContext, resolveSessionOwnerMemoryContext } from "../../lib/memory-request-context.js";
import { embeddingDimensionProfiles } from "../../lib/providers/dimensions.js";
import { checkRuntimePressure } from "../../lib/runtime-pressure-gate.js";
import { safeUpdate } from "../../lib/safe-update.js";
import { createConfirmation, isAuthorized } from "../../lib/security.js";
import { normalizeCommandInput } from "../../lib/semantic-input.js";
import { resolveEffectiveConfig } from "../../lib/setup/config-contract.js";
import { createCompactionRunner, isPartitionId } from "../../lib/setup/control-ui-compaction.js";
import { registerControlUiRuntime } from "../../lib/setup/control-ui-plugin-runtime.js";
import { applyControlUiWriteAction, createCaptureChunkingMutator, createConfirmationStore, createEmbeddingProfileMutator, createFeatureModelMutator, createFormTokenStore, createRerankerMutator, createSettingMutator, rerankerKeyConfigured } from "../../lib/setup/control-ui-write.js";
import { registerFeatureCronNativeDispatch } from "../../lib/setup/feature-cron-plugin-runtime.js";
import { resolveAgentWorkspaceDir } from "../../lib/setup/memory-host-runtime.js";
import { describeVaultCandidates, registerObsidianVaultRuntime } from "../../lib/setup/obsidian-vault-plugin-runtime.js";
import { registerReembeddingRuntime } from "../../lib/setup/reembedding-plugin-runtime.js";
import { registerWorkspacePolicyRuntime } from "../../lib/setup/workspace-policy-plugin-runtime.js";
import { safeUuid } from "../../lib/sql-safety.js";
import { listFeatures, renderFeatureList, renderToggleResult, toggleFeature } from "../../lib/telegram-commands/feature-toggle.js";
import { correctCard, forgetCard, parseCorrection, renderCandidateChoice, resolveCandidates } from "../../lib/telegram-commands/memory-edit.js";
import { formatResults as formatMemoryResults, parseMemoryFeedback, parseQuery as parseMemoryQuery, queryMemoryAcrossAccessPools } from "../../lib/telegram-commands/memory-query.js";
import { activateSkillProposal, rejectSkillProposal, rejectSkillProposalWithWorkshop, retireActiveSkill } from "../../lib/telegram-commands/skill-commands.js";
import { runSpeakerClearCommand, runSpeakerConfirmCommand, runSpeakerListCommand, runSpeakerNameCommand, runSpeakerProposalsCommand, runSpeakerRejectCommand } from "../../lib/telegram-commands/speaker-mapping.js";
import { collectStatusData } from "../../lib/telegram-commands/status-data.js";
import { renderStatus } from "../../lib/telegram-commands/status.js";

/**
 * Register every PLUR1BUS chat command on the OpenClaw plugin api.
 *
 * @param {Record<string, any>} ctx Registration context: the engine context
 *   plus `api`, `host` and the `registerPluginCommand` wrapper.
 * @returns {Record<string, Function>} The ten command bodies and helpers that
 *   `index.js` declares as `let` above `createPlur1busCommandRunner(…)` and
 *   rebinds from this return value; PR-03f's thunks read them at command time.
 */
export function registerChatCommands(ctx) {
  const {
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
  } = ctx;

  if (typeof api.registerGatewayMethod === "function" && typeof api.registerCli === "function") {
    registerFeatureCronNativeDispatch({
      api,
      runFeatureCommand: (commandCtx) => runPlur1busCommand(commandCtx),
      runOperatorCommand,
    });
  }

  const plur1busCommands = [
    { name: "plur1bus", description: "Show PLUR1BUS memory commands.", acceptsArgs: true, prefixTokens: [] },
    { name: "plur1bus_start", description: "Show PLUR1BUS status and onboarding guidance.", acceptsArgs: false, prefixTokens: ["start"] },
    { name: "plur1bus_temperament", description: "Show or set the agent's emotional temperament.", acceptsArgs: true, prefixTokens: ["temperament"] },
    { name: "plur1bus_persona", description: "Show or (re)generate the agent's persona voice profile.", acceptsArgs: true, prefixTokens: ["persona"] },
    { name: "plur1bus_status", description: "Show PLUR1BUS memory status.", acceptsArgs: true, prefixTokens: ["status"] },
    { name: "plur1bus_doctor", description: "Run PLUR1BUS diagnostics.", acceptsArgs: true, prefixTokens: ["doctor"] },
    { name: "plur1bus_state", description: "Show PLUR1BUS system state.", acceptsArgs: false, prefixTokens: ["state"] },
    { name: "plur1bus_enable", description: "Enable a PLUR1BUS feature.", acceptsArgs: true, prefixTokens: ["enable"] },
    { name: "plur1bus_disable", description: "Disable a PLUR1BUS feature.", acceptsArgs: true, prefixTokens: ["disable"] },
    { name: "plur1bus_memory", description: "Recall memories via PLUR1BUS.", acceptsArgs: true, prefixTokens: ["memory"] },
    { name: "plur1bus_forget", description: "Forget a memory via PLUR1BUS.", acceptsArgs: true, prefixTokens: ["forget"] },
    { name: "plur1bus_correct", description: "Correct a memory via PLUR1BUS.", acceptsArgs: true, prefixTokens: ["correct"] },
    { name: "plur1bus_critical", description: "Review PLUR1BUS critical memories.", acceptsArgs: true, prefixTokens: ["critical"] },
    { name: "plur1bus_dashboards", description: "Build PLUR1BUS dashboards.", acceptsArgs: true, prefixTokens: ["obsidian", "dashboards", "build"] },
    { name: "plur1bus_conflicts", description: "Build PLUR1BUS conflict reports.", acceptsArgs: true, prefixTokens: ["obsidian", "conflicts", "build"] },
  ];
  for (const command of plur1busCommands) {
    registerPluginCommand({
      name: command.name,
      description: command.description,
      acceptsArgs: command.acceptsArgs ?? false,
      channels: ["telegram", "discord", "slack", "mattermost", "cron"],
      handler: (commandCtx) => {
        if (command.name === "plur1bus_memory") return runMemoryCommand(commandCtx);
        if (command.name === "plur1bus_forget") return runForgetCommand(commandCtx);
        if (command.name === "plur1bus_correct") return runCorrectCommand(commandCtx);
        if (command.name === "plur1bus_critical") return runCriticalCommand(commandCtx);
        return runPlur1busCommand(commandCtx, command.prefixTokens);
      },
    });
  }

  // ── /status, /enable, /disable (Top-Level, user-facing) ──
  // Diese Commands lesen die vollqualifizierte openclaw.json (mit
  // ".config." Schicht) und sind bewusst von den /plur1bus_*
  // Wartungs-Commands getrennt.
  const runStatusCommand = async (commandCtx, suppliedMemoryCtx = null) => {
    try {
      const memoryCtx = suppliedMemoryCtx || await resolveRegisteredMemoryContext(commandCtx);
      const denied = await checkAuth(memoryCtx, { chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const agentId = memoryCtx.agentId;
      const mood = emotionalPool.describe(agentId);
      let cardCount = null;
      try {
        cardCount = await pool.withDb(agentId, async (db) => {
          // Ein frisch geoeffneter Store hat noch keine Tabelle; ohne
          // init() stand bei Bernhardine "unknown cards" (09.09.2026).
          if (!db?.table && typeof db?.init === "function") await db.init();
          if (!db?.table) return null;
          return db.table.countRows();
        });
      } catch (error) {
        // DB not available → cardCount stays null
        host.logger.debug(`memory-lancedb-namespaced: status card count unavailable for agent=${agentId}: ${String(error)}`);
      }
      const data = collectStatusData({
        memoryStats: { cardCount, lastUpdateMinutes: null },
        emotional: mood ? { emoji: emotionEmoji(mood.dominant), label: t(`emotion.${mood.dominant}`, { lang, tone }), intensity: mood.intensity } : null,
        llmResultCache: llmResultCache.getMetrics(agentId),
        // Command-Handler kennen nur commandCtx — ein Hook-`ctx` existiert
        // in diesem Scope nicht (ReferenceError "ctx is not defined").
        workspaceDir: memoryCtx.workspaceDir,
      });
      return { text: renderStatus(data, { lang, tone }) };
    } catch (err) {
      const { lang, tone } = resolveDenialLocale(commandCtx);
      return { text: t("plur1bus.status_failed", { lang, tone, vars: { error: err?.message || err } }) };
    }
  };

  const parseFeatureArg = (commandCtx) => {
    const raw = (commandCtx.args || "").trim();
    if (!raw) return "";
    return raw.split(/\s+/)[0];
  };

  // Operator opt-out for config-mutating chat commands. Host route facts
  // are resolved separately below; this switch remains an additional
  // deployment-level block for shared channels.
  const chatConfigCommandsBlocked = () => (cfg.security?.allowChatConfigCommands === false);

  const resolveDenialLocale = (commandCtx) => ({
    lang: resolveLocale({ ctx: commandCtx, messages: commandCtx?.messages || [], fallback: "en" }),
    tone: pickTone(null),
  });
  const checkMemoryAuth = (memoryCtx, commandCtx, opts = {}) => {
    const auth = isAuthorized(memoryCtx, cfg, { ...opts, chatKind: memoryCtx.chatKind });
    if (!auth.authorized) {
      return { text: t(`plur1bus.${auth.reason || "unauthorized"}`, resolveDenialLocale(commandCtx)) };
    }
    return null;
  };

  const checkAuth = async (memoryCtx, opts = {}, localeCtx = null) => {
    return checkMemoryAuth(memoryCtx, localeCtx, opts);
  };

  const checkArgsLength = (commandCtx) => {
    const v = validateCommandArgs(commandCtx.args);
    if (!v.ok) return { text: `❌ ${v.error}` };
    return null;
  };

  const checkSemanticArgsLength = (commandCtx) => {
    const v = validateSemanticCommandArgs(commandCtx.args);
    if (!v.ok) return { text: `❌ ${v.error}` };
    return null;
  };

  const runFeatureToggle = async (commandCtx, enable, suppliedMemoryCtx = null) => {
    const deniedLen = checkArgsLength(commandCtx);
    if (deniedLen) return deniedLen;
    const memoryCtx = suppliedMemoryCtx || await resolveRegisteredMemoryContext(commandCtx);
    const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
    if (denied) return denied;
    const { lang, tone } = resolveCommandLocale(commandCtx);
    if (chatConfigCommandsBlocked()) return { text: t("plur1bus.config_blocked", { lang, tone }) };
    const featureName = parseFeatureArg(commandCtx);
    if (!featureName) return { text: renderFeatureList({ lang, tone }) };
    try {
      const result = toggleFeature(featureName, enable, { lang, tone });
      return { text: renderToggleResult(result, { lang, tone }) };
    } catch (err) {
      return { text: t("plur1bus.toggle_failed", { lang, tone, vars: { error: err?.message || err } }) };
    }
  };

  registerPluginCommand({
    name: "state",
    description: "PLUR1BUS — system state (vault sync, sanity checks, ...). '/status' is reserved by OpenClaw.",

    acceptsArgs: false,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: runStatusCommand,
  });
  registerPluginCommand({
    name: "enable",
    description: `PLUR1BUS — Feature enable. Known: ${listFeatures().join(", ")}`,
    acceptsArgs: true,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: (commandCtx) => runFeatureToggle(commandCtx, true),
  });
  registerPluginCommand({
    name: "disable",
    description: `PLUR1BUS — Feature disable. Known: ${listFeatures().join(", ")}`,
    acceptsArgs: true,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: (commandCtx) => runFeatureToggle(commandCtx, false),
  });

  registerPluginCommand({
    name: "speaker",
    description: "PLUR1BUS — Speaker naming. /speaker list | name <label> <name> | proposals | confirm <label> | reject <label> | clear <label>",
    acceptsArgs: true,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: async (commandCtx) => {
      const deniedLen = checkArgsLength(commandCtx);
      if (deniedLen) return deniedLen;
      const memoryCtx = await resolveRegisteredMemoryContext(commandCtx);
      const denied = await checkAuth(memoryCtx, { chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
      const { lang } = resolveCommandLocale(commandCtx);
      const agentId = memoryCtx.agentId;
      const sub = (commandCtx.args || "").trim().split(/\s+/)[0]?.toLowerCase() || "list";
      const rest = (commandCtx.args || "").trim().slice(sub.length).trim();
      const subCtx = { ...commandCtx, args: rest };
      let speakerAuth = () => null;
      if (["name", "confirm", "reject", "clear"].includes(sub)) {
        const denied = checkMemoryAuth(memoryCtx, commandCtx, { destructive: true });
        if (denied) return denied;
        speakerAuth = (ctx, opts) => checkMemoryAuth(memoryCtx, ctx, opts);
      }
      switch (sub) {
        case "name":
          return runSpeakerNameCommand(subCtx, agentId, speakerAuth, { lang });
        case "proposals":
          return runSpeakerProposalsCommand(agentId, { lang });
        case "confirm":
          return runSpeakerConfirmCommand(subCtx, agentId, speakerAuth, { lang });
        case "reject":
          return runSpeakerRejectCommand(subCtx, agentId, speakerAuth, { lang });
        case "clear":
          return runSpeakerClearCommand(subCtx, agentId, speakerAuth, { lang });
        case "list":
        default:
          return runSpeakerListCommand(agentId, { lang });
      }
    },
  });

  const resolveRegisteredMemoryContext = (commandCtx, options = {}) => resolveHostCommandMemoryContext(commandCtx, {
    resolveAgentWorkspaceDir: (config, agentId) => host.runtime.agent.resolveAgentWorkspaceDir(config, agentId),
    workspaceAliases: memoryWorkspaceAliases,
    routingLoader: hostRoutingLoader,
    requireConversation: options.requireConversation !== false,
    requireWorkspace: options.requireWorkspace === true,
    requireUser: options.requireUser === true,
    // Bind conversation identity to the persisted session, not to the id
    // the host minted for this one call (see resolveHostCommandMemoryContext).
    resolveSessionEntry: async ({ agentId, sessionKey }) => {
      const getSessionEntry = host.runtime?.agent?.session?.getSessionEntry;
      if (typeof getSessionEntry !== "function") return { available: false };
      try {
        return { available: true, entry: getSessionEntry({ agentId, sessionKey, readConsistency: "latest" }) ?? null };
      } catch {
        // A lookup that throws is not evidence of anything; keep today's binding.
        return { available: false };
      }
    },
  });

  // An operator names a session; a direct chat session resolves to the
  // same identity-bound context its chat commands get (user, channel,
  // account, conversation principal), so the vault confirmation can be
  // driven from the CLI for that conversation. Other session kinds keep
  // the plain agent/workspace context.
  const resolveSessionPolicyMemoryContext = async ({ sessionKey, agentId: suppliedAgentId }) => {
    const sessionEntryFor = (agentId) => host.runtime.agent.session.getSessionEntry({
      agentId,
      sessionKey,
      readConsistency: "latest",
    });
    return resolveSessionOwnerMemoryContext({
      sessionKey,
      agentId: suppliedAgentId,
      config: api.config,
      routingLoader: hostRoutingLoader,
      workspaceAliases: memoryWorkspaceAliases,
      requireWorkspace: true,
      resolveAgentWorkspaceDir: async (_config, agentId) => {
        const sessionEntry = sessionEntryFor(agentId);
        return sessionEntry?.spawnedCwd
          || sessionEntry?.spawnedWorkspaceDir
          || sessionEntry?.worktree?.canonicalWorkspaceDir
          || await host.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
      },
      resolveSessionEntry: async ({ agentId }) => ({ available: true, entry: sessionEntryFor(agentId) }),
    });
  };

  // One-time vault confirmations live for the lifetime of the plugin
  // instance; a restart simply invalidates anything not yet redeemed.
  const obsidianVaultConfirmationStore = new Map();

  if (typeof api.registerGatewayMethod === "function" && typeof api.registerCli === "function") {
    registerWorkspacePolicyRuntime({
      api,
      store: workspacePolicyStore,
      guard: workspacePolicyGuard,
      resolveSessionMemoryContext: resolveSessionPolicyMemoryContext,
    });
    registerReembeddingRuntime({
      api,
      coordinator: reembeddingCoordinator,
      switchRuntime: reembeddingSwitchRuntime,
    });
    // The vault confirmation flow existed but had no caller, so every
    // install stayed pending with no way to finish setup.
    registerObsidianVaultRuntime({
      api,
      baseDbPath,
      confirmationStore: obsidianVaultConfirmationStore,
      resolveSessionMemoryContext: resolveSessionPolicyMemoryContext,
      getObsidianBridgeConfig: () => cfg.obsidianBridge || {},
    });
  } else {
    host.logger.warn(
      "memory-lancedb-namespaced: OpenClaw Gateway/CLI capabilities unavailable; workspace and reembedding runtime controls are disabled",
    );
  }

  // Dashboard write surface. Off by default: a page that can change the
  // running configuration is a different security posture from one that
  // cannot, so an operator has to ask for it. Without the host's config
  // mutation capability it stays off regardless.
  const controlUiWriteMode = reembeddingConfigMutationAvailable
    ? (cfg.controlUi?.writeActions === "reranker" || cfg.controlUi?.writeActions === "all"
        ? cfg.controlUi.writeActions
        : "off")
    : "off";
  if (cfg.controlUi?.writeActions && cfg.controlUi.writeActions !== "off" && controlUiWriteMode === "off") {
    host.logger.warn(
      "memory-lancedb-namespaced: controlUi.writeActions is set but OpenClaw config mutation is unavailable; the dashboard stays read-only",
    );
  }
  const controlUiWriteSurface = controlUiWriteMode === "off" ? null : (() => {
    const confirmations = createConfirmationStore();
    const setFeatureModel = createFeatureModelMutator({ api });
    const setCaptureChunking = createCaptureChunkingMutator({ api });
    const setSetting = createSettingMutator({
      api,
      validate: resolveEffectiveConfig,
      // The gc cap may never drop below what an agent currently holds;
      // the health snapshot is the same count the dashboard shows.
      maxAgentCards: async () => {
        const snapshot = await controlHealth.snapshot();
        return largestKnownAgentCount(snapshot);
      },
      modelCatalog: catalogModelIds,
      grantModel: grantModelPermission,
    });
    const setReranker = createRerankerMutator({ api });
    const setEmbeddingProfile = createEmbeddingProfileMutator({ api });
    const keyConfigured = () => rerankerKeyConfigured(cfg, process.env);
    // LanceDB fragment compaction per private partition, one at a time.
    // Only ids the health scan listed are accepted. The db-adapter owns
    // optimizeTable (the pool leases raw MemoryDB instances, which do
    // not have it); it resolves the partition's table itself and reports
    // `no-table` for a directory without one.
    const compaction = createCompactionRunner({
      logger: host.logger,
      knownPartitions: async () => {
        const snapshot = await controlHealth.snapshot();
        return (Array.isArray(snapshot?.cards?.byAgent) ? snapshot.cards.byAgent : [])
          .map((entry) => entry?.id)
          .filter((id) => isPartitionId(id));
      },
      optimize: async (partitionId) => (
        typeof memoryDbAdapter?.optimizeTable === "function"
          ? memoryDbAdapter.optimizeTable(partitionId, {})
          : { ok: false, reason: "optimize unavailable on this adapter" }
      ),
      onFinished: () => controlHealth.invalidate(),
    });
    return {
      mode: controlUiWriteMode,
      tokens: createFormTokenStore(),
      rerankerKeyConfigured: keyConfigured,
      compactionStatus: () => compaction.status(),
      applyAction: ({ action, form, mode }) => applyControlUiWriteAction({
        action,
        form,
        mode,
        deps: {
          logger: host.logger,
          confirmations,
          setReranker,
          setFeatureModel,
          setCaptureChunking,
          setSetting,
          setEmbeddingProfile,
          rerankerKeyConfigured: keyConfigured,
          preparedTarget: () => {
            const snapshot = modelPreparationCoordinator?.snapshot() || null;
            return snapshot?.state === "ready"
              ? { profileId: snapshot.profileId, fingerprintId: snapshot.targetFingerprintId }
              : null;
          },
          nextMigrationId: () => `ui-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
          planReembedding: (request) => reembeddingCoordinator.plan(request),
          applyReembedding: (request) => reembeddingCoordinator.apply(request),
          switchReembedding: (request) => reembeddingSwitchRuntime.switchGeneration(request),
          startCompaction: (request) => compaction.start(request),
          // 7.12.48: geminte Skills aus dem Dashboard freigeben,
          // ablehnen oder zurueckziehen.
          approveSkill: ({ agentId, proposalId }) => dashboardSkillAction(agentId, proposalId, ({ ledgerDir, memoryCtx, proposal }) => {
            if (!proposal) return { ok: false, reason: "not_found" };
            if (proposal.status === "pending_review" && !proposal.openClawWorkshop?.proposalId) return { ok: false, reason: "unbound" };
            return activateSkillProposal(ledgerDir, proposalId, skillActivationDeps(agentId, {
              actor: "operator-dashboard",
              actorTier: "human",
              reason: "skill-approve",
              memoryCtx,
            }));
          }),
          rejectSkill: ({ agentId, proposalId }) => dashboardSkillAction(agentId, proposalId, ({ ledgerDir, proposal }) => {
            if (!proposal) return { ok: false, reason: "not_found" };
            if (proposal.status !== "pending_review") return { ok: false, reason: "not_pending" };
            return proposal.openClawWorkshop?.proposalId
              ? rejectSkillProposalWithWorkshop(ledgerDir, proposalId, { agentId, logger: host.logger, skillWorkshop: openClawSkillWorkshop })
              : rejectSkillProposal(ledgerDir, proposalId);
          }),
          retireSkill: ({ agentId, proposalId }) => dashboardSkillAction(agentId, proposalId, ({ ledgerDir }) => (
            retireActiveSkill(ledgerDir, proposalId, { logger: host.logger })
          )),
        },
      }),
    };
  })();
  if (typeof api.registerGatewayMethod === "function") {
    registerControlUiRuntime({
      api,
      write: controlUiWriteSurface,
      getProjection: async () => {
        const workspacePolicies = workspacePolicyStore.list();
        const migrations = reembeddingStateStore.list();
        const currentMigration = migrations.at(-1) || null;
        const sourceTables = Array.isArray(currentMigration?.source?.tables)
          ? currentMigration.source.tables
          : [];
        const totalRows = sourceTables.reduce((sum, table) => (
          Number.isSafeInteger(table?.rowCount) && table.rowCount >= 0
            ? sum + table.rowCount
            : Number.MAX_SAFE_INTEGER
        ), 0);
        const sourceBytes = sourceTables.reduce((sum, table) => (
          Number.isSafeInteger(table?.estimatedBytes) && table.estimatedBytes >= 0
            ? sum + table.estimatedBytes
            : Number.MAX_SAFE_INTEGER
        ), 0);
        const targetDimensions = currentMigration?.target?.fingerprint?.dimensions;
        const targetVectorBytes = Number.isSafeInteger(totalRows)
          && Number.isSafeInteger(targetDimensions)
          && targetDimensions > 0
          && totalRows <= Math.floor(Number.MAX_SAFE_INTEGER / (targetDimensions * 4))
          ? totalRows * targetDimensions * 4
          : null;
        const estimatedBytes = Number.isSafeInteger(sourceBytes)
          && targetVectorBytes !== null
          && sourceBytes <= Number.MAX_SAFE_INTEGER - targetVectorBytes
          ? sourceBytes + targetVectorBytes
          : null;
        // Path-free by design; describeVaultCandidates only yields a count here.
        const obsidianCandidates = (() => {
          try { return describeVaultCandidates(cfg.obsidianBridge || {}).vaultPaths.length; }
          catch { return 0; }
        })();
        return buildControlPlaneProjection({
          config: cfg,
          hostConfig: api.config,
          obsidianVault: {
            configured: configuredObsidianWorkspaces.length > 0,
            configuredCount: configuredObsidianWorkspaces.length,
            confirmed: obsidianVaultsConfirmed === true,
            confirmationRequired: (cfg.obsidianBridge || {}).requireVaultPathConfirmation !== false,
            candidates: obsidianCandidates,
          },
          hooks: api.config?.plugins?.entries?.["memory-lancedb-namespaced"]?.hooks || {},
          capabilities: {
            skillWorkshop: Boolean(openClawSkillWorkshop),
            cronDispatch: cronDirectDispatchReady,
            reranker: Boolean(reranker),
          },
          providers: {
            embedding: {
              provider: normalizedEmbeddingCfg.provider,
              model: normalizedEmbeddingCfg.model,
              revision: normalizedEmbeddingCfg.local?.revision,
              dimensions: dimensions || vectorDim,
              fingerprint: activeEmbeddingFingerprintId,
            },
            reranker: reranker
              ? {
                  provider: rerankerCfg.provider,
                  model: reranker.model || rerankerCfg.model,
                  revision: rerankerCfg.local?.revision || rerankerCfg.fallbackRevision,
                }
              : null,
          },
          embeddingDimensionProfiles: embeddingDimensionProfiles({
            provider: normalizedEmbeddingCfg.provider,
            model: normalizedEmbeddingCfg.model,
            dimensions: dimensions || vectorDim,
          }),
          modelPreparation: modelPreparationCoordinator?.snapshot() || null,
          namespaces: namespaceLayout.mode === "named"
            ? namespaceLayout.recallReadNamespaces.map((id) => ({ id, dimensions: vectorDim }))
            : [{ id: "legacy-flat", dimensions: vectorDim }],
          migration: currentMigration
            ? {
                id: currentMigration.id,
                state: currentMigration.state,
                processed: currentMigration.cursor?.completedRows ?? 0,
                total: totalRows,
                ...(estimatedBytes !== null ? { estimatedBytes } : {}),
                targetFingerprint: currentMigration.target?.fingerprintId,
                targetDimensions,
                targetProbeStatus: currentMigration.target?.probeStatus,
                checkpointBytes: currentMigration.cursor?.bytes ?? 0,
                failureCode: currentMigration.error?.code ?? null,
              }
            : null,
          workspacePolicies,
          skillWorkshop: collectSkillWorkshopDashboard(),
          health: await controlHealth.snapshot(),
          // The gc job runs from the main agent and reports on every agent.
          gcReport: readGcReport(resolveAgentWorkspaceDir(api.config, "main")),
          pressure: checkRuntimePressure(cfg.runtime || {}),
          // Saved-vs-running marker: the file may be ahead of this plugin instance.
          fileConfig: readPluginConfigFile({ env: process.env }),
          env: process.env,
        });
      },
    });
    // Warm the health snapshot once the gateway is up and keep it warm,
    // so opening the tab never waits for a scan. Only the gateway does
    // this: a CLI process must not start a 20 s scan on its way out.
    if (typeof api.on === "function") {
      api.on("gateway_start", () => { controlHealth.start(); }, { timeoutMs: 5_000 });
      api.on("gateway_stop", () => { controlHealth.stop(); }, { timeoutMs: 5_000 });
    }
  } else {
    host.logger.warn(
      "memory-lancedb-namespaced: OpenClaw control status Gateway capability unavailable",
    );
  }

  const runMemoryCommand = async (commandCtx, suppliedMemoryCtx = null) => {
    try {
      const deniedLen = checkSemanticArgsLength(commandCtx);
      if (deniedLen) return deniedLen;
      const memoryCtx = suppliedMemoryCtx || await resolveRegisteredMemoryContext(commandCtx);
      const denied = await checkAuth(memoryCtx, { chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const input = (commandCtx.args || "").trim();
      const agentId = memoryCtx.agentId;
      const summarizer = makeQuerySummarizer(mergingEnabled ? recallQueryLlmCfg : null, host.logger, agentId, {
        runtimeLlm: commandCtx?.runtimeContext?.llm,
      });
      const normalized = await normalizeCommandInput({ kind: "recall-query", text: input, summarizer, logger: host.logger, lang, tone });
      if (normalized.error) return { text: `❌ ${normalized.error}` };
      const parsed = parseMemoryQuery(normalized.canonicalText);
      const items = await queryMemoryAcrossAccessPools({
        privatePool: pool,
        sharedPool: sharedMemoryPool,
        embeddings,
        agent: agentId,
        parsed,
        ctx: { ...memoryCtx, logger: host.logger },
      });
      if (parsed.explain) {
        const explanations = explainResults(items.map((r) => ({ entry: r, score: r.score ?? 0 })), parsed.topic);
        items.forEach((item, i) => {
          item.explanation = renderExplanation(explanations[i], lang);
        });
      }
      return { text: formatMemoryResults(items, parsed, { lang, tone, showIds: true }) };
    } catch (err) {
      const { lang, tone } = resolveDenialLocale(commandCtx);
      return { text: t("plur1bus.memory_failed", { lang, tone, vars: { error: err?.message || err } }) };
    }
  };

  const runForgetCommand = async (commandCtx, suppliedMemoryCtx = null) => {
    try {
      const deniedLen = checkSemanticArgsLength(commandCtx);
      if (deniedLen) return deniedLen;
      const memoryCtx = suppliedMemoryCtx || await resolveRegisteredMemoryContext(commandCtx);
      const denied = checkMemoryAuth(memoryCtx, commandCtx, { destructive: true });
      if (denied) return denied;
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const args = (commandCtx.args || "").trim();
      const agentId = memoryCtx.agentId;
      const summarizer = makeQuerySummarizer(mergingEnabled ? recallQueryLlmCfg : null, host.logger, agentId, {
        runtimeLlm: commandCtx?.runtimeContext?.llm,
      });

      // Completion: /forget confirm <token>
      const confirmation = parseConfirmationCommand(args);
      if (confirmation.requested) {
        if (!confirmation.nonce) {
          return { text: t("plur1bus.confirm_failed", { lang, tone, vars: { reason: confirmation.error || "invalid_format" } }) };
        }
        const { pending, error } = completePendingConfirmation({
          confirmationStore,
          confirmationIndex,
          expectedCommand: "forget",
          memoryCtx,
          nonce: confirmation.nonce,
        });
        if (error) return { text: t("plur1bus.confirm_failed", { lang, tone, vars: { reason: error } }) };
        const result = await forgetCard(memoryDbAdapter, agentId, pending.targetId, {
          lang,
          tone,
          workspaceDir: memoryCtx.workspaceDir,
          logger: host.logger,
          ctx: memoryCtx,
          baseDbPath,
          actor: memoryCtx?.userPrincipal || memoryCtx?.userId || "telegram:/forget",
          actorType: "human",
          reason: "user /forget command",
        });
        if (!result.ok) return { text: t("plur1bus.forget_failed", { lang, tone, vars: { error: result.error } }) };
        return { text: t("plur1bus.forget_done", { lang, tone, vars: { id: pending.targetId } }) };
      }

      // Initiation
      if (!args) return { text: t("plur1bus.forget_usage", { lang, tone }) };
      const normalized = await normalizeCommandInput({ kind: "forget-intent", text: args, summarizer, logger: host.logger, lang, tone });
      if (normalized.error) return { text: `❌ ${normalized.error}` };
      const candidates = await resolveCandidates(memoryDbAdapter, agentId, normalized.canonicalText, {
        ctx: memoryCtx,
      });
      if (candidates.none) {
        return { text: t("plur1bus.forget_not_found", { lang, tone, vars: { query: normalized.canonicalText } }) };
      }
      if (!candidates.unique) {
        const choice = renderCandidateChoice(candidates.candidates, "forget", { lang, tone });
        return { text: `${choice.text}\n\n${t("plur1bus.refine_hint", { lang, tone })}` };
      }
      const card = candidates.card;
      const confirmationIdentity = resolveConfirmationIdentity(memoryCtx);
      const confirm = createConfirmation({
        userId: confirmationIdentity.userId,
        chatId: confirmationIdentity.chatId,
        command: "forget",
        targetId: card.id,
      });
      rememberPendingConfirmation(confirmationStore, confirmationIndex, confirm);
      return { text: t("plur1bus.forget_confirm_text", { lang, tone, vars: { title: card.title || card.id, token: confirm.nonce } }) };
    } catch (err) {
      const { lang, tone } = resolveDenialLocale(commandCtx);
      return { text: t("plur1bus.forget_failed", { lang, tone, vars: { error: err?.message || err } }) };
    }
  };

  const runCorrectCommand = async (commandCtx, suppliedMemoryCtx = null) => {
    try {
      const deniedLen = checkSemanticArgsLength(commandCtx);
      if (deniedLen) return deniedLen;
      const memoryCtx = suppliedMemoryCtx || await resolveRegisteredMemoryContext(commandCtx);
      const denied = checkMemoryAuth(memoryCtx, commandCtx, { destructive: true });
      if (denied) return denied;
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const args = (commandCtx.args || "").trim();
      const agentId = memoryCtx.agentId;
      const summarizer = makeQuerySummarizer(mergingEnabled ? recallQueryLlmCfg : null, host.logger, agentId, {
        runtimeLlm: commandCtx?.runtimeContext?.llm,
      });

      // Completion: /correct confirm <token>
      const confirmation = parseConfirmationCommand(args);
      if (confirmation.requested) {
        if (!confirmation.nonce) {
          return { text: t("plur1bus.confirm_failed", { lang, tone, vars: { reason: confirmation.error || "invalid_format" } }) };
        }
        const { pending, error } = completePendingConfirmation({
          confirmationStore,
          confirmationIndex,
          expectedCommand: "correct",
          memoryCtx,
          nonce: confirmation.nonce,
        });
        if (error) return { text: t("plur1bus.confirm_failed", { lang, tone, vars: { reason: error } }) };

        // Step 12 (plan) — explicit trust-status transition surface,
        // folded into /correct's existing confirmation flow rather
        // than a new command. Same nonce machinery, same
        // checkMemoryAuth(destructive: true) gate already passed
        // above — no new authorization surface.
        if (pending.payload?.trustStatus) {
          const targetStatus = pending.payload.trustStatus;
          try {
            const result = await pool.withDb(agentId, async (rawDb) => {
              await rawDb.init();
              return applyEpistemicStatusToLanceDb(rawDb, pending.targetId, targetStatus, {
                ctx: memoryCtx,
                actor: memoryCtx?.userPrincipal || memoryCtx?.userId || "telegram:/correct",
                actorTier: "human",
                reason: "human review via /correct trust",
                // Authorized by reaching this point at all: destructive-op
                // auth already checked above, and the nonce-confirmation
                // round-trip (same UX as content correction) already
                // completed — the same security bar transitionEpistemicStatus()
                // requires for "trusted"/"invalidated" targets.
                authorized: true,
                workspaceDir: memoryCtx.workspaceDir,
              });
            });
            if (!result.ok) return { text: t("plur1bus.correct_trust_failed", { lang, tone, vars: { error: result.reason || "unknown" } }) };
            return { text: t("plur1bus.correct_trust_done", { lang, tone, vars: { id: pending.targetId, status: targetStatus } }) };
          } catch (err) {
            return { text: t("plur1bus.correct_trust_failed", { lang, tone, vars: { error: err?.message || String(err) } }) };
          }
        }

        const newText = pending.payload?.newText || "";
        if (!newText) return { text: t("plur1bus.confirm_failed", { lang, tone, vars: { reason: "missing_payload" } }) };
        const validated = validateCorrectionText(newText);
        if (!validated.ok) return { text: `❌ ${validated.error}` };
        const result = await correctCard(memoryDbAdapter, agentId, pending.targetId, newText, {
          lang,
          tone,
          workspaceDir: memoryCtx.workspaceDir,
          logger: host.logger,
          ctx: memoryCtx,
          updateMemory: async ({ id, newContent }) => {
            return pool.withDb(agentId, async (rawDb) => {
              await rawDb.init();
              const vector = await embeddings.embed(newContent, { agentId });
              const neoStore = getNeoStore(commandCtx, {});
              const { newId } = await safeUpdate(
                rawDb,
                id,
                { text: newContent, summary: newContent.split(/\r?\n/)[0].slice(0, 200), vector },
                {
                  updateSource: "telegram:/correct",
                  // payload.oldText ist der gespeicherte Vorher-Text (nicht
                  // der Suchbegriff), gekappt damit die Beweiszeile bei
                  // langen Erinnerungen nicht ausufert.
                  updateEvidence: pending.payload?.oldText
                    ? `User corrected "${sanitizeMemoryTextForPrompt(pending.payload.oldText, CORRECTION_PREVIEW_CHARS)}" to "${newContent}"`
                    : `User correction via /correct`,
                  confidence: 1,
                },
                {
                  neoStore,
                  logger: host.logger,
                  // Bewusst übersprungen: /correct ist eine per Nonce
                  // bestätigte Nutzeraktion, und der Bestätigungsdialog
                  // zeigt Alt- und Neu-Text im Klartext. Eine hohe
                  // semantische Drift ist hier also gewollt und informiert
                  // abgesegnet — das Gate würde legitime große Korrekturen
                  // mit einer Exception blockieren. Die Drift wird trotzdem
                  // als `semanticDrift` ins Reconsolidation-Event geschrieben.
                  skipDriftGate: true,
                  workspaceAliases: memoryCtx.workspaceAliases,
                },
              );
              // newId === id on idempotent skip; reinforcement still valid
              try {
                const correctedCard = await rawDb.getById(newId);
                if (correctedCard) {
                  await rawDb.update(newId, applyRetrievalReinforcement(correctedCard, Date.now()));
                }
              } catch (err) {
                host.logger.warn(`[/correct] reinforcement failed: ${err?.message}`);
              }
            });
          },
        });
        if (!result.ok) return { text: t("plur1bus.correct_failed", { lang, tone, vars: { error: result.error } }) };
        return { text: t("plur1bus.correct_done", { lang, tone, vars: { id: pending.targetId } }) };
      }

      // Initiation
      if (!args) return { text: t("plur1bus.correct_usage", { lang, tone }) };

      // Trust-status initiation: "/correct trust <status> <query>".
      // Deliberately a distinct, unambiguous prefix so it can never be
      // confused with parseCorrection's "<old> zu <new>" / "<old> -> <new>"
      // content-correction grammar.
      const trustMatch = args.match(/^trust\s+(\S+)\s+(.+)$/i);
      if (trustMatch) {
        const requestedStatus = trustMatch[1].toLowerCase();
        const trustQuery = trustMatch[2].trim();
        if (!EPISTEMIC_STATUSES.includes(requestedStatus)) {
          return { text: t("plur1bus.correct_trust_invalid_status", { lang, tone, vars: { status: trustMatch[1], valid: EPISTEMIC_STATUSES.join(", ") } }) };
        }
        const trustCandidates = await resolveCandidates(memoryDbAdapter, agentId, trustQuery, { ctx: memoryCtx });
        if (trustCandidates.none) {
          return { text: t("plur1bus.correct_not_found", { lang, tone, vars: { query: trustQuery } }) };
        }
        if (!trustCandidates.unique) {
          const choice = renderCandidateChoice(trustCandidates.candidates, "correct", { lang, tone });
          return { text: `${choice.text}\n\n${t("plur1bus.refine_hint", { lang, tone })}` };
        }
        const trustCard = trustCandidates.card;
        const currentStatus = normalizeEpistemicStatus(trustCard.epistemicStatus);
        if (!isLegalEpistemicTransition(currentStatus, requestedStatus, "human")) {
          return { text: t("plur1bus.correct_trust_illegal_transition", { lang, tone, vars: { from: currentStatus, to: requestedStatus } }) };
        }
        const trustConfirmationIdentity = resolveConfirmationIdentity(memoryCtx);
        const trustConfirm = createConfirmation({
          userId: trustConfirmationIdentity.userId,
          chatId: trustConfirmationIdentity.chatId,
          command: "correct",
          targetId: trustCard.id,
        });
        trustConfirm.payload = { trustStatus: requestedStatus, oldStatus: currentStatus };
        rememberPendingConfirmation(confirmationStore, confirmationIndex, trustConfirm);
        return { text: t("plur1bus.correct_trust_confirm_text", { lang, tone, vars: {
          title: trustCard.title || trustCard.id,
          from: currentStatus,
          to: requestedStatus,
          token: trustConfirm.nonce,
        } }) };
      }

      const parsed = parseCorrection(args);
      if (!parsed) {
        return { text: t("plur1bus.correct_no_separator", { lang, tone }) };
      }
      const [oldNorm, newNorm] = await Promise.all([
        normalizeCommandInput({ kind: "correction-old", text: parsed.old, summarizer, logger: host.logger, lang, tone }),
        normalizeCommandInput({
          kind: "correction-new",
          text: parsed.new,
          summarizer,
          maxDirectChars: INPUT_LIMITS.CORRECTION_TEXT,
          logger: host.logger,
          lang,
          tone,
        }),
      ]);
      if (oldNorm.error) return { text: `❌ ${oldNorm.error}` };
      if (newNorm.error) return { text: `❌ ${newNorm.error}` };
      const validatedCanonicalCorrection = validateCorrectionText(newNorm.canonicalText);
      if (!validatedCanonicalCorrection.ok) return { text: `❌ ${validatedCanonicalCorrection.error}` };
      const candidates = await resolveCandidates(memoryDbAdapter, agentId, oldNorm.canonicalText, {
        ctx: memoryCtx,
      });
      if (candidates.none) {
        return { text: t("plur1bus.correct_not_found", { lang, tone, vars: { query: oldNorm.canonicalText } }) };
      }
      if (!candidates.unique) {
        const choice = renderCandidateChoice(candidates.candidates, "correct", { lang, tone });
        return { text: `${choice.text}\n\n${t("plur1bus.refine_hint", { lang, tone })}` };
      }
      const card = candidates.card;
      const confirmationIdentity = resolveConfirmationIdentity(memoryCtx);
      const confirm = createConfirmation({
        userId: confirmationIdentity.userId,
        chatId: confirmationIdentity.chatId,
        command: "correct",
        targetId: card.id,
      });
      // `oldText` ist der tatsächlich gespeicherte Inhalt, NICHT der
      // Suchbegriff des Nutzers. Der Suchbegriff findet die Karte nur
      // unscharf (resolveCandidates ohne Mindestscore), also muss der
      // Nutzer vor dem Bestätigen sehen, was er wirklich überschreibt —
      // ein 80-Zeichen-Titel reicht dafür nicht. Gleichzeitig protokolliert
      // `updateEvidence` damit den echten Vorher-Zustand statt der Suchanfrage.
      confirm.payload = { newText: newNorm.canonicalText, oldText: card.text || card.summary || "" };
      rememberPendingConfirmation(confirmationStore, confirmationIndex, confirm);
      return { text: t("plur1bus.correct_confirm_text", { lang, tone, vars: {
        title: card.title || card.id,
        oldText: sanitizeMemoryTextForPrompt(confirm.payload.oldText, CORRECTION_PREVIEW_CHARS),
        newText: sanitizeMemoryTextForPrompt(newNorm.canonicalText, CORRECTION_PREVIEW_CHARS),
        token: confirm.nonce,
      } }) };
    } catch (err) {
      const { lang, tone } = resolveDenialLocale(commandCtx);
      return { text: t("plur1bus.correct_failed", { lang, tone, vars: { error: err?.message || err } }) };
    }
  };

  /**
   * Critical-Memory-Review: Listenansicht und die Aktionen accept /
   * reject / edit über Kurzreferenzen (oder vollständige UUID als
   * Kompatibilitätsfallback). Accept/Reject/Edit teilen denselben
   * Resolver. Reject ist nicht-destruktiv (verwirft nur die besondere
   * Kennzeichnung). Löschen/Archivieren bleibt die getrennte, bestätigte
   * /forget-Aktion.
   */
  const runCriticalCommand = async (commandCtx, suppliedMemoryCtx = null) => {
    try {
      const deniedLen = checkSemanticArgsLength(commandCtx);
      if (deniedLen) return deniedLen;
      const memoryCtx = suppliedMemoryCtx || await resolveRegisteredMemoryContext(commandCtx);
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const agentId = memoryCtx.agentId;
      let tokens = (commandCtx.args || "").trim().split(/\s+/).filter(Boolean);
      if ((tokens[0] || "").toLowerCase() === "critical") tokens = tokens.slice(1);
      const subKey = (tokens[0] || "").toLowerCase();
      const ref = tokens[1] || "";

      let pending = [];
      try {
        // ctx erzwingt die Per-Karten-ACL. Der Filter läuft VOR
        // assignShortRefs, damit eine fremde Karte gar keine Kurzreferenz
        // bekommt — Liste, accept, reject und edit sind damit gleichzeitig
        // abgedeckt (edit gab zuvor card.title aus, also echten Inhalt).
        pending = await memoryDbAdapter.findPendingCriticalReviews(agentId, { ctx: memoryCtx });
      } catch (err) {
        host.logger.warn(`plur1bus critical[${agentId}]: findPendingCriticalReviews failed: ${err.message}`);
      }
      const refMap = assignShortRefs((pending || []).map((c) => c.id));

      // Listenansicht. `list` ist in isSensitiveChatRead bereits
      // autorisiert und muss denselben Pfad nehmen wie der leere subKey —
      // sonst landet es im Usage-Zweig.
      if (!subKey || subKey === "list") {
        const denied = await checkAuth(memoryCtx, { chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        if (!pending || pending.length === 0) {
          return { text: t("critical.list_empty", { lang, tone }) };
        }
        const lines = [t("critical.list_headline", { lang, tone })];
        pending.forEach((card, index) => {
          lines.push(t("critical.list_item", {
            lang, tone,
            vars: { index: index + 1, ref: refMap.get(card.id) || "", type: translateType(card.type, lang) },
          }));
        });
        lines.push("", t("critical.usage", { lang, tone }));
        return { text: lines.join("\n") };
      }

      if (!["accept", "reject", "edit"].includes(subKey)) {
        return { text: t("critical.usage", { lang, tone }) };
      }

      // Mutation → destructive Auth (fail-closed in Gruppen/ohne Whitelist).
      const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;

      if (!ref) return { text: t("critical.usage", { lang, tone }) };

      // Bulk: `accept all`, `reject all`, or several references at once.
      // Each reference resolves against the same authorized pending set;
      // unknown or ambiguous ones are reported, the rest is applied.
      const refs = tokens.slice(1);
      const wantsAll = refs.length === 1 && refs[0].toLowerCase() === "all";
      if (subKey !== "edit" && (wantsAll || refs.length > 1)) {
        if (!pending || pending.length === 0) return { text: t("critical.list_empty", { lang, tone }) };
        const targets = [];
        const skipped = [];
        if (wantsAll) {
          for (const card of pending) targets.push(card.id);
        } else {
          for (const candidate of refs) {
            const one = resolveShortRef(candidate, pending);
            if (one.ok && !targets.includes(one.id)) targets.push(one.id);
            else if (!one.ok) skipped.push(candidate);
          }
        }
        if (targets.length === 0) return { text: t("critical.not_found", { lang, tone, vars: { ref: refs.join(", ") } }) };
        let done = 0;
        const failed = [];
        for (const id of targets) {
          const result = subKey === "accept"
            ? await memoryDbAdapter.markCriticalAccepted(agentId, id)
            : await memoryDbAdapter.markCriticalRejected(agentId, id);
          if (result?.ok) done += 1;
          else failed.push(refMap.get(id) || id.slice(-5));
        }
        const lines = [t(subKey === "accept" ? "critical.bulk_accepted" : "critical.bulk_rejected", { lang, tone, vars: { count: done } })];
        if (skipped.length > 0) lines.push(t("critical.bulk_skipped", { lang, tone, vars: { refs: skipped.join(", ") } }));
        if (failed.length > 0) lines.push(t("critical.failed", { lang, tone, vars: { error: failed.join(", ") } }));
        return { text: lines.join("\n") };
      }

      const resolved = resolveShortRef(ref, pending || []);
      if (!resolved.ok) {
        if (resolved.error === "ambiguous") {
          const suggestions = (resolved.suggestions || []).join(" oder ");
          return { text: t("critical.ambiguous", { lang, tone, vars: { ref, suggestions } }) };
        }
        if (resolved.error === "invalid_format") {
          return { text: t("critical.invalid_ref", { lang, tone }) };
        }
        return { text: t("critical.not_found", { lang, tone, vars: { ref } }) };
      }
      const fullId = resolved.id;

      if (subKey === "accept") {
        const result = await memoryDbAdapter.markCriticalAccepted(agentId, fullId);
        if (!result?.ok) return { text: t("critical.failed", { lang, tone, vars: { error: result?.error || "unknown" } }) };
        return { text: t("critical.accepted", { lang, tone }) };
      }
      if (subKey === "reject") {
        const result = await memoryDbAdapter.markCriticalRejected(agentId, fullId);
        if (!result?.ok) return { text: t("critical.failed", { lang, tone, vars: { error: result?.error || "unknown" } }) };
        return { text: t("critical.rejected", { lang, tone }) };
      }
      // edit → in den vorhandenen sicheren Korrekturablauf führen.
      const card = (pending || []).find((c) => c.id === fullId);
      const title = card?.title || "";
      const command = title
        ? `/plur1bus correct ${title} zu <korrigierter Text>`
        : "/plur1bus correct <Beschreibung> zu <korrigierter Text>";
      return { text: t("critical.edit_hint", { lang, tone, vars: { command } }) };
    } catch (err) {
      const { lang, tone } = resolveDenialLocale(commandCtx);
      return { text: t("critical.failed", { lang, tone, vars: { error: err?.message || err } }) };
    }
  };

  // A quoted reply to a Critical Push ("bitte alle akzeptieren" under a
  // quoted push) is answered here, before the agent: the references come
  // out of the quote the host hands over, the decision out of the reply,
  // and the same authorized critical command does the work. Anything
  // less than an unambiguous decision falls through to the agent.
  // The host fires `before_dispatch` for a chat message (with the quoted
  // text as replyToBody) and `before_agent_reply` on the agent-runner
  // path; both are claiming hooks, so the same handler serves both and
  // whichever fires first with a quoted push answers.
  if (typeof api.on === "function" && cfg.criticalPush?.enabled !== false) {
    const answerQuotedCriticalReply = async (event, context) => {
      try {
        if (event?.isGroup === true) return undefined;
        const command = buildCriticalReplyCommand({
          body: typeof event?.body === "string" ? event.body : event?.content,
          replyToBody: event?.replyToBody,
        });
        if (!command) return undefined;
        const sessionKey = String(context?.sessionKey || event?.sessionKey || "");
        const agentId = /^agent:([^:]+):/.exec(sessionKey)?.[1];
        const channel = String(context?.channelId || event?.channel || "");
        const senderId = String(context?.senderId ?? event?.senderId ?? "");
        const conversationId = String(context?.conversationId ?? "");
        if (!agentId || !channel || !senderId || !conversationId) return undefined;
        const target = `${channel}:${conversationId}`;
        const result = await runCriticalCommand({
          args: command.args,
          lang: command.lang,
          agentId,
          sessionKey,
          channel,
          accountId: context?.accountId,
          senderId,
          from: target,
          to: target,
          config: api.config,
          getCurrentConversationBinding: () => null,
          message: { from: { id: senderId }, chat: { id: conversationId, type: "private" } },
        });
        const text = typeof result?.text === "string" ? result.text : "";
        if (!text) return undefined;
        host.logger.info(`plur1bus critical[${agentId}]: quoted-reply ${command.action} for ${command.refs.length} reference(s)`);
        return { handled: true, text, reply: { text } };
      } catch (error) {
        host.logger.warn(`memory-lancedb-namespaced: critical quoted-reply handling failed: ${error?.message || error}`);
        return undefined;
      }
    };
    for (const hookName of ["before_dispatch", "before_agent_reply"]) {
      try {
        api.on(hookName, answerQuotedCriticalReply);
      } catch (error) {
        host.logger.warn(`memory-lancedb-namespaced: could not listen on ${hookName}: ${error?.message || error}`);
      }
    }
  }

  /** Share a private memory into the bound workspace or user pool. */
  const runShareCommand = async (commandCtx) => {
    const { lang, tone } = resolveCommandLocale(commandCtx);
    const fail = (key, vars = {}) => ({ text: t(key, { lang, tone, vars }) });
    const sourceDenied = (error) => /^(?:share\.(?:card_not_found|source_not_live|source_scope_denied|source_owner_conflict|source_changed)|access denied:)/.test(String(error || ""));
    try {
      const deniedLen = checkArgsLength(commandCtx);
      if (deniedLen) return deniedLen;
      const raw = String(commandCtx?.args || "").trim();
      // Share deliberately accepts only its documented space-separated form;
      // other commands retain their existing confirmation grammar.
      const requestedConfirmation = /^confirm(?:\s|:|$)/i.test(raw);
      const confirmationMatch = raw.match(/^confirm\s+([0-9a-fA-F-]+)$/i);
      let confirmation = { requested: requestedConfirmation, nonce: "", error: "invalid_format" };
      if (confirmationMatch) {
        try { confirmation = { requested: true, nonce: safeUuid(confirmationMatch[1]) }; } catch {}
      }
      if (confirmation.requested) {
        if (!confirmation.nonce) return fail("plur1bus.confirm_failed", { reason: confirmation.error || "invalid_format" });
        // First bind the redeeming request to its host-authenticated context.
        let memoryCtx = await resolveRegisteredMemoryContext(commandCtx);
        let denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const confirmationIdentity = resolveConfirmationIdentity(memoryCtx);
        emitCommandRuntimeHook("onShareConfirmationIdentity", {
          phase: "complete",
          identity: confirmationIdentity,
          rawChatId: memoryCtx.chatId,
        });
        const completed = completePendingConfirmation({
          confirmationStore, confirmationIndex, expectedCommand: "share", memoryCtx, nonce: confirmation.nonce,
        });
        if (completed.error) return fail("plur1bus.confirm_failed", { reason: completed.error });
        const targetScope = completed.pending.payload?.targetScope;
        const sourceId = completed.pending.payload?.sourceId;
        if (!['workspace', 'user'].includes(targetScope) || !safeUuid(sourceId)) return fail("plur1bus.confirm_failed", { reason: "invalid_payload" });
        // Re-resolve and re-authorize after redemption before touching the source writer.
        memoryCtx = await resolveRegisteredMemoryContext(commandCtx, {
          requireWorkspace: targetScope === "workspace", requireUser: targetScope === "user",
        });
        denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const result = await registeredShareCard(pool, sharedMemoryPool, embeddings, memoryCtx.agentId, sourceId, {
          targetScope, allowSensitiveShare: true, ctx: memoryCtx, logger: host.logger,
        });
        if (!result.ok) return fail(sourceDenied(result.error) ? "plur1bus.share_not_found" : "plur1bus.share_failed");
        return fail("plur1bus.share_done", { id: result.sharedId });
      }

      const parts = raw.split(/\s+/).filter(Boolean);
      if (parts.length < 1 || parts.length > 2 || (parts.length === 2 && parts[1] !== "--user")) return fail("plur1bus.share_usage");
      let sourceId;
      try { sourceId = safeUuid(parts[0]); } catch { return fail("plur1bus.share_usage"); }
      const targetScope = parts[1] === "--user" ? "user" : "workspace";
      const memoryCtx = await resolveRegisteredMemoryContext(commandCtx, {
        requireWorkspace: targetScope === "workspace", requireUser: targetScope === "user",
      });
      const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
      const result = await registeredShareCard(pool, sharedMemoryPool, embeddings, memoryCtx.agentId, sourceId, {
        targetScope, ctx: memoryCtx, logger: host.logger,
      });
      if (result.ok) return fail("plur1bus.share_done", { id: result.sharedId });
      if (result.error?.startsWith("share.explicit approval required")) {
        const identity = resolveConfirmationIdentity(memoryCtx);
        if (!identity.userId) return fail("plur1bus.share_user_required");
        emitCommandRuntimeHook("onShareConfirmationIdentity", {
          phase: "create",
          identity,
          rawChatId: memoryCtx.chatId,
        });
        const pending = createConfirmation({ userId: identity.userId, chatId: identity.chatId, command: "share", targetId: sourceId });
        // Never retain source content in a command confirmation.
        pending.payload = { targetScope, sourceId };
        rememberPendingConfirmation(confirmationStore, confirmationIndex, pending);
        return fail("plur1bus.share_confirm_text", { token: pending.nonce });
      }
      return fail(sourceDenied(result.error) ? "plur1bus.share_not_found" : "plur1bus.share_failed");
    } catch (error) {
      return fail("plur1bus.share_failed");
    }
  };

  const runMemoryFeedbackCommand = async (commandCtx) => {
    try {
      const deniedLen = checkArgsLength(commandCtx);
      if (deniedLen) return deniedLen;
      const memoryCtx = await resolveRegisteredMemoryContext(commandCtx);
      const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const args = (commandCtx.args || "").trim();
      const parsed = parseMemoryFeedback(args);
      if (!parsed) {
        return { text: t("plur1bus.mf_usage", { lang, tone }) };
      }
      const workspaceDir = memoryCtx.workspaceDir || null;
      if (!workspaceDir) {
        return { text: t("plur1bus.mf_no_workspace", { lang, tone }) };
      }
      // Feedback nur fuer eine Erinnerung, die es gibt: bis 09.09.2026
      // nahm /mf jede wohlgeformte UUID an und schrieb sie ins
      // Feedback-Log, wo der Bericht sie dann als Top-Treffer zaehlte.
      // Geloeschte Karten bekommen dieselbe Meldung wie unbekannte —
      // kein Existenz-Orakel fuer Tombstones.
      const target = await memoryDbAdapter.getCard(memoryCtx.agentId, parsed.memoryId, { ctx: memoryCtx }).catch(() => null);
      if (!target || String(target.status || "") === "deleted") {
        return { text: t("plur1bus.mf_not_found", { lang, tone, vars: { id: parsed.memoryId } }) };
      }
      recordFeedback(workspaceDir, "", parsed.memoryId, parsed.feedback, {});
      return { text: t("plur1bus.mf_done", { lang, tone, vars: { id: parsed.memoryId, feedback: parsed.feedback } }) };
    } catch (err) {
      const { lang, tone } = resolveDenialLocale(commandCtx);
      return { text: t("plur1bus.mf_failed", { lang, tone, vars: { error: err?.message || err } }) };
    }
  };

  registerPluginCommand({
    name: "memory",
    description: "PLUR1BUS — recall memories (e.g. /memory this week, /memory about Eva)",
    acceptsArgs: true,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: runMemoryCommand,
  });
  registerPluginCommand({
    name: "mf",
    description: "PLUR1BUS — give feedback on a memory. Syntax: /mf <id> + (or -, ~)",
    acceptsArgs: true,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: runMemoryFeedbackCommand,
  });
  registerPluginCommand({
    name: "forget",
    description: "PLUR1BUS — delete a memory (archive-first)",
    acceptsArgs: true,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: runForgetCommand,
  });
  registerPluginCommand({
    name: "correct",
    description: "PLUR1BUS — edit a memory. Syntax: /correct <old> zu <new>",
    acceptsArgs: true,
    channels: ["telegram", "discord", "slack", "mattermost"],
    handler: runCorrectCommand,
  });
  for (const name of ["share", "teile"]) {
    registerPluginCommand({
      name,
      description: "PLUR1BUS — share a memory to the workspace or authenticated user pool",
      acceptsArgs: true,
      channels: ["telegram", "discord", "slack", "mattermost"],
      handler: runShareCommand,
    });
  }

  return {
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
  };
}
