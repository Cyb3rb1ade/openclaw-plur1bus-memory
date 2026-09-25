/**
 * engine/create-engine.js — the one construction path (spec 3.1, owner decision A).
 *
 * Was the construction half of index.js register(), moved verbatim in M1b-1
 * Task 13b. Every object it builds is a member of one EngineInternals; the
 * OpenClaw adapter registers views over it (engine/internals.js), a harness
 * or any other host uses the Engine surface returned at the end
 * (types/engine.d.ts, contract 1.5.0).
 *
 * OpenClaw-only construction inputs arrive as `host.capabilities`
 * (registrationMode, coordinatesLocalModelGeneration, resolvePath,
 * cronDirectDispatchReady, skillWorkshop, detectReactions,
 * createEmbeddingSelectionMutator, configMutationNotice, resolveNeoHooksConfig,
 * commandRuntimeHooks, handleObsidianBridgeCommand); every one has an inert
 * default, so a stub host constructs an engine too.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MEMORY_ORIGINS, MEMORY_SCOPES, categorizeMemoryWithReason } from "../lib/categorize.js";
import { computeMemoryImportance, shouldPromoteMemory } from "../lib/memory-fact-quality.js";
import { hasMeaningfulDifference, isSafeDuplicate, validateMergedTextPreservesFacts } from "../lib/memory-merge-safety.js";
import { featureModelOverrides } from "../lib/featureModels.js";
import { createWorkspacePolicyStore } from "../lib/workspace-policy.js";
import { createMemoryMaintenanceGate } from "../lib/memory-maintenance-gate.js";
import { resolveEmbeddingGenerationLayout } from "../lib/reembedding/generation-layout.js";
import { createMigrationStateStore } from "../lib/reembedding/state-store.js";
import { createLanceGenerationBackend } from "../lib/reembedding/lance-backend.js";
import { createReembeddingCoordinator } from "../lib/reembedding/coordinator.js";
import { createReembeddingSwitchRecovery, createReembeddingSwitchRuntime } from "../lib/reembedding/switch-runtime.js";
import { createGenerationRuntimeProbe } from "../lib/reembedding/runtime-probe.js";
import { createFailedModelPreparationCoordinator, createModelPreparationCoordinator } from "../lib/model-preparation/coordinator.js";
import { embeddingFingerprintId } from "../lib/reembedding/fingerprint.js";
import { embeddingFingerprintFromNormalizedConfig, redactedEmbeddingSecretRef } from "../lib/reembedding/runtime-config.js";
import { createControlPlaneHealthInspector, createControlPlaneHealthScan } from "../lib/control-plane-health.js";
import { createWorkspacePolicyGuard } from "../lib/workspace-policy-guard.js";
import { createObsidianBridgeService, discoverObsidianWorkspaces } from "../lib/obsidian-bridge.js";
import { handleObsidianBridgeCommand } from "../lib/obsidian-control-room.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";
import { isOwnedVaultConfirmed } from "../lib/obsidian-vault-authority.js";
import { getSharedDeferredDynamicsQueue } from "../lib/deferred-dynamics-queue.js";
import { archiveCard } from "../lib/telegram-commands/memory-edit.js";
import { validateMemoryText } from "../lib/input-limits.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { combineEpistemicStatusForMerge, normalizeEpistemicStatus } from "../lib/epistemic-status.js";
import { combineValidTimeForMerge, hasDisjointValidityWindows, normalizeCapturedValidityWindow, validateValidTimeInputFields } from "../lib/valid-time.js";
import { createLocalModelGenerationLifecycle } from "../lib/local-model-generation.js";
import { bindHostPaths } from "../lib/host-paths.js";
import { PLUGIN_ROOT } from "../lib/plugin-meta.js";
import { getFeatureCronsSetupHint } from "../lib/feature-crons-hint.js";
import { findProposalWorkspace } from "../lib/telegram-commands/skill-commands.js";
import { readProposals as readSkillProposals } from "../lib/jobs/skill-miner/proposal-writer.js";
import { collectSkillWorkshopProposals } from "../lib/setup/skill-workshop-dashboard.js";
import { pickTone, readSoulToneCached, resolveLocale, t } from "../lib/i18n.js";
import { PLUGIN_KEY, detectPendingFeatures, isApplyBlocked, reportDormantFeature } from "../lib/setup/feature-profiles.js";
import { PLUGIN_CONFIG_PATH, resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import { checkAccess } from "../lib/acl-middleware.js";
import { buildMemoryAccountTopology, buildMemoryWorkspaceAliases, createHostIncognitoSessionClassifier, createHostRoutingLoader, describePrimaryAgentIds, describeUserPoolLabels, describeWorkspacePoolLabels, getSharedMemoryTurnRouteRegistry, normalizeWorkspaceTarget, resolveMemoryRequestContext, resolveToolMemoryRequestContext, workspacePoolKey } from "../lib/memory-request-context.js";
import { appendDestructiveOpLog, resolveInside, safeAgentId, safeUuid } from "../lib/sql-safety.js";
import { measureControlHealthStorage } from "../lib/control-plane-storage.js";
import { appendTombstoneToRegistry, backfillCommittedTombstone, buildTombstone, findBlockingTombstoneForCapture } from "../lib/tombstone.js";
import { decideEpistemicStatusForCapture } from "../lib/epistemic-capture.js";
import { ensureEpistemicCutoff } from "../lib/epistemic-cutoff.js";
import { addTraceStoreDecision, createRecallDecisionTrace, textPreview } from "../lib/recall-decision-trace.js";
import { buildNeoWorkspaceAliases, createNeoStore, neoSessionKeysFromContext, searchNeoCandidatesGlobal, workspaceKeyFromContext } from "../lib/neo-arch.js";
import { getSharedNeoWorkerRuntime } from "../lib/neo-worker-runtime.js";
import { normalizeEmbeddingConfig, resolveLocalModelCacheDir } from "../lib/providers/config-normalize.js";
import { applyLegacyProviderDefaults } from "../lib/providers/legacy-provider-migration.js";
import { EMBEDDING_DIMENSIONS } from "../lib/providers/dimensions.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { ReloadSafeIpcScopedEmbeddingProvider, createScopedEmbeddingIpcServer } from "../lib/providers/scoped-embedding-ipc.js";
import { pinnedLocalModelProfile, validatePinnedModelArtifacts } from "../lib/providers/local-model-artifacts.js";
import { createConfiguredSecretInputResolver } from "../lib/providers/secret-input.js";
import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";
import { TimeoutError } from "../lib/with-timeout.js";
import { safeDebug, safeWarn } from "../lib/safe-logging.js";
import { LLM_ROUTE_KINDS, isLlmRouteAvailable, resolveFeatureLlmRoute } from "../lib/llm-router.js";
import { LLM_RESULT_CACHE_PURPOSES, createLlmResultCache, withLlmCallContext, withLlmResultCacheContext } from "../lib/llm-result-cache.js";
import { inferEmotionalValenceAsync, setEmotionConfig } from "../lib/emotion.js";
import { createEmotionalStatePool } from "../lib/emotional-state.js";
import { applyDynamicsDefaults } from "../lib/memory-dynamics.js";
import { applyRetroactiveInterference } from "../lib/retroactive-interference.js";
import { buildRemPartitions } from "../lib/dreaming/rem-dream.js";
import { MultiNamespacePool } from "../lib/multi-namespace-pool.js";
import { SharedMemoryPool } from "../lib/shared-memory-pool.js";
import { resolveNamespaceLayout } from "../lib/namespace-config.js";
import { createPlur1busCommandRunner } from "./commands/plur1bus-command.js";
import { createTurnCapture } from "./capture/capture-turn.js";
import { createPromptContextAssembler } from "./recall/assemble-prompt-context.js";
import { recallResult } from "./recall/recall-result.js";
import { buildSystemSupplement } from "./recall/system-supplement.js";
import { createMemoryTools } from "./tools/memory-tools.js";
import { createChannelRegistry, memoryContextFromPrincipal } from "./identity/principal.js";
import { createCheckpointStore } from "./checkpoint/checkpoint-store.js";
import { createJobRegistry } from "./jobs/job-registry.js";
import { dbg, getPluginLogger, runSpeakerProposalPipeline, setPluginLogger } from "./runtime/debug-log.js";
import { DEFAULT_BASE_DB_PATH, DEFAULT_MODEL, EPISODED_TURN_ID_MEMORY, MAX_POSTPROCESSING_RETRIES, MAX_PROMPT_REPLY_OUTCOME_READ_BYTES } from "./runtime/constants.js";
import { runSemanticDiscoveryBatches, selectSemanticDiscoveryWorkspaces } from "./runtime/semantic-discovery.js";
import { callLlm, callMergeCheck, withDeterministicLlmContext } from "./runtime/llm-calls.js";
import { commandOption, generateSummary, makeQuerySummarizer, normalizedLlmErrorClass, resolveConfiguredApiKey, resolveEnvVars, resolveOptionalEnvVars, summarizeForCapture } from "./runtime/env-config.js";
import { normalizeBoundedRecallInteger, resolveRuntimeRecallBudget, runMergedNamespaceRecall } from "./recall/namespace-recall.js";
import { applyEpistemicStatusToLanceDb, waitForTimeoutSettlement } from "./store/memory-db.js";
import { AgentDbPool } from "./store/agent-db-pool.js";
import { STORE_SCHEMA_VERSION, createStoreMigrator, writeStoreSchemaMarker } from "./store/schema-version.js";
import { CONTROL_HEALTH_CACHE_TTL_MS, CONTROL_HEALTH_FAILED_RETRY_MS, CONTROL_HEALTH_MAX_PARTITIONS, CONTROL_HEALTH_REFRESH_INTERVAL_MS, createControlHealthRowInspector, listControlHealthPartitions } from "./store/control-health.js";
import { KNOWLEDGE_LOCK_FILE, appendCurationLog, readKnowledgePendingSnapshot, removeKnowledgePending, trackKnowledgePending } from "./knowledge/knowledge-pending.js";
import { aggregateSkillMinerRuns, appendConflictLog, buildMaintenanceNudges, completePendingConfirmation, findNeoRecord, formatJsonCommandResult, formatKnownValidityLabel, rememberPendingConfirmation, resolveConfirmationIdentity, summarizeNeoStore, textSuggestsGroupOrigin } from "./commands/command-helpers.js";
import { createRuntimeRerankerProvider } from "./providers/runtime-reranker.js";
import { ENGINE_INTERNALS } from "./internals.js";
import { createResourceCloser } from "./lifecycle/close-resources.js";
import { flushMetrics } from "../lib/metrics.js";
import { createMemoryOpsContext } from "./memory-ops/context.js";
import { createMemoryRead } from "./memory-ops/read.js";
import { createMemoryWrite } from "./memory-ops/write.js";
import { memoryOpError } from "./memory-ops/errors.js";

// Nothing in this file otherwise reads the plugin's own package.json version
// (grepped repo-wide before adding this); the store schema marker records it
// alongside the schema version for forensic purposes, so it is read once,
// here, at module load.
const ENGINE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Build the engine: every store, provider, route, scheduler and command body
 * the old register() built, in the same order, with no host registration.
 *
 * @param {object} host HostServices (types/engine.d.ts, contract 1.5.0).
 * @param {object} config The plugin config (EngineConfig).
 * @param {{internals?: object}} [testOptions] Test-only: overrides applied to EngineInternals after construction.
 * @returns {object} Engine (types/engine.d.ts), plus the adapter-only internals seam (engine/internals.js).
 */
export function createEngine(host, config, testOptions = {}) {
  // Engine.events listeners. Every engine event already goes through
  // host.events.emit (engine/events.js); wrapping it once, before anything
  // reads `host`, feeds both the engine's own listeners and the host's.
  // Object.create keeps the host's lazy getters (runtime, llm) live.
  const listeners = new Map();
  const emit = (name, payload) => {
    for (const listener of listeners.get(name) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        host.logger.debug(`engine listener ${name} failed: ${String(error?.message || error)}`);
      }
    }
  };
  const hostEvents = host.events;
  host = Object.create(host, {
    events: {
      value: Object.freeze({
        emit: (name, payload) => {
          emit(name, payload);
          hostEvents?.emit?.(name, payload);
        },
      }),
      enumerable: true,
    },
  });
  const capabilities = host.capabilities ?? {};
  const resolvePath = typeof capabilities.resolvePath === "function" ? capabilities.resolvePath : (value) => value;
  const __pluginDir = PLUGIN_ROOT;
  const {
    commandRuntimeHooks = null,
    handleObsidianBridgeCommand: registeredObsidianCommandHandler = handleObsidianBridgeCommand,
  } = capabilities;
  const emitCommandRuntimeHook = (name, value) => {
    const hook = commandRuntimeHooks?.[name];
    if (hook !== undefined && typeof hook !== "function") {
      throw new TypeError(`commandRuntimeHooks.${name} must be a function when provided`);
    }
    return hook?.(value);
  };
  const rawPluginConfig = config || {};
  const namespacesExplicit = Object.hasOwn(rawPluginConfig, "namespaces");
  let cfg = resolveEffectiveConfig(rawPluginConfig);
  const coordinatesLocalModelGeneration = capabilities.coordinatesLocalModelGeneration === true;
  const requiresActiveSharedModelOwner = typeof capabilities.registrationMode === "string"
    && capabilities.registrationMode !== "full";
  const sharesActiveLocalModel = coordinatesLocalModelGeneration
    || requiresActiveSharedModelOwner;
  const localModelGeneration = createLocalModelGenerationLifecycle({
    enabled: coordinatesLocalModelGeneration,
  });
  const credentialResolver = createConfiguredSecretInputResolver({
    getConfig: () => host.runtime?.config?.current?.() || host.config(),
  });
  bindHostPaths(host.pathOverrides);
  setPluginLogger(host.logger);
  const cronDirectDispatchReady = capabilities.cronDirectDispatchReady === true;
  const openClawSkillWorkshop = capabilities.skillWorkshop ?? null;
  const detectReactionsCapabilityCached = capabilities.detectReactions ?? (async () => false);
  const baseDbPath = resolvePath(cfg.baseDbPath || DEFAULT_BASE_DB_PATH);
  const epistemicCutoffBoot = ensureEpistemicCutoff(baseDbPath);
  if (!epistemicCutoffBoot.ok) {
    host.logger.warn(`memory-lancedb-namespaced: epistemic cutoff unavailable (${epistemicCutoffBoot.reason})`);
  }
  const configuredNamespaceLayout = resolveNamespaceLayout(baseDbPath, cfg.namespaces || {}, {
    explicit: namespacesExplicit,
    path: `${PLUGIN_CONFIG_PATH}.namespaces`,
  });
  const providerMigration = applyLegacyProviderDefaults(cfg, { baseDbPath });
  cfg = providerMigration.config;
  const llmResultCache = createLlmResultCache({
    enabled: cfg.runtime?.llmResultCacheEnabled !== false,
    ttlMs: cfg.runtime?.llmResultCacheTtlMs,
    maxEntries: cfg.runtime?.llmResultCacheMaxEntries ?? 256,
    persist: cfg.runtime?.llmResultCachePersist === true,
    maxBytes: cfg.runtime?.llmResultCacheMaxBytes ?? 67_108_864,
    metrics: cfg.runtime?.llmResultCacheMetrics !== false,
    baseDbPath,
    logger: host.logger,
  });
  // 7.12.58: Hintergrund-Features ohne eigenes Modell folgten dem Hauptmodell
  // des Agenten. Episodenextraktion, Traumdeutung, Gesprächsanalyse und die
  // Verdichtung bekommen hier fest `{}` übergeben, können also gar kein
  // eigenes Modell tragen — sie verbrauchten damit das Kontingent des
  // teuersten Modells für Arbeit, die nichts vom laufenden Gespräch braucht.
  // `llmRouter.defaultModel` ist der gemeinsame Boden dafür. Ein
  // feature-eigenes Modell hat weiterhin Vorrang, und Features mit eigenem
  // Transport bleiben unberührt: dort wäre ein fremdes Modell am fremden
  // Endpunkt sinnlos.
  const featureDefaultModel = typeof cfg.llmRouter?.defaultModel === "string"
    && cfg.llmRouter.defaultModel.trim()
    ? cfg.llmRouter.defaultModel.trim()
    : "";
  const createFeatureRoute = (feature, featureConfig = {}) => {
    const routeConfig = { ...featureConfig };
    const hasOwnTransport = Boolean(routeConfig.baseUrl || routeConfig.apiKey || routeConfig.headers);
    if (featureDefaultModel && !hasOwnTransport
      && !(typeof routeConfig.model === "string" && routeConfig.model.trim())) {
      routeConfig.model = featureDefaultModel;
    }
    let credentialUnavailable = false;
    if (typeof routeConfig.apiKey === "string" && routeConfig.apiKey.trim()) {
      try {
        const unresolvedReference = routeConfig.apiKey.replace(/\$\{[^{}]+\}/g, "");
        if (unresolvedReference.includes("${")) {
          throw new Error("Malformed environment reference");
        }
        routeConfig.apiKey = resolveEnvVars(routeConfig.apiKey);
      } catch (_) {
        credentialUnavailable = true;
        delete routeConfig.apiKey;
      }
    }
    const route = resolveFeatureLlmRoute(routeConfig, {
      feature,
      agentModels: featureModelOverrides(cfg, feature),
      runtimeLlm: host.runtime?.llm,
      logger: host.logger,
      resultCache: llmResultCache,
      credentialUnavailable,
      // 7.12.55: Nur wenn der Betreiber es einschaltet, schreibt der Router
      // die redigierte Fehlermeldung in eine eigene Datei — nie ins Log.
      diagnosticsPath: cfg.llmRouter?.errorDiagnostics === true
        ? join(baseDbPath, "llm-router-errors.log")
        : "",
    });
    return isLlmRouteAvailable(route) ? route : null;
  };
  if (providerMigration.changed) {
    host.logger.info(
      `memory-lancedb-namespaced: applied local provider defaults for empty legacy install (${providerMigration.migrations.join(", ")})`
    );
  }

  const obsidianBridgeCfg = cfg.obsidianBridge || {};
  const configuredObsidianWorkspaces = obsidianBridgeCfg.enabled !== false
    ? discoverObsidianWorkspaces(obsidianBridgeCfg)
    : [];
  const obsidianVaultsConfirmed = configuredObsidianWorkspaces.length > 0
    && configuredObsidianWorkspaces.every((workspace) => {
      const workspaceIdentity = normalizeWorkspaceTarget(
        workspace.workspaceId,
        "Obsidian setup workspace",
      );
      return isOwnedVaultConfirmed({
        baseDbPath,
        memoryCtx: {
          agentId: workspace.agentId,
          workspaceIdentity,
          workspaceId: workspaceIdentity,
        },
        vaultPath: workspace.path,
      });
    });

  // Explicit-profile setup notices: protected receipts are the runtime truth;
  // the safety-gate config bit alone does not mean confirmation is still pending.
  const applyBlocked = isApplyBlocked(cfg, { vaultConfirmed: obsidianVaultsConfirmed });
  if (applyBlocked.blocked) {
    if (applyBlocked.reason === "pending_setup") {
      const pending = detectPendingFeatures(cfg, { vaultConfirmed: obsidianVaultsConfirmed });
      for (const p of pending) {
        // A feature the operator explicitly switched on and left unconfigured
        // is worth a warning. One that is merely on by default is not: with
        // opt-out that would warn every user on every start about something
        // they never asked for.
        reportDormantFeature(host.logger, {
          explicit: p.explicit,
          message: `memory-lancedb-namespaced: PENDING SETUP — ${p.feature}: ${p.reason}. Run /plur1bus start for the setup status.`,
        });
      }
    }
  }

  // Store schema version marker (E2 Task 2, contract 1.6.0): a fresh
  // baseDbPath (missing, or present but empty) starts current — there is
  // nothing on disk yet to migrate. An existing, non-empty store with no
  // marker stays at LEGACY_STORE_SCHEMA_VERSION ("0") until the owner runs
  // admin.migrate. This must run before anything else touches baseDbPath,
  // and writing a fresh marker must not change golden-prefix output (it
  // touches no LanceDB table).
  const baseDbPathIsFreshStore = !existsSync(baseDbPath)
    || readdirSync(baseDbPath).length === 0;
  if (baseDbPathIsFreshStore) {
    writeStoreSchemaMarker(baseDbPath, STORE_SCHEMA_VERSION, { engineVersion: ENGINE_VERSION });
  }
  const storeMigrator = createStoreMigrator({ baseDbPath, logger: host.logger, engineVersion: ENGINE_VERSION });

  const obsidianBridgeEnabled = obsidianBridgeCfg.enabled !== false;

  const embeddingCfg = cfg.embedding || {};
  const localModelCacheDir = resolveLocalModelCacheDir(embeddingCfg);
  const nonCommercialModelAccepted = cfg.modelPreparation?.acceptNonCommercialLicense === true;
  const normalizedEmbeddingCfg = normalizeEmbeddingConfig(embeddingCfg, {
    mode: "existing",
    acceptNonCommercialLicense: nonCommercialModelAccepted,
  });
  const apiKey = normalizedEmbeddingCfg.provider === "local-transformers"
    ? undefined
    : resolveConfiguredApiKey(normalizedEmbeddingCfg, "${OPENAI_API_KEY}");
  const model = normalizedEmbeddingCfg.model || DEFAULT_MODEL;
  const baseUrl = normalizedEmbeddingCfg.baseUrl;
  const dimensions = normalizedEmbeddingCfg.dimensions;
  const embeddingGenerationLayout = resolveEmbeddingGenerationLayout({
    stateRoot: configuredNamespaceLayout.baseDir,
    namespaceLayout: configuredNamespaceLayout,
    selection: cfg.reembedding || {},
  });
  const namespaceLayout = embeddingGenerationLayout.dataLayout;
  const fallbackEmbeddingCfg = normalizedEmbeddingCfg.fallback
    ? {
        apiKey: normalizedEmbeddingCfg.fallback.apiKey
          ? resolveEnvVars(normalizedEmbeddingCfg.fallback.apiKey)
          : resolveOptionalEnvVars("${OPENAI_API_KEY_FALLBACK}"),
        model: normalizedEmbeddingCfg.fallback.model || model,
        baseUrl: normalizedEmbeddingCfg.fallback.baseUrl,
      }
    : null;
  if (fallbackEmbeddingCfg) host.logger.info(`memory-lancedb-namespaced: embedding fallback configured (${fallbackEmbeddingCfg.model} @ ${fallbackEmbeddingCfg.baseUrl || "openai"})`);
  const autoCapture = cfg.autoCapture !== false;
  const autoRecall = cfg.autoRecall !== false;

  // v1.8.0 — Recall-Quality knobs (declared early because runtime scheduler consumes eventLoopLagSnapshot)
  const recallCfg = cfg.recall || {};
  // Seit 19.09.2026 nur noch zur Config-Validierung aufgelöst — die Pipeline
  // liest diesen Wert nicht mehr, darum wird er an keinen
  // runRecallPipeline/runMergedNamespaceRecall-Aufruf mehr weitergereicht.
  const importanceBoost  = recallCfg.importanceBoost  ?? 0.3;
  const dedupEnabled     = recallCfg.dedup            !== false; // default on
  const dedupJaccard     = recallCfg.dedupJaccard     ?? 0.78;
  const canonicalEnabled = recallCfg.canonicalFirst   !== false; // default on
  const canonicalMinScore = recallCfg.canonicalMinScore ?? 0.30;
  const canonicalMaxItems = recallCfg.canonicalMaxItems ?? 5;
  const maxPromptMemories = normalizeBoundedRecallInteger(recallCfg.maxPromptMemories, 12, 1, 100);
  const candidateTopK     = normalizeBoundedRecallInteger(recallCfg.candidateTopK, 40, 1, 100);
  const queryRefinerEnabled = recallCfg.queryRefinement?.enabled !== false;
  const adaptiveBudgetCfg = recallCfg.adaptiveBudget || {};
  const semanticCompressionCfg = recallCfg.semanticCompression || {};
  const halfLifeOverrides = recallCfg.halfLifeDaysMap   || {};
  const softBudgetMs      = recallCfg.softBudgetMs      ?? 35_000;
  const softBudgetFallback = recallCfg.softBudgetFallback !== false;
  const recallEventLoopLagSnapshot = recallCfg.eventLoopLagSnapshot !== false;
  const runtimeScheduler = createBackgroundMemoryScheduler({
    config: { ...(cfg.runtime || {}), eventLoopLagSnapshot: recallEventLoopLagSnapshot },
    logger: host.logger,
  });
  const checkpointStore = createCheckpointStore({ clock: host.clock });

  // Configurable thresholds
  const recallMinScore     = cfg.recallMinScore     ?? 0.15;
  const autoRecallMinScore = cfg.autoRecallMinScore ?? 0.2;
  const duplicateThreshold = cfg.duplicateThreshold ?? 0.95;
  const forgetThreshold    = cfg.forgetThreshold    ?? 0.3;
  const summaryMaxWords    = cfg.summaryMaxWords    ?? 150;
  const semanticLensCfg   = cfg.semanticLens || recallCfg.semanticLens || {};

  // Reply-based Outcome Tracking config (default ON — additive, append-only feedback loop)
  const replyOutcomeCfg = cfg.replyOutcomeTracking || {};
  const replyOutcomeEnabled = replyOutcomeCfg.enabled !== false;
  const replyOutcomeMaxAgeMs = replyOutcomeCfg.maxAgeMs;
  const replyOutcomeMaxMemoryIds = replyOutcomeCfg.maxMemoryIds;
  const replyOutcomeMaxReplyChars = replyOutcomeCfg.maxReplyChars;
  const replyOutcomeMaxAssistantChars = replyOutcomeCfg.maxAssistantChars;
  const replyOutcomeMaxOutcomeLogEntries = replyOutcomeCfg.maxOutcomeLogEntries;
  const replyOutcomeMaxFeedbackLogEntries = replyOutcomeCfg.maxFeedbackLogEntries;
  // 7.12.30: Die Memory-Dynamik des Reply-Outcome-Trackings (LanceDB-Updates
  // je erinnerter Erinnerung) laeuft nicht mehr im Prompt-Hook, sondern
  // seriell je Agent, angestossen nach dem Recall des Turns.
  const replyOutcomeDynamics = getSharedDeferredDynamicsQueue({
    logger: host.logger,
    maxBacklog: Math.max(1, Number(replyOutcomeCfg.dynamicsMaxBacklog) || 20),
    fallbackDelayMs: Math.max(0, Number(replyOutcomeCfg.dynamicsFallbackDelayMs ?? 10_000)),
  });
  const REPLY_OUTCOME_SYNC_LOG_MS = 1000;

  // Temporal continuity context config
  const temporalContextCfg = cfg.temporalContext || {};
  const temporalContextEnabled = temporalContextCfg.enabled !== false;

  // P2 Recall Decision Trace config
  const traceCfg = cfg.recall?.decisionTrace || {};
  const traceEnabled = traceCfg.enabled !== false;
  const traceInPrompt = traceEnabled && traceCfg.includeInPrompt === true;

  const riCfg = cfg.retroactiveInterference ?? {};

  // GC config
  const gcCfg = cfg.gc || {};
  const gcEnabled = gcCfg.enabled !== false; // default true

  // TTL presets
  const TTL_MAP = { session: 86_400_000, short: 14 * 86_400_000 };

  // Merging config
  const mergingCfg = cfg.merging || {};
  const mergingEnabled = mergingCfg.enabled !== false;
  const mergingAutoApply = mergingCfg.autoApply === true;
  const mergingThreshold = mergingCfg.threshold ?? 0.70;
  const mergingLlmCfg = mergingEnabled
    ? createFeatureRoute("merging", mergingCfg)
    : null;
  if (mergingEnabled && mergingLlmCfg) {
    host.logger.info(`memory-lancedb-namespaced: merging enabled (threshold: ${mergingThreshold}, route: ${mergingLlmCfg.kind})`);
  }

  // Dreaming-Narrative config: menschenähnliche, stimmungsgefärbte Träume
  // als additive Schicht über Light/REM Dream. Default an, aber effektiv
  // nur aktiv wenn mergingLlmCfg existiert (gleiche Vorbedingung wie die
  // Traum-Engines selbst).
  const dreamNarrativeRawCfg = cfg.dreaming?.narrative || {};
  const dreamNarrativeCfg = {
    enabled: dreamNarrativeRawCfg.enabled !== false,
    temperature: dreamNarrativeRawCfg.temperature ?? 0.9,
    storeAsMemory: dreamNarrativeRawCfg.storeAsMemory !== false,
    importanceMax: dreamNarrativeRawCfg.importanceMax ?? 0.45,
    // The narrative also goes into the agent's DREAMS.md, which is what the
    // host's Dreams page shows. Off only on explicit request.
    diary: dreamNarrativeRawCfg.diary !== false,
    timezone: typeof cfg.timezone === "string" && cfg.timezone.trim() ? cfg.timezone.trim() : null,
  };
  const resolveTemperamentName = (forAgentId) =>
    cfg.emotion?.temperaments?.[forAgentId]?.preset || null;

  // Schicht 1.5 config
  const schicht15Cfg = cfg.schicht15 || {};
  const schicht15Enabled = schicht15Cfg.enabled !== false;
  const schicht15MinImportance = schicht15Cfg.minImportance ?? 0.7;
  const schicht15MaxPromotions = schicht15Cfg.maxPromotionsPerRun ?? 3;
  const schicht15LlmCfg = schicht15Enabled
    ? createFeatureRoute("schicht15", schicht15Cfg)
    : null;
  if (schicht15LlmCfg) {
    host.logger.info(`memory-lancedb-namespaced: schicht15 enabled (minImportance: ${schicht15MinImportance}, route: ${schicht15LlmCfg.kind})`);
  }

  // Skill Miner config
  const skillMinerCfg = cfg.skillMiner || {};
  const skillMinerEnabled = skillMinerCfg.enabled !== false;
  const skillMinerLlmCfg = skillMinerEnabled
    ? createFeatureRoute("skillMiner", skillMinerCfg)
    : null;
  if (skillMinerLlmCfg) {
    host.logger.info(`memory-lancedb-namespaced: skillMiner enabled (route: ${skillMinerLlmCfg.kind})`);
  }
  // 7.12.48: Auto-Apply geminter Skills. "host" folgt dem Selbstlern-Modus
  // des Hosts (skills.workshop.autonomous.mode, ungesetzt = auto), damit
  // eine Installation, die dem Host nur Vorschlaege erlaubt, auch vom Miner
  // nur Vorschlaege bekommt.
  const hostSkillWorkshopMode = () => {
    const mode = (host.runtime?.config?.current?.() || host.config())?.skills?.workshop?.autonomous?.mode;
    return mode === "off" || mode === "propose" ? mode : "auto";
  };
  const skillMinerAutoApplyMode = skillMinerCfg.autoApply === "on" || skillMinerCfg.autoApply === "off"
    ? skillMinerCfg.autoApply
    : "host";
  const skillMinerAutoApplyEffective = () => skillMinerAutoApplyMode === "on"
    || (skillMinerAutoApplyMode === "host" && hostSkillWorkshopMode() === "auto");

  // Generic enhancement routes remain behind their existing feature gates,
  // but each prompt owns its model-selection descriptor.
  const captureSummaryLlmCfg = createFeatureRoute("capture-summary", {});
  const recallQueryLlmCfg = createFeatureRoute("recall-query-summary", {});
  const memoryCompactionLlmCfg = createFeatureRoute("memory-compaction", {});
  const conflictResolutionLlmCfg = createFeatureRoute("conflict-resolution", {});
  const remPatternLlmCfg = createFeatureRoute("rem-pattern-analysis", {});
  const conversationInsightsLlmCfg = createFeatureRoute("conversation-insights", {});
  const dreamNarrativeLlmCfg = createFeatureRoute("dream-narrative", {});
  const dreamEchoLlmCfg = createFeatureRoute("dream-echo", {});
  const episodeExtractionLlmCfg = createFeatureRoute("episode-extraction", {});
  const afterthoughtLlmCfg = createFeatureRoute("afterthought", cfg.afterthought || {});
  const personaVoiceLlmCfg = createFeatureRoute("persona-voice", cfg.personaVoice || {});
  // 7.12.38: Obergrenze des verwalteten Blocks (Seed + Gelerntes, Default 24)
  // und daraus abgeleiteter Deckel der injizierten Stimm-Direktive
  // (Formel wie directiveCharsForBullets in lib/persona-voice.js, das lazy
  // geladen wird: Zeilen x 130 + 80). Bremsen der taeglichen Evolution:
  // fruehestens alle N Tage und nur mit N neuen echten Outcomes.
  const personaMaxBullets = Number.isFinite(Number(cfg.personaVoice?.maxBullets)) && Number(cfg.personaVoice.maxBullets) >= 6
    ? Math.floor(Number(cfg.personaVoice.maxBullets))
    : 24;
  const personaDirectiveMaxChars = Number.isFinite(Number(cfg.personaVoice?.maxDirectiveChars)) && Number(cfg.personaVoice.maxDirectiveChars) >= 200
    ? Math.floor(Number(cfg.personaVoice.maxDirectiveChars))
    : personaMaxBullets * 130 + 80;
  const personaEvolveMinDaysBetween = Number.isFinite(Number(cfg.personaVoice?.minDaysBetween)) && Number(cfg.personaVoice.minDaysBetween) >= 0
    ? Number(cfg.personaVoice.minDaysBetween)
    : 2;
  const personaEvolveMinOutcomes = Number.isFinite(Number(cfg.personaVoice?.minOutcomes)) && Number(cfg.personaVoice.minOutcomes) >= 1
    ? Math.floor(Number(cfg.personaVoice.minOutcomes))
    : 10;
  const wikiLlmCfg = createFeatureRoute("wiki", {});
  const overlayLlmCfg = createFeatureRoute("continuity-overlay", cfg.continuityEngine?.overlays || {});
  const overlayAuditLlmCfg = createFeatureRoute("overlay-audit-contradiction", {});
  const memoryTextContradictionLlmCfg = createFeatureRoute("memory-text-contradiction", {});

  // Emotion Tier Config
  const emotionCfg = cfg.emotion || {};
  const emotionTier = emotionCfg.tier || "auto";
  const emotionT2Enabled = emotionCfg.t2?.enabled !== false;
  // Tier 3: enabled if wanted AND its feature-local route is available.
  // onlyWhenProviderAvailable (default: true) makes T3 soft-skip instead of error when no provider.
  const emotionT3WantsEnabled = emotionCfg.t3?.enabled !== false;
  // Abschluss-Review, Important 6: die Route wird jetzt IMMER aufgelöst,
  // unabhängig von emotionT3WantsEnabled — sonst friert eine Abschaltung
  // von emotion.t3 (oder ein Provider-Ausfall bei der Registrierung) auch
  // die Importance-Klärung im emotion-refine-Cron für immer ein, obwohl der
  // Encoding-Call (lib/encoding-llm.js) davon konzeptionell unabhängig ist.
  // emotionT3WantsEnabled bleibt das alleinige Tor für die eigentliche
  // Tier-3-Emotionsklassifikation (setEmotionConfig, Capture-Pfad unten).
  const emotionT3LlmCfg = createFeatureRoute("emotionT3", emotionCfg.t3 || {});
  const emotionT3HasProvider = Boolean(
    emotionT3LlmCfg
    && (emotionT3LlmCfg.kind === LLM_ROUTE_KINDS.DIRECT_OVERRIDE
      || typeof host.runtime?.llm?.complete === "function"),
  );
  const emotionT3OnlyWhenProviderAvailable = emotionCfg.t3?.onlyWhenProviderAvailable !== false;
  const emotionT3Enabled = emotionT3WantsEnabled && (emotionT3HasProvider || !emotionT3OnlyWhenProviderAvailable);
  const emotionT3CallLlm = (emotionT3Enabled && emotionT3LlmCfg)
    ? /**
       * Call the emotion provider with optional agent-scoped cache context.
       * @param {Array<object>} messages
       * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [context]
       * @returns {Promise<string|null>}
       */
      (messages, context = {}) => {
        const emotionLlmCfg = withLlmCallContext(
          {
            ...emotionT3LlmCfg,
            maxTokens: 300,
            // No temperature: some providers (Kimi coding) reject anything
            // but one exact value per thinking mode and answer HTTP 400.
            // Letting the provider default apply keeps the call portable.
            disableThinking: true,
          },
          context.agentId,
          LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
          { runtimeLlm: context.runtimeLlm, signal: context.signal },
        );
        return context.agentId
          ? callLlm(messages, withLlmCallContext(
              withLlmResultCacheContext(
                { ...emotionLlmCfg },
                context.agentId,
                LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
              ),
              context.agentId,
              LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
              { runtimeLlm: context.runtimeLlm, signal: context.signal },
            ))
          : callLlm(messages, emotionLlmCfg);
      }
    : null;
  if (emotionT3Enabled && emotionT3LlmCfg) {
    host.logger.info(`memory-lancedb-namespaced: emotion tier-3 enabled (route: ${emotionT3LlmCfg.kind})`);
  } else if (emotionT3WantsEnabled && !emotionT3HasProvider) {
    host.logger.info("memory-lancedb-namespaced: emotion tier-3 deferred — no LLM provider configured (onlyWhenProviderAvailable)");
  }
  // Abschluss-Review, Important 6: eigene Call-Funktion für den
  // emotion-refine-Cron (lib/encoding-llm.js), unabhängig von
  // emotionT3Enabled — verfügbar, sobald irgendein Provider existiert,
  // selbst wenn der Operator emotion.t3 selbst abgeschaltet hat. Sonst
  // friert eine Abschaltung von emotion.t3 (oder ein Provider-Ausfall bei
  // der Registrierung) auch die Importance-Klärung für immer ein, obwohl
  // der Encoding-Call davon konzeptionell unabhängig ist. Gleicher Aufbau
  // wie emotionT3CallLlm oben, bewusst nicht als gemeinsame Hilfsfunktion
  // extrahiert, damit dessen bestehende Scoping-Verträge unangetastet
  // bleiben.
  const encodingLlmCfg = createFeatureRoute("emotion-encoding", emotionCfg.t3 || {});
  const encodingHasProvider = Boolean(encodingLlmCfg && (encodingLlmCfg.kind === LLM_ROUTE_KINDS.DIRECT_OVERRIDE
    || typeof host.runtime?.llm?.complete === "function"));
  const encodingCallLlm = encodingHasProvider
    ? (messages, context = {}) => {
        const emotionLlmCfg = withLlmCallContext(
          {
            ...encodingLlmCfg,
            // Messung + Begründung bei der Konstante
            // EMOTION_REFINE_ENCODING_MAX_TOKENS weiter unten (voller
            // Vorwärtsverweis: diese Funktion wird erst vom
            // emotion-refine-Cron aufgerufen, lange nachdem die
            // Konstante beim Registrieren initialisiert wurde).
            maxTokens: EMOTION_REFINE_ENCODING_MAX_TOKENS,
            disableThinking: true,
          },
          context.agentId,
          LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
          { runtimeLlm: context.runtimeLlm, signal: context.signal },
        );
        return context.agentId
          ? callLlm(messages, withLlmCallContext(
              withLlmResultCacheContext(
                { ...emotionLlmCfg },
                context.agentId,
                LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
              ),
              context.agentId,
              LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
              { runtimeLlm: context.runtimeLlm, signal: context.signal },
            ))
          : callLlm(messages, emotionLlmCfg);
      }
    : null;
  // Emotionale Dynamik (Spec 2026-07-01): aggressive T3-Eskalation,
  // Timeout-Schutz, Recall-Gewicht und Decay-Kopplung.
  const emotionT3EscalationConfidence = emotionCfg.t3?.escalationConfidence ?? 0.85;
  const emotionT3TimeoutMs = emotionCfg.t3?.timeoutMs ?? 4000;
  const emotionMoodInfluence = emotionCfg.moodInfluence ?? 0.3;
  const emotionIntensityHalfLifeFactor = emotionCfg.intensityHalfLifeFactor ?? 1.0;
  // R16 (Abschluss-Review 19.09.2026, Critical 1): Blitzlicht-Kodierung ist
  // erst für Phase 3 vorgesehen, nach einem Pilotlauf, der die
  // 0,70-Schwelle an einer echten Importance-Verteilung kalibriert. Default
  // aus hält sowohl den Capture-Pfad (90-Tage-Boden, memory-dynamics.js)
  // als auch den neuen Refine-Pfad (kein Blitzlicht, encoding-llm.js) exakt
  // auf dem Verhalten von vor diesem Branch.
  const memoryDynamicsCfg = cfg.memoryDynamics || {};
  const flashbulbEncodingEnabled = memoryDynamicsCfg.flashbulbEncoding === true;
  setEmotionConfig({
    tier: emotionTier,
    t2: { enabled: emotionT2Enabled },
    t3: { enabled: emotionT3Enabled, callLlm: emotionT3CallLlm, apiKey: null, baseUrl: undefined, timeoutMs: emotionT3TimeoutMs },
    escalationConfidence: emotionT3EscalationConfidence,
  });
  if (emotionTier !== "auto") {
    host.logger.info(`memory-lancedb-namespaced: emotion tier locked to ${emotionTier}`);
  }
  // 7.12.22: Tier 3 fuer neue Erinnerungen laeuft nicht mehr im Turn. Die
  // LLM-Klassifikation je gespeicherter Erinnerung (4–16 s, mehrere je
  // Turn) dominierte das agent_end-Budget. Im Modus "deferred" (Default)
  // bewertet der Capture-Pfad nur lexikalisch (Tier 1/2), speichert das
  // Ergebnis vorlaeufig und markiert Zeilen unter der Eskalationsschwelle
  // als emotionStatus=pending_t3; der Feature-Cron `emotion-refine` holt
  // Tier 3 nach. Die Stimmungszeile der Antwort ist davon unberuehrt, sie
  // entsteht im Recall aus der aktuellen Nachricht. Ein fest verdrahteter
  // Tier (emotion.tier != auto) und captureMode "inline" behalten das alte
  // Verhalten.
  const emotionT3CaptureMode = emotionCfg.t3?.captureMode === "inline" ? "inline" : "deferred";
  const emotionDeferredCapture = emotionT3CaptureMode === "deferred" && emotionT3Enabled && emotionTier === "auto";
  // 7.12.23: Kern-Erinnerungen (importance ab dieser Schwelle) bekommen im
  // Cron immer Tier 3, auch wenn Tier 1/2 sicher "neutral" sagt — dort
  // wirkt die emotionale Intensitaet auf Recall-Gewicht und Zerfall, und
  // das Lexikon uebersieht Ironie oder Sorge im Sachton. Werte > 1 schalten
  // die Regel ab. Default im Normalizer, nicht im Schema.
  const emotionT3RefineImportanceMinRaw = Number(emotionCfg.t3?.refineImportanceMin);
  const emotionT3RefineImportanceMin = Number.isFinite(emotionT3RefineImportanceMinRaw) && emotionT3RefineImportanceMinRaw >= 0
    ? emotionT3RefineImportanceMinRaw
    : 0.9;
  if (emotionT3Enabled) {
    host.logger.info(`memory-lancedb-namespaced: emotion tier-3 capture mode ${emotionDeferredCapture ? "deferred (emotion-refine cron)" : "inline"}`);
  }
  /**
   * Emotionsbewertung fuer eine neu zu speichernde Erinnerung.
   * @param {string} text
   * @param {{agentId?: string, signal?: AbortSignal, importance?: number}} [context]
   * @returns {Promise<{emotion: object, emotionStatus: "final"|"pending_t3"}>}
   */
  const classifyEmotionForStore = async (text, context = {}) => {
    if (!emotionDeferredCapture) {
      const emotion = await inferEmotionalValenceAsync(text, "user", null, context);
      return { emotion, emotionStatus: "final" };
    }
    // Gleiche Tier-1/2-Route wie sonst, nur ohne den Tier-3-Sprung; der
    // Cron greift genau dort, wo der Router eskaliert haette.
    const { importance, ...engineContext } = context;
    const emotion = await inferEmotionalValenceAsync(text, "user", null, { ...engineContext, skipTier3: true });
    // Fehlende Konfidenz (synchroner Tier-1-Fallback) zaehlt als unsicher.
    const confident = Number.isFinite(emotion?.confidence) && emotion.confidence >= emotionT3EscalationConfidence;
    const coreMemory = Number.isFinite(Number(importance)) && Number(importance) >= emotionT3RefineImportanceMin;
    return { emotion, emotionStatus: confident && !coreMemory ? "final" : "pending_t3" };
  };

  // Base DB path — früh auflösen, damit Meta-Cognition-State-Read (und
  // spätere Initialisierung) denselben Pfad verwenden.
  // Meta-Cognition Config
  const metaCognitionCfg = cfg.metaCognition || {};
  const metaCognitionEnabled = metaCognitionCfg.enabled !== false;
  const metaCognitionSessionThreshold = metaCognitionCfg.sessionThreshold ?? 50;
  const metaCognitionIntervalMs = (metaCognitionCfg.intervalDays ?? 7) * 24 * 60 * 60 * 1000;
  const metaCognitionLlmReport = metaCognitionCfg.llmReport === true;

  // Reminder-Extraktion aus Auto-Capture (reminders.autoExtract: false schaltet ab)
  const reminderAutoExtract = (cfg.reminders || {}).autoExtract !== false;
  // Shared mutable state: the capture hook rebinds these at turn time
  // (index.js:10857-10858), so they must survive being passed into a module.
  const metaReflectionState = { sessionCount: 0, lastAt: 0 };
  try {
    const metaStatePath = join(baseDbPath, "_meta-cognition-state.json");
    if (existsSync(metaStatePath)) {
      const metaState = JSON.parse(readFileSync(metaStatePath, "utf8"));
      metaReflectionState.sessionCount = metaState.sessionCountSinceReflection || 0;
      metaReflectionState.lastAt = metaState.lastReflectionAt || 0;
    }
  } catch (_) {
    // ignore corrupt state
  }

  // v2.1.1: hard-fail wenn Provider-Modell ohne dimensions konfiguriert ist.
  // OpenAI-Modelle: aus EMBEDDING_DIMENSIONS-Map fallback.
  // Nicht-OpenAI-Modelle (OpenRouter, custom baseUrl, etc.): MÜSSEN explizit
  // dimensions in der Config haben, sonst weiß die LanceDB nicht welche
  // Vektor-Dim erwartet wird → Schema-Mismatch beim ersten store.
  let vectorDim = dimensions;
  if (!vectorDim) {
    vectorDim = EMBEDDING_DIMENSIONS[model];
    if (!vectorDim) {
      const isOpenAi = !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
      if (isOpenAi) {
        // Unbekanntes OpenAI-Modell — defensive default, mit Warnung
        vectorDim = 1536;
        host.logger.warn(`memory-lancedb-namespaced: unbekanntes OpenAI-Modell '${model}' — fallback auf 1536 dimensions. Empfohlen: 'dimensions' explizit setzen.`);
      } else {
        // Provider-Modell (OpenRouter, etc.) ohne dimensions — hart fail
        throw new Error(
          `memory-lancedb-namespaced: Modell '${model}' (Provider: ${baseUrl || "?"}) hat keine konfigurierten 'dimensions'. ` +
          `Setze plugins.entries.memory-lancedb-namespaced.config.embedding.dimensions explizit ` +
          `(z.B. 1024 für BAAI/Mistral, 2048 für NVIDIA-Nemotron, 3072 für Gemini). ` +
          `Test-Call: curl -H "Authorization: Bearer KEY" -d '{"model":"${model}","input":"test","encoding_format":"float"}' ${baseUrl || "https://api.openai.com/v1"}/embeddings ` +
          `→ data[0].embedding.length lesen.`
        );
      }
    }
  }
  const activeEmbeddingFingerprint = embeddingFingerprintFromNormalizedConfig({
    ...normalizedEmbeddingCfg,
    dimensions: vectorDim,
  });
  const activeEmbeddingFingerprintId = embeddingFingerprintId(activeEmbeddingFingerprint);
  if (cfg.reembedding && (
    cfg.reembedding.fingerprintId !== activeEmbeddingFingerprintId
    || cfg.reembedding.dimensions !== vectorDim
  )) {
    throw new Error(
      "memory-lancedb-namespaced: active reembedding selection does not match the configured embedding fingerprint",
    );
  }
  const reembeddingStateStore = createMigrationStateStore({ stateRoot: baseDbPath, logger: host.logger });
  const memoryMaintenanceGate = createMemoryMaintenanceGate({
    externalStatus: () => {
      const switching = reembeddingStateStore.list().find((record) => record.state === "switching");
      return switching
        ? {
            active: true,
            reason: "reembedding_switch",
            since: Date.parse(switching.updatedAt),
          }
        : { active: false };
    },
  });
  const reembeddingConfigRevision = createHash("sha256")
    .update(JSON.stringify({
      fingerprintId: activeEmbeddingFingerprintId,
      selection: embeddingGenerationLayout.selection,
      namespaceMode: configuredNamespaceLayout.mode,
      activeWriteNamespace: configuredNamespaceLayout.activeWriteNamespace || null,
    }))
    .digest("hex");
  const reembeddingBackend = createLanceGenerationBackend({
    stateRoot: baseDbPath,
    activeRoot: embeddingGenerationLayout.activeRoot,
    activeSharedBaseDir: embeddingGenerationLayout.sharedBaseDir,
    activeNamespace: configuredNamespaceLayout.mode === "named"
      ? configuredNamespaceLayout.activeWriteNamespace
      : null,
    activeGeneration: embeddingGenerationLayout.selection.mode === "generation"
      ? embeddingGenerationLayout.selection.generation
      : "legacy-active",
    activeSelection: embeddingGenerationLayout.selection,
    activeFingerprint: activeEmbeddingFingerprint,
    activeSecretRef: redactedEmbeddingSecretRef(normalizedEmbeddingCfg),
    configRevision: reembeddingConfigRevision,
  });
  const neoCfg = cfg.neo || {};
  const neoEnabled = neoCfg.enabled !== false; // 3.0 default: additive cognitive layer on
  const neoRoot = resolvePath(neoCfg.statePath || join(baseDbPath, "_neo"));
  const neoMode = neoCfg.mode || "augment";
  const neoEmbeddingDrainCfg = neoCfg.embeddingDrain || {};
  const neoEmbeddingAutoDrainEnabled = neoEmbeddingDrainCfg.enabled !== false;
  const neoEmbeddingDrainImpact = neoEmbeddingDrainCfg.impact || "low";
  const neoEmbeddingDrainMaxItems = Math.max(1, Number(neoEmbeddingDrainCfg.maxItems || 250));
  // Teilbudget fuer den agent_end-Worker. Er lief bisher auf dem vollen
  // Capture-Signal: beim ersten Turn nach einer Ruhephase ist der Neo-Store
  // kalt (bernhardine: 250-625 MB) und der Worker brauchte am 09.09.2026
  // 56 der 60 Sekunden — die Erfassung danach lief in den Abbruch und
  // speicherte nichts. Zwei Minuten spaeter, warm, dauerte dieselbe Arbeit
  // 1 s. Ueberzieht er das Teilbudget, bricht nur er ab; die Erfassung
  // behaelt den Rest und Neo holt beim naechsten Turn warm auf.
  const neoAgentEndBudgetMs = Math.max(1000, Number(neoCfg.agentEndBudgetMs || 20000));
  // 7.12.27: Suche ueber alle Kandidaten (nicht nur das 500er-Fenster).
  // Defaults hier, nicht im Schema (Installer-Profile).
  const neoGlobalRecallCfg = neoCfg.recall?.global || {};
  const neoGlobalRecall = {
    enabled: neoGlobalRecallCfg.enabled !== false,
    topK: Math.max(1, Math.min(200, Number(neoGlobalRecallCfg.topK) || 30)),
    minSimilarity: Number.isFinite(Number(neoGlobalRecallCfg.minSimilarity)) ? Math.max(0, Math.min(1, Number(neoGlobalRecallCfg.minSimilarity))) : 0.35,
    halfLifeDays: Number(neoGlobalRecallCfg.halfLifeDays) > 0 ? Number(neoGlobalRecallCfg.halfLifeDays) : 30,
    maxCandidates: Math.max(100, Number(neoGlobalRecallCfg.maxCandidates) || 20000),
    dedupeThreshold: Number.isFinite(Number(neoGlobalRecallCfg.dedupeThreshold)) ? Math.max(0, Math.min(1, Number(neoGlobalRecallCfg.dedupeThreshold))) : 0.8,
    // 7.12.30: Budget fuer die Anfrage-Einbettung im Prompt-Recall; danach
    // laeuft der Neo-Pfad ohne Vektor weiter (Lanes lexikalisch).
    embedTimeoutMs: Math.max(500, Number(neoGlobalRecallCfg.embedTimeoutMs) || 4000),
  };
  const NEO_RECALL_PRELUDE_LOG_MS = 2000;
  const runNeoGlobalSearch = (store, neoItems, queryVector, requester) => {
    if (!neoGlobalRecall.enabled || !Array.isArray(queryVector) || queryVector.length === 0) return null;
    const excludeIds = new Set(neoItems.map((item) => (item?.id ? String(item.id) : "")).filter(Boolean));
    const global = searchNeoCandidatesGlobal(store, { queryVector, requester, excludeIds, ...neoGlobalRecall });
    for (const hit of global.hits) neoItems.push(hit.item);
    const top = global.hits[0];
    host.logger.info(`plur1bus-neo: global candidate search scanned=${global.scanned} unique=${global.unique} eligible=${global.eligible} withVector=${global.withVector} hits=${global.hits.length}${top ? ` topSim=${top.similarity.toFixed(3)} topAgeDays=${top.ageDays.toFixed(1)}` : ""} index=${global.index}${global.indexLines ? `/${global.indexLines}` : ""} ms=${global.ms}`);
    return new Set(global.hits.map((hit) => String(hit.item.id)));
  };
  // Der Wartungslauf nimmt sich die Warteschlange am Stueck vor. Die Frist
  // liegt bewusst unter dem RPC-Timeout des Feature-Cron-Pfads (540s), damit
  // der Aufrufer ein Ergebnis mit Restzahl bekommt statt eines Abbruchs.
  const NEO_MANUAL_DRAIN_MAX_ITEMS = 100000;
  const NEO_MANUAL_DRAIN_DEADLINE_MS = 480000;
  // emotion-refine (7.12.22): je Lauf hoechstens so viele pending_t3-Zeilen
  // mit Tier 3 nachbessern; die Frist bleibt deutlich unter dem RPC-Timeout.
  const EMOTION_REFINE_MAX_ROWS = 100;
  const EMOTION_REFINE_DEADLINE_MS = 240000;
  const EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES = 3;
  // EMOTION_REFINE_ENCODING_MAX_TOKENS (19.09.2026): encodingCallLlm oben
  // (lib/encoding-llm.js) fragt seit der Acht-Dimensionen-Emotions-Label-
  // Map + Freitext-Grund eine deutlich längere Antwort ab als vorher — die
  // alten 300 Tokens reichten dafür nicht mehr. Gemessen an einem echten
  // Provider mit einem echten deutschen Erinnerungstext:
  //   max_tokens  400 -> 400 Tokens verbraucht, finish_reason "length"
  //                      (abgeschnittenes JSON, der Parser verwirft es)
  //   max_tokens  800 -> 800 Tokens verbraucht, finish_reason "length" (dito)
  //   max_tokens 1500 -> nur 345 Tokens verbraucht, finish_reason "stop"
  //                      (parst sauber)
  // Der Fehler blieb dabei stumm: HTTP 200, plausibel aussehendes JSON,
  // aber keine schließende Klammer — die Zeile bleibt unbewertet, ohne
  // dass irgendetwas außer einem Zähler das meldet. Der
  // Tier-3-Emotionsaufruf (emotionT3CallLlm oben) bekommt kein längeres
  // Antwortformat und bleibt deshalb unverändert bei 300 maxTokens.
  const EMOTION_REFINE_ENCODING_MAX_TOKENS_DEFAULT = 1500;
  const emotionT3EncodingMaxTokensRaw = Number(emotionCfg.t3?.encodingMaxTokens);
  // Untergrenze VOR dem Runden prüfen (>= 1, nicht > 0): sonst würde ein
  // Wert wie 0,5 die Prüfung noch bestehen und erst Math.floor() ihn auf 0
  // bringen — ein maxTokens von 0 darf aber nie beim Provider ankommen.
  const EMOTION_REFINE_ENCODING_MAX_TOKENS = Number.isFinite(emotionT3EncodingMaxTokensRaw) && emotionT3EncodingMaxTokensRaw >= 1
    ? Math.floor(emotionT3EncodingMaxTokensRaw)
    : EMOTION_REFINE_ENCODING_MAX_TOKENS_DEFAULT;
  // Hook-Drain: Marge fuer den laufenden Embed-Aufruf (die 7 s zwischen
  // Worker-Abbruch und Rueckkehr waren genau der) und Mindestrest, unter
  // dem sich ein Start nicht lohnt.
  const NEO_HOOK_DRAIN_MARGIN_MS = 10000;
  const NEO_HOOK_DRAIN_MIN_MS = 3000;
  const neoWorkspaceAliases = buildNeoWorkspaceAliases({ obsidianBridge: obsidianBridgeCfg, neo: neoCfg });
  const memoryWorkspaceAliases = buildMemoryWorkspaceAliases(cfg, neoWorkspaceAliases);
  let hostMemoryConfig = {};
  try {
    hostMemoryConfig = typeof host.runtime?.config?.current === "function" ? host.runtime.config.current() : (host.runtime?.config || {});
  } catch (error) {
    host.logger.warn(`memory-lancedb-namespaced: account topology snapshot unavailable: ${String(error)}`);
  }
  const memoryAccountTopology = buildMemoryAccountTopology(hostMemoryConfig);
  const hostRoutingLoader = createHostRoutingLoader({ logger: host.logger, importRouting: host.routing });
  const classifyHostIncognitoSession = createHostIncognitoSessionClassifier({ logger: host.logger, importRouting: host.routing });
  const turnRouteState = autoRecall ? { initPromise: null, registry: null } : null;
  const getMemoryTurnRoutes = autoRecall ? async () => {
    if (turnRouteState.registry) return turnRouteState.registry;
    if (!turnRouteState.initPromise) {
      turnRouteState.initPromise = (async () => {
        try {
          const routingCapability = await hostRoutingLoader();
          // 7.12.36: prozessweit geteilt — siehe lib/process-singleton.js.
          turnRouteState.registry = getSharedMemoryTurnRouteRegistry({ routingCapability, logger: host.logger });
          return turnRouteState.registry;
        } catch (error) {
          host.logger.warn(`memory-lancedb-namespaced: turn route registry unavailable: ${String(error)}`);
          return null;
        }
      })();
    }
    return turnRouteState.initPromise;
  } : null;
  const clearInitializedTurnRoutes = autoRecall ? async () => {
    if (!turnRouteState.initPromise) return;
    const turnRoutes = await turnRouteState.initPromise;
    turnRoutes?.clear();
  } : null;
  const workspacePolicyStore = createWorkspacePolicyStore({
    stateRoot: baseDbPath,
    logger: host.logger,
  });
  const workspacePolicyGuard = createWorkspacePolicyGuard({
    store: workspacePolicyStore,
    maintenanceGate: memoryMaintenanceGate,
    invalidate: async () => {
      await clearInitializedTurnRoutes?.();
    },
  });
  const automaticWorkspacePolicyDecision = (event = {}, ctx = {}) => {
    try {
      const workspaceDir = ctx?.workspaceDir ?? event?.workspaceDir;
      const memoryCtx = resolveMemoryRequestContext({
        agentId: ctx?.agentId ?? event?.agentId,
        workspaceDir,
        ...(workspaceDir
          ? {}
          : {
              workspaceKey: ctx?.workspaceKey ?? event?.workspaceKey,
              workspaceId: ctx?.workspaceId ?? event?.workspaceId,
            }),
        sessionKey: ctx?.sessionKey ?? event?.sessionKey,
        sessionId: ctx?.sessionId ?? event?.sessionId,
      }, { workspaceAliases: memoryWorkspaceAliases });
      return workspacePolicyGuard.automatic(memoryCtx);
    } catch (error) {
      host.logger.debug(`memory-lancedb-namespaced: workspace policy context unavailable: ${String(error)}`);
      return { allowed: false, reason: "workspace_identity_required" };
    }
  };
  const neoWorkerRuntime = neoEnabled
    ? getSharedNeoWorkerRuntime({ logger: host.logger })
    : null;
  // 7.12.30: Sentinel fuer das Embedding-Budget im Prompt-Recall.
  const NEO_EMBED_TIMEOUT = Symbol("plur1bus.neo.embedTimeout");
  if (neoEnabled && neoMode === "slot") {
    host.logger.warn("memory-lancedb-namespaced: neo mode=slot requested but this branch keeps memory-core as default slot owner; no memory capability registration call will be made.");
  }
  // Versteckte Kopplung sichtbar machen: Light/REM-Dreaming und
  // Episoden-Extraktion brauchen eine aktive Merging-Route. Ohne sie laufen
  // diese Features still als No-op, obwohl sie "aktiv" wirken.
  if (neoEnabled && !mergingLlmCfg) {
    reportDormantFeature(host.logger, {
      explicit: cfg.neo?.enabled === true,
      message: "memory-lancedb-namespaced: light/REM dreaming and episode extraction require merging.enabled and an available LLM route. They will no-op until that route is available.",
    });
  }
  const sessionWorkspaceKeys = new Map();
  const rememberNeoWorkspace = (ctx = {}, event = {}) => {
    const workspaceKey = workspaceKeyFromContext(ctx, {
      event,
      defaultWorkspaceKey: neoCfg.corpusDefaultWorkspaceKey,
      rootDir: neoRoot,
      runtime: host.runtime ?? undefined,
      sessionWorkspaceKeys,
      workspaceAliases: neoWorkspaceAliases,
    });
    for (const sessionKey of neoSessionKeysFromContext(ctx, event)) {
      sessionWorkspaceKeys.set(sessionKey, workspaceKey);
    }
    if (sessionWorkspaceKeys.size > 1000) {
      for (const key of sessionWorkspaceKeys.keys()) {
        sessionWorkspaceKeys.delete(key);
        if (sessionWorkspaceKeys.size <= 800) break;
      }
    }
    return workspaceKey;
  };
  const getNeoStore = (ctx = {}, event = {}, purpose = "general") => {
    const workspaceKey = rememberNeoWorkspace(ctx, event);
    emitCommandRuntimeHook("onNeoStore", { purpose, workspaceKey });
    return createNeoStore(neoRoot, workspaceKey);
  };
  // 7.12.45: Der Vergleich folgt dem Partitionsschluessel (ownerStorageKey):
  // agent-private kennt nur den Agenten, workspace nur die Workspace-
  // Identitaet, user Agent + Owner. Bis dahin verglich er workspaceIdentity
  // und ownerUserId fuer ALLE Scopes — Altzeilen (Juli 2026) mit gesetztem
  // workspaceKey in agent-private-Zeilen (main 7 von 9385, bernhardine 21
  // von 12034) liessen den Guard werfen, die ganze Seite fiel weg, der
  // naechtliche Decay blieb bei main/bernhardine seit Tagen bei 0.
  const sameOwnerPartition = (left, right) => {
    if (!left || !right || left.scope !== right.scope) return false;
    if (left.scope === "workspace") return left.workspaceIdentity === right.workspaceIdentity;
    if (left.scope === "user") return left.agentId === right.agentId && left.ownerUserId === right.ownerUserId;
    return left.agentId === right.agentId;
  };
  const ownerStorageKey = (partition) => partition.scope === "workspace"
    ? partition.workspaceIdentity
    : `acl-owner-v1:${partition.scope}:${partition.agentId}:${partition.key}`;
  const createOwnerBoundNeoStore = (partition) => Object.freeze({
    ...createNeoStore(neoRoot, ownerStorageKey(partition)),
    aclBindings: partition,
  });
  const createOwnerBoundTarget = (partition, store, kind, outputRoot) => Object.freeze({
    aclBindings: partition,
    kind,
    workspaceDir: outputRoot,
    writeFile: ({ path, content }) => {
      const targetPath = resolveInside(outputRoot, path);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content, "utf8");
      return { written: true, path: targetPath };
    },
  });
  // 7.12.29: ACL-Ablehnungen tragen Code und Kontext. Aufrufer koennen sie
  // damit von Query-Fehlern unterscheiden (memory-compaction fiel bisher bei
  // einem ACL-Wurf auf eine Suche OHNE Where zurueck und scheiterte dann an
  // alten Fremd-Scope-Zeilen), und der Grund steht im Log — bis 7.12.28 war
  // aus "ACL denied for query" nicht ablesbar, welche Zeile gemeint war
  // (consolidate-daily[bernhardine], 10.09.2026 04:15).
  const aclDeniedError = (operation, row, reason, partition, kind = "denied") => {
    const id = row?.id ? String(row.id).slice(0, 64) : "";
    const scope = row?.scope || "agent-private";
    const error = new Error(`ACL ${kind === "denied" ? "denied" : "partition mismatch"} for ${operation}`);
    error.code = "PLUR1BUS_ACL_DENIED";
    error.aclReason = reason || kind;
    error.rowId = id;
    const owner = partition?.agentId || partition?.workspaceIdentity || partition?.ownerUserId || "?";
    getPluginLogger()?.warn?.(`memory-lancedb-namespaced: ACL ${kind} for ${operation}: id=${id || "?"} scope=${scope} agent=${row?.agentId || row?.storedBy || "?"} workspace=${row?.workspaceId || row?.workspaceKey || ""} reason=${reason || kind} partition=${partition?.scope || "?"}:${owner}`);
    return error;
  };
  const createOwnerBoundMemoryStore = (db, partition, requestContext) => {
    const assertRecord = (record, operation) => {
      const access = record ? checkAccess(requestContext, record) : { allowed: false, reason: "acl.no_memory" };
      if (!access.allowed) {
        throw aclDeniedError(operation, record, access.reason, partition);
      }
      const candidate = {
        ...record,
        scope: record.scope || "agent-private",
        agentId: record.agentId || record.storedBy || partition.agentId,
        storedBy: record.storedBy || record.agentId || partition.agentId,
        workspaceId: record.workspaceId || record.workspaceKey || partition.workspaceIdentity,
        workspaceKey: record.workspaceKey || record.workspaceId || partition.workspaceIdentity,
        ownerUserId: record.ownerUserId || partition.ownerUserId,
      };
      if (!sameOwnerPartition({
        scope: candidate.scope,
        agentId: candidate.agentId,
        workspaceIdentity: candidate.workspaceId || candidate.workspaceKey || "",
        ownerUserId: candidate.ownerUserId || "",
      }, partition)) {
        throw new Error(`ACL partition mismatch for ${operation}`);
      }
      return record;
    };
    const withOwnershipDefaults = (entry) => ({
      ...entry,
      scope: partition.scope,
      agentId: partition.agentId,
      storedBy: entry?.storedBy || partition.agentId,
      workspaceId: partition.workspaceIdentity,
      workspaceKey: partition.workspaceIdentity,
      ownerUserId: partition.ownerUserId,
    });
    return Object.freeze({
      aclBindings: partition,
      async getById(id) {
        const record = await db.getById(id);
        return record ? assertRecord(record, "getById") : null;
      },
      async store(entry) {
        const bound = withOwnershipDefaults(entry);
        assertRecord(bound, "store");
        return db.store(bound);
      },
      async update(id, patch) {
        const record = await db.getById(id);
        assertRecord(record, "update");
        return db.update(id, patch);
      },
      async delete(id) {
        const record = await db.getById(id);
        assertRecord(record, "delete");
        return db.delete(id);
      },
      async tombstone(id, values) {
        const record = await db.getById(id);
        assertRecord(record, "tombstone");
        return db.tombstone(id, values);
      },
    });
  };
  const createPartitionScopedDb = (db, partition, requestContext) => {
    const memoryStore = createOwnerBoundMemoryStore(db, partition, requestContext);
    const assertRows = (rows, operation) => {
      for (const row of rows || []) {
        const access = checkAccess(requestContext, row);
        if (!access.allowed) throw aclDeniedError(operation, row, access.reason, partition);
        const workspaceIdentity = row.workspaceId || row.workspaceKey || "";
        if (!sameOwnerPartition({
          scope: row.scope || "agent-private",
          agentId: row.agentId || row.storedBy || "",
          workspaceIdentity,
          ownerUserId: row.ownerUserId || "",
        }, partition)) throw aclDeniedError(operation, row, "acl.partition_mismatch", partition, "mismatch");
      }
    };
    const guardedBuilder = (builder) => new Proxy(builder, {
      get(target, property) {
        if (property === "toArray") {
          return async (...args) => {
            const rows = await target.toArray(...args);
            assertRows(rows, "query");
            return rows;
          };
        }
        const value = target[property];
        if (typeof value !== "function") return value;
        return (...args) => {
          const next = value.apply(target, args);
          return next && typeof next === "object" && typeof next.toArray === "function"
            ? guardedBuilder(next)
            : next;
        };
      },
    });
    const rawTable = db.table;
    const ACL_ROW_COLUMNS = ["id", "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId", "status"];
    const readAclRows = async (where) => {
      let query = rawTable.query().where(where);
      try {
        const schema = typeof rawTable.schema === "function" ? await rawTable.schema() : null;
        const names = new Set((schema?.fields || []).map((f) => f.name));
        const columns = ACL_ROW_COLUMNS.filter((c) => names.has(c));
        if (columns.length > 0 && typeof query.select === "function") query = query.select(columns);
      } catch (_) { /* volle Zeilen lesen */ }
      return typeof query.limit === "function" ? query.limit(1_000_000).toArray() : query.toArray();
    };
    const table = rawTable ? {
      schema: (...args) => rawTable.schema(...args),
      query: (...args) => guardedBuilder(rawTable.query(...args)),
      vectorSearch: (...args) => guardedBuilder(rawTable.vectorSearch(...args)),
      async add(entries) {
        assertRows(entries, "add");
        return rawTable.add(entries);
      },
      // 7.12.47: Der Guard braucht fuer die Pruefung nur die ACL-Spalten —
      // bisher las er jede betroffene Zeile komplett (Text + 3072-dim
      // Vektor); beim Batch-Decay ueber ~9000 Zeilen waeren das >100 MB.
      async update(options) {
        const rows = await readAclRows(options.where);
        assertRows(rows, "update");
        return rawTable.update(options);
      },
      async delete(where) {
        const rows = await readAclRows(where);
        assertRows(rows, "delete");
        return rawTable.delete(where);
      },
    } : null;
    return {
      ...db,
      table,
      async getById(id) { return memoryStore.getById(id); },
      async store(entry) { return memoryStore.store(entry); },
      async update(id, patch) { return memoryStore.update(id, patch); },
      async delete(id) { return memoryStore.delete(id); },
      async tombstone(id, values) { return memoryStore.tombstone(id, values); },
      // Expiry is a global destructive operation on MemoryDB; the partition
      // compaction API owns scoped mutations, so never expose the raw purge.
      async purgeExpired() { return 0; },
    };
  };
  const neoRequester = (ctx = {}, event = {}) => ({
    requesterAgentId: [ctx?.agentId, event?.agentId].find(value => typeof value === "string" && value.trim()) || "",
    // ACL binding may not inherit routing defaults; an omitted trusted binding fails closed.
    requesterWorkspaceKey: [ctx?.workspaceKey, event?.workspaceKey, ctx?.workspaceId, event?.workspaceId]
      .find(value => typeof value === "string" && value.trim()) || "",
    requesterOwnerId: [ctx?.ownerId, event?.ownerId, ctx?.userId, event?.userId].find(value => typeof value === "string" && value.trim()) || "",
  });
  const snapshotNeoContent = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter(block => block && typeof block === "object")
      .map(block => {
        if (block.type === "text" && typeof block.text === "string") {
          return { type: "text", text: block.text };
        }
        return {
          type: typeof block.type === "string" ? block.type : "unknown",
          name: typeof block.name === "string" ? block.name : undefined,
          fileName: typeof block.fileName === "string" ? block.fileName : undefined,
          filename: typeof block.filename === "string" ? block.filename : undefined,
          mediaType: typeof block.mediaType === "string" ? block.mediaType : undefined,
          mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
          mime_type: typeof block.mime_type === "string" ? block.mime_type : undefined,
        };
      });
  };
  const snapshotNeoString = (value) => typeof value === "string" ? value : "";
  const snapshotNeoMessages = (messages = []) => Array.isArray(messages)
    ? messages
        .filter(msg => msg && typeof msg === "object")
        .map(msg => ({
          role: msg.role,
          content: snapshotNeoContent(msg.content),
          tool_call_id: msg.tool_call_id,
        }))
    : [];
  const recallInjectionKeys = new Set();
  const markNeoRecallInjection = (event = {}, ctx = {}) => {
    const key = [
      event.runId || ctx.runId || event.turnId || "",
      event.agentSessionKey || ctx.agentSessionKey || event.sessionKey || ctx.sessionKey || event.sessionId || ctx.sessionId || "",
      ctx.agentId || event.agentId || "",
      String(event.prompt || "").slice(0, 120),
    ].filter(Boolean).join("|");
    if (!key) return "";
    if (recallInjectionKeys.has(key)) return null;
    recallInjectionKeys.add(key);
    if (recallInjectionKeys.size > 1000) {
      for (const oldKey of recallInjectionKeys) {
        recallInjectionKeys.delete(oldKey);
        if (recallInjectionKeys.size <= 800) break;
      }
    }
    return `plur1bus:${key}`;
  };

  // MemoryDB.search() resolves a row's missing halfLifeDays against the
  // configured recall.halfLifeDaysMap; every pool this engine opens carries it.
  const EngineAgentDbPool = AgentDbPool.withOptions({ halfLifeOverrides });
  const pool = new MultiNamespacePool(namespaceLayout, vectorDim, EngineAgentDbPool, host.logger);
  const sharedMemoryPool = new SharedMemoryPool(embeddingGenerationLayout.sharedBaseDir, vectorDim, EngineAgentDbPool, host.logger);
  // The control surface gets its own bounded, read-only view. It must never
  // reuse a write pool: a status request is not allowed to create a Lance
  // table, directory, or card as a side effect.
  const controlHealthWorkspaceIdentityByKey = new Map();
  const controlHealthUserLabelByKey = new Map();
  let controlHealthPrimaryAgentIds = [];
  const controlHealthNamespaceRoots = namespaceLayout.mode === "named"
    ? namespaceLayout.recallReadNamespaces.map((id) => ({
        id,
        path: resolve(namespaceLayout.baseDir, id),
        dimensions: vectorDim,
      }))
    : [{ id: "legacy-flat", path: namespaceLayout.baseDbPath, dimensions: vectorDim }];
  const controlHealthScan = createControlPlaneHealthScan({
    namespaceRoots: controlHealthNamespaceRoots,
    sharedRoots: {
      workspace: {
        path: resolve(embeddingGenerationLayout.sharedBaseDir, ".plur1bus-shared", "workspaces"),
        dimensions: vectorDim,
      },
      user: {
        path: resolve(embeddingGenerationLayout.sharedBaseDir, ".plur1bus-shared", "users"),
        dimensions: vectorDim,
      },
    },
    listPartitions: ({ basePath }) => listControlHealthPartitions(basePath),
    inspectRows: createControlHealthRowInspector(vectorDim, host.logger),
    measureStorage: () => measureControlHealthStorage(baseDbPath),
    workspaceIdentityForKey: (key) => controlHealthWorkspaceIdentityByKey.get(key) ?? null,
    userIdentityForKey: (key) => controlHealthUserLabelByKey.get(key) ?? null,
    primaryAgentIds: () => controlHealthPrimaryAgentIds,
    maxPartitions: CONTROL_HEALTH_MAX_PARTITIONS,
  });
  // The workspace identities are refreshed inside the scan, not by the page
  // request: the warm-up at gateway start and the background refresh never
  // go through a request, and without this they would count shared
  // workspace cards under raw pool keys.
  // Pool keys are hashes; the page needs names. Durable policy records name
  // their workspace identity, the alias snapshot names every aliased
  // workspace (`main`) and its pre-alias directory identity (`main.dir`).
  // A bare `workspace:v1:<id>` identity is shown as `<id>`.
  const shortWorkspaceLabel = (identity) => (
    typeof identity === "string" && identity.startsWith("workspace:v1:") && identity.length > "workspace:v1:".length
      ? identity.slice("workspace:v1:".length)
      : identity
  );
  const syncControlHealthWorkspaceIdentities = () => {
    controlHealthWorkspaceIdentityByKey.clear();
    for (const record of workspacePolicyStore.list()) {
      controlHealthWorkspaceIdentityByKey.set(
        workspacePoolKey(record.workspaceIdentity),
        shortWorkspaceLabel(record.workspaceIdentity),
      );
    }
    for (const entry of describeWorkspacePoolLabels(memoryWorkspaceAliases)) {
      if (!controlHealthWorkspaceIdentityByKey.has(entry.poolKey)) {
        controlHealthWorkspaceIdentityByKey.set(entry.poolKey, entry.label);
      }
    }
    // User pools are named after the agent, channel and account whose
    // allowed direct-message user owns them; the user id stays off the page.
    controlHealthUserLabelByKey.clear();
    let liveHostConfig = hostMemoryConfig;
    try {
      const current = host.runtime?.config?.current;
      if (typeof current === "function") liveHostConfig = current() || hostMemoryConfig;
    } catch {
      liveHostConfig = hostMemoryConfig;
    }
    for (const entry of describeUserPoolLabels(liveHostConfig)) {
      controlHealthUserLabelByKey.set(entry.poolKey, entry.label);
    }
    controlHealthPrimaryAgentIds = describePrimaryAgentIds(liveHostConfig);
  };
  const controlHealth = createControlPlaneHealthInspector({
    scan: async () => {
      try {
        syncControlHealthWorkspaceIdentities();
      } catch (error) {
        host.logger.warn(`memory-lancedb-namespaced: control health workspace identities unavailable: ${error?.message || error}`);
      }
      return controlHealthScan();
    },
    ttlMs: CONTROL_HEALTH_CACHE_TTL_MS,
    staleWhileRevalidate: true,
    refreshIntervalMs: CONTROL_HEALTH_REFRESH_INTERVAL_MS,
    failedRetryMs: CONTROL_HEALTH_FAILED_RETRY_MS,
    onRefresh: ({ status, failed, durationMs }) => {
      const line = `memory-lancedb-namespaced: control health snapshot ${failed ? "failed" : "refreshed"} in ${Math.round(durationMs / 100) / 10}s (${status})`;
      if (failed) host.logger.warn(line);
      else host.logger.info(line);
    },
  });
  const legacyMigrationShutdown = new AbortController();
  if (commandRuntimeHooks) {
    const withDb = pool.withDb.bind(pool);
    pool.withDb = async (agentId, operation, ...args) => withDb(agentId, async (db, ...operationArgs) => {
      emitCommandRuntimeHook("onPoolAcquire", { agentId });
      const init = db.init?.bind(db);
      if (init) {
        db.init = async (...initArgs) => {
          emitCommandRuntimeHook("onDbInit", { agentId });
          return init(...initArgs);
        };
      }
      try {
        return await operation(db, ...operationArgs);
      } finally {
        if (init) db.init = init;
      }
    }, ...args);
  }
  const emotionalPool = createEmotionalStatePool({
    temperaments: emotionCfg.temperaments || {},
    moodInfluence: emotionMoodInfluence,
  });
  // One embedder for the whole engine: a test-only testOptions.internals
  // embedder replaces the provider here, at its construction site, so every
  // consumer built below (the DB adapter, the store helper, the command
  // runner, the scoped IPC server, the resource closer) and the registration
  // views use the same object. No real provider is constructed then.
  const embeddings = testOptions.internals?.embeddings ?? (normalizedEmbeddingCfg.provider === "local-transformers"
    ? (requiresActiveSharedModelOwner
        ? new ReloadSafeIpcScopedEmbeddingProvider({
            stateRoot: baseDbPath,
            model: normalizedEmbeddingCfg.local.model,
            dimensions: dimensions || vectorDim,
            fingerprintId: activeEmbeddingFingerprintId,
          })
        : new LocalTransformersEmbeddingProvider({
        ...normalizedEmbeddingCfg.local,
        cacheDir: localModelCacheDir,
        acceptNonCommercialLicense: nonCommercialModelAccepted,
        dimensions: dimensions || vectorDim,
        embeddingCacheEnabled: cfg.runtime?.embeddingCacheEnabled,
        cacheMaxEntries: cfg.runtime?.embeddingCacheMaxEntries ?? normalizedEmbeddingCfg.cacheMaxEntries,
        cacheTtlMs: cfg.runtime?.embeddingCacheTtlMs ?? normalizedEmbeddingCfg.cacheTtlMs,
        embeddingCachePersist: cfg.runtime?.embeddingCachePersist,
        embeddingCachePersistDebug: cfg.runtime?.embeddingCachePersistDebug,
        embeddingCacheCoalesce: cfg.runtime?.embeddingCacheCoalesce,
        embeddingCacheMetrics: cfg.runtime?.embeddingCacheMetrics,
        embeddingCacheScope: cfg.runtime?.embeddingCacheScope,
        embeddingCacheMaxBytes: cfg.runtime?.embeddingCacheMaxBytes,
        cacheBasePath: baseDbPath,
        logger: host.logger,
        localModelGeneration,
        sharedModelPool: sharesActiveLocalModel,
        sharedModelOwner: coordinatesLocalModelGeneration,
        sharedModelRequireOwner: requiresActiveSharedModelOwner,
        sharedModelActivationManaged: coordinatesLocalModelGeneration,
      }))
    : new OpenAIEmbeddingProvider({
        ...normalizedEmbeddingCfg,
        apiKey: normalizedEmbeddingCfg.apiKey,
        apiKeyEnv: normalizedEmbeddingCfg.apiKeyEnv,
        credentialResolver,
        fallback: embeddingCfg.fallback,
        dimensions: dimensions || vectorDim,
        embeddingCacheEnabled: cfg.runtime?.embeddingCacheEnabled,
        cacheMaxEntries: cfg.runtime?.embeddingCacheMaxEntries ?? normalizedEmbeddingCfg.cacheMaxEntries,
        cacheTtlMs: cfg.runtime?.embeddingCacheTtlMs ?? normalizedEmbeddingCfg.cacheTtlMs,
        embeddingCachePersist: cfg.runtime?.embeddingCachePersist,
        embeddingCachePersistDebug: cfg.runtime?.embeddingCachePersistDebug,
        embeddingCacheCoalesce: cfg.runtime?.embeddingCacheCoalesce,
        embeddingCacheMetrics: cfg.runtime?.embeddingCacheMetrics,
        embeddingCacheScope: cfg.runtime?.embeddingCacheScope,
        embeddingCacheMaxBytes: cfg.runtime?.embeddingCacheMaxBytes,
        cacheBasePath: baseDbPath,
        logger: host.logger,
      }));
  const scopedEmbeddingServer = coordinatesLocalModelGeneration
    && normalizedEmbeddingCfg.provider === "local-transformers"
    ? createScopedEmbeddingIpcServer({
        stateRoot: baseDbPath,
        embeddings,
        fingerprintId: activeEmbeddingFingerprintId,
        logger: host.logger,
      })
    : null;
  if (commandRuntimeHooks) {
    for (const method of ["embed", "embedQuery", "embedPassage", "embedBatch"]) {
      if (typeof embeddings[method] !== "function") continue;
      const original = embeddings[method].bind(embeddings);
      embeddings[method] = async (...args) => {
        emitCommandRuntimeHook("onEmbed", { method });
        return original(...args);
      };
    }
  }

  // This adapter also owns plugin-lifecycle resources, so it must exist even
  // on hosts without the optional chat-command registration capability.
  const memoryDbAdapter = createDbAdapter({
    basePath: embeddingGenerationLayout.activeRoot,
    getEmbedding: async (text) => {
      try {
        return await embeddings.embed(text);
      } catch (error) {
        safeDebug(host.logger, "memory-adapter.embedding-fallback", error);
        return null;
      }
    },
    embedder: {
      embed: async (text) => embeddings.embed(text),
    },
    logger: host.logger,
  });

  // Typed MemoryOps (contract 1.5.0, E1). One context instance is shared by
  // every MemoryOps member; it is also exposed on internals as memoryOpsContext.
  // isClosed reads the engine's `closing` flag (set by closeEngine below) so a
  // MemoryOp that started before close() still refuses before it mutates.
  const memoryOpsContext = createMemoryOpsContext({
    host,
    logger: host.logger,
    getWorkspaceAliases: () => internals.memoryWorkspaceAliases ?? memoryWorkspaceAliases,
    isClosed: () => closing != null,
  });
  const memoryRead = createMemoryRead({
    opsContext: memoryOpsContext,
    pool,
    sharedMemoryPool,
    embeddings,
    memoryDbAdapter,
    baseDbPath,
    logger: host.logger,
  });
  const memoryWrite = createMemoryWrite({
    opsContext: memoryOpsContext,
    memoryDbAdapter,
    baseDbPath,
    pool,
    sharedMemoryPool,
    embeddings,
    // E1 Task 8: correct writes through safeUpdate with the Neo store, as /correct always did.
    getNeoStore,
    logger: host.logger,
  });

  // 7.12.48: Das Skill-Ledger liegt je ACL-Partition unter dem Neo-Store.
  // Chat-Befehle und Nudge lasen bis 7.12.47 den Agenten-Workspace, wo nie
  // ein Ledger lag — kein Vorschlag wurde je angezeigt. Diese Helfer leiten
  // die Verzeichnisse genauso ab wie der Miner selbst.
  const skillLedgerDirsFor = (memoryCtx) => {
    const dirs = [];
    for (const partition of buildRemPartitions(memoryCtx)) {
      try { dirs.push(createOwnerBoundNeoStore(partition).paths.workspaceDir); } catch { /* Partition nicht baubar */ }
    }
    return [...new Set(dirs)];
  };
  const skillLedgerDirForAgent = (agentId) => {
    try {
      return skillLedgerDirsFor(resolveMemoryRequestContext({ agentId }, { workspaceAliases: memoryWorkspaceAliases }))[0] || null;
    } catch {
      return null;
    }
  };
  // Gemeinsame Aktivierungs-Abhaengigkeiten fuer Miner-Auto-Apply,
  // Dashboard und Chat: inspect → hash-gebundenes apply → Evidenz-Promotion.
  const skillActivationDeps = (agentId, { actor, actorTier, reason, memoryCtx, lang, tone } = {}) => ({
    agentId,
    lang,
    tone,
    logger: host.logger,
    skillWorkshop: openClawSkillWorkshop,
    // 7.12.52: Mit welcher Stufe die Belege gehoben werden. Die
    // Workshop-Stufe darf nur nach corroborated; die Aktivierung überspringt
    // dann alles andere, statt an einem illegalen Übergang zu scheitern.
    evidenceActorTier: actorTier,
    // 7.12.51: Wo der Host einen angewandten Skill ablegt. Nur benutzt, wenn
    // der Workshop den Vorschlag schon angewandt hat und keinen Zielpfad
    // mitliefert.
    workshopSkillPath: (skillName) => join(
      host.stateDir,
      "agents",
      agentId,
      "agent",
      "workshop-skills",
      skillName,
      "SKILL.md",
    ),
    memoryCtx,
    loadEvidenceRecord: async (memoryId) => {
      try {
        return await pool.withDb(agentId, (db) => db.getById(memoryId));
      } catch (error) {
        // null is indistinguishable from "no evidence exists", so record
        // that this was a failed read instead.
        host.logger.warn(`memory-lancedb-namespaced: evidence record unreadable for ${String(memoryId)}: ${String(error)}`);
        return null;
      }
    },
    applyEpistemicStatus: async (memoryId, nextStatus) => pool.withWriteDb(agentId, (db) => applyEpistemicStatusToLanceDb(db, memoryId, nextStatus, {
      ctx: memoryCtx,
      actor,
      actorTier,
      authorized: false,
      workspaceDir: memoryCtx?.workspaceDir,
      reason,
    })),
  });
  const dashboardSkillAction = async (agentId, proposalId, run) => {
    let memoryCtx;
    try {
      memoryCtx = resolveMemoryRequestContext({ agentId }, { workspaceAliases: memoryWorkspaceAliases });
    } catch {
      return { ok: false, reason: "not_found" };
    }
    const dirs = skillLedgerDirsFor(memoryCtx);
    const ledgerDir = findProposalWorkspace(dirs, proposalId);
    if (!ledgerDir) return { ok: false, reason: "not_found" };
    const proposal = readSkillProposals(ledgerDir).find((entry) => entry.id === proposalId);
    return run({ ledgerDir, memoryCtx, proposal });
  };
  const collectSkillWorkshopDashboard = () => {
    const entries = (host.runtime?.config?.current?.() || host.config())?.agents?.entries;
    const agents = [];
    for (const [agentId, entry] of Object.entries(entries && typeof entries === "object" ? entries : {})) {
      const ledgerDir = skillLedgerDirForAgent(agentId);
      if (!ledgerDir) continue;
      agents.push({ agentId, workspace: entry?.workspace, ledgerDirs: [ledgerDir] });
    }
    return {
      ...collectSkillWorkshopProposals({ agents }),
      available: Boolean(openClawSkillWorkshop),
      mode: skillMinerAutoApplyMode,
      hostMode: hostSkillWorkshopMode(),
      autoApply: skillMinerAutoApplyEffective(),
    };
  };

  const createTargetEmbeddingProvider = async ({ fingerprint, secretRef } = {}) => {
    if (!fingerprint || typeof fingerprint !== "object") {
      throw new Error("reembedding target fingerprint is required");
    }
    if (fingerprint.provider === "local-transformers") {
      const profile = pinnedLocalModelProfile(fingerprint.model);
      if (!profile || profile.revision !== fingerprint.revision) {
        throw new Error(`reembedding local model is not pinned: ${String(fingerprint.model)}`);
      }
      if (profile.role !== "embedding") {
        throw new Error(`reembedding local model is not an embedding model: ${profile.model}`);
      }
      return new LocalTransformersEmbeddingProvider({
        model: fingerprint.model,
        revision: fingerprint.revision,
        dimensions: fingerprint.dimensions,
        queryPrefix: fingerprint.queryPrefix,
        passagePrefix: fingerprint.passagePrefix,
        cacheDir: localModelCacheDir,
        acceptNonCommercialLicense: nonCommercialModelAccepted,
        embeddingCacheEnabled: false,
        logger: host.logger,
        localModelGeneration,
        sharedModelPool: requiresActiveSharedModelOwner,
        sharedModelOwner: false,
        sharedModelRequireOwner: requiresActiveSharedModelOwner,
      });
    }
    return new OpenAIEmbeddingProvider({
      provider: fingerprint.provider,
      model: fingerprint.model,
      baseUrl: fingerprint.endpoint,
      dimensions: fingerprint.dimensions,
      ...(secretRef ? { apiKey: secretRef } : {}),
      credentialResolver,
      embeddingCacheEnabled: false,
      logger: host.logger,
    });
  };
  const embedWithTargetProvider = async (provider, text, purpose) => {
    if (purpose === "query" && typeof provider.embedQuery === "function") {
      return provider.embedQuery(text, { purpose: "reembedding" });
    }
    if (typeof provider.embedPassage === "function") {
      return provider.embedPassage(text, { purpose: "reembedding" });
    }
    return provider.embed(text, { purpose: "reembedding" });
  };
  const shutdownTargetProvider = async (provider, operationError = null) => {
    try {
      await provider?.shutdown?.();
    } catch (shutdownError) {
      if (operationError) {
        throw new AggregateError([operationError, shutdownError], "reembedding provider operation and shutdown failed");
      }
      throw shutdownError;
    }
    if (operationError) throw operationError;
  };
  const targetGenerationDataRoot = (generation) => {
    if (generation === null) {
      return configuredNamespaceLayout.mode === "named"
        ? resolveInside(configuredNamespaceLayout.baseDir, configuredNamespaceLayout.activeWriteNamespace)
        : configuredNamespaceLayout.baseDbPath;
    }
    const root = resolveInside(baseDbPath, "generations", generation);
    return configuredNamespaceLayout.mode === "named"
      ? resolveInside(root, configuredNamespaceLayout.activeWriteNamespace)
      : root;
  };
  const withTargetGenerationDb = async ({ generation, agentId, dimensions: targetDimensions }, operation) => {
    // EngineAgentDbPool, not AgentDbPool: re-embedding reads rank with the
    // same recall.halfLifeDaysMap as every other pool the engine opens.
    const targetPool = new EngineAgentDbPool(
      targetGenerationDataRoot(generation),
      targetDimensions,
      host.logger,
    );
    let operationError = null;
    let result;
    try {
      result = await targetPool.withDb(agentId, operation);
    } catch (error) {
      operationError = error;
    }
    try {
      await targetPool.shutdown();
    } catch (shutdownError) {
      if (operationError) {
        throw new AggregateError([operationError, shutdownError], "reembedding target DB operation and shutdown failed");
      }
      throw shutdownError;
    }
    if (operationError) throw operationError;
    return result;
  };
  const readConfiguredReembeddingSelection = () => {
    const current = host.runtime?.config?.current?.() || host.config();
    const currentReembedding = current?.plugins?.entries?.[PLUGIN_KEY]?.config?.reembedding;
    return Object.freeze({ generation: currentReembedding?.activeGeneration ?? null });
  };
  const runTargetGenerationRuntimeProbe = async (input) => {
    const provider = await createTargetEmbeddingProvider(input);
    const probe = createGenerationRuntimeProbe({
      readActiveSelection: readConfiguredReembeddingSelection,
      embedTarget: ({ text, purpose }) => embedWithTargetProvider(provider, text, purpose),
      withTargetDb: withTargetGenerationDb,
      appendAudit: (entry) => appendDestructiveOpLog(baseDbPath, entry),
    });
    let operationError = null;
    let result;
    try {
      result = await probe(input);
    } catch (error) {
      operationError = error;
    }
    await shutdownTargetProvider(provider, operationError);
    return result;
  };
  const readReembeddingDiskStatus = async () => {
    const disk = statfsSync(baseDbPath);
    const freeBytes = Math.floor(Number(disk.bavail) * Number(disk.bsize));
    return { freeBytes: Math.min(Number.MAX_SAFE_INTEGER, freeBytes) };
  };
  const reembeddingCoordinator = createReembeddingCoordinator({
    stateStore: reembeddingStateStore,
    backend: reembeddingBackend,
    createTargetProvider: createTargetEmbeddingProvider,
    plannerDependencies: {
      statDisk: readReembeddingDiskStatus,
      inspectTargetArtifacts: async ({ fingerprint }) => {
        const profile = pinnedLocalModelProfile(fingerprint.model);
        if (!profile || profile.revision !== fingerprint.revision) {
          return { ready: false, verified: false };
        }
        const provider = await createTargetEmbeddingProvider({ fingerprint });
        let operationError = null;
        let inspected;
        try {
          inspected = provider.cacheDir
            ? await validatePinnedModelArtifacts(profile, provider.cacheDir)
            : { ok: false, artifacts: [] };
        } catch (error) {
          operationError = error;
        }
        await shutdownTargetProvider(provider, operationError);
        return { ready: inspected.ok, verified: inspected.ok };
      },
      probeTargetProvider: async ({ target, purpose }) => {
        const provider = await createTargetEmbeddingProvider(target);
        let operationError = null;
        let vector;
        try {
          vector = await embedWithTargetProvider(
            provider,
            `PLUR1BUS ${purpose} provider probe`,
            "passage",
          );
        } catch (error) {
          operationError = error;
        }
        await shutdownTargetProvider(provider, operationError);
        return vector;
      },
    },
    readPolicySnapshot: async () => workspacePolicyStore.list(),
    runValidationProbes: async ({ record, backend, provider }) => {
      const table = record.source.tables.find((candidate) => candidate.rowCount > 0);
      if (!table) throw new Error("reembedding semantic validation requires at least one source memory");
      const [sourceRow] = await backend.readSourceBatch(table.tableId, { offset: 0, limit: 1 });
      if (!sourceRow || typeof sourceRow.text !== "string" || !sourceRow.text.trim()) {
        throw new Error("reembedding semantic validation source memory is invalid");
      }
      const queryVector = await embedWithTargetProvider(provider, sourceRow.text, "query");
      const recalled = await backend.searchTarget(record.target.generation, table.tableId, queryVector, { limit: 5 });
      if (!recalled.some((candidate) => candidate.id === sourceRow.id)) {
        throw new Error("reembedding target generation did not recall the source validation memory");
      }
      return { semanticRecall: true, validationMemoryId: sourceRow.id, validationTable: table.tableId };
    },
  });
  let modelPreparationCoordinator = null;
  if (cfg.modelPreparation) {
    try {
      modelPreparationCoordinator = createModelPreparationCoordinator({
        stateRoot: baseDbPath,
        cacheDir: localModelCacheDir,
        config: cfg.modelPreparation,
        activeFingerprint: activeEmbeddingFingerprint,
        inventoryActiveGeneration: reembeddingBackend.inventoryActiveGeneration,
        statDisk: readReembeddingDiskStatus,
        logger: host.logger,
      });
    } catch (error) {
      safeWarn(host.logger, "model-preparation.initialize", error);
      modelPreparationCoordinator = createFailedModelPreparationCoordinator({
        config: cfg.modelPreparation,
        activeFingerprint: activeEmbeddingFingerprint,
      });
    }
  }
  const reembeddingConfigMutationAvailable = typeof host.runtime?.config?.mutateConfigFile === "function";
  const reembeddingSelectionMutator = reembeddingConfigMutationAvailable
    ? (capabilities.createEmbeddingSelectionMutator?.() ?? null)
    : null;
  const reembeddingSwitchRuntime = reembeddingConfigMutationAvailable
    ? createReembeddingSwitchRuntime({
        stateStore: reembeddingStateStore,
        maintenanceGate: memoryMaintenanceGate,
        mutateSelection: reembeddingSelectionMutator,
      })
    : Object.freeze({
        async switchGeneration() {
          throw new Error("OpenClaw mutateConfigFile capability is required for reembedding switch");
        },
        async planManualRollback() {
          throw new Error("OpenClaw mutateConfigFile capability is required for reembedding rollback");
        },
      });
  const reembeddingSwitchRecovery = reembeddingConfigMutationAvailable
    ? createReembeddingSwitchRecovery({
        stateStore: reembeddingStateStore,
        readActiveSelection: readConfiguredReembeddingSelection,
        mutateSelection: reembeddingSelectionMutator,
        probeRuntime: runTargetGenerationRuntimeProbe,
      })
    : null;
  const configMutationNotice = capabilities.configMutationNotice ?? null;
  if (configMutationNotice) {
    host.logger?.[configMutationNotice.level]?.(configMutationNotice.message);
  }

  // Reranker (optional — provider-aware since v3.1)
  // Cohere reranker — lokaler Fallback nur wenn fallbackProvider="local-transformers" explizit gesetzt
  const { reranker, rerankerCfg } = createRuntimeRerankerProvider(
    cfg.reranker || {},
    host.logger,
    { credentialResolver, localModelGeneration },
  );
  // Wie viele Kandidaten vor dem Re-Ranking holen (dann auf limit/top_n reduzieren)
  const rerankCandidates = rerankerCfg.candidates ?? candidateTopK;

  if (reranker) {
    const experimental = rerankerCfg.provider === "local-transformers" ? " experimental" : "";
    const modelName = reranker.model || reranker.id || "unknown";
    host.logger.info(`memory-lancedb-namespaced: reranker enabled (${rerankerCfg.provider}${experimental}, model: ${modelName})`);
  }

  host.logger.info(`memory-lancedb-namespaced: registered (baseDbPath: ${baseDbPath})`);

  function resolveStoreScopeAccess(memoryCtx, rawScope) {
    const scope = MEMORY_SCOPES.includes(rawScope) ? rawScope : "agent-private";
    if (!memoryCtx?.agentId) return { ok: false, error: "memory context requires an agent" };
    if (scope === "user" && !memoryCtx.userPrincipal) {
      return { ok: false, error: "user scope requires an authenticated user" };
    }
    if (scope === "workspace" && !memoryCtx.workspaceIdentity) {
      return { ok: false, error: "workspace scope requires a bound workspace" };
    }
    const workspaceIdentity = scope === "workspace" ? memoryCtx.workspaceIdentity : "";
    return {
      ok: true,
      scope,
      ownerUserId: scope === "user" ? memoryCtx.userPrincipal : "",
      ownershipFields: Object.freeze({
        agentId: memoryCtx.agentId,
        storedBy: memoryCtx.agentId,
        workspaceId: workspaceIdentity,
        workspaceKey: workspaceIdentity,
        ownerUserId: scope === "user" ? memoryCtx.userPrincipal : "",
      }),
    };
  }

  function candidateVisibleForStore(candidate, accessCtx) {
    if (!candidate) return false;
    return checkAccess(accessCtx, candidate.entry).allowed;
  }

  function findSafeDuplicateForValidity(candidates, text, validityWindow) {
    return candidates.find((candidate) => (
      isSafeDuplicate(candidate.entry.text, text)
      && stableValidTimeValue(candidate.entry.validFrom) === stableValidTimeValue(validityWindow.validFrom)
      && stableValidTimeValue(candidate.entry.validUntil) === stableValidTimeValue(validityWindow.validUntil)
    ));
  }

  const durableMergeQueues = new Map();

  function stableValidTimeValue(value) {
    const numeric = Number(value || 0);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  }

  function hasEquivalentEpistemicMetadata(left, right, { includeUpdatedAt = true } = {}) {
    const stringFields = [
      "epistemicStatus",
      "epistemicStatusActor",
      "epistemicStatusReason",
      "previousEpistemicStatus",
    ];
    if (stringFields.some((field) => String(left?.[field] ?? "") !== String(right?.[field] ?? ""))) {
      return false;
    }
    return !includeUpdatedAt
      || stableValidTimeValue(left?.epistemicStatusUpdatedAt) === stableValidTimeValue(right?.epistemicStatusUpdatedAt);
  }

  function durableMergeEpistemicMetadata(candidate) {
    return {
      epistemicStatus: combineEpistemicStatusForMerge(candidate.epistemicStatus, undefined),
      previousEpistemicStatus: normalizeEpistemicStatus(candidate.epistemicStatus),
      epistemicStatusActor: "system:merge",
      epistemicStatusReason: `memory_store merge with ${candidate.id}`,
      epistemicStatusUpdatedAt: Date.now(),
    };
  }

  function durableMergeWriteKey({
    workspaceKey,
    text,
    category,
    origin,
    importance,
    ttl,
    sourceUrl,
    evidenceQuote,
    scope,
    ownerUserId,
    validFrom,
    validUntil,
  }) {
    return JSON.stringify([
      workspaceKey,
      text,
      category,
      origin,
      importance,
      ttl,
      sourceUrl,
      evidenceQuote,
      scope,
      ownerUserId,
      stableValidTimeValue(validFrom),
      stableValidTimeValue(validUntil),
    ]);
  }

  function durableMergeIdentity(agentId, candidateId, writeKey) {
    const digest = createHash("sha256")
      .update(JSON.stringify(["memory_store_merge", agentId, candidateId, String(writeKey || "")]))
      .digest("hex");
    return {
      idempotencyKey: `sha256:${digest}`,
      replacementId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    };
  }

  function destructiveDeleteIdempotencyKey(source, agentId, memoryId, via) {
    const digest = createHash("sha256")
      .update(JSON.stringify(["memory.deleted", source, agentId, memoryId, via]))
      .digest("hex");
    return `sha256:${digest}`;
  }

  async function deleteWithAuditContinuation({
    db,
    memoryId,
    workspaceDir,
    logEntry,
    onLateFailure,
  }) {
    const idempotencyKey = logEntry.idempotencyKey
      || destructiveDeleteIdempotencyKey(logEntry.source, logEntry.agentId, memoryId, logEntry.via);
    let deletionLogged = false;
    const appendDeletionLog = () => {
      if (deletionLogged) return;
      appendDestructiveOpLog(workspaceDir, { ...logEntry, memoryId, idempotencyKey });
      deletionLogged = true;
    };

    try {
      await db.delete(memoryId);
    } catch (deleteErr) {
      if (deleteErr instanceof TimeoutError && deleteErr.settlement) {
        const rawDeleteSettlement = deleteErr.settlement;
        deleteErr.settlement = rawDeleteSettlement.then(
          (value) => {
            appendDeletionLog();
            return value;
          },
          (lateDeleteError) => {
            onLateFailure?.(lateDeleteError);
            throw lateDeleteError;
          },
        );
      }
      throw deleteErr;
    }

    appendDeletionLog();
  }

  async function tombstoneMemoryWithAudit({
    db,
    card,
    agentId,
    workspaceDir,
    baseDbPath,
    source,
    via,
    query,
    archivePath,
    actor = "memory_forget",
    actorType = "tool",
    reason = "memory_forget tool",
  }) {
    const memoryId = String(card?.id || "");
    const tombstone = buildTombstone({
      card,
      agentId,
      actor,
      actorType,
      reason,
      sourceOp: source,
      archiveRef: archivePath,
      previousVersion: String(card?.previousVersion || ""),
    });

    let committed = false;
    const commitTombstone = (already) => {
      if (committed) return true;
      // In-Memory-Commit-Flag erst NACH erfolgreicher Persistierung setzen,
      // damit ein fehlgeschlagener Append keinen falschen "committed"-Zustand
      // vortäuscht und ein erneuter Forget nachtragen kann.
      if (baseDbPath && !already) {
        appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "committed" });
      }
      const auditOk = appendDestructiveOpLog(workspaceDir, {
        event: "memory.deleted",
        source,
        agentId,
        memoryId,
        canonicalOriginId: tombstone.canonicalOriginId,
        via,
        query,
        archivePath,
        tombstoneId: tombstone.tombstoneId,
        result: already ? "already_tombstoned" : "committed",
        timestamp: new Date().toISOString(),
      });
      committed = auditOk;
      return auditOk;
    };
    const failTombstone = (errorClass) => {
      if (baseDbPath) {
        appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "failed" });
      }
      appendDestructiveOpLog(workspaceDir, {
        event: "memory.deleted",
        source,
        agentId,
        memoryId,
        via,
        query,
        archivePath,
        tombstoneId: tombstone.tombstoneId,
        result: "failed",
        errorClass: errorClass || "Error",
        timestamp: new Date().toISOString(),
      });
    };

    // Phase 1: attempted (vor der Mutation).
    if (baseDbPath) {
      appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "attempted" });
    }
    let result;
    try {
      result = await db.tombstone(memoryId);
    } catch (err) {
      // LanceDB-Schreib-Timeout: die Mutation kann trotzdem "spät" committen.
      // Keine sofortige failed-Audit — das Ergebnis steht erst bei Settlement fest.
      if (err instanceof TimeoutError && err.settlement) {
        const rawSettlement = err.settlement;
        const derived = rawSettlement.then(
          (value) => {
            // Audit-Fehler beim Late-Settlement muss das Settlement ablehnen.
            if (!commitTombstone(false)) {
              throw new Error("tombstone audit write failed (late settlement)");
            }
            return value;
          },
          (lateErr) => {
            failTombstone(lateErr?.name || "Error");
            throw lateErr;
          },
        );
        // Rejection beobachten, damit ein Late-Audit-Fehler nicht als
        // unhandled rejection den Prozess beendet; das Settlement bleibt abgelehnt.
        derived.catch((lateErr) => {
          host.logger.warn(`memory-lancedb-namespaced: memory_forget late settlement audit failed for agent=${agentId} memory=${memoryId}: ${String(lateErr)}`);
        });
        err.settlement = derived;
        throw err;
      }
      failTombstone(err?.name || "Error");
      throw err;
    }
    if (result?.notFound) {
      if (baseDbPath) {
        appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "failed" });
      }
      return { ok: false, notFound: true };
    }
    if (result?.alreadyTombstoned) {
      // Crash-Recovery: Zeile bereits deleted — fehlenden committed Tombstone
      // und Audit nachtragen. Fehlschlag des Backfills ist ein Fehler (fail-closed),
      // kein stilles ok:true.
      if (baseDbPath) {
        const backfill = backfillCommittedTombstone(baseDbPath, card, {
          agentId,
          actor,
          actorType,
          reason,
          sourceOp: source,
          archiveRef: archivePath,
          previousVersion: String(card?.previousVersion || ""),
        });
        // Audit IMMER schreiben (auch bei alreadyCommitted), damit ein zuvor
        // verschluckter Audit-Schreibfehler nicht dauerhaft unerfasst bleibt.
        const backfillAuditOk = appendDestructiveOpLog(workspaceDir, {
          event: "memory.deleted",
          source,
          agentId,
          memoryId,
          canonicalOriginId: backfill.tombstone.canonicalOriginId,
          via,
          query,
          archivePath,
          tombstoneId: backfill.tombstone.tombstoneId,
          result: backfill.alreadyCommitted ? "already_tombstoned" : "committed",
          timestamp: new Date().toISOString(),
        });
        if (!backfillAuditOk) {
          throw new Error("tombstone audit write failed");
        }
      }
      return { ok: true, alreadyTombstoned: true };
    }
    // Phase 2: committed erst nach bestätigter Mutation.
    if (!commitTombstone(Boolean(result?.alreadyTombstoned))) {
      throw new Error("tombstone audit write failed");
    }
    return { ok: true, alreadyTombstoned: Boolean(result?.alreadyTombstoned) };
  }

  function durableMergeLineage(candidate) {
    return [
      candidate.id,
      `valid-time:${stableValidTimeValue(candidate.validFrom)}:${stableValidTimeValue(candidate.validUntil)}`,
    ];
  }

  function isExpectedMergeReplacement(entry, replacementId, candidateId, expectedEntry, expectedCandidate) {
    if (!entry || entry.id !== replacementId || entry.text !== expectedEntry.text) return false;
    if (entry.status && entry.status !== "active") return false;
    const stableFields = [
      "agentId",
      "storedBy",
      "workspaceId",
      "workspaceKey",
      "scope",
      "ownerUserId",
      "sourceUrl",
      "evidenceQuote",
    ];
    if (stableFields.some((field) => entry[field] !== expectedEntry[field])) return false;
    if (!hasEquivalentEpistemicMetadata(entry, expectedEntry, { includeUpdatedAt: false })) return false;
    if (Number(entry.validFrom || 0) !== Number(expectedEntry.validFrom || 0)) return false;
    if (Number(entry.validUntil || 0) !== Number(expectedEntry.validUntil || 0)) return false;
    try {
      const lineage = JSON.parse(entry.mergedFrom || "[]");
      if (!Array.isArray(lineage)) {
        host.logger.debug(`memory-lancedb-namespaced: invalid mergedFrom shape for replacement=${replacementId}`);
        return false;
      }
      return durableMergeLineage(expectedCandidate).every((marker) => lineage.includes(marker));
    } catch (error) {
      host.logger.debug(`memory-lancedb-namespaced: invalid mergedFrom for replacement=${replacementId}: ${String(error)}`);
      return false;
    }
  }

  function isExpectedMergeCandidate(entry, expectedEntry, candidateId, accessCtx) {
    if (!entry || entry.id !== candidateId || entry.text !== expectedEntry.text) return false;
    if (entry.status && entry.status !== "active") return false;
    if (!hasEquivalentEpistemicMetadata(entry, expectedEntry)) return false;
    if (stableValidTimeValue(entry.validFrom) !== stableValidTimeValue(expectedEntry.validFrom)) return false;
    if (stableValidTimeValue(entry.validUntil) !== stableValidTimeValue(expectedEntry.validUntil)) return false;
    return candidateVisibleForStore({ entry }, accessCtx);
  }

  function runDurableMergeQueued(queueKey, operation) {
    const predecessor = durableMergeQueues.get(queueKey) || Promise.resolve();
    const operationPromise = predecessor
      .catch((predecessorErr) => {
        // The predecessor already delivered its own failure. Keep the key
        // usable for the next independent attempt and make the continuation
        // visible without propagating the old rejection into the new work.
        host.logger.debug(`memory-lancedb-namespaced: durable merge predecessor failed for ${queueKey}: ${String(predecessorErr)}`);
      })
      .then(operation);
    const settlementTail = operationPromise.catch(async (error) => {
      const settlement = await waitForTimeoutSettlement(error);
      if (settlement.status === "rejected") {
        host.logger.debug(
          `memory-lancedb-namespaced: durable merge late settlement failed for ${queueKey}: ${String(settlement.error)}`,
        );
      }
    });
    durableMergeQueues.set(queueKey, settlementTail);
    settlementTail.then(
      () => {
        if (durableMergeQueues.get(queueKey) === settlementTail) durableMergeQueues.delete(queueKey);
      },
      (trackingError) => {
        host.logger.warn(`memory-lancedb-namespaced: durable merge settlement tracking failed for ${queueKey}: ${String(trackingError)}`);
        if (durableMergeQueues.get(queueKey) === settlementTail) durableMergeQueues.delete(queueKey);
      },
    );
    return operationPromise;
  }

  async function withDurableMerge({
    db,
    agentId,
    selectedCandidate,
    accessCtx,
    workspaceDir,
    writeKey,
    prepareReplacement,
  }) {
    const candidateId = safeUuid(selectedCandidate?.entry?.id);
    const selectedText = selectedCandidate?.entry?.text;
    const queueKey = JSON.stringify([agentId, candidateId]);
    return runDurableMergeQueued(queueKey, async () => {
      const authoritativeCandidate = await db.getById(candidateId);
      if (!isExpectedMergeCandidate(authoritativeCandidate, selectedCandidate.entry, candidateId, accessCtx)) {
        const staleErr = new Error("merge candidate is stale, no longer active, or no longer authorized");
        host.logger.warn(`memory-lancedb-namespaced: durable merge revalidation failed for agent=${agentId} candidate=${candidateId}: ${staleErr.message}`);
        throw staleErr;
      }

      const { idempotencyKey, replacementId } = durableMergeIdentity(agentId, candidateId, writeKey || selectedText);

      const preparedResult = await prepareReplacement(authoritativeCandidate, replacementId);
      if (!preparedResult) return null;

      let candidateAfterPreparation;
      try {
        candidateAfterPreparation = await db.getById(candidateId);
      } catch (revalidationErr) {
        host.logger.warn(`memory-lancedb-namespaced: durable merge post-prepare revalidation read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId}: ${String(revalidationErr)}`);
        throw revalidationErr;
      }
      if (!isExpectedMergeCandidate(candidateAfterPreparation, authoritativeCandidate, candidateId, accessCtx)) {
        const staleErr = new Error("stale merge candidate changed during replacement preparation");
        host.logger.warn(`memory-lancedb-namespaced: durable merge post-prepare revalidation failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId}: ${staleErr.message}`);
        throw staleErr;
      }

      const mergedEntry = { ...preparedResult.mergedEntry, id: safeUuid(replacementId) };
      const prepared = { ...preparedResult, mergedEntry };
      let archivePath = "";
      try {
        archivePath = archiveCard(authoritativeCandidate, agentId);
      } catch (archiveErr) {
        host.logger.warn(`memory-lancedb-namespaced: durable merge archive failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath || "unwritten"}: ${String(archiveErr)}`);
        throw archiveErr;
      }

      const finishDurableMerge = async () => {
        let verifiedReplacement;
        try {
          verifiedReplacement = await db.getById(replacementId);
        } catch (verificationErr) {
          host.logger.warn(`memory-lancedb-namespaced: durable merge verification read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(verificationErr)}`);
          throw verificationErr;
        }
        if (!isExpectedMergeReplacement(verifiedReplacement, replacementId, candidateId, mergedEntry, authoritativeCandidate)) {
          const verificationErr = new Error(`merge replacement verification failed for ${replacementId}`);
          host.logger.warn(`memory-lancedb-namespaced: durable merge verification failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${verificationErr.message}`);
          throw verificationErr;
        }

        let candidateBeforeDelete;
        try {
          candidateBeforeDelete = await db.getById(candidateId);
        } catch (revalidationErr) {
          host.logger.warn(`memory-lancedb-namespaced: durable merge pre-delete revalidation read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(revalidationErr)}`);
          throw revalidationErr;
        }
        if (!isExpectedMergeCandidate(candidateBeforeDelete, authoritativeCandidate, candidateId, accessCtx)) {
          const staleErr = new Error("stale merge candidate changed before original deletion");
          host.logger.warn(`memory-lancedb-namespaced: durable merge pre-delete revalidation failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${staleErr.message}`);
          throw staleErr;
        }

        try {
          await deleteWithAuditContinuation({
            db,
            memoryId: candidateId,
            workspaceDir,
            logEntry: {
              event: "memory.deleted",
              source: "memory_store_merge",
              agentId,
              via: "merge",
              archivePath,
              idempotencyKey,
              timestamp: new Date().toISOString(),
            },
            onLateFailure: (lateDeleteError) => {
              host.logger.warn(`memory-lancedb-namespaced: durable merge late delete failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(lateDeleteError)}`);
            },
          });
        } catch (deleteErr) {
          host.logger.warn(`memory-lancedb-namespaced: durable merge delete failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(deleteErr)}`);
          throw deleteErr;
        }
        return { ...prepared, authoritativeCandidate, archivePath, idempotencyKey };
      };

      let existingReplacement;
      try {
        existingReplacement = await db.getById(replacementId);
      } catch (idempotencyReadError) {
        host.logger.warn(`memory-lancedb-namespaced: durable merge idempotency read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId}: ${String(idempotencyReadError)}`);
        throw idempotencyReadError;
      }
      if (existingReplacement) {
        if (!isExpectedMergeReplacement(existingReplacement, replacementId, candidateId, mergedEntry, authoritativeCandidate)) {
          throw new Error(`durable merge idempotency collision for ${replacementId}`);
        }
        return finishDurableMerge();
      }

      try {
        await db.store(mergedEntry);
      } catch (storeErr) {
        if (storeErr instanceof TimeoutError && storeErr.settlement) {
          const rawStoreSettlement = storeErr.settlement;
          storeErr.settlement = rawStoreSettlement.then(
            () => finishDurableMerge(),
            (lateStoreError) => {
              host.logger.warn(`memory-lancedb-namespaced: durable merge late store failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(lateStoreError)}`);
              throw lateStoreError;
            },
          );
        }
        host.logger.warn(`memory-lancedb-namespaced: durable merge store failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(storeErr)}`);
        throw storeErr;
      }

      return finishDurableMerge();
    });
  }

  async function storeMemoryFromToolParams(storeCtx = {}, params = {}) {
    const memoryCtx = storeCtx.memoryCtx || resolveToolMemoryRequestContext({
      agentId: storeCtx.agentId,
      workspaceDir: storeCtx.workspaceDir,
      sessionKey: storeCtx.sessionKey,
      messageChannel: storeCtx.messageChannel,
      agentAccountId: storeCtx.agentAccountId,
      requesterSenderId: storeCtx.requesterSenderId,
      deliveryContext: storeCtx.deliveryContext,
    }, { workspaceAliases: memoryWorkspaceAliases });
    const storeAgentId = memoryCtx.agentId;
    const scopeAccess = resolveStoreScopeAccess(memoryCtx, params.scope);
    if (!scopeAccess.ok) return { error: scopeAccess.error };
    const { scope, ownerUserId, ownershipFields } = scopeAccess;
    const storeWorkspaceKey = ownershipFields.workspaceKey;
    // v6.2.1 — Input-Validierung für Memory-Text (P0-Fix)
    const textValidation = validateMemoryText(params.text);
    if (!textValidation.ok) {
      return { error: textValidation.error };
    }
    const validTimeValidation = validateValidTimeInputFields(params, ["validFrom", "validUntil"]);
    if (!validTimeValidation.ok) return { error: validTimeValidation.error };
    const trace = createRecallDecisionTrace({
      query: textPreview(params.text, traceCfg.maxTextPreviewChars ?? 160),
      mode: "store",
      maxTextPreviewChars: traceCfg.maxTextPreviewChars ?? 160,
      maxCandidates: traceCfg.maxCandidates ?? 50,
    });
    try {
      return await pool.withWriteDb(storeAgentId, async (storeDb) => {
      const vector = await embeddings.embed(params.text, { agentId: storeAgentId });
      const categoryResult = params.category
        ? { category: params.category, reason: "caller-provided" }
        : categorizeMemoryWithReason(params.text);
      const category = categoryResult.category;
      const categoryReason = categoryResult.reason;
      const origin = MEMORY_ORIGINS.includes(params.origin) ? params.origin : "dm";
      const importanceResult = computeMemoryImportance({
        text: params.text,
        category,
        categoryReason,
        explicitImportance: params.importance,
        origin,
      });
      const importance = importanceResult.importance;
      addTraceStoreDecision(trace, {
        action: "importance_assessed",
        memoryId: null,
        reason: `category=${category} (${categoryReason}); importance=${importance.toFixed(2)}; ${importanceResult.importanceReason}`,
      });
      const expiresAt = params.ttl && TTL_MAP[params.ttl] ? Date.now() + TTL_MAP[params.ttl] : 0;
      const storeAccessCtx = memoryCtx;
      const sourceUrl = typeof params.sourceUrl === "string" ? params.sourceUrl.slice(0, 500) : "";
      const evidenceQuote = typeof params.evidenceQuote === "string" ? params.evidenceQuote.slice(0, 200) : "";
      // Phase 2 — Bi-Temporal Memory (§7): caller-supplied only, never
      // guessed/extracted from text. Unparseable/absent -> 0 (unknown).
      const { validFrom: capturedValidFrom, validUntil: capturedValidUntil } = normalizeCapturedValidityWindow(params, { logger: host.logger });

      // 0. Tombstone-Block: eine gleichlautende, zuvor gelöschte Erinnerung im
      // selben autorisierten Scope darf nicht still reaktiviert werden.
      const blockingTombstone = findBlockingTombstoneForCapture(baseDbPath, {
        agentId: storeAgentId,
        text: params.text,
        scope,
        workspaceIdentity: ownershipFields.workspaceId || ownershipFields.workspaceKey,
        ownerUserId,
      });
      if (blockingTombstone) {
        if (blockingTombstone._blockReason) {
          host.logger.warn(`memory-lancedb-namespaced: tombstone registry ${blockingTombstone._blockReason} for agent=${storeAgentId}: ${blockingTombstone._diagnostic || ""} — blocking capture fail-closed`);
        }
        addTraceStoreDecision(trace, {
          action: "tombstone_blocked",
          memoryId: blockingTombstone.memoryId,
          reason: blockingTombstone._blockReason || `forgotten memory fingerprint match (scope=${scope})`,
        });
        return {
          content: [{ type: "text", text: "This information was previously forgotten and cannot be silently re-stored." }],
          details: { action: "tombstone_blocked", id: blockingTombstone.memoryId, decisionTrace: trace },
        };
      }

      // 1. Duplicate check
      const existing = (await storeDb.findSimilar(vector, params.text, duplicateThreshold))
        .filter((candidate) => candidateVisibleForStore(candidate, storeAccessCtx));
      if (existing.length > 0) {
        const safeDuplicate = findSafeDuplicateForValidity(
          existing,
          params.text,
          { validFrom: capturedValidFrom, validUntil: capturedValidUntil },
        );
        if (!safeDuplicate) {
          // Nothing went wrong here: a near-duplicate was found, merging was refused
          // because the validity windows differ, and the memory was stored separately.
          // That is the conservative outcome, and the decision is already durable in the
          // trace as unsafe_duplicate_rejected. Reporting a safe refusal at warn turned a
          // routine store into an operator alarm -- 192 of them in one seeded run.
          host.logger.info(`[memory-merge-safety] high similarity but no safe duplicate; storing separately: "${params.text.slice(0, 120)}"`);
          addTraceStoreDecision(trace, { action: "unsafe_duplicate_rejected", memoryId: existing[0].entry.id, reason: "high similarity but no safe duplicate" });
        } else {
          if (storeCtx.workspaceDir) appendCurationLog(storeCtx.workspaceDir, storeAgentId, { event: "memory.rejected_duplicate", timestamp: new Date().toISOString(), agentId: storeAgentId, memoryId: safeDuplicate.entry.id, text: params.text.slice(0, 200), category, origin, reason: `duplicate_score:${safeDuplicate.score.toFixed(3)}`, relatedId: safeDuplicate.entry.id });
          addTraceStoreDecision(trace, { action: "safe_duplicate", memoryId: safeDuplicate.entry.id, reason: `duplicate_score:${safeDuplicate.score.toFixed(3)}` });
          return { content: [{ type: "text", text: `Similar memory already exists: "${safeDuplicate.entry.text}"` }], details: { action: "duplicate", id: safeDuplicate.entry.id, decisionTrace: trace } };
        }
      }

      // 2. Merge check (+ conflict detection for decision category)
      if (mergingEnabled && mergingLlmCfg && mergingAutoApply) {
        const mergeCandidateRaw = await storeDb.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
        const mergeCandidate = candidateVisibleForStore(mergeCandidateRaw, storeAccessCtx) ? mergeCandidateRaw : null;
        if (mergeCandidate) {
          addTraceStoreDecision(trace, { action: "merge_candidate", memoryId: mergeCandidate.entry.id, reason: `merge_score:${mergeCandidate.score.toFixed(3)}` });
          const durableMerge = await withDurableMerge({
            db: storeDb,
            agentId: storeAgentId,
            selectedCandidate: mergeCandidate,
            accessCtx: storeAccessCtx,
            workspaceDir: storeCtx?.workspaceDir,
            writeKey: durableMergeWriteKey({
              workspaceKey: storeWorkspaceKey,
              text: params.text,
              category,
              origin,
              importance,
              ttl: params.ttl && TTL_MAP[params.ttl] ? params.ttl : "",
              sourceUrl,
              evidenceQuote,
              scope,
              ownerUserId,
              validFrom: capturedValidFrom,
              validUntil: capturedValidUntil,
            }),
            prepareReplacement: async (authoritativeCandidate, replacementId) => {
              let mergeResult = null;
              if (hasMeaningfulDifference(authoritativeCandidate.text, params.text)) {
                host.logger.warn(`[memory-merge-safety] merge candidate has meaningful difference; storing separately: "${params.text.slice(0, 120)}" vs "${authoritativeCandidate.text.slice(0, 120)}"`);
                addTraceStoreDecision(trace, { action: "merge_aborted", memoryId: authoritativeCandidate.id, reason: "meaningful difference" });
              } else {
                try {
                  mergeResult = await Promise.race([
                    callMergeCheck(
                      authoritativeCandidate.text,
                      params.text,
                      mergingLlmCfg,
                      storeAgentId,
                      storeCtx.callContext,
                    ),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
                  ]);
                } catch (mergeErr) {
                  host.logger.warn("memory-lancedb-namespaced: merge check skipped", {
                    errorClass: normalizedLlmErrorClass(mergeErr),
                  });
                }
              }
              if (category === "decision" && storeCtx.workspaceDir && authoritativeCandidate.storedBy && authoritativeCandidate.storedBy !== storeAgentId) {
                const mergeDecision = mergeResult?.merge === true ? "merged" : "stored_separately";
                appendConflictLog(storeCtx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: storeAgentId, newText: params.text.slice(0, 200), existingMemoryId: authoritativeCandidate.id, existingAgentId: authoritativeCandidate.storedBy, existingText: authoritativeCandidate.text.slice(0, 200), score: mergeCandidate.score, category, mergeDecision });
              }
              const minLen = Math.min(authoritativeCandidate.text.length, params.text.length);
              if (!(mergeResult?.merge === true && mergeResult.mergedText && mergeResult.mergedText.length > minLen)) {
                return null;
              }
              if (!validateMergedTextPreservesFacts(authoritativeCandidate.text, params.text, mergeResult.mergedText)) {
                host.logger.warn(`[memory-merge-safety] LLM mergedText loses facts; aborting merge and storing separately: "${mergeResult.mergedText.slice(0, 120)}"`);
                addTraceStoreDecision(trace, { action: "merge_aborted", memoryId: authoritativeCandidate.id, reason: "LLM mergedText loses facts" });
                return null;
              }
              if (hasDisjointValidityWindows(authoritativeCandidate, { validFrom: capturedValidFrom, validUntil: capturedValidUntil })) {
                host.logger.warn(`[memory-merge-safety] disjoint validity windows; aborting merge and storing separately`);
                addTraceStoreDecision(trace, { action: "merge_aborted", memoryId: authoritativeCandidate.id, reason: "disjoint validity windows" });
                return null;
              }
              const mergedImportance = Math.max(importance, authoritativeCandidate.importance ?? 0.5);
              const mergedVector = await embeddings.embed(mergeResult.mergedText, { agentId: storeAgentId });
              const mergedValidTime = combineValidTimeForMerge(authoritativeCandidate, { validFrom: capturedValidFrom, validUntil: capturedValidUntil });
              const mergedEntry = applyDynamicsDefaults({ id: replacementId, text: mergeResult.mergedText, summary: generateSummary(mergeResult.mergedText, summaryMaxWords), origin, vector: mergedVector, importance: mergedImportance, category, createdAt: Date.now(), mergedFrom: JSON.stringify(durableMergeLineage(authoritativeCandidate)), expiresAt, ...ownershipFields, ...durableMergeEpistemicMetadata(authoritativeCandidate), sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: Date.now(), sourceUrl, evidenceQuote, scope, validFrom: mergedValidTime.validFrom, validUntil: mergedValidTime.validUntil }, Date.now(), halfLifeOverrides, { flashbulbEncodingEnabled });
              return { mergedEntry, mergeResult, mergedImportance };
            },
          });
          if (durableMerge) {
            const { mergedEntry, mergeResult, mergedImportance, authoritativeCandidate } = durableMerge;
            if (storeCtx.workspaceDir) appendCurationLog(storeCtx.workspaceDir, storeAgentId, { event: "memory.merged", timestamp: new Date().toISOString(), agentId: storeAgentId, memoryId: mergedEntry.id, text: mergeResult.mergedText.slice(0, 200), category, origin, reason: `merged_with:${authoritativeCandidate.id} (${mergeResult.reason || ""})`, relatedId: authoritativeCandidate.id });
            if (storeCtx.workspaceDir && shouldPromoteMemory(category, mergedImportance, importanceResult.factQuality, schicht15MinImportance)) {
              trackKnowledgePending(storeCtx.workspaceDir, { sourceAgent: storeAgentId, memoryId: mergedEntry.id, category, importance: mergedImportance });
            }
            addTraceStoreDecision(trace, { action: "merge_allowed", memoryId: mergedEntry.id, reason: `merged_with:${authoritativeCandidate.id} (${mergeResult.reason || ""})` });
            return { content: [{ type: "text", text: `Memory merged [${category}|${origin}]: "${mergeResult.mergedText}" (ID: ${mergedEntry.id})` }], details: { action: "merged", id: mergedEntry.id, decisionTrace: trace } };
          }
        }
      } else if (category === "decision" && storeCtx.workspaceDir) {
        try {
          const conflictCandidateRaw = await storeDb.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
          const conflictCandidate = candidateVisibleForStore(conflictCandidateRaw, storeAccessCtx) ? conflictCandidateRaw : null;
          if (conflictCandidate && conflictCandidate.entry.storedBy && conflictCandidate.entry.storedBy !== storeAgentId) {
            appendConflictLog(storeCtx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: storeAgentId, newText: params.text.slice(0, 200), existingMemoryId: conflictCandidate.entry.id, existingAgentId: conflictCandidate.entry.storedBy, existingText: conflictCandidate.entry.text.slice(0, 200), score: conflictCandidate.score, category, mergeDecision: "no_merge_llm_call" });
          }
        } catch (_e) { dbg(_e); }
      }

      // 3. Normal store
      const summary = generateSummary(params.text, summaryMaxWords);
      const entry = applyDynamicsDefaults({ id: randomUUID(), text: params.text, summary, origin, vector, importance, category, createdAt: Date.now(), mergedFrom: "[]", expiresAt, ...ownershipFields, sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: Date.now(), sourceUrl, evidenceQuote, scope, validFrom: capturedValidFrom, validUntil: capturedValidUntil, epistemicStatus: decideEpistemicStatusForCapture({ text: params.text, sourceMessageRole: "", origin, cutoffFailed: !epistemicCutoffBoot.ok }) }, Date.now(), halfLifeOverrides, { flashbulbEncodingEnabled });
      await storeDb.store(entry);
      if (riCfg.enabled) {
        setImmediate(() => {
          const maintenance = pool.withWriteDb(storeAgentId, (maintenanceDb) =>
            applyRetroactiveInterference(maintenanceDb, entry, {
              threshold: riCfg.threshold ?? 0.65,
              multiplier: riCfg.multiplier ?? 0.9,
              maxAffected: riCfg.maxAffected ?? 5,
            }));
          return maintenance.catch((err) => {
            host.logger.warn("[retroactive-interference] failed", err?.message ?? err);
          });
        });
      }
      if (storeCtx.workspaceDir) appendCurationLog(storeCtx.workspaceDir, storeAgentId, { event: "memory.stored", timestamp: new Date().toISOString(), agentId: storeAgentId, memoryId: entry.id, text: params.text.slice(0, 200), category, origin, reason: "stored", relatedId: null });
      if (storeCtx.workspaceDir && shouldPromoteMemory(category, importance, importanceResult.factQuality, schicht15MinImportance)) {
        trackKnowledgePending(storeCtx.workspaceDir, { sourceAgent: storeAgentId, memoryId: entry.id, category, importance });
      }
      addTraceStoreDecision(trace, { action: "stored_separately", memoryId: entry.id, reason: "stored" });
      return { content: [{ type: "text", text: `Memory stored [${category}|${origin}]: ${summary} (ID: ${entry.id})` }], details: { action: "stored", id: entry.id, decisionTrace: trace } };
      });
    } catch (err) {
      return { content: [{ type: "text", text: `Memory store failed: ${String(err)}` }] };
    }
  }

  // One policy builder for every service-side vault write (bridge service
  // and the discover-semantic-links cron): the exact workspace identity,
  // the bridge's mode/dryRun/allowWrite, and the receipt for THIS vault.
  // The cron handler used to call the discoverer without any policy, which
  // the policy layer rightly reads as "blocked", so scheduled discovery
  // never wrote a single link.
  const obsidianServiceMutationPolicy = (workspace, { plan = ["dashboards", "build"], actionConfirmed } = {}) => {
    const workspaceIdentity = normalizeWorkspaceTarget(
      workspace.workspaceId,
      "Obsidian service workspace",
    );
    const memoryCtx = {
      agentId: workspace.agentId,
      workspaceIdentity,
      workspaceId: workspaceIdentity,
    };
    return parseObsidianCommandPlan(plan, {
      memoryCtx,
      baseDbPath,
      mode: obsidianBridgeCfg.mode,
      dryRun: obsidianBridgeCfg.dryRun,
      allowWrite: obsidianBridgeCfg.allowWrite,
      vaultConfirmed: isOwnedVaultConfirmed({
        baseDbPath,
        memoryCtx,
        vaultPath: workspace.path,
      }),
      ...(actionConfirmed === undefined ? {} : { actionConfirmed }),
    }).mutationPolicy;
  };

  const bridgeService = obsidianBridgeEnabled
    ? createObsidianBridgeService(obsidianBridgeCfg, {
        logger: host.logger,
        loadLanceDbRecords: async ({ workspace }) => {
          const workspaceIdentity = normalizeWorkspaceTarget(
            workspace.workspaceId,
            "Obsidian service workspace",
          );
          const memoryCtx = Object.freeze({
            agentId: safeAgentId(workspace.agentId),
            workspaceIdentity,
            workspaceId: workspaceIdentity,
            userPrincipal: "",
            workspaceAliases: memoryWorkspaceAliases,
          });
          return pool.withAuthoritativeReadDb(memoryCtx.agentId, async (mirrorDb) => {
            const initialized = await mirrorDb.init();
            if (initialized === false) return [];
            const records = await mirrorDb.scanActive();
            if (!Array.isArray(records)) {
              throw new TypeError("Obsidian memory mirror scan must return an array");
            }
            return records.filter((record) => checkAccess(memoryCtx, record).allowed);
          });
        },
        mutationPolicyForWorkspace: (workspace) => obsidianServiceMutationPolicy(workspace),
        memoryStore: async ({ workspace, payload }) => {
          const memoryCtx = resolveMemoryRequestContext({
            agentId: workspace.agentId,
            workspaceDir: workspace.path,
          }, { workspaceAliases: memoryWorkspaceAliases });
          const result = await storeMemoryFromToolParams({ memoryCtx, workspaceDir: memoryCtx.workspaceDir }, payload);
          const text = result?.content?.[0]?.text || "";
          if (text.startsWith("Memory store failed")) throw new Error(text);
          return result;
        },
      })
    : null;

  const jobs = createJobRegistry({ host, jobsRoot: join(baseDbPath, "_jobs") });

  const resolveCommandLocale = (commandCtx) => {
    emitCommandRuntimeHook("onLocale", { commandCtx });
    const messages = commandCtx?.messages || [];
    const lang = resolveLocale({ ctx: commandCtx, messages, fallback: "en" });
    const toneHint = commandCtx?.workspaceDir ? readSoulToneCached(commandCtx.workspaceDir) : null;
    const tone = pickTone(toneHint);
    return { lang, tone };
  };

  const parsePlur1busArgs = (commandCtx) => commandCtx.args?.trim().split(/\s+/).filter(Boolean) || [];
  const plur1busHelp = (mode = "quick", opts = {}) => ({
    text: mode === "advanced" ? t("plur1bus.help_advanced", opts) : t("plur1bus.help_quick", opts),
  });
  const obsidianActionNames = new Set([
    "conflicts",
    "cron",
    "dashboards",
    "evening",
    "evening-review",
    "morning",
    "morning-review",
    "review",
  ]);
  const resolveCronMemoryContext = async (commandCtx) => {
    const agentId = safeAgentId(commandCtx?.agentId || "default");
    // The OpenClaw runtime's resolver when the host has one (unchanged path);
    // otherwise the contract's HostServices.workspaceDir, so internal jobs run
    // on a host without an OpenClaw runtime (the harness scheduler, M1b-3).
    const resolver = host.runtime?.agent?.resolveAgentWorkspaceDir;
    const workspaceDir = typeof resolver === "function"
      ? await resolver(commandCtx?.config, agentId)
      : await host.workspaceDir(agentId);
    return resolveMemoryRequestContext({
      agentId,
      workspaceDir,
      channel: "cron",
      accountId: "cron",
    }, { workspaceAliases: memoryWorkspaceAliases });
  };
  // Chat command dispatch is deliberately deny-by-classification: a new
  // action must be added to one of these predicates before it may acquire
  // a store or other memory-bearing dependency.
  const SENSITIVE_READ_ACTIONS = new Set([
    "behavior", "curation", "doctor", "dreaming", "embeddings", "memory",
    "origin", "persona", "recall", "reminder", "reminders", "skills", "start",
    "state", "status", "temperament",
  ]);
  const isSensitiveChatRead = (actionKey, subKey) => {
    if (actionKey === "neo") return subKey === "workspaces";
    if (actionKey === "critical") return ["", "list"].includes(subKey);
    if (!SENSITIVE_READ_ACTIONS.has(actionKey)) return false;
    if (actionKey === "skills") return ["review", "list", "show"].includes(subKey);
    if (actionKey === "reminder" || actionKey === "reminders") return ["", "list", "show", "help"].includes(subKey);
    if (actionKey === "memory") return !["promote", "demote", "prune", "tombstone", "disable-overlay", "supersede-overlay"].includes(subKey);
    if (actionKey === "behavior") return !["promote", "demote", "prune"].includes(subKey);
    return true;
  };
  const isDestructiveAction = (actionKey, subKey, tokens) => (
    actionKey === "setup"
    || actionKey === "migrate-legacy-shared"
    || actionKey === "enable"
    || actionKey === "disable"
    || actionKey === "forget"
    || actionKey === "correct"
    || (actionKey === "critical" && ["accept", "reject", "edit"].includes(subKey))
    || (actionKey === "temperament" && Boolean(subKey))
    || (actionKey === "persona" && ["regenerate", "accept"].includes(subKey))
    || (actionKey === "skills" && ["approve", "reject"].includes(subKey))
    || (actionKey === "curation" && ["resolve", "apply-conflict", "drop-injected", "confirm"].includes(subKey))
    || ((actionKey === "reminder" || actionKey === "reminders") && ["cancel", "delete"].includes(subKey))
    || (actionKey === "memory" && ["promote", "demote", "prune", "tombstone", "disable-overlay", "supersede-overlay"].includes(subKey))
    || (actionKey === "behavior" && ["promote", "demote", "prune"].includes(subKey))
    || (actionKey === "neo" && subKey === "workspaces" && tokens[2] === "migrate" && !tokens.includes("--dry-run"))
  );
  const knownPlur1busActions = new Set([
    ...SENSITIVE_READ_ACTIONS, "setup", "enable", "disable", "forget", "correct",
    "internal", "migrate-legacy-shared", "neo", "critical",
  ]);
  // Pending-confirmation state, shared by the /plur1bus dispatcher and by
  // the user-facing command handlers registered further down. Both hold
  // the *same* two Map objects — a copy would split the nonce index from
  // the record store and silently break every confirmation round-trip.
  // They are declared here, above the first reader, rather than next to
  // the handlers: PR-03f evaluates the dispatcher's context object at
  // this point, and a `const` declared later is in its temporal dead zone.
  const confirmationStore = new Map();
  const confirmationIndex = new Map();
  const callCommandLlm = async (messages, llmCfg) => {
    emitCommandRuntimeHook("onLlmCallContext", llmCfg?.callContext);
    return callLlm(messages, llmCfg);
  };
  // The ten command bodies and auth/locale helpers the runner thunks live
  // in one shared object: adapter/openclaw/plugin.js fills it from
  // registerChatCommands()'s return value after this engine is built, and
  // the thunks below read it at command time (EngineInternals.commandBodies).
  const commandBodies = {};
  // The ten thunked keys below are filled in *after* this point (the
  // user-facing command bodies and their auth/locale helpers). The
  // runner only calls them at command time, so a lazy `(...args) =>`
  // wrapper keeps this object literal out of their temporal dead zone.
  // `resolveNeoHooksConfig` arrives as a host capability: the engine module
  // never sees the OpenClaw plugin handle.
  const runPlur1busCommandWithIdentity = createPlur1busCommandRunner({
    __pluginDir,
    afterthoughtLlmCfg,
    aggregateSkillMinerRuns,
    applyEpistemicStatusToLanceDb,
    baseDbPath,
    callCommandLlm,
    callLlm,
    cfg,
    checkArgsLength: (...args) => commandBodies.checkArgsLength(...args),
    checkAuth: (...args) => commandBodies.checkAuth(...args),
    commandOption,
    completePendingConfirmation,
    confirmationIndex,
    confirmationStore,
    conflictResolutionLlmCfg,
    createFeatureRoute,
    createOwnerBoundMemoryStore,
    createOwnerBoundNeoStore,
    createOwnerBoundTarget,
    createPartitionScopedDb,
    dbg,
    dreamEchoLlmCfg,
    dreamNarrativeCfg,
    dreamNarrativeLlmCfg,
    embeddings,
    EMOTION_REFINE_DEADLINE_MS,
    EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES,
    EMOTION_REFINE_MAX_ROWS,
    encodingCallLlm,
    episodeExtractionLlmCfg,
    findNeoRecord,
    flashbulbEncodingEnabled,
    formatJsonCommandResult,
    getFeatureCronsSetupHint,
    getNeoStore,
    host,
    isDestructiveAction,
    isSensitiveChatRead,
    jobs,
    knownPlur1busActions,
    legacyMigrationShutdown,
    memoryCompactionLlmCfg,
    memoryDbAdapter,
    mergingEnabled,
    metaCognitionLlmReport,
    NEO_MANUAL_DRAIN_DEADLINE_MS,
    NEO_MANUAL_DRAIN_MAX_ITEMS,
    neoCfg,
    neoEmbeddingDrainImpact,
    neoEnabled,
    neoGlobalRecall,
    neoRequester,
    neoRoot,
    neoWorkspaceAliases,
    normalizedEmbeddingCfg,
    obsidianActionNames,
    obsidianBridgeCfg,
    obsidianServiceMutationPolicy,
    openClawSkillWorkshop,
    overlayAuditLlmCfg,
    parsePlur1busArgs,
    personaEvolveMinDaysBetween,
    personaEvolveMinOutcomes,
    personaMaxBullets,
    personaVoiceLlmCfg,
    plur1busHelp,
    pool,
    registeredObsidianCommandHandler,
    rememberNeoWorkspace,
    rememberPendingConfirmation,
    remPatternLlmCfg,
    resolveCommandLocale,
    resolveConfirmationIdentity,
    resolveCronMemoryContext,
    resolveDenialLocale: (...args) => commandBodies.resolveDenialLocale(...args),
    resolveEnvVars,
    resolveNeoHooksConfig: capabilities.resolveNeoHooksConfig ?? (() => ({})),
    resolveRegisteredMemoryContext: (...args) => commandBodies.resolveRegisteredMemoryContext(...args),
    resolveTemperamentName,
    runCorrectCommand: (...args) => commandBodies.runCorrectCommand(...args),
    runCriticalCommand: (...args) => commandBodies.runCriticalCommand(...args),
    runFeatureToggle: (...args) => commandBodies.runFeatureToggle(...args),
    runForgetCommand: (...args) => commandBodies.runForgetCommand(...args),
    runMemoryCommand: (...args) => commandBodies.runMemoryCommand(...args),
    runSemanticDiscoveryBatches,
    runStatusCommand: (...args) => commandBodies.runStatusCommand(...args),
    runtimeScheduler,
    selectSemanticDiscoveryWorkspaces,
    sharedMemoryPool,
    skillActivationDeps,
    skillLedgerDirsFor,
    skillMinerAutoApplyEffective,
    skillMinerCfg,
    skillMinerEnabled,
    skillMinerLlmCfg,
    storeMemoryFromToolParams,
    summarizeNeoStore,
    vectorDim,
    workspacePolicyGuard,
  });

  // ========================================================================
  // Auto-Recall: Memories before prompt build injecten
  // ========================================================================

  // resolveCommandLocale ist im neoEnabled-Block definiert, aber autoRecall
  // kann unabhängig davon aktiviert sein. Wir brauchen eine eigene Kopie,
  // die außerhalb beider Blöcke verfügbar ist.
  const resolveCommandLocaleRecall = (commandCtx) => {
    const messages = commandCtx?.messages || [];
    const lang = resolveLocale({ ctx: commandCtx, messages, fallback: "en" });
    const toneHint = commandCtx?.workspaceDir ? readSoulToneCached(commandCtx.workspaceDir) : null;
    const tone = pickTone(toneHint);
    return { lang, tone };
  };

  // P0-1: Minimaler Maintenance-Pfad für interne/background Turns (Cron,
  // Heartbeat, Dreaming, Magic Messages). Führt Neo-Hook-Tracking und
  // GC-Purge durch, erzeugt aber KEINEN Recall-Context.
  function runMinimalBeforePromptMaintenance(event, ctx, { neoEnabled, gcEnabled }) {
    const agentId = ctx?.agentId;
    if (neoEnabled) {
      try {
        const neoStore = getNeoStore(ctx, event);
        neoStore.recordHook("before_prompt_build", {
          agentId: ctx?.agentId || "default",
          promptLength: event?.prompt?.length || 0,
          runner: event?.runner || event?.provider || "",
          skipped: true,
        });
      } catch (neoErr) {
        host.logger.warn(`plur1bus-neo: before_prompt_build maintenance tracking failed: ${String(neoErr)}`);
      }
    }
    // GC: purge expired memories (non-blocking, throttled on hot path)
    if (gcEnabled) {
      pool.withDb(agentId, (db) => db.purgeExpiredThrottled(host.logger)).catch((gcErr) => {
        host.logger.warn(`memory-lancedb-namespaced: GC purge on internal turn failed: ${String(gcErr)}`);
      });
    }
    return undefined;
  }

  // The engine's close path. The OpenClaw adapter registers the same closer as
  // the host's runtime-lifecycle cleanup and gateway_stop handler
  // (registerGatewayShutdownServices), so every caller shares one promise.
  const closeResources = createResourceCloser({
    logger: host.logger,
    memoryDbAdapter,
    pool: {
      shutdown: async () => {
        legacyMigrationShutdown.abort();
        await pool.shutdown();
      },
    },
    sharedMemoryPool,
    clearTurnRoutes: clearInitializedTurnRoutes,
    flushMetrics,
    llmResultCache,
    scopedEmbeddingServer,
    embeddings,
    reranker,
    modelPreparationCoordinator,
    reembeddingCoordinator,
    localModelGeneration,
  });
  let closing = null;
  const closeEngine = (budgetMs) => {
    if (closing) return closing;
    const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 30_000;
    // close() never rejects (final review m4): a resource that fails to
    // close is logged, and the engine is closed either way. The closer is
    // read from internals so a testOptions.internals override reaches it.
    closing = Promise.race([
      Promise.resolve()
        .then(() => internals.closeResources())
        .catch((error) => { host.logger.warn(`plur1bus engine: close failed; the engine is closed anyway: ${detailOf(error)}`); }),
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          host.logger.warn(`plur1bus engine: close exceeded ${budget} ms; resources still closing in the background`);
          resolve();
        }, budget);
        timer.unref?.();
      }),
    ]);
    return closing;
  };

  // EngineInternals: the union of what the nine register-* contexts, the
  // memory capability and the skill-proposal listener read (derived with
  // tools/free-identifiers.mjs), plus the Engine surface's own members.
  const internals = {
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
    closeEngine,
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
    host,
    hostRoutingLoader,
    jobs,
    llmResultCache,
    markNeoRecallInjection,
    maxPromptMemories,
    memoryAccountTopology,
    memoryDbAdapter,
    memoryOpsContext,
    memoryRead,
    memoryWrite,
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
    model,
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
    ...(testOptions.internals ?? {}),
  };

  // Registration views (spec 3.1: views over EngineInternals are built once,
  // not per call). Each is the context the OpenClaw adapter used to assemble
  // inline for registerRecallHook / registerCaptureHook / registerMemoryTools;
  // the adapter now spreads these with its host handle, and the Engine
  // surface below builds its recall assembler, capture handler and tool
  // factory from the same objects. Members are read from `internals`, not
  // the local bindings, so testOptions.internals overrides reach both paths.
  const viewOf = (names, extra) => {
    const view = {};
    for (const name of names) {
      if (!Object.hasOwn(internals, name)) throw new Error(`EngineInternals has no ${name}`);
      view[name] = internals[name];
    }
    return Object.freeze({ ...view, ...extra });
  };
  internals.recallContext ??= viewOf([
    "NEO_EMBED_TIMEOUT",
    "NEO_RECALL_PRELUDE_LOG_MS",
    "adaptiveBudgetCfg",
    "autoRecallMinScore",
    "automaticWorkspacePolicyDecision",
    "candidateTopK",
    "canonicalEnabled",
    "canonicalMaxItems",
    "canonicalMinScore",
    "cfg",
    "checkpointStore",
    "dedupEnabled",
    "dedupJaccard",
    "detectReactionsCapabilityCached",
    "embeddings",
    "emotionalPool",
    "gcEnabled",
    "getMemoryTurnRoutes",
    "getNeoStore",
    "host",
    "hostRoutingLoader",
    "markNeoRecallInjection",
    "maxPromptMemories",
    "memoryAccountTopology",
    "memoryTextContradictionLlmCfg",
    "memoryWorkspaceAliases",
    "mergingEnabled",
    "namespaceLayout",
    "neoEnabled",
    "neoGlobalRecall",
    "neoRequester",
    "neoWorkerRuntime",
    "overlayLlmCfg",
    "personaDirectiveMaxChars",
    "personaVoiceLlmCfg",
    "pool",
    "queryRefinerEnabled",
    "recallQueryLlmCfg",
    "replyOutcomeDynamics",
    "replyOutcomeEnabled",
    "replyOutcomeMaxAssistantChars",
    "replyOutcomeMaxMemoryIds",
    "rerankCandidates",
    "reranker",
    "rerankerCfg",
    "resolveCommandLocaleRecall",
    "runMinimalBeforePromptMaintenance",
    "runNeoGlobalSearch",
    "runtimeScheduler",
    "schicht15Enabled",
    "semanticCompressionCfg",
    "semanticLensCfg",
    "sharedMemoryPool",
    "skillLedgerDirForAgent",
    "skillMinerEnabled",
    "softBudgetFallback",
    "softBudgetMs",
    "summaryMaxWords",
    "temporalContextEnabled",
    "traceCfg",
    "traceEnabled",
    "traceInPrompt",
    "workspacePolicyGuard",
  ], {
    MAX_PROMPT_REPLY_OUTCOME_READ_BYTES,
    buildMaintenanceNudges,
    callLlm,
    dbg,
    makeQuerySummarizer,
    normalizeBoundedRecallInteger,
    normalizedLlmErrorClass,
    resolveRuntimeRecallBudget,
    runMergedNamespaceRecall,
  });
  internals.captureContext ??= viewOf([
    "NEO_HOOK_DRAIN_MARGIN_MS",
    "NEO_HOOK_DRAIN_MIN_MS",
    "baseDbPath",
    "captureSummaryLlmCfg",
    "cfg",
    "checkpointStore",
    "classifyEmotionForStore",
    "classifyHostIncognitoSession",
    "conversationInsightsLlmCfg",
    "dreamEchoLlmCfg",
    "dreamNarrativeCfg",
    "dreamNarrativeLlmCfg",
    "duplicateThreshold",
    "embeddings",
    "emotionIntensityHalfLifeFactor",
    "emotionalPool",
    "episodeExtractionLlmCfg",
    "epistemicCutoffBoot",
    "flashbulbEncodingEnabled",
    "getNeoStore",
    "halfLifeOverrides",
    "host",
    "jobs",
    "memoryWorkspaceAliases",
    "mergingEnabled",
    "metaCognitionEnabled",
    "metaCognitionIntervalMs",
    "metaCognitionLlmReport",
    "metaCognitionSessionThreshold",
    "metaReflectionState",
    "neoAgentEndBudgetMs",
    "neoCfg",
    "neoEmbeddingAutoDrainEnabled",
    "neoEmbeddingDrainImpact",
    "neoEmbeddingDrainMaxItems",
    "neoEnabled",
    "neoRoot",
    "neoWorkerRuntime",
    "neoWorkspaceAliases",
    "personaVoiceLlmCfg",
    "pool",
    "rememberNeoWorkspace",
    "reminderAutoExtract",
    "resolveTemperamentName",
    "runtimeScheduler",
    "skillMinerEnabled",
    "snapshotNeoMessages",
    "snapshotNeoString",
    "summaryMaxWords",
    "vectorDim",
    "workspacePolicyGuard",
  ], {
    EPISODED_TURN_ID_MEMORY,
    MAX_POSTPROCESSING_RETRIES,
    callLlm,
    generateSummary,
    runSpeakerProposalPipeline,
    summarizeForCapture,
    textSuggestsGroupOrigin,
    waitForTimeoutSettlement,
  });
  internals.toolContext ??= viewOf([
    "TTL_MAP",
    "adaptiveBudgetCfg",
    "baseDbPath",
    "candidateTopK",
    "candidateVisibleForStore",
    "canonicalEnabled",
    "canonicalMaxItems",
    "canonicalMinScore",
    "cfg",
    "classifyEmotionForStore",
    "dedupEnabled",
    "dedupJaccard",
    "duplicateThreshold",
    "durableMergeEpistemicMetadata",
    "durableMergeLineage",
    "durableMergeWriteKey",
    "embeddings",
    "emotionIntensityHalfLifeFactor",
    "emotionalPool",
    "epistemicCutoffBoot",
    "findSafeDuplicateForValidity",
    "flashbulbEncodingEnabled",
    "forgetThreshold",
    "getNeoStore",
    "halfLifeOverrides",
    "host",
    "maxPromptMemories",
    "memoryWorkspaceAliases",
    "mergingAutoApply",
    "mergingEnabled",
    "mergingLlmCfg",
    "mergingThreshold",
    "namespaceLayout",
    "pool",
    "queryRefinerEnabled",
    "recallMinScore",
    "recallQueryLlmCfg",
    "rerankCandidates",
    "reranker",
    "rerankerCfg",
    "resolveStoreScopeAccess",
    "runtimeScheduler",
    "schicht15Enabled",
    "schicht15LlmCfg",
    "schicht15MaxPromotions",
    "schicht15MinImportance",
    "sharedMemoryPool",
    "softBudgetFallback",
    "softBudgetMs",
    "summaryMaxWords",
    "tombstoneMemoryWithAudit",
    "traceCfg",
    "traceEnabled",
    "withDurableMerge",
    "workspacePolicyGuard",
  ], {
    KNOWLEDGE_LOCK_FILE,
    appendConflictLog,
    appendCurationLog,
    callLlm,
    callMergeCheck,
    dbg,
    formatKnownValidityLabel,
    generateSummary,
    makeQuerySummarizer,
    normalizeBoundedRecallInteger,
    normalizedLlmErrorClass,
    readKnowledgePendingSnapshot,
    removeKnowledgePending,
    resolveRuntimeRecallBudget,
    runMergedNamespaceRecall,
    trackKnowledgePending,
    withDeterministicLlmContext,
  });
  // The capture handler is built at most once: createTurnCapture binds the
  // light-dream job owner when it runs, and a second call would throw. It is
  // built lazily — by the adapter's registerCaptureHook (only when autoCapture
  // is on, as before) or by the first Engine.capture() — so an engine that
  // never captures leaves light-dream unowned exactly as before. The recall
  // assembler and the tool factory have no construction-time side effect;
  // they are lazy only so an adapter-only engine never builds them.
  let captureTurnHandler = null;
  let engineRecallTurn = null;
  let memoryToolFactory = null;
  internals.getCaptureTurn ??= () => (captureTurnHandler ??= createTurnCapture(internals.captureContext));
  internals.getToolFactory ??= () => (memoryToolFactory ??= createMemoryTools(internals.toolContext));
  // Engine.recall always passes its memoryCtx, so its assembler needs no turn
  // resolver; the adapter builds its own with the host's (register-recall-hook.js).
  const getRecallTurn = () => (engineRecallTurn ??= createPromptContextAssembler(internals.recallContext));

  const clock = () => (typeof host.clock === "function" ? host.clock() : Date.now());
  const detailOf = (error) => String(error?.message || error).slice(0, 200);
  const notInM1b1 = (name) => async () => {
    throw new Error(`${name} is not available in M1b-1`);
  };
  const openedAgents = new Set();
  const channels = createChannelRegistry();
  let toolSpecs = null;

  // EmbeddingService over the engine's provider and reranker.
  const embeddingService = Object.freeze({
    async embed(texts, o = {}) {
      const provider = internals.embeddings;
      const method = o.kind === "query" ? "embedQuery" : "embedPassage";
      const vectors = await Promise.all(texts.map((text) => provider[method](text, { signal: o.signal })));
      return vectors.map((vector) => Float32Array.from(vector));
    },
    rerank: (query, docs, o = {}) => (internals.reranker
      ? internals.reranker.rerank(query, docs, o.topN, { signal: o.signal })
      : Promise.resolve([])),
    probe: async () => ({ ok: true, cached: false }),
    identities: () => [Object.freeze({
      fingerprintId: internals.activeEmbeddingFingerprintId,
      provider: internals.normalizedEmbeddingCfg.provider,
      model: internals.normalizedEmbeddingCfg.model || internals.model,
      dimensions: internals.vectorDim,
    })],
    serve: async () => ({ dispose() {} }),
  });

  // AdminOps: the existing coordinators behind the contract's method names;
  // an operation with no engine-side implementation yet rejects.
  // share/forget (1.6.0, deprecated) are aliases of Engine.memory.share/forget —
  // same code path as engine.memory below, not a second implementation.
  const adminOps = Object.freeze({
    share: async (id, target, p, a, opts) => { assertMemoryOpen(); return internals.memoryWrite.share(id, target, p, a, opts); },
    forget: async (id, p, a) => { assertMemoryOpen(); return internals.memoryWrite.forget(id, p, a); },
    reembedding: Object.freeze({
      plan: (...args) => internals.reembeddingCoordinator.plan(...args),
      apply: (...args) => internals.reembeddingCoordinator.apply(...args),
      resume: (...args) => internals.reembeddingCoordinator.resume(...args),
      status: (...args) => internals.reembeddingCoordinator.status(...args),
      rollback: (...args) => (internals.reembeddingSwitchRuntime
        ? internals.reembeddingSwitchRuntime.planManualRollback(...args)
        : notInM1b1("admin.reembedding.rollback without host config mutation")()),
      switch: (...args) => (internals.reembeddingSwitchRuntime
        ? internals.reembeddingSwitchRuntime.switchGeneration(...args)
        : notInM1b1("admin.reembedding.switch without host config mutation")()),
    }),
    workspacePolicy: Object.freeze({
      get: async (...args) => internals.workspacePolicyStore.get(...args),
      list: async (...args) => internals.workspacePolicyStore.list(...args),
      set: async (...args) => internals.workspacePolicyStore.set(...args),
    }),
    obsidian: Object.freeze({
      detect: notInM1b1("admin.obsidian.detect"),
      prepare: notInM1b1("admin.obsidian.prepare"),
      confirm: notInM1b1("admin.obsidian.confirm"),
    }),
    migrate: async (from, to) => { assertMemoryOpen(); return storeMigrator.migrate(from, to); },
  });
  internals.embeddingService = embeddingService;
  internals.adminOps = adminOps;

  // What recall/capture answer once close() was called (final review m4).
  const ENGINE_CLOSED = Object.freeze({ reason: "engine-closed", detail: "engine closed" });
  const assertMemoryOpen = () => {
    if (closing) throw memoryOpError("storage", "engine is closed");
  };

  // The Engine (types/engine.d.ts, contract 1.6.0).
  const engine = {
    contract: "1.6.0",
    async open(agentId) {
      const id = safeAgentId(agentId);
      await internals.pool.withDb(id, (db) => db.init());
      openedAgents.add(id);
      return { agentId: id, close: async () => { openedAgents.delete(id); } };
    },
    close: ({ budgetMs } = {}) => internals.closeEngine(budgetMs),
    async status() {
      return {
        ready: true,
        degraded: null,
        agents: openedAgents.size,
        contract: "1.6.0",
        storeSchema: { current: storeMigrator.current(), expected: STORE_SCHEMA_VERSION },
      };
    },
    systemSupplement: () => buildSystemSupplement({ neoEnabled: internals.neoEnabled }),
    async recall(q) {
      if (closing) return recallResult({ degraded: { ...ENGINE_CLOSED, capability: "recall" } });
      if (!(q?.signal instanceof AbortSignal)) {
        return recallResult({ degraded: { reason: "invalid-query", capability: "recall", detail: "signal is required" } });
      }
      try {
        const agentId = safeAgentId(q.principal?.agentId);
        const workspaceDir = await host.workspaceDir(agentId);
        const memoryCtx = memoryContextFromPrincipal(q.principal, { workspaceDir, workspaceAliases: internals.memoryWorkspaceAliases, logger: host.logger });
        const query = String(q.query ?? "");
        const event = { prompt: query, messages: [{ role: "user", content: query }], ...(q.compactedAt ? { compactedAt: q.compactedAt } : {}) };
        // The assembler itself emits `recall.completed` (with `timing`) once
        // per scheduled recall — do not emit it again here, or every
        // `Engine.recall` call would double the event the adapter's own
        // registered hook already produces through the same assembler.
        return (await getRecallTurn()(event, { agentId, workspaceDir }, { signal: q.signal, memoryCtx, agentContext: q.agent })) ?? recallResult();
      } catch (error) {
        // An abort that lands before the assembler runs (e.g. during
        // host.workspaceDir) is still an abort, not a bad query.
        return recallResult({ degraded: { reason: q.signal.aborted ? "aborted" : "invalid-query", capability: "recall", detail: detailOf(error) } });
      }
    },
    capture(t) {
      const controller = new AbortController();
      const signal = t?.signal instanceof AbortSignal ? AbortSignal.any([t.signal, controller.signal]) : controller.signal;
      const acceptedAt = clock();
      const done = (async () => {
        if (closing) return { stored: 0, skipped: 1, reason: ENGINE_CLOSED.reason };
        if (t?.incognito !== false) return { stored: 0, skipped: 1, reason: "incognito" };
        const agentId = safeAgentId(t.agentId);
        // The turn's agent and its principal's agent must agree: the queue is
        // keyed by one and the stores are scoped by the other.
        if (t.principal?.agentId !== agentId) return { stored: 0, skipped: 1, reason: "principal-agent-mismatch" };
        const workspaceDir = await host.workspaceDir(agentId);
        const memoryCtx = memoryContextFromPrincipal(t.principal, { workspaceDir, sessionKey: t.sessionKey, workspaceAliases: internals.memoryWorkspaceAliases, logger: host.logger });
        // TurnRecord.incognito === false is the host's own classification:
        // the host routing classifier is not consulted again (a host without
        // routing would otherwise store nothing for a keyed session).
        const report = { stored: 0, skipped: 0 };
        const outcome = await internals.getCaptureTurn()(
          { messages: t.messages, success: true, runId: t.runId, sessionKey: t.sessionKey },
          { agentId, workspaceDir, sessionKey: t.sessionKey },
          { memoryCtx, agentContext: t.agent, signal, incognitoClassified: true, report },
        );
        if (outcome?.ok) return { stored: report.stored, skipped: report.skipped };
        return { stored: 0, skipped: 1, reason: outcome?.reason ?? (outcome?.aborted ? "aborted" : "not_captured") };
      })().catch((error) => ({ stored: 0, skipped: 1, reason: detailOf(error) }));
      return { id: randomUUID(), acceptedAt, done, abort: (reason) => controller.abort(reason) };
    },
    async checkpoint(agentId, reason) {
      return internals.checkpointStore.checkpoint(safeAgentId(agentId), reason);
    },
    get tools() {
      // The five specs do not depend on who asks: they are read once from a
      // describe-only tool context (the engine's own state directory as the
      // workspace), and nothing built here is ever executed.
      toolSpecs ??= Object.freeze(internals.getToolFactory()({ agentId: "default", workspaceDir: host.stateDir })
        .map(({ name, description, parameters }) => Object.freeze({ name, description, parameters })));
      return toolSpecs;
    },
    commands: Object.freeze([Object.freeze({ name: "plur1bus", description: "PLUR1BUS memory commands", acceptsArgs: true })]),
    async runCommand(name, args, principalIn, agentIn) {
      if (name !== "plur1bus") {
        return { text: `command not available on this host: ${String(name).slice(0, 64)}`, details: { reason: "unknown-command" } };
      }
      // The six user-facing command bodies and their auth/locale helpers are
      // still built by the OpenClaw adapter (register-commands.js) and handed
      // over through commandBodies; on a host without that surface the
      // dispatcher's first call would be a TypeError.
      if (typeof internals.commandBodies.checkArgsLength !== "function") {
        return {
          text: "PLUR1BUS commands are not available on this host.",
          details: { reason: "commands-unavailable", capability: "commands" },
        };
      }
      try {
        const agentId = safeAgentId(principalIn?.agentId);
        const workspaceDir = await host.workspaceDir(agentId);
        const memoryCtx = memoryContextFromPrincipal(principalIn, { workspaceDir, workspaceAliases: internals.memoryWorkspaceAliases, logger: host.logger });
        return await internals.runPlur1busCommand(
          { agentId, args: String(args ?? ""), channel: principalIn.channel, accountId: principalIn.accountId, chatId: principalIn.chat?.id, workspaceDir, config: host.config() },
          [],
          { agentContext: agentIn, memoryCtx },
        );
      } catch (error) {
        return { text: "PLUR1BUS command failed.", details: { reason: "command-failed", detail: detailOf(error) } };
      }
    },
    jobs: Object.freeze({
      list: () => internals.jobs.list(),
      // Only the contract's options reach the registry: a host cannot inject
      // the registry-internal `input`/`preSkip`. `signal` is observed before
      // start only; `dryRun` comes back skipped/dry_run_unsupported.
      run: async (name, agentId, opts = {}) => {
        if (closing) throw new Error("engine closed");
        return internals.jobs.run(name, agentId, {
          trigger: opts?.trigger ?? "harness",
          ...(opts?.signal instanceof AbortSignal ? { signal: opts.signal } : {}),
          ...(opts?.dryRun === true ? { dryRun: true } : {}),
        });
      },
      history: (agentId, opts = {}) => internals.jobs.history(agentId, opts),
    }),
    embedding: embeddingService,
    admin: adminOps,
    // Typed MemoryOps surface (contract 1.5.0, E1). After close() every member
    // rejects with MemoryOpError "storage" before it touches a store, so a
    // late call can neither reopen LanceDB nor write an archive or tombstone.
    memory: Object.freeze({
      list: async (q, p, a) => { assertMemoryOpen(); return internals.memoryRead.list(q, p, a); },
      show: async (id, p, a) => { assertMemoryOpen(); return internals.memoryRead.show(id, p, a); },
      forget: async (id, p, a) => { assertMemoryOpen(); return internals.memoryWrite.forget(id, p, a); },
      correct: async (id, newText, p, a) => { assertMemoryOpen(); return internals.memoryWrite.correct(id, newText, p, a); },
      share: async (id, target, p, a, opts) => { assertMemoryOpen(); return internals.memoryWrite.share(id, target, p, a, opts); },
      state: async (p, a) => { assertMemoryOpen(); return internals.memoryRead.state(p, a); },
    }),
    events: Object.freeze({
      on(name, handler) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handler);
        return { dispose: () => { listeners.get(name)?.delete(handler); } };
      },
    }),
    channels,
  };
  Object.defineProperty(engine, ENGINE_INTERNALS, { value: internals, enumerable: false });
  return engine;
}
