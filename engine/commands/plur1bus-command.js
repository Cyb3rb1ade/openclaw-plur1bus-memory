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
import { resolveCurationRecord } from "../../lib/curation-resolve.js";
import { applyDropInjected, previewDropInjected } from "../../lib/drop-injected-conflicts.js";
import { DEFAULT_TEMPERAMENTS } from "../../lib/emotional-state.js";
import { t } from "../../lib/i18n.js";
import { applyConflictViaSafeUpdate, findResolvableConflict, resolutionApplyId, resolutionApplyText } from "../../lib/jobs/apply-conflict-resolution.js";
import { getPendingProposals } from "../../lib/jobs/skill-miner/proposal-writer.js";
import { createInternalJobBodies } from "../jobs/internal-job-bodies.js";
import { INTERNAL_JOB_NAMES } from "../jobs/job-specs.js";
import { withLlmCallContext } from "../../lib/llm-result-cache.js";
import { isLlmRouteAvailable } from "../../lib/llm-router.js";
import { buildNeoDoctorReport, migrateNeoWorkspaces, transitionRecordStatus } from "../../lib/neo-arch.js";
import { resolveCommandVaultPath } from "../../lib/obsidian-control-room.js";
import { describeOwnedVaultConfirmation, isOwnedVaultConfirmed } from "../../lib/obsidian-vault-authority.js";
import { runOverlayAuditCommand } from "../../lib/overlay-commands.js";
import { cancelReminder, listReminders } from "../../lib/reminder-store.js";
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
    isDestructiveAction,
    isSensitiveChatRead,
    jobs = null,
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

  if (jobs) {
    const runInternalJob = createInternalJobBodies({ ...ctx });
    const defaultInput = async (agentId, jobName) => {
      let workspaceDir;
      try {
        workspaceDir = await host.workspaceDir(agentId);
      } catch (error) {
        host.logger.debug(`plur1bus job ${jobName}[${agentId}]: workspaceDir unresolved: ${String(error?.message || error)}`);
      }
      const commandCtx = {
        agentId,
        channel: "cron",
        origin: "cron",
        sessionKey: `agent:${agentId}:cron:${jobName}`,
        args: `internal ${jobName}`,
        config: host.config(),
        workspaceDir,
      };
      const memoryCtx = await resolveCronMemoryContext(commandCtx);
      const decision = workspacePolicyGuard.decision(memoryCtx);
      if (!decision.allowed) {
        const reason = decision.reason || "workspace_disabled";
        return { preSkip: { reason, output: { text: "NO_REPLY", metadata: { skipped: true, reason } } } };
      }
      const commandStore = getNeoStore({
        workspaceDir: memoryCtx?.workspaceDir || "",
        agentId: memoryCtx?.agentId || agentId,
      });
      return {
        commandCtx,
        memoryCtx,
        cronInternal: true,
        commandStore,
        id: "",
        tokens: ["internal", jobName],
      };
    };
    for (const jobName of INTERNAL_JOB_NAMES) jobs.bind(jobName, runInternalJob, { defaultInput });
  }

  return async function runPlur1busCommand(commandCtx, prefixTokens = [], opts = {}) {
    const agentContext = opts.agentContext ?? { origin: "user", background: false };
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
      const openclawHome = host.stateDir;
      const openclawConfigPath = host.configPath();
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
    const cronInternal = actionKey === "internal" && agentContext.origin === "cron";
    const memoryCtx = opts.memoryCtx ?? (cronInternal
      ? await resolveCronMemoryContext(commandCtx)
      : await resolveRegisteredMemoryContext(commandCtx));
    const workspacePolicyDecision = workspacePolicyGuard.decision(memoryCtx);
    if (!workspacePolicyDecision.allowed) {
      const rejectionReason = workspacePolicyDecision.reason || "workspace_disabled";
      if (actionKey === "internal") {
        const refusal = { text: "NO_REPLY", metadata: { skipped: true, reason: rejectionReason } };
        const jobName = (sub || "").toLowerCase();
        // Controller ruling: an unauthenticated/non-cron caller never
        // produces a job record — only a verified cron-internal call is
        // recorded (job.run + skip log), matching the authorized dispatch
        // path below.
        if (jobs && cronInternal && INTERNAL_JOB_NAMES.includes(jobName)) {
          const refused = await jobs.run(jobName, commandCtx.agentId || "default", {
            trigger: "cron",
            preSkip: { reason: rejectionReason, output: refusal },
          });
          return refused.output;
        }
        return refusal;
      }
      return formatJsonCommandResult({
        ok: false,
        reason: rejectionReason,
        retryable: workspacePolicyDecision.retryable === true,
        policy: workspacePolicyDecision.policy,
      });
    }
    if (actionKey === "internal") {
      if (agentContext.origin !== "cron") {
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
      if (!jobs || !INTERNAL_JOB_NAMES.includes(subKey)) {
        return formatJsonCommandResult({ error: `unknown internal job: ${subKey || "(none)"}`, valid: ["consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream", "skill-miner", "skill-benefit-backfill", "afterthought", "persona-evolve", "reminder-dispatch", "discover-semantic-links", "gc-run", "embedding-drain", "emotion-refine", "feedback-report", "proactive-check", "meta-reflect", "episodes-rebuild"] });
      }
      const internalRun = await jobs.run(subKey, commandCtx.agentId || "default", {
        trigger: cronInternal ? "cron" : "manual",
        signal: commandCtx.abortSignal,
        input: { commandCtx, memoryCtx, cronInternal, commandStore, id, tokens },
      });
      if (internalRun.outcome === "failed") throw internalRun.error;
      return internalRun.output;
    }
    if (actionKey === "start") {
      const openclawHome = host.stateDir;
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
      const openclawHome = host.stateDir;
      const openclawConfigPath = host.configPath();
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
      const openclawHome = host.stateDir;
      const openclawConfigPath = host.configPath();
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
      // The caller's AgentContext travels with the memory context, so the
      // engine's destructive-origin guard sees who really asked (E1-R12 M2).
      return runForgetCommand(commandCtx, memoryCtx, agentContext);
    }
    if (actionKey === "correct") {
      // The caller's AgentContext travels with the memory context, so the
      // engine's destructive-origin guard sees who really asked (E1-R12 M2).
      return runCorrectCommand(commandCtx, memoryCtx, agentContext);
    }
    if (actionKey === "critical") {
      return runCriticalCommand(commandCtx, memoryCtx);
    }
    return plur1busHelp("quick", resolveCommandLocale(commandCtx));
  };
}
