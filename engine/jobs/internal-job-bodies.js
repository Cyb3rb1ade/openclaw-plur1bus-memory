/**
 * engine/jobs/internal-job-bodies.js — the 17 internal job runners (PR-07).
 *
 * Was engine/commands/plur1bus-command.js:409-1178, the `/plur1bus internal
 * <job>` chain. Each branch is the job body for one name; its reply is the
 * job's output, and every job-level early exit is `return jobCtx.skip(...)`
 * so the registry records why the job did not run.
 */

import { IMPORTANCE_STATUS } from "../../lib/importance-status.js";
import { buildRefinePatch, classifyEncoding } from "../../lib/encoding-llm.js";
import { buildRemPartitions, describeRemPartitionRun, resolveRemOutputRoot, runRemDream, writeRemDreamToVault } from "../../lib/dreaming/rem-dream.js";
import { ledgerBackedCompletion, remJobOutcome } from "./rem-outcome.js";
import { findEpisodeCardPath, rebuildEpisode, writeEpisodeToVault } from "../../lib/episodes.js";
import { classifierPartialFailureWarning, formatAfterthoughtCronReply, formatClassifierCronReply } from "../../lib/internal-cron-reply.js";
import { expireStaleCriticals as runExpireStaleCriticals } from "../../lib/jobs/auto-accept-stale-criticals.js";
import { runClassifier as runCriticalClassifier } from "../../lib/jobs/critical-classifier.js";
import { runConsolidation as runDailyConsolidation } from "../../lib/jobs/daily-consolidation.js";
import { runFeedbackAnalyzer } from "../../lib/jobs/feedback-analyzer.js";
import { runGcJob } from "../../lib/jobs/gc-job.js";
import { runProactiveCheck } from "../../lib/jobs/proactive-check.js";
import { runReflectionJob } from "../../lib/jobs/reflection-job.js";
import { runReminderDispatch } from "../../lib/jobs/reminder-dispatch.js";
import { runSkillMiner } from "../../lib/jobs/skill-miner.js";
import { resolveLancedbOptimizePlan, summarizeLancedbOptimize } from "../../lib/lancedb-optimize.js";
import { LLM_RESULT_CACHE_PURPOSES, withLlmCallContext } from "../../lib/llm-result-cache.js";
import { LLM_ROUTE_KINDS, isLlmRouteAvailable } from "../../lib/llm-router.js";
import { pruneGraphEdges } from "../../lib/memory-graph.js";
import { createNeoStore } from "../../lib/neo-arch.js";
import { readReplyOutcomeLog } from "../../lib/reply-outcome-tracking.js";
import { activateSkillProposal } from "../../lib/telegram-commands/skill-commands.js";

/**
 * @param {Record<string, any>} ctx The command runner's context plus its factory-level helpers.
 * @returns {(name: string, jobCtx: object) => Promise<object>} Job body.
 */
export function createInternalJobBodies(ctx) {
  const {
    aggregateSkillMinerRuns,
    afterthoughtLlmCfg,
    baseDbPath,
    callCommandLlm,
    callLlm,
    cfg,
    conflictResolutionLlmCfg,
    createFeatureRoute,
    createOwnerBoundMemoryStore,
    createOwnerBoundNeoStore,
    createOwnerBoundTarget,
    createPartitionScopedDb,
    dreamEchoLlmCfg,
    dreamNarrativeCfg,
    dreamNarrativeLlmCfg,
    embeddings,
    EMOTION_REFINE_DEADLINE_MS,
    EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES,
    EMOTION_REFINE_MAX_ROWS,
    encodingCallLlm,
    episodeExtractionLlmCfg,
    flashbulbEncodingEnabled,
    formatJsonCommandResult,
    getNeoStore,
    host,
    memoryCompactionLlmCfg,
    memoryDbAdapter,
    mergingEnabled,
    metaCognitionLlmReport,
    NEO_MANUAL_DRAIN_DEADLINE_MS,
    NEO_MANUAL_DRAIN_MAX_ITEMS,
    neoEmbeddingDrainImpact,
    neoEnabled,
    neoGlobalRecall,
    neoRoot,
    normalizedEmbeddingCfg,
    obsidianBridgeCfg,
    obsidianServiceMutationPolicy,
    openClawSkillWorkshop,
    personaEvolveMinDaysBetween,
    personaEvolveMinOutcomes,
    personaMaxBullets,
    personaVoiceLlmCfg,
    pool,
    remPatternLlmCfg,
    rememberNeoWorkspace,
    resolveEnvVars,
    resolveTemperamentName,
    runSemanticDiscoveryBatches,
    selectSemanticDiscoveryWorkspaces,
    sharedMemoryPool,
    skillActivationDeps,
    skillLedgerDirsFor,
    skillMinerAutoApplyEffective,
    skillMinerCfg,
    skillMinerEnabled,
    skillMinerLlmCfg,
    vectorDim,
  } = ctx;

  return async function runInternalJob(name, jobCtx) {
    const { commandCtx, memoryCtx, cronInternal, commandStore, id, tokens } = jobCtx.input;
    const subKey = name;
    const internalAgent = commandCtx.agentId || "default";
      if (subKey === "consolidate-daily") {
        const dcCfg = cfg.dailyConsolidation || {};
        if (dcCfg.enabled === false) {
          return jobCtx.skip("dailyConsolidation_disabled", formatJsonCommandResult({ job: "consolidate-daily", skipped: true, reason: "dailyConsolidation_disabled" }));
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
          return jobCtx.skip("criticalPush_disabled", cronInternal ? formatClassifierCronReply(disabledResult) : formatJsonCommandResult(disabledResult));
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
        // 7.16.10: eine Telegram-Nachricht je Karte mit Annehmen/Ablehnen.
        // Nicht gesendete Karten gehen wie bisher als Text über die
        // Cron-Zustellung raus. Den Versand macht der Host über
        // HostCapabilities.pushCriticalButtons (adapter/openclaw/plugin.js).
        // Sie liefert null, solange der Klick-Handler nicht registriert ist.
        const pushedCount = Array.isArray(result?.pushMessages) ? result.pushMessages.length : 0;
        const pushCriticalButtons = host.capabilities?.pushCriticalButtons;
        if (cronInternal && pushedCount > 0 && cpCfg.buttons !== false && typeof pushCriticalButtons === "function") {
          // Ein fremder Host kann werfen oder etwas Unvollständiges liefern;
          // dann bleibt es bei der Textzustellung über den Cron.
          let delivery = null;
          try {
            delivery = await pushCriticalButtons({
              agentId: internalAgent,
              result,
              commandCtx,
              warning: classifierPartialFailureWarning(result),
            });
          } catch (error) {
            host.logger.warn(`plur1bus critical[${internalAgent}]: button push failed: ${error?.message || error}`);
            delivery = null;
          }
          if (delivery) {
            host.logger.info(`plur1bus critical[${internalAgent}]: button push sent=${delivery.sent}${delivery.reason ? ` fallback=${delivery.reason}` : ""}`);
            if (delivery.sent > 0 && Array.isArray(delivery?.unsentTexts)) {
              if (delivery.unsentTexts.length === 0) return { text: "NO_REPLY" };
              return formatClassifierCronReply({
                ...result,
                pushMessages: delivery.unsentTexts.map((text) => ({ text })),
              });
            }
          }
        }
        return cronInternal
          ? formatClassifierCronReply(result)
          : formatJsonCommandResult({ job: "classify-recent", ...result });
      }
      if (subKey === "auto-accept-stale") {
        // Seit 7.16.10 verfallen unbestätigte Criticals zur normalen
        // Notiz statt automatisch als Critical akzeptiert zu werden.
        // Name und Cron bleiben für bestehende Installationen gleich.
        const result = await runExpireStaleCriticals(memoryDbAdapter, internalAgent, { logger: host.logger, hours: 24 });
        host.logger.info(`plur1bus internal auto-accept-stale[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "auto-accept-stale", ...result });
      }
      if (subKey === "rem-dream") {
        if (!mergingEnabled || !isLlmRouteAvailable(remPatternLlmCfg)) {
          return jobCtx.skip("no_llm_config", formatJsonCommandResult({ job: "rem-dream", skipped: true, reason: "no_llm_config" }));
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
          return jobCtx.skip("acl_partition_missing", formatJsonCommandResult({ job: "rem-dream", skipped: true, reason: "acl_partition_missing" }));
        }
        const remRuns = [];
        for (const remAclPartition of remAclPartitions) {
          const remStore = ledgerBackedCompletion(createOwnerBoundNeoStore(remAclPartition), jobCtx);
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
          if (partitionResult?.diary) jobCtx.noteDiary(partitionResult.diary);
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
        const remReply = formatJsonCommandResult({
          job: "rem-dream",
          partitions: remRuns.map((run) => describeRemPartitionRun(run)),
          ...(result.report || result),
        });
        const verdict = remJobOutcome(remRuns, { narrativeExpected: dreamNarrativeCfg?.enabled !== false, dryRun: false });
        for (const key of verdict.pendingKeys) jobCtx.notePendingKey(key);
        const diaryDisabled = dreamNarrativeCfg?.diary === false;
        jobCtx.setDiaryTarget(diaryDisabled ? null : (memoryCtx?.workspaceDir || null), {
          timezone: dreamNarrativeCfg?.timezone ?? null,
          disabled: diaryDisabled,
        });
        if (verdict.outcome === "incomplete") return jobCtx.incomplete(verdict.reason, remReply);
        if (verdict.outcome === "skipped") return jobCtx.skip(verdict.reason, remReply);
        return remReply;
      }
      if (subKey === "skill-miner") {
        if (!skillMinerEnabled || !skillMinerLlmCfg) {
          return jobCtx.skip("not_configured", formatJsonCommandResult({ job: "skill-miner", skipped: true, reason: "not_configured" }));
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
          return jobCtx.skip("acl_partition_missing", formatJsonCommandResult({ job: "skill-miner", skipped: true, reason: "acl_partition_missing", partitions: [] }));
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
          return jobCtx.skip("not_configured", formatJsonCommandResult({ job: "skill-benefit-backfill", skipped: true, reason: "not_configured" }));
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
          return jobCtx.skip("disabled", cronInternal ? formatAfterthoughtCronReply(disabledResult) : formatJsonCommandResult(disabledResult));
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
          return jobCtx.skip("not_configured", formatJsonCommandResult({ job: "persona-evolve", skipped: true, reason: "not_configured" }));
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
          return jobCtx.skip("neo_disabled", formatJsonCommandResult({ job: "episodes-rebuild", skipped: true, reason: "neo_disabled" }));
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
          return jobCtx.skip("gc_disabled", formatJsonCommandResult({ job: "gc-run", skipped: true, reason: "gc_disabled" }));
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
          return jobCtx.skip("neo_disabled", formatJsonCommandResult({ job: "embedding-drain", skipped: true, reason: "neo_disabled" }));
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
        const emotionReply = formatJsonCommandResult({ job: "emotion-refine", ...result });
        return result.skipped ? jobCtx.skip(result.reason, emotionReply) : emotionReply;
      }
      if (subKey === "feedback-report") {
        if (!commandCtx.workspaceDir) {
          return jobCtx.skip("no_workspace", formatJsonCommandResult({ job: "feedback-report", skipped: true, reason: "no_workspace" }));
        }
        const result = await runFeedbackAnalyzer(commandCtx.workspaceDir);
        host.logger.info(`plur1bus internal feedback-report[${internalAgent}]: ${JSON.stringify(result)}`);
        return formatJsonCommandResult({ job: "feedback-report", ...result });
      }
      if (subKey === "discover-semantic-links") {
        const semBridgeCfg = obsidianBridgeCfg || {};
        const workspaces = selectSemanticDiscoveryWorkspaces(semBridgeCfg, internalAgent);
        if (!workspaces.length) {
          return jobCtx.skip("no_workspace_for_agent", formatJsonCommandResult({ job: "discover-semantic-links", skipped: true, reason: "no_workspace_for_agent" }));
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
          return jobCtx.skip("no_workspace", formatJsonCommandResult({ job: "proactive-check", skipped: true, reason: "no_workspace" }));
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
          return jobCtx.skip("no_workspace", formatJsonCommandResult({ job: "meta-reflect", skipped: true, reason: "no_workspace" }));
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

    throw new Error(`internal job ${name} has no branch`);
  };
}
