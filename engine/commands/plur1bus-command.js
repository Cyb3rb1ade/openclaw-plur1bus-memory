/**
 * engine/commands/plur1bus-command.js
 *
 * The /plur1bus chat command (was index.js:7271-9055), including the 17
 * internal job runners that PR-07 turns into JobRegistry.run(). Host-neutral:
 * every dependency arrives in the context object, and the OpenClaw
 * registration stays in index.js.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCurationRecord } from "../../lib/curation-resolve.js";
import { buildRemPartitions, describeRemPartitionRun, resolveRemOutputRoot, runRemDream, writeRemDreamToVault } from "../../lib/dreaming/rem-dream.js";
import { applyDropInjected, previewDropInjected } from "../../lib/drop-injected-conflicts.js";
import { DEFAULT_TEMPERAMENTS } from "../../lib/emotional-state.js";
import { buildRefinePatch, classifyEncoding } from "../../lib/encoding-llm.js";
import { findEpisodeCardPath, rebuildEpisode, writeEpisodeToVault } from "../../lib/episodes.js";
import { t } from "../../lib/i18n.js";
import { IMPORTANCE_STATUS } from "../../lib/importance-status.js";
import { formatAfterthoughtCronReply, formatClassifierCronReply } from "../../lib/internal-cron-reply.js";
import { applyConflictViaSafeUpdate, findResolvableConflict, resolutionApplyId, resolutionApplyText } from "../../lib/jobs/apply-conflict-resolution.js";
import { autoAcceptStale as runAutoAcceptStale } from "../../lib/jobs/auto-accept-stale-criticals.js";
import { runClassifier as runCriticalClassifier } from "../../lib/jobs/critical-classifier.js";
import { runConsolidation as runDailyConsolidation } from "../../lib/jobs/daily-consolidation.js";
import { runFeedbackAnalyzer } from "../../lib/jobs/feedback-analyzer.js";
import { runGcJob } from "../../lib/jobs/gc-job.js";
import { runProactiveCheck } from "../../lib/jobs/proactive-check.js";
import { runReflectionJob } from "../../lib/jobs/reflection-job.js";
import { runReminderDispatch } from "../../lib/jobs/reminder-dispatch.js";
import { runSkillMiner } from "../../lib/jobs/skill-miner.js";
import { getPendingProposals } from "../../lib/jobs/skill-miner/proposal-writer.js";
import { resolveLancedbOptimizePlan, summarizeLancedbOptimize } from "../../lib/lancedb-optimize.js";
import { LLM_RESULT_CACHE_PURPOSES, withLlmCallContext } from "../../lib/llm-result-cache.js";
import { LLM_ROUTE_KINDS, isLlmRouteAvailable } from "../../lib/llm-router.js";
import { pruneGraphEdges } from "../../lib/memory-graph.js";
import { buildNeoDoctorReport, createNeoStore, migrateNeoWorkspaces, transitionRecordStatus } from "../../lib/neo-arch.js";
import { resolveCommandVaultPath } from "../../lib/obsidian-control-room.js";
import { describeOwnedVaultConfirmation, isOwnedVaultConfirmed } from "../../lib/obsidian-vault-authority.js";
import { runOverlayAuditCommand } from "../../lib/overlay-commands.js";
import { cancelReminder, listReminders } from "../../lib/reminder-store.js";
import { readReplyOutcomeLog } from "../../lib/reply-outcome-tracking.js";
import { createConfirmation } from "../../lib/security.js";
import { PLUGIN_KEY, applyFeatureProfile, consumePlur1busStartNotice, describeProfileDiff, detectObsidianVaults, detectPendingFeatures, recommendedProfile, renderPlur1busStartStatus, safeProfile } from "../../lib/setup/feature-profiles.js";
import { migrateLegacySharedRows, parseLegacyMigrationArgs } from "../../lib/shared-memory-migration.js";
import { appendDestructiveOpLog } from "../../lib/sql-safety.js";
import { withConfigLock } from "../../lib/telegram-commands/feature-toggle.js";
import { activateSkillProposal, buildSkillReviewPayload, findProposalWorkspace, listActiveSkills, rejectSkillProposalWithWorkshop, showProposal } from "../../lib/telegram-commands/skill-commands.js";
import { applyTemperamentToRawConfig, renderTemperamentOverview } from "../../lib/temperament-command.js";

/**
 * Build the /plur1bus command runner from an already-resolved engine context.
 * Every binding the moved body closes over is destructured once, here, at
 * registration time.
 *
 * @param {Record<string, any>} ctx Engine context; see the destructuring below.
 * @returns {(commandCtx: Record<string, any>, prefixTokens?: string[]) => Promise<any>} The command runner.
 */
export function createPlur1busCommandRunner(ctx) {
  const {
    __pluginDir,
    afterthoughtLlmCfg,
    aggregateSkillMinerRuns,
    applyEpistemicStatusToLanceDb,
    baseDbPath,
    callCommandLlm,
    callLlm,
    cfg,
    checkArgsLength,
    checkAuth,
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
    isCronCommandContext,
    isDestructiveAction,
    isSensitiveChatRead,
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
    resolveDenialLocale,
    resolveEnvVars,
    resolveNeoHooksConfig,
    resolveRegisteredMemoryContext,
    resolveTemperamentName,
    runCorrectCommand,
    runCriticalCommand,
    runFeatureToggle,
    runForgetCommand,
    runMemoryCommand,
    runSemanticDiscoveryBatches,
    runStatusCommand,
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
  } = ctx;

  return async function runPlur1busCommand(commandCtx, prefixTokens = []) {
    const deniedLen = checkArgsLength(commandCtx);
    if (deniedLen) return deniedLen;
    const tokens = [...prefixTokens, ...parsePlur1busArgs(commandCtx)];
    if (tokens.length === 0) return plur1busHelp("quick", resolveDenialLocale(commandCtx));
    if (tokens[0]?.toLowerCase() === "help") return plur1busHelp(tokens[1]?.toLowerCase() === "advanced" ? "advanced" : "quick", resolveDenialLocale(commandCtx));
    const action = tokens[0] || "status";
    const actionKey = action.toLowerCase();
    const sub = tokens[1] || "";
    const id = tokens[2] || "";

    if (actionKey === "workspace") {
      const memoryCtx = await resolveRegisteredMemoryContext(commandCtx, { requireWorkspace: true });
      const subKey = sub.toLowerCase() || "status";
      if (!["status", "enable", "disable"].includes(subKey)) {
        return { text: "Usage: /plur1bus workspace status|enable|disable <expected-revision>" };
      }
      const denied = await checkAuth(
        memoryCtx,
        subKey === "status"
          ? { chatKind: memoryCtx.chatKind }
          : { destructive: true, chatKind: memoryCtx.chatKind },
        commandCtx,
      );
      if (denied) return denied;
      if (subKey === "status") {
        return formatJsonCommandResult({ policy: workspacePolicyGuard.decision(memoryCtx).policy });
      }
      const expectedRevision = Number(id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return { text: "A non-negative expected policy revision is required. Run /plur1bus workspace status first." };
      }
      const policy = await workspacePolicyGuard.set({
        memoryCtx,
        enabled: subKey === "enable",
        expectedRevision,
        actorId: memoryCtx.userPrincipal || `user:${memoryCtx.userId}`,
      });
      return formatJsonCommandResult({ policy });
    }

    // Obsidian is an explicit B14 boundary. Its command-specific
    // authorization remains delegated unchanged to its own handler.
    if (actionKey === "obsidian" || obsidianActionNames.has(actionKey)) {
      const obsidianMemoryCtx = await resolveRegisteredMemoryContext(commandCtx);
      if (!workspacePolicyGuard.decision(obsidianMemoryCtx).allowed) {
        return { text: "PLUR1BUS is disabled for this workspace." };
      }
      let commandStore = null;
      const getObsidianCommandStore = () => {
        if (!commandStore) {
          commandStore = getNeoStore({
            workspaceDir: commandCtx.workspaceDir,
            workspaceKey: commandCtx.workspaceKey,
            agentId: commandCtx.agentId || "command",
          }, {}, "obsidian");
        }
        return commandStore;
      };
      let runtimeConfig = null;
      try {
        if (typeof host.runtime?.config?.current === "function") {
          runtimeConfig = host.runtime.config.current();
        } else if (host.runtime?.config && typeof host.runtime.config === "object") {
          runtimeConfig = host.runtime.config;
        }
      } catch (_e) { dbg(_e); }
      const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
      const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH || join(openclawHome, "openclaw.json");
      const obsidianTokens = actionKey === "obsidian" ? tokens.slice(1) : tokens;
      // Resolve the vault the way the handler will, so the confirmed
      // receipt is looked up under the same path it was written for.
      const requestedVaultPath = resolveCommandVaultPath(obsidianBridgeCfg, {
        agentId: obsidianMemoryCtx.agentId,
        workspaceKey: obsidianMemoryCtx.workspaceIdentity,
        workspaceDir: commandCtx.workspaceDir,
        commandCtx,
      });
      return registeredObsidianCommandHandler(obsidianTokens, {
        config: obsidianBridgeCfg,
        configPath: openclawConfigPath,
        openclawConfig: commandCtx.openclawConfig || commandCtx.config || runtimeConfig,
        openclawHome,
        neoRoot,
        commandCtx,
        workspaceDir: commandCtx.workspaceDir,
        pluginConfig: cfg,
        memoryCtx: obsidianMemoryCtx,
        baseDbPath,
        vaultConfirmed: requestedVaultPath
          ? isOwnedVaultConfirmed({
              baseDbPath,
              memoryCtx: obsidianMemoryCtx,
              vaultPath: requestedVaultPath,
            })
          : false,
        // Fingerprint-and-booleans explanation of that check, so a
        // denial can say which binding failed instead of a bare false.
        vaultConfirmation: requestedVaultPath
          ? describeOwnedVaultConfirmation({
              baseDbPath,
              memoryCtx: obsidianMemoryCtx,
              vaultPath: requestedVaultPath,
            })
          : null,
        semanticConfirmationStore: confirmationStore,
        confirmationStore,
        loadSemanticRecords: async () => pool.withAuthoritativeReadDb(obsidianMemoryCtx.agentId, async (semanticDb) => {
          const initialized = await semanticDb.init();
          if (initialized === false) return [];
          return semanticDb.scanActive();
        }),
        searchSemanticNeighbors: async (source) => pool.withAuthoritativeReadDb(obsidianMemoryCtx.agentId, async (semanticDb) => {
          const initialized = await semanticDb.init();
          if (initialized === false) return [];
          return semanticDb.search(
            source.vector,
            obsidianBridgeCfg?.graphLinks?.semanticDiscovery?.topK || 20,
            obsidianBridgeCfg?.graphLinks?.semanticDiscovery?.threshold || 0.78,
          );
        }),
        loadRecords: async () => {
          const store = getObsidianCommandStore();
          return [
            ...store.readCandidates(500, neoRequester(commandCtx, {})).map((record) => ({ ...record, type: "memory_candidate", id: record.id, summary: record.statement || record.summary || record.text || "", sourceRefs: record.sourceRefs || [], memoryIds: record.memoryIds || [] })),
            ...store.readBehaviorCards(200, neoRequester(commandCtx, {})).map((record) => ({ ...record, type: "source", id: record.id, summary: record.statement || record.summary || "", sourceRefs: record.sourceRefs || [], memoryIds: record.memoryIds || [] })),
          ];
        },
        findRecord: (recordId) => findNeoRecord(
          getObsidianCommandStore(),
          recordId,
          neoRequester(commandCtx, {}),
        ),
        memoryStore: async ({ payload }) => {
          const result = await storeMemoryFromToolParams({
            memoryCtx: obsidianMemoryCtx,
            workspaceDir: obsidianMemoryCtx.workspaceDir,
            callContext: {
              runtimeLlm: commandCtx?.runtimeContext?.llm,
            },
          }, payload);
          const text = result?.content?.[0]?.text || "";
          if (result?.error) throw new Error(`Memory store failed: ${result.error}`);
          if (text.startsWith("Memory store failed")) throw new Error(text);
          return result;
        },
      });
    }
    if (!knownPlur1busActions.has(actionKey)) {
      return plur1busHelp("quick", resolveDenialLocale(commandCtx));
    }
    const subKey = sub.toLowerCase();
    if (actionKey === "skills" && !["review", "list", "show", "approve", "reject", "confirm"].includes(subKey)) {
      const { lang, tone } = resolveDenialLocale(commandCtx);
      return { text: subKey ? t("plur1bus.skills_unknown", { lang, tone, vars: { sub: subKey } }) : t("plur1bus.skills_help", { lang, tone }) };
    }
    if (actionKey === "neo" && !(subKey === "workspaces" && tokens[2] === "migrate")) {
      return plur1busHelp("quick", resolveDenialLocale(commandCtx));
    }
    if ((actionKey === "recall" && subKey !== "why") || (actionKey === "origin" && subKey !== "trace")) {
      return plur1busHelp("quick", resolveDenialLocale(commandCtx));
    }
    if ((actionKey === "persona" && !["", "regenerate", "accept"].includes(subKey))
      || (actionKey === "behavior" && !["show", "candidates", "explain", "promote", "demote", "prune"].includes(subKey))
      || ((actionKey === "reminder" || actionKey === "reminders") && !["", "list", "show", "help", "cancel", "delete"].includes(subKey))
      || (actionKey === "curation" && !["", "conflicts", "stale", "promoted", "resolve", "apply-conflict", "drop-injected", "confirm"].includes(subKey))) {
      return plur1busHelp("quick", resolveDenialLocale(commandCtx));
    }
    if (actionKey === "migrate-legacy-shared") {
      const resolvedCtx = await resolveRegisteredMemoryContext(commandCtx, {
        requireWorkspace: true,
      });
      const denied = await checkAuth(
        resolvedCtx,
        { destructive: true, chatKind: resolvedCtx.chatKind },
        commandCtx,
      );
      if (denied) return denied;
      const options = parseLegacyMigrationArgs(tokens.slice(1));
      return formatJsonCommandResult(await migrateLegacySharedRows({
        privatePool: pool,
        sharedPool: sharedMemoryPool,
        embeddings,
        agentId: resolvedCtx.agentId,
        workspaceAliases: resolvedCtx.workspaceAliases,
        apply: options.apply,
        reportDir: resolvedCtx.workspaceDir,
        reportName: options.reportName,
        continuationToken: options.continuationToken,
        signal: commandCtx.abortSignal || legacyMigrationShutdown.signal,
        logger: host.logger,
      }));
    }
    const cronInternal = actionKey === "internal" && isCronCommandContext(commandCtx);
    const memoryCtx = cronInternal
      ? await resolveCronMemoryContext(commandCtx)
      : await resolveRegisteredMemoryContext(commandCtx);
    const workspacePolicyDecision = workspacePolicyGuard.decision(memoryCtx);
    if (!workspacePolicyDecision.allowed) {
      const rejectionReason = workspacePolicyDecision.reason || "workspace_disabled";
      if (actionKey === "internal") {
        return {
          text: "NO_REPLY",
          metadata: { skipped: true, reason: rejectionReason },
        };
      }
      return formatJsonCommandResult({
        ok: false,
        reason: rejectionReason,
        retryable: workspacePolicyDecision.retryable === true,
        policy: workspacePolicyDecision.policy,
      });
    }
    if (actionKey === "internal") {
      if (!isCronCommandContext(commandCtx)) {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
      }
    } else if (isDestructiveAction(actionKey, subKey, tokens)) {
      const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
    } else if (isSensitiveChatRead(actionKey, subKey)) {
      const denied = await checkAuth(memoryCtx, { chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
    }
    // Denselben Neo-Store wie die Hooks: nur der vom Host aufgeloeste
    // Workspace-Pfad geht hinein, kein Schluessel. workspaceKeyFromContext
    // loest ihn dann wie bei before_prompt_build/agent_end ueber
    // Pfad-Map -> Alias -> Basename auf ("main" fuer aliasierte
    // Workspaces). Bis 7.12.18 stand hier der ACL-Principal
    // ("workspace:v1:main") als expliziter Schluessel; der zeigte auf ein
    // leeres Verzeichnis, und status/doctor/curation meldeten im Chat
    // "hooks: {}", "not fired" und keine Kandidaten. Der rohe
    // Chat-workspaceKey bleibt draussen (Tests b13-sensitive-read-auth,
    // plur1bus-internal-auth).
    const commandStore = getNeoStore({
      workspaceDir: memoryCtx?.workspaceDir || "",
      agentId: memoryCtx?.agentId || commandCtx.agentId || "command",
    });
    // ── Phase 5+6: silent cron-internal jobs ──────────────────────
    // Pattern: /plur1bus internal <consolidate-daily|classify-recent|auto-accept-stale|rem-dream|embedding-drain>
    // Wird ausschliesslich aus den OpenClaw-managed Cron-Jobs gefeuert
    // (delivery.mode=none).
    if (actionKey === "internal") {
      const subKey = (sub || "").toLowerCase();
      const internalAgent = commandCtx.agentId || "default";
      if (subKey === "consolidate-daily") {
        const dcCfg = cfg.dailyConsolidation || {};
        if (dcCfg.enabled === false) {
          return formatJsonCommandResult({ job: "consolidate-daily", skipped: true, reason: "dailyConsolidation_disabled" });
        }
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const dailyRuns = [];
        for (const dailyPartition of buildRemPartitions(memoryCtx)) {
          const dailyStore = createOwnerBoundNeoStore(dailyPartition);
          const dailyWorkspaceDir = dailyPartition.scope === "workspace"
            && memoryCtx?.workspaceDir
            && dailyPartition.workspaceIdentity === memoryCtx.workspaceIdentity
            ? memoryCtx.workspaceDir
            : dailyStore.paths.workspaceDir;
          const runDailyPartition = async (rawDb) => {
            await rawDb.init();
            return runDailyConsolidation(
              createPartitionScopedDb(rawDb, dailyPartition, memoryCtx),
              internalAgent,
              {
                logger: host.logger,
                neoStore: dailyStore,
                requestContext: memoryCtx,
                aclPartition: dailyPartition,
                // 7.12.47: "batch" (Default) oder "rows" (alter Zeilenpfad).
                dynamicsDecayMode: dcCfg.decayMode === "rows" ? "rows" : "batch",
                workspaceDir: dailyWorkspaceDir,
                workspaceKey: dailyPartition.workspaceIdentity || dailyPartition.ownerUserId || dailyPartition.agentId,
                compactionLlmCfg: mergingEnabled ? withLlmCallContext(
                  memoryCompactionLlmCfg,
                  internalAgent,
                  "memory-compaction",
                  { runtimeLlm: sessionRuntime },
                ) : null,
                conflictLlmCfg: mergingEnabled ? withLlmCallContext(
                  conflictResolutionLlmCfg,
                  internalAgent,
                  "conflict-resolution",
                  { runtimeLlm: sessionRuntime },
                ) : null,
                callLlm,
                embeddings,
              },
            );
          };
          const partitionResult = dailyPartition.scope === "workspace"
            ? await sharedMemoryPool.withWorkspaceDb(memoryCtx, runDailyPartition)
            : dailyPartition.scope === "user"
              ? await sharedMemoryPool.withUserDb(memoryCtx, runDailyPartition)
              : await pool.withDb(internalAgent, runDailyPartition);
          dailyRuns.push({ scope: dailyPartition.scope, result: partitionResult });
        }
        // 7.12.24: Graph-Kanten auf geloeschte oder zusammengefuehrte
        // Erinnerungen wurden nie entfernt (main: 800 von 5004, bernhardine:
        // 73 von 5026 am 09.09.2026) und belegten Platz unter dem 5000er-Cap.
        let graphPrune = null;
        try {
          const graphEdges = commandStore.readGraphEdges(100_000);
          if (graphEdges.length > 0) {
            const liveRows = await pool.withDb(internalAgent, async (agentDb) => {
              if (!agentDb?.table && typeof agentDb?.init === "function") await agentDb.init();
              if (!agentDb?.table) return null;
              return agentDb.table.query().select(["id", "status"]).limit(500_000).toArray();
            });
            if (Array.isArray(liveRows)) {
              const liveMemoryIds = new Set(liveRows
                .filter((row) => !row.status || row.status === "active")
                .map((row) => String(row.id)));
              const episodeIds = new Set(commandStore.readEpisodes(100_000).map((episode) => String(episode.id)));
              const pruned = pruneGraphEdges(graphEdges, { liveMemoryIds, episodeIds });
              if (pruned.after !== pruned.before) commandStore.rewriteGraphEdges(pruned.kept);
              const { kept: _kept, ...graphPruneCounts } = pruned;
              graphPrune = graphPruneCounts;
            }
          }
        } catch (graphErr) {
          graphPrune = { error: String(graphErr?.message || graphErr) };
        }
        // 7.12.28: Kandidaten-Metadatenindex auf die juengste Revision je ID
        // ziehen (Cap = neo.recall.global.maxCandidates), bevor der Sidecar
        // kompaktiert wird — dessen Live-Menge liest den Index mit.
        let candidateIndex = null;
        try {
          candidateIndex = typeof commandStore.compactCandidateIndex === "function" ? commandStore.compactCandidateIndex({ maxEntries: neoGlobalRecall.maxCandidates }) : null;
        } catch (indexErr) {
          candidateIndex = { error: String(indexErr?.message || indexErr) };
        }
        // 7.12.26: verwaiste Vektor-Slots (Re-Embeddings, gecappte Zeilen)
        // aus dem Sidecar raeumen; pruneAll hat keinen Aufrufer im Betrieb.
        let vectorCompaction = null;
        try {
          vectorCompaction = typeof commandStore.compactVectors === "function" ? commandStore.compactVectors() : null;
        } catch (vectorErr) {
          vectorCompaction = { error: String(vectorErr?.message || vectorErr) };
        }
        // 7.12.31: LanceDB-Kompaktierung der Agententabelle (Fragmente
        // zusammenfuehren, Versionen aelter als keepVersionsHours
        // verwerfen). Lief bisher nur ueber den Dashboard-Schalter; die
        // Tabellen standen bei 352/845 Fragmenten mit Median 1 Zeile.
        let lancedbOptimize = null;
        const optimizePlan = resolveLancedbOptimizePlan(dcCfg.lancedbOptimize);
        if (!optimizePlan.enabled) {
          lancedbOptimize = { skipped: true, reason: "disabled" };
        } else if (typeof memoryDbAdapter?.optimizeTable !== "function") {
          lancedbOptimize = { skipped: true, reason: "optimize_unavailable" };
        } else {
          try {
            const outcome = await memoryDbAdapter.optimizeTable(internalAgent, {
              cleanupOlderThan: optimizePlan.cleanupOlderThan,
              timeoutMs: optimizePlan.timeoutMs,
            });
            lancedbOptimize = outcome?.ok
              ? { ok: true, ms: outcome.ms, keepVersionsHours: optimizePlan.keepVersionsHours, ...summarizeLancedbOptimize(outcome.stats, outcome.before, outcome.after, { attempts: outcome.attempts }) }
              : { ok: false, reason: outcome?.reason || "unknown" };
          } catch (optimizeErr) {
            lancedbOptimize = { ok: false, error: String(optimizeErr?.message || optimizeErr) };
          }
        }
        const result = {
          partitionResults: dailyRuns,
          compacted: dailyRuns.reduce((total, run) => total + Number(run.result?.compaction?.compacted || 0), 0),
          deleted: dailyRuns.reduce((total, run) => total + Number(run.result?.compaction?.deleted || 0), 0),
          merged: dailyRuns.reduce((total, run) => total + Number(run.result?.compaction?.merged || 0), 0),
          graphPrune,
          candidateIndex,
          vectorCompaction,
          lancedbOptimize,
        };
        host.logger.info(`plur1bus internal consolidate-daily[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "consolidate-daily", ...result });
      }
      if (subKey === "classify-recent") {
        const cpCfg = cfg.criticalPush || {};
        if (cpCfg.enabled === false) {
          const disabledResult = { job: "classify-recent", skipped: true, reason: "criticalPush_disabled" };
          return cronInternal
            ? formatClassifierCronReply(disabledResult)
            : formatJsonCommandResult(disabledResult);
        }
        const cpLlmCfg = createFeatureRoute("criticalPush", cpCfg);
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const directCriticalRoute = cpLlmCfg?.kind === LLM_ROUTE_KINDS.DIRECT_OVERRIDE;
        const nativeCriticalRuntimeAvailable = typeof sessionRuntime?.complete === "function"
          || typeof cpLlmCfg?.runtimeLlm?.complete === "function";
        if (cpLlmCfg && !directCriticalRoute && !nativeCriticalRuntimeAvailable) {
          host.logger.warn(
            "memory-lancedb-namespaced: Critical Push skipped: openclaw-runtime-unavailable",
            { feature: "criticalPush" },
          );
        }
        const criticalRouteAvailable = directCriticalRoute || nativeCriticalRuntimeAvailable;
        const criticalModel = cpLlmCfg && criticalRouteAvailable ? {
          complete: async ({ prompt }) => {
            const callContext = typeof sessionRuntime?.complete === "function"
              ? {
                  runtimeLlm: sessionRuntime,
                  agentId: internalAgent,
                  purpose: "critical-push-classification",
                }
              : {
                  agentId: internalAgent,
                  purpose: "critical-push-classification",
                };
            const text = await callLlm([{ role: "user", content: prompt }], {
              ...cpLlmCfg,
              maxTokens: 16,
              callContext,
            });
            return { text: text || "" };
          },
        } : null;
        const result = await runCriticalClassifier(memoryDbAdapter, internalAgent, {
          logger: host.logger,
          model: criticalModel,
          // Ohne Konfiguration greift der Default aus
          // findRecentUnclassified, der das 3h-Cron-Intervall überdeckt.
          sinceMinutes: cpCfg.sinceMinutes,
          maxPerDay: cpCfg.maxPerDay ?? 3,
          hideTypes: cpCfg.hideTypes,
        });
        host.logger.info(`plur1bus internal classify-recent[${internalAgent}]: ${JSON.stringify(result)}`);
        return cronInternal
          ? formatClassifierCronReply(result)
          : formatJsonCommandResult({ job: "classify-recent", ...result });
      }
      if (subKey === "auto-accept-stale") {
        const result = await runAutoAcceptStale(memoryDbAdapter, internalAgent, { logger: host.logger, hours: 24 });
        host.logger.info(`plur1bus internal auto-accept-stale[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "auto-accept-stale", ...result });
      }
      if (subKey === "rem-dream") {
        if (!mergingEnabled || !isLlmRouteAvailable(remPatternLlmCfg)) {
          return formatJsonCommandResult({ job: "rem-dream", skipped: true, reason: "no_llm_config" });
        }
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const commandRoute = (route, purpose) => withLlmCallContext(
          route,
          internalAgent,
          purpose,
          { runtimeLlm: sessionRuntime },
        );
        const isLocalProvider = normalizedEmbeddingCfg.provider === "local-transformers";
        // Ein Lauf je ACL-Partition. Vorher wurde ausschließlich `user`
        // oder `workspace` gebaut — nie `agent-private`. Da
        // loadCandidateMemories über `sameRemBindings` filtert und das
        // `a.scope === b.scope` vergleicht, fiel jede agent-private
        // Zeile heraus; live sind das 100 % der Kandidaten, weshalb der
        // Job dauerhaft `too_few_memories, count: 0` meldete.
        //
        // Mehrere Läufe sind unbedenklich: buildRunKey bindet den
        // Run-Key an die Partition, die Deduplizierung greift getrennt.
        const remAclPartitions = buildRemPartitions(memoryCtx);
        if (remAclPartitions.length === 0) {
          return formatJsonCommandResult({ job: "rem-dream", skipped: true, reason: "acl_partition_missing" });
        }
        const remRuns = [];
        for (const remAclPartition of remAclPartitions) {
          const remStore = createOwnerBoundNeoStore(remAclPartition);
          const remOutputRoot = resolveRemOutputRoot({
            partition: remAclPartition,
            memoryCtx,
            storeWorkspaceDir: remStore.paths.workspaceDir,
          });
          const remTarget = createOwnerBoundTarget(
            remAclPartition,
            remStore,
            remAclPartition.scope,
            remOutputRoot,
          );
          const runRemPartition = async (db) => {
            await db.init();
            return runRemDream({
              db,
              patternLlmCfg: commandRoute(remPatternLlmCfg, "rem-pattern-analysis"),
              narrativeLlmCfg: commandRoute(dreamNarrativeLlmCfg, "dream-narrative"),
              echoLlmCfg: commandRoute(dreamEchoLlmCfg, "dream-echo"),
              callLlm,
              neoStore: remStore,
              workspaceKey: remAclPartition.workspaceIdentity || remAclPartition.ownerUserId || remAclPartition.agentId,
              agentId: internalAgent,
              requestContext: memoryCtx,
              aclPartition: remAclPartition,
              partitionSink: {
                aclBindings: remAclPartition,
                neoStore: remStore,
                memoryStore: createOwnerBoundMemoryStore(db, remAclPartition, memoryCtx),
                inputTarget: remTarget,
                outputTarget: remTarget,
              },
              logger: host.logger,
              maxMemories: isLocalProvider ? 1000 : 5000,
              topK: isLocalProvider ? 10 : 20,
              narrativeCfg: dreamNarrativeCfg,
              embeddings,
              workspaceDir: remTarget.workspaceDir,
              temperamentName: resolveTemperamentName(internalAgent),
            });
          };
          const partitionResult = remAclPartition.scope === "workspace"
            ? await sharedMemoryPool.withWorkspaceDb(memoryCtx, runRemPartition)
            : remAclPartition.scope === "user"
              ? await sharedMemoryPool.withUserDb(memoryCtx, runRemPartition)
              : await pool.withDb(internalAgent, runRemPartition);
          if (partitionResult.report) {
            writeRemDreamToVault(partitionResult.report, partitionResult.trends, remTarget);
          }
          host.logger.info(`plur1bus internal rem-dream[${internalAgent}/${remAclPartition.scope}]: ${JSON.stringify(partitionResult.report || partitionResult)}`);
          remRuns.push({ scope: remAclPartition.scope, result: partitionResult });
        }
        // Der erste Lauf mit Report gewinnt für die Antwort; sonst der erste.
        const result = (remRuns.find((run) => run.result?.report) || remRuns[0]).result;
        const semanticCfg = obsidianBridgeCfg?.graphLinks?.semanticDiscovery;
        if (semanticCfg?.enabled && commandCtx.workspaceDir) {
          const semVaultCfg = { ...obsidianBridgeCfg, vaultPath: commandCtx.workspaceDir };
          pool.withDb(internalAgent, (semDb) =>
            runSemanticDiscoveryBatches({
                db: semDb,
                semVaultCfg,
                pool,
                logger: host.logger,
                defaultAgentId: internalAgent,
              }))
            .then((r) => host.logger.info(`plur1bus-semantic: processed=${r.processed} unchanged=${r.unchanged} errors=${r.errors}${r.blocked ? ` blocked=${r.reason || true}` : ""}${r.batchAborted ? " (aborted-429)" : ""}`))
            .catch((err) => host.logger.warn(`plur1bus-semantic: discovery failed: ${String(err)}`));
        }
        return formatJsonCommandResult({
          job: "rem-dream",
          partitions: remRuns.map((run) => describeRemPartitionRun(run)),
          ...(result.report || result),
        });
      }
      if (subKey === "skill-miner") {
        if (!skillMinerEnabled || !skillMinerLlmCfg) {
          return formatJsonCommandResult({ job: "skill-miner", skipped: true, reason: "not_configured" });
        }
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const skillMinerCallContext = typeof sessionRuntime?.complete === "function"
          ? {
              runtimeLlm: sessionRuntime,
              purpose: LLM_RESULT_CACHE_PURPOSES.SKILL_EXTRACTION,
            }
          : {
              agentId: internalAgent,
              purpose: LLM_RESULT_CACHE_PURPOSES.SKILL_EXTRACTION,
        };
        const skillRuns = [];
        const skillAclPartitions = buildRemPartitions(memoryCtx);
        if (skillAclPartitions.length === 0) {
          return formatJsonCommandResult({ job: "skill-miner", skipped: true, reason: "acl_partition_missing", partitions: [] });
        }
        for (const skillAclPartition of skillAclPartitions) {
          const skillStore = createOwnerBoundNeoStore(skillAclPartition);
          const skillWorkspaceDir = skillAclPartition.scope === "workspace"
            && memoryCtx?.workspaceDir
            && skillAclPartition.workspaceIdentity === memoryCtx.workspaceIdentity
            ? memoryCtx.workspaceDir
            : skillStore.paths.workspaceDir;
          try {
            const runSkillMinerPartition = async (rawDb) => {
              await rawDb.init();
              return runSkillMiner(rawDb, internalAgent, {
                logger: host.logger,
                neoStore: skillStore,
                requestContext: memoryCtx,
                aclPartition: skillAclPartition,
                workspaceDir: skillWorkspaceDir,
                workspaceKey: skillAclPartition.workspaceIdentity,
                skillWorkshop: openClawSkillWorkshop,
                requireSkillWorkshop: openClawSkillWorkshop !== null,
                autoApply: openClawSkillWorkshop !== null && skillMinerAutoApplyEffective(),
                activateProposal: (proposal) => activateSkillProposal(skillWorkspaceDir, proposal.id, skillActivationDeps(internalAgent, {
                  actor: "plur1bus-skill-miner",
                  actorTier: "system:skill-workshop",
                  reason: "skill-miner-auto-apply",
                  memoryCtx,
                })),
                llmCfg: withLlmCallContext(
                  skillMinerLlmCfg,
                  skillMinerCallContext.agentId,
                  LLM_RESULT_CACHE_PURPOSES.SKILL_EXTRACTION,
                  { runtimeLlm: skillMinerCallContext.runtimeLlm },
                ),
                callLlm,
                baseDbPath,
                maxPerRun: skillMinerCfg.maxPerRun ?? 5,
                minConfidence: skillMinerCfg.minConfidence ?? 0.6,
                minEvidenceScore: skillMinerCfg.minEvidenceScore ?? 3,
              });
            };
            const missingSharedPartition = (reason) => ({
              timestamp: new Date().toISOString(),
              agent: internalAgent,
              skipped: true,
              reason,
            });
            const result = skillAclPartition.scope === "workspace"
              ? await sharedMemoryPool.withWorkspaceReadDb(memoryCtx, async (rawDb) => {
                if (!rawDb) return missingSharedPartition("shared_workspace_absent");
                return runSkillMinerPartition(rawDb);
              })
              : skillAclPartition.scope === "user"
                ? await sharedMemoryPool.withUserReadDb(memoryCtx, async (rawDb) => {
                  if (!rawDb) return missingSharedPartition("shared_user_absent");
                  return runSkillMinerPartition(rawDb);
                })
                : await pool.withDb(internalAgent, runSkillMinerPartition);
            skillRuns.push({ scope: skillAclPartition.scope, result });
          } catch {
            host.logger.warn(`plur1bus internal skill-miner[${internalAgent}/${skillAclPartition.scope}] partition failed`);
            skillRuns.push({ scope: skillAclPartition.scope, failed: true });
          }
        }
        host.logger.info(`plur1bus internal skill-miner[${internalAgent}]: ${JSON.stringify(skillRuns)}`);
        const result = aggregateSkillMinerRuns(skillRuns, internalAgent);
        return formatJsonCommandResult({
          job: "skill-miner",
          partitions: skillRuns.map((run) => ({
            scope: run.scope,
            failed: run.failed === true,
            skipped: run.failed === true ? false : run.result?.skipped ?? false,
            ...(run.failed === true
              ? { reason: "partition_failed" }
              : (run.result?.reason ? { reason: run.result.reason } : {})),
          })),
          ...result,
        });
      }
      // 7.12.49: Nutzen-Satz fuer Vorschlaege aus Laeufen vor 7.12.48
      // nachtragen. Liest die Ledger aller ACL-Partitionen des Agenten.
      if (subKey === "skill-benefit-backfill") {
        if (!skillMinerEnabled || !isLlmRouteAvailable(skillMinerLlmCfg)) {
          return formatJsonCommandResult({ job: "skill-benefit-backfill", skipped: true, reason: "not_configured" });
        }
        const { backfillProposalBenefits } = await import("../../lib/jobs/skill-miner/benefit-backfill.js");
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const backfillLimit = Number.parseInt(id, 10);
        const result = await backfillProposalBenefits({
          ledgerDirs: skillLedgerDirsFor(memoryCtx),
          llmCfg: withLlmCallContext(
            skillMinerLlmCfg,
            internalAgent,
            LLM_RESULT_CACHE_PURPOSES.SKILL_EXTRACTION,
            { runtimeLlm: sessionRuntime },
          ),
          callLlm: callCommandLlm,
          ...(Number.isFinite(backfillLimit) ? { limit: backfillLimit } : {}),
          logger: host.logger,
        });
        host.logger.info(`plur1bus internal skill-benefit-backfill[${internalAgent}]: ${JSON.stringify({ ...result, items: result.items?.length })}`);
        return formatJsonCommandResult({ job: "skill-benefit-backfill", ...result });
      }
      if (subKey === "afterthought") {
        if ((cfg.afterthought?.enabled ?? true) === false
          || !(skillMinerEnabled || mergingEnabled)
          || !isLlmRouteAvailable(afterthoughtLlmCfg)) {
          const disabledResult = { job: "afterthought", skipped: true, reason: "disabled" };
          return cronInternal
            ? formatAfterthoughtCronReply(disabledResult)
            : formatJsonCommandResult(disabledResult);
        }
        const { runAfterthoughtJob } = await import("../../lib/afterthought.js");
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const result = await runAfterthoughtJob({
          workspaceDir: commandCtx.workspaceDir,
          agentId: internalAgent,
          llmCfg: withLlmCallContext(
            afterthoughtLlmCfg,
            internalAgent,
            "afterthought",
            { runtimeLlm: sessionRuntime },
          ),
          callLlm: callCommandLlm,
          timeZone: cfg.afterthought?.timezone ?? cfg.timezone ?? null,
          logger: host.logger,
        });
        host.logger.info(`plur1bus internal afterthought[${internalAgent}]: ${JSON.stringify({ ...result, text: result.text ? `${result.text.slice(0, 60)}…` : undefined })}`);
        return cronInternal
          ? formatAfterthoughtCronReply(result)
          : formatJsonCommandResult({ job: "afterthought", ...result });
      }
      if (subKey === "persona-evolve") {
        if ((cfg.personaVoice?.enabled ?? true) === false
          || !skillMinerEnabled
          || !isLlmRouteAvailable(personaVoiceLlmCfg)) {
          return formatJsonCommandResult({ job: "persona-evolve", skipped: true, reason: "not_configured" });
        }
        const { evolvePersonaVoice } = await import("../../lib/persona-voice.js");
        // 7.12.38: 300 statt 200 — Heartbeat-Turns (~12/Woche je Agent)
        // stehen mit im Log und werden erst in evolvePersonaVoice gefiltert.
        const outcomes = readReplyOutcomeLog(commandCtx.workspaceDir, 300);
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const result = await evolvePersonaVoice({
          workspaceDir: commandCtx.workspaceDir,
          outcomes,
          maxBullets: personaMaxBullets,
          minDaysBetween: personaEvolveMinDaysBetween,
          minOutcomes: personaEvolveMinOutcomes,
          llmCfg: withLlmCallContext(
            personaVoiceLlmCfg,
            internalAgent,
            "persona-voice",
            { runtimeLlm: sessionRuntime },
          ),
          callLlm: callCommandLlm,
        });
        host.logger.info(`plur1bus internal persona-evolve[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "persona-evolve", ...result });
      }
      if (subKey === "reminder-dispatch") {
        const remindersCfg = cfg.reminders || {};
        const result = await pool.withDb(internalAgent, async (rawDb) => {
          await rawDb.init();
          return runReminderDispatch(rawDb, internalAgent, {
            logger: host.logger,
            workspaceDir: commandCtx.workspaceDir,
            workspaceKey: commandCtx?.workspaceKey || commandCtx?.workspaceDir || null,
            deliveryMode: remindersCfg.deliveryMode || "pending_only",
            webhookUrl: remindersCfg.webhookUrl ? resolveEnvVars(remindersCfg.webhookUrl) : null,
          });
        });
        host.logger.info(`plur1bus internal reminder-dispatch[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "reminder-dispatch", ...result });
      }
      // 7.12.43: Nachmigration aelterer Episoden-Karten auf das aktuelle
      // Schema (mentioned, voice_speakers, Modell-Emotion). Baut jede
      // Episode der letzten N Tage aus ihren Turns neu, ersetzt die Karte
      // (nur Dateien mit genau dieser einen Episode) und haengt den
      // Datensatz mit derselben id an. `--days N` (Default 1), `--dry-run`.
      if (subKey === "episodes-rebuild") {
        if (!neoEnabled) {
          return formatJsonCommandResult({ job: "episodes-rebuild", skipped: true, reason: "neo_disabled" });
        }
        const rebuildArgs = tokens.slice(2);
        const daysIdx = rebuildArgs.indexOf("--days");
        const rebuildDays = daysIdx >= 0 && Number.isFinite(Number(rebuildArgs[daysIdx + 1])) ? Math.max(0.05, Number(rebuildArgs[daysIdx + 1])) : 1;
        const rebuildDryRun = rebuildArgs.includes("--dry-run");
        const neoStore = getNeoStore(commandCtx, {}, "episodes-rebuild");
        const since = Date.now() - rebuildDays * 86400000;
        const episodes = neoStore.readEpisodes(2000).filter((ep) => new Date(ep.createdAt || ep.startTime || 0).getTime() >= since);
        const turnsById = new Map();
        for (const turn of neoStore.readTurns(5000)) if (turn?.id) turnsById.set(String(turn.id), turn);
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const rebuildLlmCfg = mergingEnabled ? withLlmCallContext(
          episodeExtractionLlmCfg,
          internalAgent,
          "episode-extraction",
          { runtimeLlm: sessionRuntime },
        ) : null;
        const hooksBefore = neoStore.readHooks();
        const openEpisodeState = hooksBefore?.agent_end?.openEpisode || null;
        const result = { job: "episodes-rebuild", days: rebuildDays, dryRun: rebuildDryRun, candidates: episodes.length, rebuilt: 0, cardsReplaced: 0, cardsAppended: 0, skippedNoTurns: 0, errors: [] };
        const allTurns = [...turnsById.values()].filter((t) => t?.role === "user" || t?.role === "assistant");
        result.byWindow = 0;
        for (const ep of episodes) {
          let turns = (Array.isArray(ep.memoryIds) ? ep.memoryIds : []).map((id) => turnsById.get(String(id))).filter(Boolean);
          if (turns.length === 0) {
            // Karten vor 7.12.44 tragen Turn-IDs, die es im Journal nie gab
            // (andere Identitaetsbasis) — ueber das Zeitfenster der Episode
            // finden sich dieselben Turns trotzdem.
            const from = new Date(ep.startTime || 0).getTime() - 2000;
            const to = new Date(ep.endTime || 0).getTime() + 2000;
            if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
              turns = allTurns.filter((t) => { const ts = new Date(t.createdAt || 0).getTime(); return ts >= from && ts <= to; });
              if (turns.length > 0) result.byWindow += 1;
            }
          }
          if (turns.length === 0) { result.skippedNoTurns += 1; continue; }
          try {
            const rebuilt = await rebuildEpisode(ep, turns, {
              workspaceDir: commandCtx.workspaceDir,
              agentId: internalAgent,
              llmCfg: rebuildLlmCfg,
              callLlm,
            });
            if (!rebuilt) { result.skippedNoTurns += 1; continue; }
            result.rebuilt += 1;
            if (rebuildDryRun) continue;
            if (typeof neoStore.appendEpisodesAsync === "function") await neoStore.appendEpisodesAsync([rebuilt]);
            else neoStore.appendEpisodes([rebuilt]);
            if (commandCtx.workspaceDir) {
              const replacePath = findEpisodeCardPath(ep, commandCtx.workspaceDir);
              const written = writeEpisodeToVault(rebuilt, commandCtx.workspaceDir, { replacePath });
              if (written?.replaced) result.cardsReplaced += 1;
              else if (written?.written) result.cardsAppended += 1;
              if (written?.written && openEpisodeState && openEpisodeState.id === rebuilt.id) {
                neoStore.recordHook("agent_end", { openEpisode: { ...openEpisodeState, vaultPath: written.path, revision: rebuilt.revision } });
              }
            }
          } catch (rebuildErr) {
            result.errors.push(`${ep.id}: ${String(rebuildErr?.message || rebuildErr).slice(0, 120)}`);
          }
        }
        host.logger.info(`plur1bus internal episodes-rebuild[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult(result);
      }
      if (subKey === "gc-run") {
        const gcPolicy = cfg.gc || {};
        if (gcPolicy.enabled === false) {
          return formatJsonCommandResult({ job: "gc-run", skipped: true, reason: "gc_disabled" });
        }
        const result = await runGcJob({
          baseDbPath,
          dbPool: pool,
          policy: gcPolicy,
          workspaceDir: commandCtx.workspaceDir,
          logger: host.logger,
        });
        host.logger.info(`plur1bus internal gc-run[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "gc-run", ...result });
      }
      // Wartungsgriff fuer die Neo-Embedding-Warteschlange. Bisher lief der
      // Drain ausschliesslich als Nebenjob nach jeder Erfassung, gedeckelt
      // auf maxItems und auf das, was vom Capture-Budget uebrig war. Kommt
      // mehr herein als abfliesst, holt er nie auf: am 09.09.2026 standen
      // fuer bernhardine knapp 3000 Eintraege offen, seit Wochen zwischen
      // 3000 und 4200 pendelnd. Ohne Vektor faellt der mit 0,75 gewichtete
      // Anteil der Neo-Bewertung auf null, der Datensatz rankt nur noch
      // ueber Token-Ueberlappung. Dieser Lauf nimmt sich die Warteschlange
      // am Stueck vor, bleibt aber unter dem RPC-Timeout (540s) und meldet
      // den Rest, damit man ihn bis pending=0 wiederholen kann.
      if (subKey === "embedding-drain") {
        if (!neoEnabled) {
          return formatJsonCommandResult({ job: "embedding-drain", skipped: true, reason: "neo_disabled" });
        }
        const neoStore = getNeoStore(commandCtx, {}, "embedding-drain");
        const result = await neoStore.drainEmbeddingQueue({
          impact: neoEmbeddingDrainImpact,
          maxItems: NEO_MANUAL_DRAIN_MAX_ITEMS,
          deadlineMs: NEO_MANUAL_DRAIN_DEADLINE_MS,
          dimensions: vectorDim,
          embedder: (text) => embeddings.embed(text, { agentId: internalAgent }),
        });
        host.logger.info(`plur1bus internal embedding-drain[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "embedding-drain", ...result });
      }
      if (subKey === "emotion-refine") {
        // Abschluss-Review, Important 6: emotion.t3 (die eigentliche
        // Tier-3-Emotionsklassifikation) und die Importance-Klärung
        // dieses Crons sind jetzt entkoppelt — beide teilen sich nur
        // den LLM-Call (lib/encoding-llm.js), nicht das Feature-Flag.
        // Ein abgeschaltetes emotion.t3 (oder ein zur
        // Registrierungszeit fehlender Provider unter
        // onlyWhenProviderAvailable) darf die Importance-Klärung
        // nicht mehr für immer einfrieren, solange irgendeine
        // nutzbare Route für den Encoding-Call existiert
        // (encodingCallLlm). Nur wenn wirklich kein Provider da ist,
        // wird übersprungen — dann aber mit Warnung und Pending-Zahl,
        // statt still.
        const refineStartedAt = Date.now();
        const result = await pool.withDb(internalAgent, async (agentDb) => {
          if (!agentDb?.table && typeof agentDb?.init === "function") await agentDb.init();
          const counts = { refined: 0, finalized: 0, failed: 0, poisoned: 0, pending: 0, scanned: 0, deadlineHit: false, ms: 0 };
          if (!agentDb?.table || !agentDb.schemaFieldNames?.has("emotionStatus") || !agentDb.schemaFieldNames?.has("importanceStatus")) {
            return { ...counts, skipped: true, reason: "no_emotion_status_column" };
          }
          // pending_backfill bewusst ausgeschlossen: die rund 23.000 Bestandszeilen
          // gehören einem eigenen Batch-Skript, nicht diesem stündlichen Cron —
          // sonst entstünde eine LanceDB-Version je Zeile (siehe 13.09.2026).
          const rows = await agentDb.table.query()
            .where(`emotionStatus = 'pending_t3' OR importanceStatus = '${IMPORTANCE_STATUS.PENDING}'`)
            .limit(EMOTION_REFINE_MAX_ROWS + 1)
            .toArray();
          if (!encodingCallLlm) {
            counts.pending = rows.length;
            return { ...counts, skipped: true, reason: "no_llm_route" };
          }
          counts.scanned = Math.min(rows.length, EMOTION_REFINE_MAX_ROWS);
          let consecutiveFailures = 0;
          for (const row of rows.slice(0, EMOTION_REFINE_MAX_ROWS)) {
            if (Date.now() - refineStartedAt > EMOTION_REFINE_DEADLINE_MS) {
              counts.deadlineHit = true;
              break;
            }
            const status = String(row.status || "active");
            if (status !== "active") {
              // Ueberholte oder geloeschte Zeilen brauchen keinen LLM-Lauf,
              // sollen aber nicht bei jedem Lauf erneut gescannt werden — auf
              // beiden Statusspalten, sonst hängt die Zeile über die
              // importanceStatus-Bedingung des OR weiter im Scan.
              await agentDb.update(row.id, { emotionStatus: "final", importanceStatus: IMPORTANCE_STATUS.FINAL });
              counts.finalized++;
              continue;
            }
            // Ein Call klärt Emotion UND Bedeutung (Tier 3 ohnehin gelesen,
            // siehe lib/encoding-llm.js).
            const encoding = await classifyEncoding(String(row.text || "").slice(0, 2000), {
              agentId: internalAgent,
              callLlm: encodingCallLlm,
            });
            const patch = buildRefinePatch(row, encoding, Date.now(), { flashbulbEncodingEnabled });
            if (!patch) {
              // Provider-Ausfall oder unparsbare Antwort liefert ok:false, nie
              // einen geratenen Wert: Zeile bleibt pending, nächster Lauf
              // versucht es erneut.
              //
              // Abschluss-Review, Important 4: "die Route ist tot" und "diese
              // Zeile ist vergiftet" sind verschiedene Zustände. Nur ein
              // werfendes/leeres callLlm zählt zum Consecutive-Failure-Breaker
              // (Route tot, Lauf abbrechen statt Zeitbudget verheizen). Eine
              // Zeile, die das Modell zur Verweigerung bringt (unparsbare, aber
              // tatsächlich erhaltene Antwort), scheitert deterministisch und
              // dauerhaft an derselben Stelle — drei solcher Zeilen am Kopf der
              // Warteschlange dürfen den Breaker nicht auslösen, sonst wird
              // nichts dahinter je wieder bewertet. Sie wird einfach
              // übersprungen, separat gezählt, und beim nächsten Lauf erneut
              // versucht.
              if (encoding?.callFailed) {
                counts.failed++;
                if (++consecutiveFailures >= EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES) break;
              } else {
                counts.poisoned++;
              }
              continue;
            }
            consecutiveFailures = 0;
            await agentDb.update(row.id, patch);
            counts.refined++;
          }
          counts.pending = Math.max(0, rows.length - counts.refined - counts.finalized);
          counts.ms = Date.now() - refineStartedAt;
          return counts;
        });
        if (result.reason === "no_llm_route") {
          // Sichtbar statt still (Important 6): eine wachsende Pending-
          // Warteschlange ohne LLM-Route ist sonst nur an einer
          // "importance: 0.5 für alles" über Wochen zu erahnen.
          host.logger.warn(`plur1bus internal emotion-refine[${internalAgent}]: kein LLM-Provider verfügbar — ${result.pending} Zeile(n) bleiben ohne Importance-Klärung pending`);
        } else {
          host.logger.info(`plur1bus internal emotion-refine[${internalAgent}]: ${JSON.stringify(result)}`);
        }
        return formatJsonCommandResult({ job: "emotion-refine", ...result });
      }
      if (subKey === "feedback-report") {
        if (!commandCtx.workspaceDir) {
          return formatJsonCommandResult({ job: "feedback-report", skipped: true, reason: "no_workspace" });
        }
        const result = await runFeedbackAnalyzer(commandCtx.workspaceDir);
        host.logger.info(`plur1bus internal feedback-report[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "feedback-report", ...result });
      }
      if (subKey === "discover-semantic-links") {
        const semBridgeCfg = obsidianBridgeCfg || {};
        const workspaces = selectSemanticDiscoveryWorkspaces(semBridgeCfg, internalAgent);
        if (!workspaces.length) {
          return formatJsonCommandResult({ job: "discover-semantic-links", skipped: true, reason: "no_workspace_for_agent" });
        }
        let totalProcessed = 0, totalSkipped = 0, totalUnchanged = 0, totalErrors = 0, totalBlocked = 0;
        for (const ws of workspaces) {
          try {
            const semVaultCfg = { ...semBridgeCfg, vaultPath: ws.path };
            const wsAgentId = ws.agentId || internalAgent;
            // Without a policy the discoverer is blocked by design.
            // The scheduled run is the operator's standing confirmation
            // of the semantic-discovery action (the feature gate and the
            // cron exist because they switched it on); receipt, apply
            // mode and allowWrite are still required by the policy.
            const mutationPolicy = obsidianServiceMutationPolicy(
              { ...ws, agentId: wsAgentId },
              { plan: ["semantic-discovery", "confirm"], actionConfirmed: true },
            );
            const semResult = await pool.withDb(wsAgentId, (wsDb) =>
              runSemanticDiscoveryBatches({
                db: wsDb,
                semVaultCfg,
                pool,
                logger: host.logger,
                defaultAgentId: wsAgentId,
                mutationPolicy,
              }));
            host.logger.info(`plur1bus internal discover-semantic-links[${wsAgentId}]: ${JSON.stringify(semResult)}`);
            totalProcessed += semResult.processed;
            totalSkipped += semResult.skipped;
            totalUnchanged += semResult.unchanged;
            totalErrors += semResult.errors;
            if (semResult.blocked) totalBlocked++;
          } catch (err) {
            host.logger.warn(`[discover-semantic-links] workspace ${ws.path} failed: ${err.message}`);
            totalErrors++;
          }
        }
        return formatJsonCommandResult({ job: "discover-semantic-links", processed: totalProcessed, skipped: totalSkipped, unchanged: totalUnchanged, errors: totalErrors, blocked: totalBlocked });
      }
      if (subKey === "proactive-check") {
        if (!commandCtx.workspaceDir) {
          return formatJsonCommandResult({ job: "proactive-check", skipped: true, reason: "no_workspace" });
        }
        const neoStore = createNeoStore(neoRoot, rememberNeoWorkspace(commandCtx, {}));
        const result = await runProactiveCheck(neoStore, internalAgent, {
          workspaceDir: commandCtx.workspaceDir,
          workspaceKey: commandCtx.workspaceKey || "default",
          embedFn: async (text) => embeddings.embed(text, { agentId: commandCtx?.agentId || "default" }),
          logger: host.logger,
        });
        host.logger.info(`plur1bus internal proactive-check[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "proactive-check", ...result });
      }
      if (subKey === "meta-reflect") {
        if (!commandCtx.workspaceDir) {
          return formatJsonCommandResult({ job: "meta-reflect", skipped: true, reason: "no_workspace" });
        }
        const neoStore = createNeoStore(neoRoot, rememberNeoWorkspace(commandCtx, {}));
        const result = await runReflectionJob({
          store: neoStore,
          workspaceDir: commandCtx.workspaceDir,
          logger: host.logger,
          llmReport: metaCognitionLlmReport,
        });
        host.logger.info(`plur1bus internal meta-reflect[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "meta-reflect", ...result });
      }
      return formatJsonCommandResult({ error: `unknown internal job: ${subKey || "(none)"}`, valid: ["consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream", "skill-miner", "skill-benefit-backfill", "afterthought", "persona-evolve", "reminder-dispatch", "discover-semantic-links", "gc-run", "embedding-drain", "emotion-refine", "feedback-report", "proactive-check", "meta-reflect", "episodes-rebuild"] });
    }
    if (actionKey === "start") {
      const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
      const statusText = renderPlur1busStartStatus(cfg, {
        vaultPath: cfg.obsidianBridge?.vaultPath || null,
        workspaceRoot: cfg.obsidianBridge?.workspaceRoot || null,
        reviewRoot: cfg.obsidianBridge?.reviewRoot || "plur1bus",
      });
      const notice = consumePlur1busStartNotice(openclawHome);
      const lines = [];
      if (notice) lines.push(notice, "");
      lines.push(statusText);
      const startAgentId = commandCtx?.agentId || "default";
      const startTemperament = cfg.emotion?.temperaments?.[startAgentId];
      const startTemperamentLabel = startTemperament?.preset || (startTemperament ? "custom" : (DEFAULT_TEMPERAMENTS[startAgentId] ? "default-Profil" : "ausgewogen"));
      lines.push("", `🎭 Temperament (${startAgentId}): ${startTemperamentLabel} — ändern mit /plur1bus temperament <preset>`);
      lines.push("", "Setup choices: /plur1bus setup safe or /plur1bus setup recommended");
      return { text: lines.join("\n") };
    }
    if (actionKey === "temperament") {
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const de = lang === "de";
      const temperamentAgentId = commandCtx?.agentId || "default";
      const presetName = (sub || "").toLowerCase();
      if (!presetName) {
        return { text: renderTemperamentOverview({ agentId: temperamentAgentId, temperamentsCfg: cfg.emotion?.temperaments || {}, lang }) };
      }
      const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
      if (cfg.security?.allowChatConfigCommands === false) {
        return { text: t("plur1bus.setup_blocked", { lang, tone }) };
      }
      const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
      const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH || join(openclawHome, "openclaw.json");
      const writeResult = withConfigLock(openclawConfigPath, () => {
        let rawTemperamentCfg;
        try {
          rawTemperamentCfg = JSON.parse(readFileSync(openclawConfigPath, "utf8"));
        } catch (err) {
          return { error: `openclaw.json not readable: ${err.message}` };
        }
        const applied = applyTemperamentToRawConfig(rawTemperamentCfg, PLUGIN_KEY, temperamentAgentId, presetName);
        if (applied.error) return { error: applied.error };
        try {
          const tmp = `${openclawConfigPath}.tmp-${process.pid}-${Date.now()}`;
          writeFileSync(tmp, JSON.stringify(applied.merged, null, 2));
          renameSync(tmp, openclawConfigPath);
        } catch (err) {
          return { error: `Saving config failed: ${err.message}` };
        }
        return { ok: true };
      });
      if (writeResult?.error) return { text: `❌ ${writeResult.error}` };
      return { text: de
        ? `🎭 Temperament für ${temperamentAgentId} auf "${presetName}" gesetzt. ${t("plur1bus.setup_restart", { lang, tone })}`
        : `🎭 Temperament for ${temperamentAgentId} set to "${presetName}". ${t("plur1bus.setup_restart", { lang, tone })}` };
    }
    if (actionKey === "persona") {
      const { lang } = resolveCommandLocale(commandCtx);
      const de = lang === "de";
      const personaAgentId = commandCtx?.agentId || "default";
      const personaSub = (sub || "").toLowerCase();
      const { hasPersonaVoice, generatePersonaSeed, writePersonaVoice, readPersonaFile, acceptPersonaProposal } = await import("../../lib/persona-voice.js");
      if (!commandCtx.workspaceDir) {
        return { text: de ? "❌ Kein Workspace verfügbar." : "❌ No workspace available." };
      }
      if (!personaSub) {
        if (!hasPersonaVoice(commandCtx.workspaceDir)) {
          return { text: de
            ? "🎤 Noch kein Persona-Profil — `/plur1bus persona regenerate`."
            : "🎤 No persona profile yet — `/plur1bus persona regenerate`." };
        }
        const parsed = readPersonaFile(commandCtx.workspaceDir);
        return { text: de
          ? `🎤 Persona-Voice (${personaAgentId}):\n${parsed?.managedBlock || "(leer)"}`
          : `🎤 Persona voice (${personaAgentId}):\n${parsed?.managedBlock || "(empty)"}` };
      }
      if (personaSub === "regenerate") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        if (hasPersonaVoice(commandCtx.workspaceDir)) {
          return { text: de
            ? "⚠️ Persona-Profil existiert bereits — erst `persona-voice.md` manuell löschen, um neu zu erzeugen."
            : "⚠️ Persona profile already exists — delete `persona-voice.md` manually first to regenerate." };
        }
        if (!(skillMinerEnabled || mergingEnabled) || !isLlmRouteAvailable(personaVoiceLlmCfg)) {
          return { text: de ? "❌ Kein LLM konfiguriert." : "❌ No LLM configured." };
        }
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const seed = await generatePersonaSeed({
          agentId: personaAgentId,
          lang,
          llmCfg: withLlmCallContext(
            personaVoiceLlmCfg,
            personaAgentId,
            "persona-voice",
            { runtimeLlm: sessionRuntime },
          ),
          callLlm: callCommandLlm,
        });
        if (!seed) {
          return { text: de ? "❌ Persona-Seed-Generierung fehlgeschlagen." : "❌ Persona seed generation failed." };
        }
        const ok = writePersonaVoice(commandCtx.workspaceDir, seed);
        if (!ok) {
          return { text: de ? "❌ Schreiben fehlgeschlagen." : "❌ Write failed." };
        }
        return { text: de
          ? `🎤 Persona-Profil erzeugt:\n${seed}`
          : `🎤 Persona profile generated:\n${seed}` };
      }
      if (personaSub === "accept") {
        // Legacy-Pfad: übernimmt eine ggf. noch vorhandene alte
        // Proposal-Sektion aus einer Version vor Auto-Apply. Neue
        // wöchentliche Evolutionen werden inzwischen direkt im
        // Managed Block angewendet und brauchen kein accept mehr.
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const result = acceptPersonaProposal(commandCtx.workspaceDir);
        if (!result.accepted) {
          return { text: de
            ? "❌ Kein Alt-Vorschlag zum Übernehmen verfügbar (neue Evolutionen wenden sich automatisch an)."
            : "❌ No legacy proposal to accept available (new evolutions apply automatically)." };
        }
        return { text: de
          ? `✅ Alt-Vorschlag übernommen: ${result.marker}`
          : `✅ Legacy proposal accepted: ${result.marker}` };
      }
      return { text: de
        ? `❌ Unbekannter Persona-Befehl: "${personaSub}". Nutze \`/plur1bus persona\`, \`/plur1bus persona regenerate\` oder \`/plur1bus persona accept\` (für Alt-Vorschläge).`
        : `❌ Unknown persona command: "${personaSub}". Use \`/plur1bus persona\`, \`/plur1bus persona regenerate\`, or \`/plur1bus persona accept\` (for legacy proposals).` };
    }
    if (actionKey === "setup") {
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
      if (denied) return denied;
      if (cfg.security?.allowChatConfigCommands === false) {
        return { text: t("plur1bus.setup_blocked", { lang, tone }) };
      }
      const profileName = sub?.toLowerCase() || "";
      const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
      const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH || join(openclawHome, "openclaw.json");
      if (profileName === "crons") {
        const cronsAgent = commandOption(tokens, "--agent", "") || null;
        const cronsAccount = commandOption(tokens, "--account", "") || null;
        const args = ["scripts/setup-feature-crons.mjs", "--json"];
        if (cronsAgent) args.push("--agent", cronsAgent);
        if (cronsAccount) args.push("--account", cronsAccount);
        const { spawnSync } = await import("node:child_process");
        // 180s: setup-feature-crons.mjs can spawn several sequential
        // `openclaw` CLI calls (agent discovery, cron list, one
        // `cron add` per planned job), each with its own up-to-15s
        // timeout — worst case observed ~125s on a multi-agent
        // install. 30s cut that off mid-run. Any partial creation
        // is safe either way: the planner is idempotent and
        // self-heals on the next run/retry.
        const r = spawnSync("node", args, { cwd: __pluginDir, encoding: "utf8", timeout: 180000 });
        if (r.error || r.status !== 0) {
          const detail = r.error?.message || r.stderr?.trim() || "unbekannter Fehler";
          const detailEn = r.error?.message || r.stderr?.trim() || "unknown error";
          return { text: lang === "de"
            ? `❌ Feature-Cron-Setup fehlgeschlagen: ${detail}\n  Hinweis: bereits erstellte Crons bleiben erhalten — ein erneuter Lauf holt den Rest idempotent nach.`
            : `❌ Feature-cron setup failed: ${detailEn}\n  Note: any crons already created are kept — re-running self-heals the rest idempotently.` };
        }
        let summary;
        try {
          summary = JSON.parse(r.stdout);
        } catch (_e) {
          summary = r.stdout;
        }
        return formatJsonCommandResult(summary);
      }
      if (!profileName) {
        return { text: t("plur1bus.setup_profiles", { lang, tone }) };
      }
      let profile;
      if (profileName === "recommended") profile = recommendedProfile();
      else if (profileName === "safe") profile = safeProfile();
      else return { text: t("plur1bus.setup_unknown", { lang, tone, vars: { profile: profileName } }) };
      const writeResult = withConfigLock(openclawConfigPath, () => {
        let rawCfg;
        try {
          rawCfg = JSON.parse(readFileSync(openclawConfigPath, "utf8"));
        } catch (err) {
          return { error: `openclaw.json not readable: ${err.message}` };
        }
        const pluginKey = PLUGIN_KEY;
        const existingPluginCfg = rawCfg.plugins?.entries?.[pluginKey]?.config || null;

        // Discovery is informational only; explicit confirmation remains required.
        const vaultResult = detectObsidianVaults(existingPluginCfg?.obsidianBridge || profile.obsidianBridge || {});

        // Compute diff before applying (shows what changes)
        const diff = describeProfileDiff(existingPluginCfg, profile);

        const merged = applyFeatureProfile(rawCfg, profile);
        const pendingInner = detectPendingFeatures(merged.plugins?.entries?.[pluginKey]?.config);
        try {
          const tmp = `${openclawConfigPath}.tmp-${process.pid}-${Date.now()}`;
          writeFileSync(tmp, JSON.stringify(merged, null, 2));
          renameSync(tmp, openclawConfigPath);
        } catch (err) {
          return { error: `Saving config failed: ${err.message}` };
        }
        return {
          pending: pendingInner,
          mergedCfg: merged.plugins?.entries?.[pluginKey]?.config,
          diff,
          vaultResult,
          existingPluginCfg,
        };
      });
      if (writeResult.error) return { text: `❌ ${writeResult.error}` };
      const pending = writeResult.pending || [];
      const mergedCfg = writeResult.mergedCfg || {};
      const diff = writeResult.diff || {};
      const vaultResult = writeResult.vaultResult || { detected: false, vaultPaths: [] };
      const existingPluginCfg = writeResult.existingPluginCfg;
      const pendingSet = new Set(pending.map(p => p.feature));

      const lines = [];

      // Install type header
      if (diff.isUpdate) {
        lines.push(t("plur1bus.setup_update_mode", { lang, tone, vars: { date: "current config" } }));
      } else {
        lines.push(t("plur1bus.setup_fresh_install", { lang, tone }));
      }
      lines.push(t("plur1bus.setup_confirm", { lang, tone, vars: { profile: profileName } }));
      lines.push("");

      // Obsidian vault status
      if (vaultResult.detected) {
        lines.push(t("plur1bus.setup_obsidian_found", { lang, tone, vars: { paths: vaultResult.vaultPaths.join(", ") } }));
      } else {
        lines.push(t("plur1bus.setup_obsidian_missing", { lang, tone }));
      }
      lines.push("");

      // Feature status table
      lines.push(t("plur1bus.setup_activated", { lang, tone }));
      for (const [key, value] of Object.entries(profile)) {
        if (key === "setupProfile" || key === "featuresConfirmedAt") continue;
        if (value === null || typeof value !== "object" || value.enabled === undefined) continue;
        const actualEnabled = mergedCfg[key]?.enabled ?? value.enabled;
        if (!actualEnabled) {
          lines.push(`• ${key}: disabled`);
        } else if (pendingSet.has(key)) {
          lines.push(`• ${key}: pending_setup`);
        } else if (diff.alreadyActive.includes(key)) {
          lines.push(`• ${key}: ${t("plur1bus.setup_already_active", { lang, tone })}`);
        } else {
          lines.push(`• ${key}: ${t("plur1bus.setup_newly_active", { lang, tone })}`);
        }
      }

      if (pending.length > 0) {
        lines.push("");
        lines.push(t("plur1bus.setup_pending", { lang, tone }));
        for (const p of pending) {
          lines.push(`• ${p.feature}: ${p.reason}`);
        }
      }
      lines.push("");
      lines.push(t("plur1bus.setup_restart", { lang, tone }));
      return { text: lines.join("\n") };
    }
    if (actionKey === "skills") {
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const subKey = sub?.toLowerCase() || "";
      // 7.12.48: Ledger je ACL-Partition; der Agenten-Workspace bleibt
      // als letzter Suchort fuer Altbestaende. Die Uebersicht zeigt das
      // erste Ledger mit offenen Vorschlaegen.
      const skillLedgerDirs = [...new Set([
        ...skillLedgerDirsFor(memoryCtx),
        ...(commandCtx.workspaceDir ? [commandCtx.workspaceDir] : []),
      ])];
      const workspaceDir = skillLedgerDirs.find((dir) => {
        try { return getPendingProposals(dir).length > 0; } catch { return false; }
      }) || skillLedgerDirs[0];
      if (!workspaceDir) {
        return { text: t("plur1bus.no_workspace", { lang, tone }) };
      }
      const ledgerDirFor = (proposalId) => findProposalWorkspace(skillLedgerDirs, proposalId) || workspaceDir;
      if (!subKey || subKey === "help") {
        return { text: t("plur1bus.skills_help", { lang, tone }) };
      }
      if (subKey === "review") {
        const identity = resolveConfirmationIdentity(memoryCtx);
        const payload = buildSkillReviewPayload(workspaceDir, {
          lang,
          tone,
          userId: identity.userId,
          chatId: identity.chatId,
        });
        for (const pending of payload.confirmations) {
          rememberPendingConfirmation(confirmationStore, confirmationIndex, pending);
        }
        return { text: payload.text, inline_keyboard: payload.inline_keyboard };
      }
      if (subKey === "confirm") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const nonce = id;
        let completed = completePendingConfirmation({
          confirmationStore,
          confirmationIndex,
          expectedCommand: "skills-approve",
          memoryCtx,
          nonce,
        });
        let reject = false;
        if (completed.error) {
          completed = completePendingConfirmation({
            confirmationStore,
            confirmationIndex,
            expectedCommand: "skills-reject",
            memoryCtx,
            nonce,
          });
          reject = !completed.error;
        }
        if (completed.error || !completed.pending) {
          return { text: t("skill.approve_not_found", { lang, tone, vars: { id: nonce || "?" } }) };
        }
        if (reject || completed.pending.command === "skills-reject") {
          const rejected = await rejectSkillProposalWithWorkshop(
            ledgerDirFor(completed.pending.targetId),
            completed.pending.targetId,
            {
              lang,
              tone,
              agentId: commandCtx.agentId || "default",
              logger: host.logger,
              skillWorkshop: openClawSkillWorkshop,
            },
          );
          return { text: rejected.text };
        }
        const result = await activateSkillProposal(ledgerDirFor(completed.pending.targetId), completed.pending.targetId, {
          lang,
          tone,
          agentId: commandCtx.agentId || "default",
          logger: host.logger,
          skillWorkshop: openClawSkillWorkshop,
          memoryCtx,
          loadEvidenceRecord: async (memoryId) => {
            try {
              return await pool.withDb(commandCtx.agentId || "default", (db) => db.getById(memoryId));
            } catch (error) {
              // null is indistinguishable from "no evidence exists",
              // so record that this was a failed read instead.
              host.logger.warn(`memory-lancedb-namespaced: evidence record unreadable for ${String(memoryId)}: ${String(error)}`);
              return null;
            }
          },
          applyEpistemicStatus: async (memoryId, nextStatus) => pool.withWriteDb(commandCtx.agentId || "default", (db) => applyEpistemicStatusToLanceDb(db, memoryId, nextStatus, {
            ctx: memoryCtx,
            actor: String(memoryCtx.userId || "human"),
            actorTier: "human",
            authorized: false,
            workspaceDir,
            reason: "skill-approve",
          })),
        });
        return { text: result.text };
      }
      if (subKey === "list") {
        return { text: listActiveSkills(workspaceDir, { lang, tone }) };
      }
      if (subKey === "show") {
        if (!id) return { text: t("plur1bus.skills_show_usage", { lang, tone }) };
        return { text: showProposal(ledgerDirFor(id), id, { lang, tone }).text };
      }
      if (subKey === "approve") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        if (!id) return { text: t("plur1bus.skills_approve_usage", { lang, tone }) };
        const result = await activateSkillProposal(ledgerDirFor(id), id, {
          lang,
          tone,
          agentId: commandCtx.agentId || "default",
          logger: host.logger,
          skillWorkshop: openClawSkillWorkshop,
          memoryCtx,
          loadEvidenceRecord: async (memoryId) => {
            try {
              return await pool.withDb(commandCtx.agentId || "default", (db) => db.getById(memoryId));
            } catch (error) {
              // null is indistinguishable from "no evidence exists",
              // so record that this was a failed read instead.
              host.logger.warn(`memory-lancedb-namespaced: evidence record unreadable for ${String(memoryId)}: ${String(error)}`);
              return null;
            }
          },
          applyEpistemicStatus: async (memoryId, nextStatus) => pool.withWriteDb(commandCtx.agentId || "default", (db) => applyEpistemicStatusToLanceDb(db, memoryId, nextStatus, {
            ctx: memoryCtx,
            actor: String(memoryCtx.userId || "human"),
            actorTier: "human",
            authorized: false,
            workspaceDir,
            reason: "skill-approve",
          })),
        });
        return { text: result.text };
      }
      if (subKey === "reject") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        if (!id) return { text: t("plur1bus.skills_reject_usage", { lang, tone }) };
        const result = await rejectSkillProposalWithWorkshop(ledgerDirFor(id), id, {
          lang,
          tone,
          agentId: commandCtx.agentId || "default",
          logger: host.logger,
          skillWorkshop: openClawSkillWorkshop,
        });
        return { text: result.text };
      }
      return { text: t("plur1bus.skills_unknown", { lang, tone, vars: { sub: subKey } }) };
    }
    if (actionKey === "reminders" || actionKey === "reminder") {
      const { lang, tone } = resolveCommandLocale(commandCtx);
      const subKey = sub?.toLowerCase() || "list";
      const reminderAgent = commandCtx.agentId || "default";
      const reminderWsKey = commandCtx.workspaceKey || commandCtx.workspaceDir || "default";
      if (subKey === "cancel" || subKey === "delete") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        if (!id) return { text: t("reminder.cancel_usage", { lang, tone }) };
        return pool.withDb(reminderAgent, async (rdb) => {
          await rdb.init();
          try {
            await cancelReminder(rdb, id);
            return { text: t("reminder.cancel_success", { lang, tone, vars: { id } }) };
          } catch (e) {
            return { text: t("reminder.cancel_failed", { lang, tone, vars: { id, error: e?.message || String(e) } }) };
          }
        });
      }
      if (subKey === "list" || subKey === "show" || subKey === "help") {
        return pool.withDb(reminderAgent, async (rdb) => {
          await rdb.init();
          let rows = [];
          try {
            rows = await listReminders(rdb, reminderAgent, reminderWsKey);
          } catch (e) {
            host.logger.warn(`plur1bus-reminder: list failed: ${String(e)}`);
          }
          const active = rows.filter(r => !["cancelled", "acknowledged"].includes(r.reminderStatus));
          if (active.length === 0) return { text: t("reminder.list_none", { lang, tone }) };
          // remindAt kommt aus LanceDB als BigInt: `new Date(1n)` wirft
          // "Cannot convert a BigInt value to a number" — Bernhardines
          // /reminder list fiel am 09.09.2026 genau daran.
          const remindAtMs = (r) => Number(r.remindAt || 0);
          active.sort((a, b) => remindAtMs(a) - remindAtMs(b));
          const lines = [t("reminder.list_header", { lang, tone })];
          for (const r of active) {
            const when = remindAtMs(r) ? new Date(remindAtMs(r)).toISOString().replace("T", " ").slice(0, 16) : "?";
            lines.push(t("reminder.list_item", { lang, tone, vars: {
              when,
              text: String(r.text || "").slice(0, 80),
              status: r.reminderStatus || "scheduled",
              id: r.id,
            } }));
          }
          lines.push(t("reminder.list_hint", { lang, tone }));
          return { text: lines.join("\n") };
        });
      }
      return { text: t("reminder.unknown", { lang, tone, vars: { sub: subKey } }) };
    }
    if (action === "status") {
      const statusReport = summarizeNeoStore(commandStore);
      const statusCronsHint = getFeatureCronsSetupHint(baseDbPath);
      if (statusCronsHint) statusReport.featureCronsHint = statusCronsHint;
      return formatJsonCommandResult(statusReport);
    }
    if (action === "doctor") {
      const report = buildNeoDoctorReport({
        hooks: commandStore.readHooks(),
        config: { ...neoCfg, hooks: resolveNeoHooksConfig(commandCtx.config) },
      });
      report.runtimeScheduler = runtimeScheduler.status();
      const featureCronsHint = getFeatureCronsSetupHint(baseDbPath);
      if (featureCronsHint) report.featureCronsHint = featureCronsHint;
      return formatJsonCommandResult(report);
    }
    if (action === "neo" && sub === "workspaces" && tokens[2] === "migrate") {
      const dryRun = tokens.includes("--dry-run");
      if (!dryRun) {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
      }
      const backupDir = commandOption(tokens, "--backup-dir", commandOption(tokens, "--backup", ""));
      return formatJsonCommandResult(migrateNeoWorkspaces(neoRoot, {
        dryRun,
        verbose: tokens.includes("--verbose"),
        backupDir,
        workspaceAliases: neoWorkspaceAliases,
      }));
    }
    if (action === "curation") {
      if (sub === "resolve") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const keepOrDrop = (tokens[3] || "").toLowerCase();
        const record = findNeoRecord(commandStore, id, neoRequester(commandCtx, {}));
        const result = resolveCurationRecord(commandStore, record, keepOrDrop, { authorized: true });
        if (result.ok) {
          appendDestructiveOpLog(commandCtx?.workspaceDir, {
            event: "curation.resolve",
            source: "plur1bus_curation",
            agentId: commandCtx.agentId || "command",
            recordId: id,
            action: keepOrDrop,
            timestamp: new Date().toISOString(),
          });
        }
        return formatJsonCommandResult(result);
      }
      if (sub === "drop-injected") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const requester = neoRequester(commandCtx, {});
        const preview = previewDropInjected(commandStore, requester);
        if (!preview.ok) return formatJsonCommandResult(preview);
        const confirmationIdentity = resolveConfirmationIdentity(memoryCtx);
        const confirm = createConfirmation({
          userId: confirmationIdentity.userId,
          chatId: confirmationIdentity.chatId,
          command: "drop-injected",
          targetId: randomUUID(),
        });
        confirm.payload = { hash: preview.hash, count: preview.count };
        rememberPendingConfirmation(confirmationStore, confirmationIndex, confirm);
        return {
          text: [
            `Drop ${preview.count} injected behavior conflict(s).`,
            ...preview.examples.map((ex) => `- ${ex.id}: ${ex.statement}`),
            `Confirm: /plur1bus curation confirm ${confirm.nonce}`,
          ].join("\n"),
        };
      }
      if (sub === "apply-conflict") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const workspaceDir = memoryCtx.workspaceDir || commandCtx?.workspaceDir;
        const entry = findResolvableConflict(workspaceDir, id);
        if (!entry) return formatJsonCommandResult({ ok: false, reason: "not_found" });
        const applyId = resolutionApplyId(entry);
        const confirmationIdentity = resolveConfirmationIdentity(memoryCtx);
        const confirm = createConfirmation({
          userId: confirmationIdentity.userId,
          chatId: confirmationIdentity.chatId,
          command: "conflict-apply",
          targetId: applyId,
        });
        rememberPendingConfirmation(confirmationStore, confirmationIndex, confirm);
        return {
          text: `Confirm conflict apply for ${applyId}: /plur1bus curation confirm ${confirm.nonce}`,
        };
      }
      if (sub === "confirm") {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
        const dropped = completePendingConfirmation({
          confirmationStore,
          confirmationIndex,
          expectedCommand: "drop-injected",
          memoryCtx,
          nonce: id,
        });
        if (!dropped.error) {
          const result = applyDropInjected(commandStore, {
            authorized: true,
            requester: neoRequester(commandCtx, {}),
            expectedHash: dropped.pending?.payload?.hash,
            expectedCount: dropped.pending?.payload?.count,
          });
          if (result.ok) {
            appendDestructiveOpLog(commandCtx?.workspaceDir, {
              event: "curation.drop_injected",
              source: "plur1bus_curation",
              agentId: commandCtx.agentId || "command",
              count: result.dropped,
              hash: dropped.pending?.payload?.hash,
              timestamp: new Date().toISOString(),
            });
          }
          return formatJsonCommandResult(result);
        }
        const { pending, error } = completePendingConfirmation({
          confirmationStore,
          confirmationIndex,
          expectedCommand: "conflict-apply",
          memoryCtx,
          nonce: id,
        });
        if (error) return formatJsonCommandResult({ ok: false, reason: error });
        const workspaceDir = memoryCtx.workspaceDir || commandCtx?.workspaceDir;
        const entry = findResolvableConflict(workspaceDir, pending.targetId);
        if (!entry) return formatJsonCommandResult({ ok: false, reason: "not_found" });
        const applyId = resolutionApplyId(entry);
        const text = resolutionApplyText(entry);
        const result = await pool.withDb(memoryCtx.agentId, async (rawDb) => {
          await rawDb.init();
          const card = typeof rawDb.getById === "function" ? await rawDb.getById(applyId) : null;
          let vector = card?.vector;
          if (embeddings && typeof embeddings.embed === "function" && text && text !== card?.text) {
            vector = await embeddings.embed(text, { agentId: memoryCtx.agentId });
          }
          return applyConflictViaSafeUpdate(
            rawDb,
            { existingMemoryId: applyId, mergedText: text, reason: entry.reason },
            { confirm: true, vector, neoStore: commandStore, logger: host.logger, agentId: memoryCtx.agentId },
          );
        });
        if (result.ok) {
          appendDestructiveOpLog(workspaceDir, {
            event: "curation.conflict_apply",
            source: "plur1bus_curation",
            agentId: commandCtx.agentId || "command",
            recordId: applyId,
            timestamp: new Date().toISOString(),
          });
        }
        return formatJsonCommandResult(result);
      }
      const candidates = commandStore.readCandidates(500, neoRequester(commandCtx, {}));
      const behavior = commandStore.readBehaviorCards(200, neoRequester(commandCtx, {}));
      const records = [...candidates, ...behavior];
      const filtered = sub === "conflicts" ? records.filter(r => r.status === "conflict")
        : sub === "stale" ? records.filter(r => r.embeddingStatus === "stale")
        : sub === "promoted" ? records.filter(r => r.status === "promoted")
        : records.filter(r => r.status === "candidate" || r.status === "active").slice(-50);
      return formatJsonCommandResult(filtered);
    }
    if (action === "memory") {
      // Overlay audit subcommands do not require a neo record lookup.
      const subKey = sub.toLowerCase();
      if (["overlays", "overlay", "disable-overlay", "contradictions", "supersede-overlay", "doctor"].includes(subKey)) {
        if (subKey === "disable-overlay" || subKey === "supersede-overlay") {
          const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
          if (denied) return denied;
        }
        const extraArgs = ["supersede-overlay", "doctor"].includes(subKey) ? tokens.slice(3) : [];
        const doctorCfg = cfg?.continuityEngine?.doctor ?? { enabled: false };
        const auditAgentId = commandCtx?.agentId || "default";
        const sessionRuntime = commandCtx?.runtimeContext?.llm;
        const result = await runOverlayAuditCommand({
          subCommand: subKey,
          id,
          extraArgs,
          workspaceDir: commandCtx?.workspaceDir,
          callLlm,
          overlayAuditLlmCfg: mergingEnabled ? withLlmCallContext(
            overlayAuditLlmCfg,
            auditAgentId,
            "overlay-audit-contradiction",
            { runtimeLlm: sessionRuntime },
          ) : null,
          doctorCfg,
        });
        if ((subKey === "disable-overlay" || subKey === "supersede-overlay") && result.ok) {
          appendDestructiveOpLog(commandCtx?.workspaceDir, {
            event: subKey === "disable-overlay" ? "overlay.disabled" : "overlay.superseded",
            source: "plur1bus_memory",
            agentId: commandCtx.agentId || "command",
            overlayId: id,
            timestamp: new Date().toISOString(),
          });
        }
        return result;
      }

      if (!id && ["origin", "explain", "promote", "demote", "prune", "tombstone"].includes(sub)) {
        if (sub === "demote") {
          return { text: "Usage: /plur1bus memory demote <id> — withholds the newest neo revision from recall. Reversible with /plur1bus memory promote <id>." };
        }
        return { text: `Usage: /plur1bus memory ${sub} <id>` };
      }
      if (["promote", "demote", "prune", "tombstone"].includes(sub)) {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
      }
      const record = findNeoRecord(commandStore, id, neoRequester(commandCtx, {}));
      if (!record) return { text: `No PLUR1BUS neo record found for ${id}` };
      if (sub === "origin" || sub === "explain") return formatJsonCommandResult(record);
      if (["promote", "demote", "prune", "tombstone"].includes(sub)) {
        const next = sub === "tombstone" ? "tombstoned" : `${sub}d`;
        const updated = transitionRecordStatus(record, next);
        commandStore.appendCandidates([updated]);
        commandStore.appendEmbeddingQueue([updated]);
        return formatJsonCommandResult(updated);
      }
    }
    if (action === "recall" && sub === "why") {
      const record = findNeoRecord(commandStore, id, neoRequester(commandCtx, {}));
      if (!record) return { text: `No PLUR1BUS neo record found for ${id}` };
      return formatJsonCommandResult({ id, category: record.category, status: record.status, origin: record.origin, salience: record.salience, confidence: record.confidence });
    }
    if (action === "origin" && sub === "trace") {
      const record = findNeoRecord(commandStore, id, neoRequester(commandCtx, {}));
      if (!record) return { text: `No PLUR1BUS neo record found for ${id}` };
      return formatJsonCommandResult({ id, sourceTurnIds: record.sourceTurnIds || record.origin?.sourceTurnIds || [], sourceMemoryIds: record.origin?.sourceMemoryIds || [], sourceToolCallIds: record.origin?.sourceToolCallIds || [], origin: record.origin });
    }
    if (action === "behavior") {
      if (["promote", "demote", "prune"].includes(sub)) {
        const denied = await checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind }, commandCtx);
        if (denied) return denied;
      }
      const cards = commandStore.readBehaviorCards(500, neoRequester(commandCtx, {}));
      if (sub === "show") return formatJsonCommandResult(cards.filter(c => c.status === "active" || c.status === "promoted"));
      if (sub === "candidates") return formatJsonCommandResult(cards.filter(c => c.status === "candidate"));
      const card = cards.find(c => c.id === id);
      if (sub === "explain") return card ? formatJsonCommandResult(card) : { text: `No BehaviorCard found for ${id}` };
      if (["promote", "demote", "prune"].includes(sub)) {
        if (!card) return { text: `No BehaviorCard found for ${id}` };
        const updated = transitionRecordStatus(card, `${sub}d`);
        commandStore.appendBehaviorCards([updated]);
        commandStore.appendEmbeddingQueue([updated]);
        return formatJsonCommandResult(updated);
      }
    }
    if (action === "embeddings") {
      return formatJsonCommandResult({ queuePath: commandStore.paths.embeddings, status: "queued", note: "Embedding drain is handled by plugin service/OpenClaw-agent-cron in neo-arch." });
    }
    if (action === "dreaming") {
      const remDream = await import("../../lib/dreaming/rem-dream.js");
      const weekWindow = remDream.getWeekWindow();
      const runKey = remDream.buildRunKey(commandCtx.workspaceKey || "default", commandCtx.agentId || "default", weekWindow.weekOf);
      const runs = commandStore.readRunState();
      const lastRun = runs.completed?.[runKey];
      return formatJsonCommandResult({
        status: "active",
        heavyJobCarrier: "OpenClaw-managed agent cron",
        modes: ["light", "rem", "deep"],
        rem: {
          currentWeek: weekWindow.weekOf,
          lastRun: lastRun ? { weekOf: weekWindow.weekOf, completedAt: lastRun.completedAt, patternsFound: lastRun.patternsFound } : null,
          nextRun: lastRun ? "already completed this week" : "pending",
        },
      });
    }
    if (actionKey === "state") {
      return runStatusCommand(commandCtx, memoryCtx);
    }
    if (actionKey === "enable") {
      return runFeatureToggle(commandCtx, true, memoryCtx);
    }
    if (actionKey === "disable") {
      return runFeatureToggle(commandCtx, false, memoryCtx);
    }
    if (actionKey === "memory") {
      return runMemoryCommand(commandCtx, memoryCtx);
    }
    if (actionKey === "forget") {
      return runForgetCommand(commandCtx, memoryCtx);
    }
    if (actionKey === "correct") {
      return runCorrectCommand(commandCtx, memoryCtx);
    }
    if (actionKey === "critical") {
      return runCriticalCommand(commandCtx, memoryCtx);
    }
    return plur1busHelp("quick", resolveCommandLocale(commandCtx));
  };
}
