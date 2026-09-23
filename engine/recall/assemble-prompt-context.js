/**
 * engine/recall/assemble-prompt-context.js
 *
 * The per-turn recall assembly (was index.js:12261-13327): identity, Neo
 * window, embedding, merged namespace search, lanes, dedupe, and the six
 * named injection blocks under the global char cap. Host-neutral; everything
 * it needs arrives in the context object.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { throwIfAborted } from "../../lib/abort.js";
import { checkAccess } from "../../lib/acl-middleware.js";
import { filterAssociativeCandidates, filterPatternCandidates } from "../../lib/continuity-gate.js";
import { ContradictionDetector } from "../../lib/contradiction-detector.js";
import { runConversationReactivationRecall } from "../../lib/conversation-reactivation-recall.js";
import { inferEmotionalValenceAsync } from "../../lib/emotion.js";
import { extractMessageText, formatMoodFile } from "../../lib/emotional-state.js";
import { planGlobalInjectBudget } from "../../lib/inject-budget.js";
import { InterpretationOverlayStore } from "../../lib/interpretation-overlay.js";
import { renderSkillProposalNudge } from "../../lib/jobs/skill-miner/nudge-renderer.js";
import { getPendingProposals, lastPresentationAgeMs, recordPresentation } from "../../lib/jobs/skill-miner/proposal-writer.js";
import { withLlmCallContext } from "../../lib/llm-result-cache.js";
import { isLlmRouteAvailable } from "../../lib/llm-router.js";
import { createRetrievalLedgerEntry } from "../../lib/memory-dynamics.js";
import { resolveHostHookMemoryContext, resolveMemoryRequestContext } from "../../lib/memory-request-context.js";
import { buildMoodStyleDirective } from "../../lib/mood-style-directive.js";
import { dedupeNeoLanesAgainstTexts, formatNeoRecallContext, routeNeoRecall } from "../../lib/neo-arch.js";
import { OPEN_THREADS_SHOWN_FILE, collectOpenThreads, formatOpenThreadsContext, normalizeTopic } from "../../lib/open-threads.js";
import { OverlayGenerator } from "../../lib/overlay-generator.js";
import { findBestPattern } from "../../lib/pattern-surface.js";
import { addTraceDecision, addTraceStoreDecision, attachTraceToMemory, createRecallDecisionTrace } from "../../lib/recall-decision-trace.js";
import { createRecallPhaseTimer } from "../../lib/recall-phase-timer.js";
import { computeUseAssociative } from "../../lib/recall-pipeline.js";
import { formatRelevantMemoriesContext, resolveFadedThreshold } from "../../lib/relevant-memory-context.js";
import { formatReminderNudge } from "../../lib/reminder-nudge.js";
import { readPendingReminders, writePendingReminders } from "../../lib/reminder-pending.js";
import { listDueReminders, presentReminder } from "../../lib/reminder-store.js";
import { readReplyOutcomeLog, recordPendingReplyOutcome, sessionKeyFrom } from "../../lib/reply-outcome-tracking.js";
import { resolveCompactedAt } from "../checkpoint/checkpoint-store.js";
import { emitEngineEvent } from "../events.js";
import { ABORTED, contextBlock, recallResult } from "./recall-result.js";
import { isBackgroundTurn, shouldSkipAutoRecallForInternalTurn } from "../../lib/runtime-scheduler.js";
import { applySemanticLensToRecall } from "../../lib/semantic-lens-index.js";
import { formatTimeContext, getLastActivity, recordActivity } from "../../lib/session-time.js";
import { consumePlur1busStartNotice } from "../../lib/setup/feature-profiles.js";
import { withAccessReadDbs } from "../../lib/shared-memory.js";
import { formatTemporalContinuityContext } from "../../lib/temporal-context.js";
import { compressMemorySlotsForPrompt, generateSummary as libGenerateSummary } from "../../lib/text-utils.js";
import { hourInTimeZone } from "../../lib/time-window.js";

/**
 * Build the `before_prompt_build` recall handler from an already-resolved
 * engine context. Every binding the moved body closes over is destructured
 * once, here, at registration time.
 *
 * `ctx.recallTimingSink`, when provided, is called once per attempted recall
 * with `{ agentId, phases, totalMs }` after the scheduled recall settles —
 * `phases` is `phaseTimer.summary()` (`lib/recall-phase-timer.js`), `totalMs`
 * is `phaseTimer.elapsedMs()`. Purely additive/observational: it never
 * changes the returned `prependContext`, defaults to `null` (a no-op), and
 * production wiring (`index.js`) only ever passes a real function through a
 * test-only property nothing in production sets — see the fix-round note at
 * that call site.
 *
 * @param {Record<string, any>} ctx Engine context; see the destructuring below.
 * @returns {(event: Record<string, any>, hookCtx: Record<string, any>) => Promise<object>} A RecallResult (engine/recall/recall-result.js).
 */
export function createPromptContextAssembler(ctx) {
  const {
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
    checkpointStore = null,
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
    recallTimingSink = null,
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
  } = ctx;

  return async function assemblePromptContext(event, hookCtx, opts = {}) {
    const callerSignal = opts?.signal;
    if (!(callerSignal instanceof AbortSignal)) {
      const degraded = { reason: "invalid-query", capability: "recall", detail: "signal is required" };
      emitEngineEvent(host, "recall.degraded", { agentId: hookCtx?.agentId || "default", degraded });
      return recallResult({ degraded });
    }
    if (callerSignal.aborted) {
      emitEngineEvent(host, "recall.degraded", { agentId: hookCtx?.agentId || "default", degraded: ABORTED });
      return recallResult({ degraded: ABORTED });
    }
    // Blocks finished before the scheduled work completes. An aborted or
    // timed-out recall returns these (spec 3.2) instead of nothing.
    const completed = { neo: "", start: "" };
    const background = isBackgroundTurn(event, hookCtx);
    const skipInternalRecall = shouldSkipAutoRecallForInternalTurn(event, hookCtx);
    if (hookCtx?.workspaceDir && !automaticWorkspacePolicyDecision(event, hookCtx).allowed) return recallResult();
    const agentIdForCache = hookCtx?.agentId || "default";
    const sessionKeyForCache = hookCtx?.sessionKey || event?.sessionKey || event?.sessionId || event?.runId || "";
    const cacheKey = `${agentIdForCache}:${sessionKeyForCache}:${String(event?.prompt || "").slice(0, 500)}`;
    const phaseTimer = createRecallPhaseTimer({
      softBudgetMs,
      hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs,
      logger: host.logger,
    });
    const scheduledRecall = await runtimeScheduler.runRecall({
      background,
      cacheKey,
      priority: background ? "low" : "normal",
      phaseTimer,
      signal: callerSignal,
    }, async (signal, timer) => {
    throwIfAborted(signal, "recall aborted");
    // P0-1: Interne/background Turns bekommen keine volle Recall-Injektion.
    if (skipInternalRecall) {
      return runMinimalBeforePromptMaintenance(event, hookCtx, { neoEnabled, gcEnabled });
    }
    const routingCapability = await hostRoutingLoader();
    const turnRoutes = await getMemoryTurnRoutes();
    // 7.12.30: Phasenzeiten des Vorlaufs (Identitaet, Neo-Fenster, Embedding,
    // globale Suche, Lanes). Der Host bricht den Hook nach 15 s ab; am
    // 09./10.09.2026 passierte das dutzendfach, ohne dass eine Logzeile den
    // Verbleib der Zeit zeigte.
    const recallPrelude = { startedAt: Date.now(), identityMs: 0, hookRecordMs: 0, windowMs: 0, embedMs: 0, embedTimedOut: false, globalMs: 0, lanesMs: 0 };
    const memoryCtx = turnRoutes
      ? await resolveHostHookMemoryContext({
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
        })
      : resolveMemoryRequestContext({
          agentId: hookCtx?.agentId,
          workspaceDir: hookCtx?.workspaceDir,
          channel: hookCtx?.messageProvider,
          chatId: hookCtx?.chatId,
          sessionKey: hookCtx?.sessionKey ?? event?.sessionKey,
          sessionId: hookCtx?.sessionId ?? event?.sessionId,
        }, { workspaceAliases: memoryWorkspaceAliases });
    if (!workspacePolicyGuard.automatic(memoryCtx).allowed) return undefined;
    let neoContext = "";
    let neoLanes = null;
    let neoGlobalIds = null;
    let neoInjectionKey = null;
    if (neoEnabled) {
      // 7.12.27: Der Warm-up bei gateway_start erreicht nur die erste
      // Plugin-Instanz; Instanzen, die der Host spaeter je Agent anlegt,
      // trafen agent_end mit kaltem Worker (spawnMs 592 trotz Warm-up,
      // 10.09.2026 00:20). Der Recall laeuft vor agent_end — hier
      // anwerfen, ensureWorker ist idempotent.
      try { neoWorkerRuntime?.warmUp?.(); } catch (_) { /* best-effort */ }
      recallPrelude.identityMs = Date.now() - recallPrelude.startedAt;
      try {
        const injectionKey = markNeoRecallInjection(event, hookCtx);
        neoInjectionKey = injectionKey;
        const neoStore = getNeoStore(hookCtx, event);
        const requester = neoRequester(hookCtx, event);
        // 7.12.30: Hook-Zaehler ohne synchronen Lock (Atomics.wait bis 5 s
        // im Main-Thread); fire-and-forget, asynchron gewartet.
        const hookRecordStartedAt = Date.now();
        const hookMeta = {
          agentId: hookCtx?.agentId || "default",
          promptLength: event?.prompt?.length || 0,
          runner: event?.runner || event?.provider || "",
        };
        if (typeof neoStore.recordHookAsync === "function") {
          neoStore.recordHookAsync("before_prompt_build", hookMeta)
            .catch((hookErr) => host.logger.debug(`plur1bus-neo: before_prompt_build hook record skipped: ${String(hookErr?.message || hookErr)}`));
        } else {
          neoStore.recordHook("before_prompt_build", hookMeta);
        }
        recallPrelude.hookRecordMs = Date.now() - hookRecordStartedAt;
        if (injectionKey !== null && event?.prompt && event.prompt.length >= 5) {
          const windowStartedAt = Date.now();
          const neoItems = [...neoStore.readCandidates(500, requester), ...neoStore.readBehaviorCards(200, requester)];
          recallPrelude.windowMs = Date.now() - windowStartedAt;
          let queryVector = null;
          const embedStartedAt = Date.now();
          try {
            const embedPromise = Promise.resolve(typeof embeddings.embedQuery === "function" ? embeddings.embedQuery(event.prompt, { agentId: requester.requesterAgentId }) : embeddings.embed(event.prompt, { agentId: requester.requesterAgentId }));
            let embedTimer = null;
            const embedTimeout = new Promise((resolve) => { embedTimer = setTimeout(() => resolve(NEO_EMBED_TIMEOUT), neoGlobalRecall.embedTimeoutMs); });
            try {
              const outcome = await Promise.race([embedPromise, embedTimeout]);
              if (outcome === NEO_EMBED_TIMEOUT) {
                recallPrelude.embedTimedOut = true;
                embedPromise.catch(() => {});
                host.logger.warn(`plur1bus-neo: prompt query embedding exceeded ${neoGlobalRecall.embedTimeoutMs} ms, continuing without vector`);
              } else {
                queryVector = outcome;
              }
            } finally {
              if (embedTimer) clearTimeout(embedTimer);
            }
          } catch (error) { host.logger.debug(`plur1bus-neo: prompt query embedding unavailable: ${String(error)}`); }
          recallPrelude.embedMs = Date.now() - embedStartedAt;
          const globalStartedAt = Date.now();
          try {
            neoGlobalIds = runNeoGlobalSearch(neoStore, neoItems, queryVector, requester);
          } catch (globalErr) {
            host.logger.warn(`plur1bus-neo: global candidate search failed: ${String(globalErr)}`);
          }
          recallPrelude.globalMs = Date.now() - globalStartedAt;
          const lanesStartedAt = Date.now();
          neoLanes = routeNeoRecall(neoItems, event.prompt, { ...requester, queryVector, maxPerLane: 2, minScore: 0.08 });
          neoContext = formatNeoRecallContext(neoLanes, { idempotencyKey: injectionKey || undefined });
          recallPrelude.lanesMs = Date.now() - lanesStartedAt;
        }
      } catch (neoErr) {
        host.logger.warn(`plur1bus-neo: before_prompt_build recall failed: ${String(neoErr)}`);
      }
    }
    completed.neo = neoContext;
    {
      const preludeMs = Date.now() - recallPrelude.startedAt;
      const preludeLine = `plur1bus-neo: recall prelude total=${preludeMs}ms identity=${recallPrelude.identityMs}ms hookRecord=${recallPrelude.hookRecordMs}ms window=${recallPrelude.windowMs}ms embed=${recallPrelude.embedMs}ms${recallPrelude.embedTimedOut ? "(timeout)" : ""} global=${recallPrelude.globalMs}ms lanes=${recallPrelude.lanesMs}ms authenticated=${memoryCtx?.userPrincipal ? "yes" : "no"} agent=${hookCtx?.agentId || "default"}`;
      if (preludeMs >= NEO_RECALL_PRELUDE_LOG_MS) host.logger.info(preludeLine);
      else host.logger.debug(preludeLine);
    }
    if (!event.prompt || event.prompt.length < 5) return neoContext ? recallResult({ blocks: [contextBlock("neo", neoContext, true)] }) : undefined;
    // Skip heavy LanceDB recall for internal dreaming/sleep magic messages —
    // these cron turns don't need memory context and the recall would block
    // the event loop for each workspace, causing lane timeouts.
    if (
      event.prompt === "__openclaw_memory_core_short_term_promotion_dream__" ||
      event.prompt === "__openclaw_memory_core_light_sleep__" ||
      event.prompt === "__openclaw_memory_core_rem_sleep__"
    ) { return neoContext ? recallResult({ blocks: [contextBlock("neo", neoContext, true)] }) : undefined; }
    // consumePlur1busStartNotice deletes the one-time start notice as it reads
    // it, so this check must run immediately before that call: an already-
    // aborted job must degrade here, before it can consume (and thereby hide)
    // the notice a still-pending or future job would otherwise still show.
    throwIfAborted(signal, "recall aborted");
    const pendingStartNotice = consumePlur1busStartNotice(process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"));
    const startNoticeContext = pendingStartNotice
      ? `<plur1bus-start-notice>\n${pendingStartNotice}\n</plur1bus-start-notice>`
      : "";
    completed.start = startNoticeContext;
    const agentId = memoryCtx.agentId;
    return pool.withWriteDb(agentId, (db) => withAccessReadDbs(
      pool,
      sharedMemoryPool,
      agentId,
      { ...memoryCtx, logger: host.logger },
      async (readDbs) => {
    // GC: purge expired memories (non-blocking, throttled on hot path)
    if (gcEnabled) {
      pool.withWriteDb(agentId, (maintenanceDb) => maintenanceDb.purgeExpiredThrottled(host.logger))
        .catch((gcErr) => {
          host.logger.warn(`memory-lancedb-namespaced: GC purge before recall failed: ${String(gcErr)}`);
        });
    }
    try {
      await db.init();
      // Init additional read namespaces (skip write-db instance — already inited above)
      const initializedReadDbs = [];
      for (const entry of readDbs) {
        const initialized = entry.db === db ? true : await entry.db.init();
        if (initialized !== false && entry.db.table) initializedReadDbs.push(entry);
      }
      readDbs = initializedReadDbs;
      // v5.5.0 — Fast-Bernd IPC: merge pending voice turns + export state
      let voiceMessages = event.messages || [];
      if (hookCtx?.workspaceDir) {
        const pendingTurnsPath = join(hookCtx.workspaceDir, ".fast-bernd-pending-turns.jsonl");
        if (existsSync(pendingTurnsPath)) {
          try {
            const processingPath = join(hookCtx.workspaceDir, ".fast-bernd-pending-turns.processing.jsonl");
            renameSync(pendingTurnsPath, processingPath);
            const extraMessages = [];
            for (const line of readFileSync(processingPath, "utf8").trim().split("\n").filter(Boolean)) {
              try {
                const turn = JSON.parse(line);
                if (turn.user) extraMessages.push({ role: "user", content: turn.user });
                if (turn.assistant) extraMessages.push({ role: "assistant", content: turn.assistant });
              } catch (e) {
                dbg(e);
              }
            }
            unlinkSync(processingPath);
            if (extraMessages.length) voiceMessages = [...voiceMessages, ...extraMessages];
          } catch (e) {
            dbg(e);
          }
        }
      }
      const emoState = emotionalPool.get(agentId);
      // Restart-Persistenz: Zustand einmalig aus der Datei zurücklesen,
      // Decay rechnet ab persistiertem lastUpdateAt weiter.
      if (hookCtx?.workspaceDir) {
        try { emoState.hydrateOnce(join(hookCtx.workspaceDir, ".emotional-state.json")); } catch (e) { dbg(e); }
      }
      // Stimmung aus dem aktuellen Turn via EmotionEngine (T1→T2→T3)
      // statt der alten Regex-Heuristik ableiten.
      try {
        const promptText = typeof event.prompt === "string" ? event.prompt.trim() : "";
        const lastUserText = promptText
          || extractMessageText([...voiceMessages].reverse().find((m) => m && m.role === "user")).trim();
        if (lastUserText.length >= 3) {
          const turnEmotion = await inferEmotionalValenceAsync(lastUserText.slice(0, 2000), "user", null, { agentId, signal });
          throwIfAborted(signal, "recall aborted");
          emoState.applyEmotionScore(turnEmotion);
        } else {
          emoState.updateFromMessages(voiceMessages);
        }
      } catch (e) {
        throwIfAborted(signal, "recall aborted");
        dbg(e);
        emoState.updateFromMessages(voiceMessages);
      }
      if (hookCtx?.workspaceDir) {
        try {
          throwIfAborted(signal, "recall aborted");
          const moodNow = emoState.describeMood();
          throwIfAborted(signal, "recall aborted");
          writeFileSync(join(hookCtx.workspaceDir, ".emotional-state.json"), JSON.stringify({ ...moodNow, agentId, ts: Date.now(), state: emoState.serializeState() }));
          throwIfAborted(signal, "recall aborted");
          writeFileSync(join(hookCtx.workspaceDir, ".current-mood.txt"), formatMoodFile(moodNow, agentId));
        } catch (e) {
          throwIfAborted(signal, "recall aborted");
          dbg(e);
        }
      }
      // v5.4.0 — Graph-Edges für assoziativen Spread laden
      let graphEdges = [];
      try {
        const neoStore = getNeoStore(hookCtx, event);
        graphEdges = neoStore.readGraphEdges(5_000);
      } catch (_e) { dbg(_e); }
      // Inner Continuity Engine config (Phase 1)
      const continuityCfg = cfg.continuityEngine || {};
      const continuityEnabled = continuityCfg.enabled !== false;
      const assocCfg = continuityCfg.associativeRecall || {};
      const patternCfg = continuityCfg.patternSurfacing || {};
      const tasteCfg = continuityCfg.tasteGate || {};
      const overlayCfg = continuityCfg.overlays || {};
      const autoCreateOverlays = continuityEnabled && overlayCfg.autoCreateOnRecall === true;
      let overlayGenerator = null;
      let overlayStore = null;
      if (autoCreateOverlays
        && mergingEnabled
        && isLlmRouteAvailable(overlayLlmCfg)
        && hookCtx?.workspaceDir) {
        overlayStore = new InterpretationOverlayStore(hookCtx.workspaceDir);
        const overlayCallCfg = mergingEnabled ? withLlmCallContext(
          overlayLlmCfg,
          agentId,
          "continuity-overlay",
          { signal },
        ) : null;
        overlayGenerator = new OverlayGenerator({
          enabled: true,
          llm: overlayCallCfg ? (messages) => callLlm(messages, overlayCallCfg) : null,
          contradictionLlm: overlayCfg.autoResolveContradictions && overlayCallCfg
            ? async (messages) => callLlm(messages, overlayCallCfg)
            : null,
          autoResolveContradictions: overlayCfg.autoResolveContradictions ?? false,
          workspaceDir: hookCtx?.workspaceDir,
          confidenceThreshold: overlayCfg.confidenceThreshold ?? 0.7,
          maxPerSession: overlayCfg.maxPerSession ?? 3,
          provisionalByDefault: overlayCfg.provisionalByDefault ?? true,
          maxAgeDays: overlayCfg.maxAgeDays ?? 30,
          overlayStore,
          logger: host.logger,
        });
      }
      const useAssociative = computeUseAssociative(continuityEnabled, assocCfg);
      // P2 Recall Decision Trace
      let trace = traceEnabled
        ? createRecallDecisionTrace({
            query: event.prompt,
            mode: "auto-recall",
            maxTextPreviewChars: traceCfg.maxTextPreviewChars ?? 160,
            maxCandidates: traceCfg.maxCandidates ?? 50,
          })
        : null;
      // v1.9.0 — komplette Pipeline aus shared module
      const _autoRecallBaseParams = {
        query: event.prompt,
        phaseTimer: timer,
        softBudgetFallback,
        embeddings,
        signal,
        workspaceDir: hookCtx?.workspaceDir,
        topN: maxPromptMemories,
        budget: resolveRuntimeRecallBudget(event.prompt, maxPromptMemories, adaptiveBudgetCfg),
        adaptiveBudget: adaptiveBudgetCfg,
        recallMinScore: autoRecallMinScore,
        dedupEnabled,
        dedupJaccard,
        canonicalEnabled,
        canonicalMinScore,
        canonicalMaxItems,
        reranker,
        rerankCandidates,
        candidateTopK,
        rerankerTimeoutMs: rerankerCfg.timeoutMs ?? 5000,
        rerankerFallbackOnError: rerankerCfg.fallbackOnError !== false,
        summaryMaxWords,
        querySummarizer: makeQuerySummarizer(
          mergingEnabled ? recallQueryLlmCfg : null,
          host.logger,
          agentId,
          { agentId, signal },
        ),
        logger: host.logger,
        emotionalState: emotionalPool.get(agentId),
        graphEdges,
        associativeEnabled: useAssociative,
        graphConfig: useAssociative ? {
          maxDepth: assocCfg.maxDepth ?? 2,
          maxNeighborsPerNode: assocCfg.maxNeighborsPerNode ?? 8,
          maxAssociatedResults: assocCfg.maxAssociatedResults ?? 40,
          minCumulativeRelevance: assocCfg.minCumulativeRelevance ?? 0.2,
          graphHydrationRelevanceThreshold: assocCfg.graphHydrationRelevanceThreshold ?? 0.25,
          graphIndex: { enabled: assocCfg.graphIndex?.enabled !== false },
        } : {},
        workspaceKey: hookCtx?.workspaceKey || hookCtx?.workspaceDir || null,
        agentId,
        memoryCtx,
        queryRefinerEnabled,
        decisionTrace: trace,
        retrievalLogger: (ledgerInfo) => {
          try {
            const neoStore = getNeoStore(hookCtx, event);
            neoStore.appendRetrievalLedger([createRetrievalLedgerEntry({
              ...ledgerInfo,
              timestamp: Date.now(),
            })]);
          } catch (_e) { dbg(_e); }
        },
      };
      const { canonical: canonicalHits, memories: ordered, trace: pipelineTrace } = await runMergedNamespaceRecall(
        readDbs,
        _autoRecallBaseParams,
        trace,
        timer,
        {
          strictReadErrors: namespaceLayout.recallReadNamespaces.length > 1,
          // Fix round 2: only fold per-namespace fine-grained phases into the
          // outer timer when something will actually read them — otherwise
          // this stays exactly the pre-fix-round behaviour (one coarse
          // "namespace-recall" entry), including for the timeout-warning log
          // line at lib/runtime-scheduler.js:456-476, which reads this same
          // outer timer's summary().
          recordNamespacePhases: Boolean(recallTimingSink),
        },
      );
      trace = pipelineTrace || trace;

      host.logger.info?.(`memory-lancedb-namespaced: injecting ${ordered.length} memories + ${canonicalHits.length} canonical for agent=${agentId || "default"}${reranker ? " (reranked)" : ""}`);

      const items = [];
      for (const c of canonicalHits) {
        const head = c.heading.replace(/\s+/g, " ").slice(0, 80);
        const snippet = libGenerateSummary(c.text.replace(/^#+\s+.+\n/, "").trim(), 60);
        // Canonical-Sections haben kein eigenes createdAt — als Alter dient die
        // mtime von KNOWLEDGE.md. `authoritative` nimmt sie vom Operational-Guard
        // aus: kanonische Docs sind die Referenz, gegen die verifiziert wird.
        const item = {
          id: `canonical:${head}`,
          category: "canonical",
          source: "knowledge",
          display: `${head} — ${snippet}`,
          createdAt: c.mtimeMs ?? 0,
          authoritative: true,
        };
        if (traceEnabled) {
          attachTraceToMemory(item, { sourceStage: "canonical", score: c.score, reason: "canonical KNOWLEDGE.md hit" });
        }
        items.push(item);
      }
      for (const r of ordered) {
        const sourceStage = r.source === "graph" || r.source === "both" ? "graph" : "vector";
        const item = {
          id: r.entry.id,
          category: r.entry.category,
          source: r.entry.origin || "dm",
          display: r.entry.summary || libGenerateSummary(r.entry.text, summaryMaxWords),
          memoryStrength: r.entry.memoryStrength ?? 1.0,
          graphSource: r.source,
          depth: r.depth,
          relevanceScore: r.score,
          versionNumber: r.entry.versionNumber ?? 1,
          previousVersion: r.entry.previousVersion || "",
          supersededBy: r.entry.supersededBy || "",
          updateSource: r.entry.updateSource || "",
          updateEvidence: r.entry.updateEvidence || "",
          reconsolidationConfidence: r.entry.reconsolidationConfidence ?? 0.0,
          status: r.entry.status || "active",
          versionCreatedAt: r.entry.versionCreatedAt ?? r.entry.createdAt ?? 0,
          createdAt: r.entry.createdAt ?? 0,
          updatedAt: r.entry.updatedAt ?? undefined,
          lastRetrievedAt: r.entry.lastRetrievedAt ?? undefined,
          memoryClass: r.entry.memoryClass || "standard",
          validFrom: r.entry.validFrom ?? 0,
          validUntil: r.entry.validUntil ?? 0,
          epistemicStatus: r.entry.epistemicStatus,
        };
        if (traceEnabled) {
          attachTraceToMemory(item, {
            sourceStage,
            score: r.score,
            graphSource: r.source,
            reason: sourceStage === "graph" ? "associative graph" : "vector recall",
          });
        }
        items.push(item);
      }

      const semanticLensResult = (ordered.length === 0 && canonicalHits.length === 0)
        ? { lensMemories: [] }
        : await applySemanticLensToRecall(ordered, {
          semanticLens: semanticLensCfg,
          workspaceDir: hookCtx?.workspaceDir,
          getMemoryById: async (memoryId) => db.getById(memoryId),
        });
      const semanticLensItems = semanticLensResult.lensMemories.map((r) => ({
        id: r.entry.id,
        category: r.entry.category,
        source: "semantic-lens",
        display: r.entry.summary || libGenerateSummary(r.entry.text || "", summaryMaxWords),
        memoryClass: r.entry.memoryClass || "standard",
        memoryStrength: r.entry.memoryStrength ?? 1.0,
        relevanceScore: r.score,
        versionNumber: r.entry.versionNumber ?? 1,
        supersededBy: r.entry.supersededBy || "",
        updateSource: r.entry.updateSource || "",
        status: r.entry.status || "active",
        versionCreatedAt: r.entry.versionCreatedAt ?? r.entry.createdAt ?? 0,
        // Ohne diese drei Felder rendert jeder Lens-Treffer age="unknown",
        // obwohl r.entry die Zeitstempel trägt (siehe Vektor-Mapping oben).
        createdAt: r.entry.createdAt ?? 0,
        updatedAt: r.entry.updatedAt ?? undefined,
        lastRetrievedAt: r.entry.lastRetrievedAt ?? undefined,
        validFrom: r.entry.validFrom ?? 0,
        validUntil: r.entry.validUntil ?? 0,
        epistemicStatus: r.entry.epistemicStatus,
      }));
      if (semanticLensItems.length > 0) {
        host.logger.info?.(`memory-lancedb-namespaced: semantic lens added ${semanticLensItems.length} memories for agent=${agentId || "default"}`);
      }

      // Inner Continuity Engine: taste gate + pattern surfacing
      let associativeItems = items;
      let matchedPattern = null;
      const sessionState = {}; // per-recall session state
      const tasteEnabled = tasteCfg.enabled !== false;
      if (continuityEnabled) {
        if (tasteEnabled) {
          associativeItems = filterAssociativeCandidates(items, {
            maxAssociations: tasteCfg.maxAssociationsPerSession ?? 1,
            assocThreshold: assocCfg.assocThreshold ?? 0.75,
            sessionState,
            decisionTrace: traceEnabled ? trace : null,
          });
        }

        if (patternCfg.enabled !== false) {
          try {
            const patternRecords = getNeoStore(hookCtx, event).readPatterns(100);
            matchedPattern = await findBestPattern({
              recentMemoryIds: ordered.map(r => r.entry.id),
              threshold: patternCfg.patternThreshold ?? 0.7,
              patternRecords: Array.isArray(patternRecords) ? patternRecords : [],
            });
            if (tasteEnabled) {
              const emotionalState = emotionalPool.get(agentId);
              const currentRegister = emotionalState?.describeMood?.().dominant || null;
              matchedPattern = filterPatternCandidates(matchedPattern, {
                maxPatterns: patternCfg.maxPerSession ?? tasteCfg.maxPatternsPerSession ?? 1,
                currentRegister,
                sessionState,
                decisionTrace: traceEnabled ? trace : null,
              });
            }
          } catch (e) {
            host.logger.warn?.(`continuity-engine: pattern surfacing failed: ${String(e)}`);
            matchedPattern = null;
          }
        }
      }

      // Inner Continuity Engine: interpretation overlays
      let overlays = [];
      if (continuityEnabled && overlayCfg.enabled !== false && hookCtx?.workspaceDir) {
        const targetIds = associativeItems.map((item) => item.id);
        try {
          if (!overlayStore) {
            overlayStore = new InterpretationOverlayStore(hookCtx.workspaceDir);
          }
          overlays = await overlayStore.loadForTargets(targetIds, overlayCfg.maxAgeDays ?? 30);
        } catch (e) {
          host.logger.warn?.(`continuity-engine: overlay load failed: ${String(e)}`);
        }
        // Enrich loaded overlays with contradiction flags from persisted records.
        try {
          const detector = new ContradictionDetector({ workspaceDir: hookCtx.workspaceDir });
          const allActive = await overlayStore.loadAllOverlays(targetIds, {
            includeProvisional: false,
            includeSuperseded: false,
            includeDisabled: false,
            maxAgeDays: overlayCfg.maxAgeDays ?? 30,
          });
          const activeIds = new Set(allActive.map((o) => o.id));
          await detector.flagContradictoryOverlays(overlays, activeIds);
          if (traceEnabled && trace) {
            for (const ov of overlays) {
              if (ov.contradiction) {
                addTraceDecision(trace, {
                  memoryId: ov.targetMemoryId || ov.id,
                  action: "rejection",
                  stage: "overlay-contradiction",
                  reason: "contradiction_detected",
                });
              }
            }
          }
        } catch (e) {
          host.logger.warn?.(`continuity-engine: contradiction enrichment failed: ${String(e)}`);
        }
        if (autoCreateOverlays && overlayGenerator && overlayStore) {
          const emotionalState = emotionalPool.get(agentId);
          const currentRegister = emotionalState?.describeMood?.().dominant || null;
          const overlaySessionState = sessionState && typeof sessionState === "object" ? sessionState : {};
          for (const item of associativeItems) {
            if (!item.id || String(item.id).startsWith("canonical:")) continue;
            const memory = ordered.find(r => r.entry.id === item.id)?.entry;
            if (!memory) continue;
            try {
              const newOverlay = await overlayGenerator.generate({
                memory,
                relevanceScore: item.relevanceScore ?? 0,
                currentRegister,
                conversationContext: event.prompt,
                triggerMemoryIds: [item.id],
                sessionState: overlaySessionState,
                signal,
              });
              throwIfAborted(signal, "recall aborted");
              if (newOverlay) {
                throwIfAborted(signal, "recall aborted");
                const written = await overlayStore.append(newOverlay, 7, { signal });
                throwIfAborted(signal, "recall aborted");
                if (written && newOverlay.autoContradiction) {
                  try {
                    const detector = new ContradictionDetector({ workspaceDir: hookCtx?.workspaceDir });
                    throwIfAborted(signal, "recall aborted");
                    await detector.persistContradiction(newOverlay.autoContradiction, { signal });
                    throwIfAborted(signal, "recall aborted");
                  } catch (e) {
                    throwIfAborted(signal, "recall aborted");
                    host.logger.warn?.(`continuity-engine: contradiction audit append failed: ${String(e)}`);
                  }
                }
                if (written) overlays.push(newOverlay);
              }
            } catch (e) {
              throwIfAborted(signal, "recall aborted");
              host.logger.warn?.(`continuity-engine: overlay generation failed: ${String(e)}`);
            }
          }
        }
      }

      // K1-06: detect contradictory factual memories among recalled items.
      let memoryTextContradictions = [];
      const contraCfg = cfg?.continuityEngine?.contradictionDetection || {};
      if (contraCfg.enabled !== false && hookCtx?.workspaceDir) {
        try {
          const memoryContradictionCallCfg = mergingEnabled ? withLlmCallContext(
            memoryTextContradictionLlmCfg,
            agentId,
            "memory-text-contradiction",
            { signal },
          ) : null;
          const llm = memoryContradictionCallCfg
            ? (messages) => callLlm(messages, memoryContradictionCallCfg)
            : null;
          const detector = new ContradictionDetector({
            llm,
            workspaceDir: hookCtx.workspaceDir,
            logger: host.logger,
          });
          memoryTextContradictions = await detector.findMemoryTextContradictions(associativeItems, {
            maxPairs: contraCfg.maxPairsPerRecall ?? 20,
            signal,
          });
          throwIfAborted(signal, "recall aborted");
        } catch (e) {
          throwIfAborted(signal, "recall aborted");
          host.logger.warn(`continuity-engine: memory-text contradiction detection failed: ${String(e)}`);
        }
      }
      const contradictionPairs = [];
      if (memoryTextContradictions.length > 0) {
        const { resolveContradictionWinner } = await import("../../lib/memory-text-contradiction.js");
        const byId = new Map(associativeItems.map((m) => [m.id, m]));
        for (const rec of memoryTextContradictions) {
          const a = byId.get(rec.memoryA);
          const b = byId.get(rec.memoryB);
          if (!a || !b) continue;
          const winner = resolveContradictionWinner(a, b);
          const loser = winner.id === a.id ? b : a;
          contradictionPairs.push({ winner, loser });
          if (traceEnabled && trace) {
            addTraceStoreDecision(trace, {
              action: "superseded",
              memoryId: loser.id,
              relatedMemoryId: winner.id,
              reason: "memory-text contradiction winner",
              score: null,
            });
          }
          if (!loser.supersededBy) {
            loser.supersededBy = winner.id;
            loser.status = "superseded-in-context";
          }
        }
        try {
          const detector = new ContradictionDetector({ workspaceDir: hookCtx.workspaceDir, logger: host.logger });
          for (const rec of memoryTextContradictions) {
            throwIfAborted(signal, "recall aborted");
            await detector.persistContradiction({
              targetMemoryId: rec.memoryA,
              overlayA: rec.memoryA,
              overlayB: rec.memoryB,
              descriptionA: rec.descriptionA,
              descriptionB: rec.descriptionB,
            }, { signal });
            throwIfAborted(signal, "recall aborted");
            await detector.persistContradiction({
              targetMemoryId: rec.memoryB,
              overlayA: rec.memoryA,
              overlayB: rec.memoryB,
              descriptionA: rec.descriptionA,
              descriptionB: rec.descriptionB,
            }, { signal });
            throwIfAborted(signal, "recall aborted");
          }
        } catch (e) {
          throwIfAborted(signal, "recall aborted");
          host.logger.warn(`continuity-engine: failed to persist memory-text contradictions: ${String(e)}`);
        }
      }

      let contradictionDisclosureContext = null;
      try {
        const { formatContradictionDisclosure } = await import("../../lib/contradiction-disclosure.js");
        const cdEnabled = cfg.contradictionDisclosure?.enabled !== false;
        contradictionDisclosureContext = formatContradictionDisclosure(contradictionPairs, { enabled: cdEnabled });
      } catch (_) { /* fail-open */ }

      let reactivationContext = "";
      let reactivationAdditions = [];
      const crrCfg = cfg.conversationReactivationRecall || {};
      if (crrCfg.enabled !== false) {
        try {
          const baseRecallIds = new Set(associativeItems.map(i => i.id));
          const baseRecallTopScore = associativeItems[0]?.relevanceScore
            ?? ordered[0]?.score
            ?? 0;
          const neoStore = getNeoStore(hookCtx, event);
          const crrResult = await Promise.race([
            runConversationReactivationRecall({
              prompt: event.prompt,
              messageText: event.prompt,
              baseRecallIds,
              baseRecallTopScore,
              workspaceDir: hookCtx?.workspaceDir,
              neoStore,
              graphEdges,
              cfg: crrCfg,
              agentId,
              sessionKey: hookCtx?.sessionKey || event?.sessionKey || event?.sessionId || event?.runId || "",
              now: Date.now(),
              logger: host.logger,
              compactedAt: resolveCompactedAt({ event, hookCtx, store: checkpointStore, agentId }),
              requestContext: memoryCtx,
              getMemoryById: async (memoryId) => {
                const memory = await db.getById(memoryId);
                if (!memory || !checkAccess(memoryCtx, memory).allowed) return null;
                return memory;
              },
              decisionTrace: traceEnabled ? trace : null,
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("crr_timeout")), crrCfg.timeoutMs ?? 50)
            ),
          ]);
          reactivationContext = crrResult?.context || "";
          reactivationAdditions = crrResult?.additions || [];
          if (traceEnabled && crrResult?.trace) {
            trace = crrResult.trace;
          }
        } catch (crrErr) {
          host.logger.warn?.(`conversation-reactivation-recall: ${crrErr.message}`);
        }
      }

      const recallCfg = cfg.recall || {};
      const nowMs = Date.now();

      // Reply-based Outcome Tracking: merke die tatsächlich injizierten Memory-IDs,
      // damit die nächste User-Antwort als Feedback dafür gewertet werden kann.
      if (replyOutcomeEnabled && hookCtx?.workspaceDir && event?.prompt && !skipInternalRecall) {
        try {
          recordPendingReplyOutcome(hookCtx.workspaceDir, {
            agentId,
            sessionKey: sessionKeyFrom(event, hookCtx),
            workspaceKey: hookCtx?.workspaceKey || hookCtx?.workspaceDir || null,
            userPrompt: event.prompt,
            memoryIds: [
              ...associativeItems.map((i) => i.id),
              ...semanticLensItems.map((i) => i.id),
            ],
            now: nowMs,
            maxMemoryIds: replyOutcomeMaxMemoryIds,
            maxAssistantChars: replyOutcomeMaxAssistantChars,
          });
        } catch (err) {
          host.logger.warn(`reply-outcome-tracking: recording pending outcome failed: ${String(err)}`);
        }
      }

      if (traceEnabled && trace) {
        try {
          const { enrichTraceWithTemporalProvenance } = await import("../../lib/temporal-provenance.js");
          enrichTraceWithTemporalProvenance(trace, associativeItems, { now: nowMs });
        } catch (e) {
          host.logger.warn(`temporal-provenance: trace enrichment failed: ${String(e)}`);
        }
      }

      // cfg.recallHedging is passed through as opts to frameRecallConfidence:
      // minItems, bottomFraction, maxHedged, and minSpread (default 0.1 —
      // minimum top/cut score gap required before anything is hedged, to
      // avoid phantom-hedging tightly-clustered strong scores).
      let framedItems = associativeItems;
      try {
        if ((cfg.recallHedging?.enabled ?? true) !== false) {
          const { frameRecallConfidence } = await import("../../lib/recall-confidence-framing.js");
          framedItems = frameRecallConfidence(associativeItems, cfg.recallHedging || {}).items;
        }
      } catch (_) { framedItems = associativeItems; }

      let promptItems = framedItems;
      let promptSemanticLensItems = semanticLensItems;
      if (semanticCompressionCfg.enabled !== false) {
        const allPromptItems = [...framedItems, ...semanticLensItems];
        const tokenBudget = normalizeBoundedRecallInteger(
          semanticCompressionCfg.tokenBudget,
          240,
          1,
          1000,
        );
        const compressedSlots = compressMemorySlotsForPrompt(
          allPromptItems.map((item) => ({
            entry: {
              id: item.id,
              text: item.display || "",
              summary: item.display || "",
              category: item.category,
              memoryClass: item.memoryClass,
            },
          })),
          tokenBudget,
        );
        promptItems = allPromptItems.flatMap((item, index) => (
          compressedSlots[index] ? [{ ...item, display: compressedSlots[index] }] : []
        ));
        promptSemanticLensItems = [];
      }
      const memoryDeferrals = [];
      const memoriesContext = formatRelevantMemoriesContext(promptItems, {
        fadedThreshold: resolveFadedThreshold(recallCfg),
        // Inner cap on the <relevant-memories> block itself, independent of
        // (and hit first by) recall.globalInjectMaxChars — see
        // docs/configuration.md "Recall-Pipeline" for how the two relate.
        maxTotalChars: recallCfg.memoriesMaxChars ?? 12_000,
        overlays,
        matchedPattern,
        semanticLensMemories: promptSemanticLensItems,
        decisionTrace: traceEnabled ? trace : null,
        traceOptions: {
          includeInPrompt: traceInPrompt,
          maxTextPreviewChars: traceCfg.maxTextPreviewChars ?? 160,
        },
        now: nowMs,
        onTruncate: ({ from, to }) => {
          memoryDeferrals.push({ block: "memories", kind: "clipped", from, to, reason: "memories-cap" });
        },
      });
      let personaDirective = null;
      let personaEmojiPalette = null;
      if (hookCtx?.workspaceDir && (cfg.personaVoice?.enabled ?? true) !== false) {
        try {
          const { scheduleEnsurePersonaVoiceSeed, loadPersonaDirective, loadPersonaEmojiPalette } = await import("../../lib/persona-voice.js");
          // Fire-and-forget: seed generation calls an LLM (default 30s
          // timeout) and must never block prompt assembly, which runs
          // under the much shorter recallTimeoutMs. Throttled internally
          // (in-flight guard + 6h backoff after a failed attempt).
          scheduleEnsurePersonaVoiceSeed({
            workspaceDir: hookCtx.workspaceDir,
            agentId,
            lang: cfg.language || "de",
            llmCfg: (skillMinerEnabled || mergingEnabled) ? withLlmCallContext(
              personaVoiceLlmCfg,
              agentId,
              "persona-voice",
              { signal },
            ) : null,
            callLlm,
            signal,
          })?.catch((err) => {
            host.logger.debug(`persona-voice: scheduled seed failed (fail-open): ${normalizedLlmErrorClass(err)}`);
          });
          personaDirective = loadPersonaDirective(hookCtx.workspaceDir, { maxChars: personaDirectiveMaxChars });
          personaEmojiPalette = loadPersonaEmojiPalette(hookCtx.workspaceDir);
        } catch (err) {
          host.logger.debug(`persona-voice: scheduled seed setup failed (fail-open): ${normalizedLlmErrorClass(err)}`);
        }
      }

      const styleCfg = cfg.styleDirective || {};
      const moodStyleDirective = buildMoodStyleDirective(emotionalPool.describe(agentId), {
        hour: styleCfg.timeOfDay !== false ? hourInTimeZone(nowMs, styleCfg.timezone ?? cfg.timezone ?? null) : null,
        temperamentName: cfg.emotion?.temperaments?.[agentId]?.preset ?? null,
        opinion: styleCfg.opinion !== false,
        askBack: styleCfg.askBack !== false,
      });

      // Open-threads injection: load reply-outcome log fail-open, derive context once per day.
      let openThreadsContext = null;
      if (hookCtx?.workspaceDir) {
        try {
          const resolvedWorkspaceDir = resolve(hookCtx.workspaceDir);
          const outcomesPath = join(resolvedWorkspaceDir, ".adaptive-learning", "reply-outcomes.jsonl");
          const cooldownPath = join(resolvedWorkspaceDir, OPEN_THREADS_SHOWN_FILE);
          if (!outcomesPath.startsWith(resolvedWorkspaceDir + "/") || !cooldownPath.startsWith(resolvedWorkspaceDir + "/")) throw new Error("open-threads: path escapes workspaceDir");
          const todayUtc = new Date(nowMs).toISOString().slice(0, 10);
          let cooldownOk = true;
          try {
            const cd = JSON.parse(readFileSync(cooldownPath, "utf8"));
            if (cd?.date === todayUtc) cooldownOk = false;
          } catch { /* file missing or unreadable → treat as fresh */ }
          if (cooldownOk) {
            let rawEntries = [];
            try {
              rawEntries = readReplyOutcomeLog(resolvedWorkspaceDir, {
                maxBytes: MAX_PROMPT_REPLY_OUTCOME_READ_BYTES,
              });
              // reply-outcomes.jsonl has no "topic" field — derive one from userPrompt
              // Collapse whitespace BEFORE slicing so the stored dedup topics
              // normalize identically to the afterthought reader (which slices
              // AFTER collapsing) — see normalizeTopic in lib/open-threads.js.
              rawEntries = rawEntries.map((e) => e.topic ? e : { ...e, topic: typeof e.userPrompt === "string" ? e.userPrompt.replace(/\s+/g, " ").trim().slice(0, 80) : null });
            } catch { /* file missing → empty */ }
            const threads = collectOpenThreads(rawEntries, { now: nowMs });
            openThreadsContext = formatOpenThreadsContext(threads);
            const normalizedTopics = (threads || []).map((t) => normalizeTopic(t.topic)).filter(Boolean);
            if (openThreadsContext && normalizedTopics.length > 0) {
              try { writeFileSync(cooldownPath, JSON.stringify({ date: todayUtc, topics: normalizedTopics }), "utf8"); } catch { /* non-blocking */ }
            }
          }
        } catch { /* fail-open */ }
      }

      // Dream-Echo injection (Humanization F1): 1x/Tag, Governor-gebremst.
      let dreamEchoContext = null;
      if (hookCtx?.workspaceDir && (cfg.dreamEcho?.enabled ?? true) !== false) {
        try {
          const echoCooldownPath = join(resolve(hookCtx.workspaceDir), ".dream-echo-shown.json");
          let echoCooldownOk = true;
          try {
            const cd = JSON.parse(readFileSync(echoCooldownPath, "utf8"));
            if (cd?.date === new Date(nowMs).toISOString().slice(0, 10)) echoCooldownOk = false;
          } catch { /* fresh */ }
          if (echoCooldownOk) {
            const { loadFreshDreamEcho, formatDreamEchoContext } = await import("../../lib/dream-echo.js");
            const { loadGovernorState, saveGovernorState, applyOutcomeAdjustments, evaluateGovernor, recordProactiveSend, withGovernorLock } = await import("../../lib/proactive-governor.js");
            let echoRequestContext = null;
            try {
              echoRequestContext = resolveMemoryRequestContext({
                agentId: hookCtx?.agentId || "default",
                workspaceDir: hookCtx.workspaceDir,
                userId: hookCtx?.userId ?? hookCtx?.senderId,
                channel: hookCtx?.channel ?? hookCtx?.messageProvider,
                accountId: hookCtx?.accountId ?? hookCtx?.channelContext?.accountId,
                chatId: hookCtx?.chatId,
              }, { workspaceAliases: memoryWorkspaceAliases });
            } catch (err) {
              host.logger.debug(`plur1bus dream echo context unavailable: ${err?.message || "invalid context"}`);
            }
            const echo = loadFreshDreamEcho(hookCtx.workspaceDir, { now: nowMs, requestContext: echoRequestContext });
            if (echo) {
              // Advisory cross-process lock (closes the lost-update window
              // with lib/afterthought.js's runAfterthoughtJob, which may run
              // as a separate cron process). Skip-on-contention: this block
              // is synchronous between load and save, so contention is only
              // cross-process — on failure just leave dreamEchoContext null
              // and don't stamp the cooldown, budget stays untouched.
              await withGovernorLock(hookCtx.workspaceDir, async () => {
                let gov = loadGovernorState(hookCtx.workspaceDir);
                gov = applyOutcomeAdjustments(
                  gov,
                  readReplyOutcomeLog(hookCtx.workspaceDir, 100, { maxBytes: MAX_PROMPT_REPLY_OUTCOME_READ_BYTES }),
                  { now: nowMs },
                );
                if (evaluateGovernor(gov, nowMs).allowed) {
                  dreamEchoContext = formatDreamEchoContext(echo);
                  if (dreamEchoContext) gov = recordProactiveSend(gov, "dream-echo", nowMs);
                }
                saveGovernorState(hookCtx.workspaceDir, gov);
                // Only burn the daily stamp when injection actually happened —
                // if the governor blocked it, budget may free up later today,
                // so the day must not be marked as "shown" already.
                if (dreamEchoContext) {
                  try { writeFileSync(echoCooldownPath, JSON.stringify({ date: new Date(nowMs).toISOString().slice(0, 10) }), "utf8"); } catch { }
                }
              }, { now: nowMs });
            }
          }
        } catch (_) { /* fail-open */ }
      }

      // Reaction-nudge directive (Humanization F6): only when the gateway
      // exposes react-capability (auto-detected, cached) or is force-enabled.
      let reactionDirective = null;
      try {
        const rnCfg = cfg.reactionNudge || {};
        const mode = rnCfg.enabled ?? "auto";
        if (mode === true || (mode === "auto" && await detectReactionsCapabilityCached())) {
          const { buildReactionDirective } = await import("../../lib/reaction-directive.js");
          reactionDirective = buildReactionDirective({
            palette: rnCfg.palette || null,
            personaPalette: personaEmojiPalette,
          });
        }
      } catch (_) { /* fail-open */ }

      const fullMemoriesContext = [personaDirective, moodStyleDirective, reactionDirective, dreamEchoContext, openThreadsContext, contradictionDisclosureContext, memoriesContext, reactivationContext].filter(Boolean).join("\n\n");

      // Knowledge-update + conflict-review nudges (shared, localized helper;
      // conflict-log is read only once). #9 dedup + #11 i18n.
      const { lang, tone } = resolveCommandLocaleRecall({ messages: event?.messages || [] });
      const { knowledgeNudge: nudge, conflictNudge } = buildMaintenanceNudges({
        workspaceDir: hookCtx?.workspaceDir,
        schicht15Enabled,
        lang,
        tone,
        logger: host.logger,
      });

      // Skill-proposal nudge: weekly proactive presentation of new skill proposals
      let skillProposalNudge = "";
      // 7.12.48: Ledger je ACL-Partition (bis 7.12.47 wurde der Workspace
      // gelesen, wo nie ein Vorschlag lag).
      const skillNudgeLedgerDir = hookCtx?.workspaceDir
        ? [skillLedgerDirForAgent(agentId), hookCtx.workspaceDir].find((dir) => {
          if (!dir) return false;
          try { return getPendingProposals(dir).length > 0; } catch { return false; }
        }) || null
        : null;
      if (skillNudgeLedgerDir) {
        try {
          const pending = getPendingProposals(skillNudgeLedgerDir);
          if (pending.length > 0 && lastPresentationAgeMs(skillNudgeLedgerDir) > 6 * 86400000) {
            const proposal = pending[0];
            const nudgeText = renderSkillProposalNudge(proposal, pending.length, {
              workspaceDir: hookCtx.workspaceDir,
              messages: event?.messages || [],
            });
            skillProposalNudge = `\n<skill-proposal-reminder>\n${nudgeText}\n</skill-proposal-reminder>`;
            recordPresentation(skillNudgeLedgerDir, pending.map(p => p.id));
          }
        } catch (_e) { dbg(_e); }
      }
      // --- Time Context & Reminder Nudge Injection ---
      let timeContext = "";
      let temporalContinuityContext = "";
      let reminderNudge = "";
      try {
        // lang/tone bereits oben via resolveCommandLocale aufgelöst.
        const wsKey = hookCtx?.workspaceDir || "default";
        // Capture previous activity before recording the current turn
        const previousUserTurnAt = await getLastActivity(agentId, wsKey, hookCtx?.workspaceDir);
        // Inject time context BEFORE recording activity
        timeContext = await formatTimeContext(agentId, wsKey, hookCtx?.workspaceDir, lang);
        if (temporalContextEnabled) {
          temporalContinuityContext = await formatTemporalContinuityContext(
            agentId,
            wsKey,
            hookCtx?.workspaceDir,
            { enabled: true, lang, now: Date.now(), previousUserTurnAt }
          );
        }
        await recordActivity(agentId, wsKey, hookCtx?.workspaceDir);
        // Check DB for due reminders
        const dueFromDb = await listDueReminders(db, agentId, wsKey);
        // Check pending file
        const pendingData = await readPendingReminders(hookCtx?.workspaceDir, wsKey, agentId);
        const dueFromPending = Object.values(pendingData.pending || {});
        // Dedupe by id
        const byId = new Map();
        for (const r of [...dueFromDb, ...dueFromPending]) {
          byId.set(r.id || r.reminderKey, r);
        }
        const allDue = [...byId.values()];
        if (allDue.length > 0) {
          reminderNudge = formatReminderNudge(allDue, { lang, tone });
          for (const r of dueFromDb) {
            await presentReminder(db, r.id).catch((err) => {
              host.logger.warn?.(`plur1bus-reminder: present failed for ${r.id}: ${String(err)}`);
            });
          }
          // Batch remove all from pending file in one write
          if (dueFromPending.length > 0) {
            for (const r of allDue) {
              delete pendingData.pending[r.id || r.reminderKey];
            }
            await writePendingReminders(hookCtx?.workspaceDir, wsKey, agentId, pendingData);
          }
        }
      } catch (reminderErr) {
        host.logger.warn(`plur1bus-reminder: nudge injection failed: ${String(reminderErr)}`);
      }
      throwIfAborted(signal, "recall aborted");
      // 7.12.27: Globale Neo-Treffer, die als LanceDB-Erinnerung schon im
      // selben Prompt stehen, nicht doppelt injizieren.
      if (neoLanes && neoGlobalIds?.size > 0 && Array.isArray(ordered) && ordered.length > 0) {
        try {
          const memoryTexts = ordered.map((row) => row?.entry?.text || row?.text || "").filter(Boolean);
          const deduped = dedupeNeoLanesAgainstTexts(neoLanes, memoryTexts, { onlyIds: neoGlobalIds, threshold: neoGlobalRecall.dedupeThreshold });
          if (deduped.dropped > 0) {
            neoContext = formatNeoRecallContext(deduped.lanes, { idempotencyKey: neoInjectionKey || undefined });
            host.logger.info(`plur1bus-neo: global candidate search dropped ${deduped.dropped} hit(s) already injected as memories`);
          }
        } catch (dedupeErr) {
          host.logger.debug(`plur1bus-neo: global dedupe skipped: ${String(dedupeErr)}`);
        }
      }
      const blocks = [
        contextBlock("neo", neoContext, true),
        contextBlock("start", startNoticeContext, true),
        contextBlock("memories", fullMemoriesContext + nudge + conflictNudge + skillProposalNudge, true),
        contextBlock("time", timeContext, false),
        contextBlock("temporal", temporalContinuityContext, false),
        contextBlock("reminder", reminderNudge, false),
      ];
      const capChars = cfg.recall?.globalInjectMaxChars ?? 17_000;
      const deferrals = [...memoryDeferrals, ...planGlobalInjectBudget({ blocks, maxChars: capChars }).deferrals];
      for (const deferral of deferrals) {
        emitEngineEvent(host, `recall.block-${deferral.kind}`, { agentId, ...deferral });
      }
      return recallResult({ blocks, capChars, deferrals });
    } catch (err) {
      throwIfAborted(signal, "recall aborted");
      host.logger.warn(`memory-lancedb-namespaced: recall failed for agent=${agentId}: ${String(err)}`);
      const fallbackBlocks = [contextBlock("neo", neoContext, true), contextBlock("start", startNoticeContext, true)]
        .filter((block) => block.text);
      if (fallbackBlocks.length > 0) return recallResult({ blocks: fallbackBlocks });
    }
    }));
    });
    // Task 19 fix round: additive, observational only — never changes what
    // is returned below. `phaseTimer` (created above, same object as the
    // `timer` the callback closed over) is fully populated by now, whether
    // the callback returned normally, hit the soft-budget fallback, timed
    // out, or threw and was caught as `scheduledRecall.error`. Fix round 3:
    // a caller-supplied sink is untrusted code from this function's point of
    // view (AGENTS.md: no silent catches), so a throwing sink is caught and
    // logged rather than breaking the turn's actual reply.
    try {
      recallTimingSink?.({ agentId: hookCtx?.agentId, phases: phaseTimer.summary(), totalMs: phaseTimer.elapsedMs() });
    } catch (sinkErr) {
      dbg(sinkErr);
    }
    // 7.12.30: Der Recall des Turns ist durch; jetzt darf die verschobene
    // Reply-Outcome-Dynamik die Tabelle anfassen.
    if (replyOutcomeEnabled) replyOutcomeDynamics.kick(agentIdForCache);
    const partial = () => [contextBlock("neo", completed.neo, true), contextBlock("start", completed.start, true)]
      .filter((block) => block.text);
    if (scheduledRecall.ok) {
      if (scheduledRecall.timedOut && scheduledRecall.fromCache) {
        host.logger.warn(`memory-lancedb-namespaced: using cached recall after timeout for agent=${agentIdForCache}${background ? " (background)" : ""}`);
      }
      return scheduledRecall.value ?? recallResult();
    }
    if (scheduledRecall.aborted || scheduledRecall.timedOut) {
      const degraded = scheduledRecall.aborted ? ABORTED : { reason: "timeout", capability: "recall" };
      const reasonLabel = scheduledRecall.aborted ? "aborted" : "timed out";
      host.logger.warn(`memory-lancedb-namespaced: recall ${reasonLabel} without cache for agent=${agentIdForCache}${background ? " (background)" : ""}`);
      emitEngineEvent(host, "recall.degraded", { agentId: agentIdForCache, degraded });
      return recallResult({ blocks: partial(), degraded });
    }
    if (scheduledRecall.error) {
      host.logger.warn(`memory-lancedb-namespaced: recall scheduler failed for agent=${agentIdForCache}: ${String(scheduledRecall.error)}`);
    }
    return recallResult();
  };
}
