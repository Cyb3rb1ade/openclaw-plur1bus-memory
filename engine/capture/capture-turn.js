/**
 * engine/capture/capture-turn.js
 *
 * The per-turn auto-capture pipeline (was index.js:10357-11305): fail-closed
 * incognito classification, workspace-policy gate, NEO turn write, chunking,
 * embedding, dedupe, durable store, graph/episode/dream post-processing,
 * meta-reflection and reminder extraction. Host-neutral; everything it needs
 * arrives in the context object.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveBudgetedSignal, isAbortError, isBudgetExhaustion, throwIfAborted } from "../../lib/abort.js";
import { categorizeMemoryWithReason } from "../../lib/categorize.js";
import { lightDream, writeLightDreamToVault } from "../../lib/dreaming/light-dream.js";
import { serializeEmotionalValence } from "../../lib/emotion.js";
import { filterAlreadyEpisoded, mergeEpisodedTurnIds, resolveWatermarkAdvance } from "../../lib/episode-watermark.js";
import { extractEpisodesWithState, writeEpisodeToVault } from "../../lib/episodes.js";
import { decideEpistemicStatusForCapture } from "../../lib/epistemic-capture.js";
import { IMPORTANCE_STATUS } from "../../lib/importance-status.js";
import { runReflectionJob } from "../../lib/jobs/reflection-job.js";
import { withLlmCallContext } from "../../lib/llm-result-cache.js";
import { isLlmRouteAvailable } from "../../lib/llm-router.js";
import { expandForCapture } from "../../lib/memory-chunking.js";
import { applyDynamicsDefaults } from "../../lib/memory-dynamics.js";
import { buildEdgesForSession, buildEpisodeAnchorEdges, createGraphMetrics, extractGraphSignals, readBoundGraph, writeGraphConstellationReport } from "../../lib/memory-graph.js";
import { resolveMemoryRequestContext } from "../../lib/memory-request-context.js";
import { shouldTriggerReflection } from "../../lib/meta-cognition.js";
import { createNeoStore, isInjectedContextText, turnEventsFromMessages, turnIdentityParams } from "../../lib/neo-arch.js";
import { planReminderExtraction } from "../../lib/reminder-extraction.js";
import { saveReminder } from "../../lib/reminder-store.js";
import { isBackgroundTurn, shouldSkipAutoCaptureForInternalTurn } from "../../lib/runtime-scheduler.js";
import { trySafeWarn } from "../../lib/safe-logging.js";
import { extractMediaOutputIds, stripMediaOutputIdToken } from "../../lib/speaker-segment-schema.js";

/**
 * Build the `agent_end` auto-capture handler from an already-resolved engine
 * context. Every binding the moved body closes over is destructured once,
 * here, at registration time.
 *
 * @param {Record<string, any>} ctx Engine context; see the destructuring below.
 * @returns {(event: Record<string, any>, hookCtx: Record<string, any>) => Promise<unknown>} The hook handler.
 */
export function createTurnCapture(ctx) {
  const {
    EPISODED_TURN_ID_MEMORY,
    MAX_POSTPROCESSING_RETRIES,
    NEO_HOOK_DRAIN_MARGIN_MS,
    NEO_HOOK_DRAIN_MIN_MS,
    baseDbPath,
    callLlm,
    captureSummaryLlmCfg,
    cfg,
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
    jobs = null,
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
  } = ctx;

  jobs?.bind("light-dream", async (_name, jobCtx) => {
    const work = jobCtx.input?.work;
    if (typeof work !== "function") return jobCtx.skip("no_turns");
    return { dreamed: await work() };
  });

  // Per-registration one-shot warning latches (were index.js:10357-10358).
  // They are rebound at turn time, so they stay inside the closure rather
  // than travelling through the context object by value.
  let warnedMissingCaptureSessionKey = false;
  let warnedIncognitoClassifierDegraded = false;

  return async function captureTurn(event, hookCtx) {
    const sessionKey = hookCtx?.sessionKey ?? event?.sessionKey;
    // A turn without a session key cannot be an incognito session: the host
    // identifies incognito *by* that key. Both the host types and every
    // other consumer in this file treat sessionKey as optional, so a
    // missing key must not silently drop the turn — that would disable the
    // plugin's core function. Classify only when a key is actually present.
    if (typeof sessionKey === "string" && sessionKey.trim()) {
      try {
        if (await classifyHostIncognitoSession(sessionKey)) {
          host.logger.info("memory-lancedb-namespaced: skipping durable capture for incognito session");
          return undefined;
        }
      } catch (error) {
        // Fail closed: a keyed session we cannot classify must not be stored.
        trySafeWarn(host.logger, "auto-capture.incognito-classifier", error);
        if (!warnedIncognitoClassifierDegraded) {
          warnedIncognitoClassifierDegraded = true;
          trySafeWarn(host.logger, "auto-capture.incognito-classifier-degraded", new Error(
            "incognito classifier unavailable; durable capture is disabled for keyed sessions until it recovers",
          ));
        }
        return undefined;
      }
    } else if (!warnedMissingCaptureSessionKey) {
      warnedMissingCaptureSessionKey = true;
      trySafeWarn(host.logger, "auto-capture.session-key-missing", new Error(
        "agent_end turn has no session key; capturing without incognito classification",
      ));
    }
    host.logger.info(`memory-lancedb-namespaced: agent_end hook fired`);

    const agentId = hookCtx?.agentId || "default";
    const background = isBackgroundTurn(event, hookCtx);
    if (shouldSkipAutoCaptureForInternalTurn(event, hookCtx)) {
      host.logger.info(`memory-lancedb-namespaced: skipping durable capture for internal/background turn (agent=${agentId})`);
      return undefined;
    }
    let memoryCtx = null;
    try {
      memoryCtx = resolveMemoryRequestContext({
        agentId,
        workspaceDir: hookCtx?.workspaceDir,
        workspaceKey: hookCtx?.workspaceKey,
        workspaceId: hookCtx?.workspaceId,
        userId: hookCtx?.userId ?? hookCtx?.senderId,
        channel: hookCtx?.channel ?? hookCtx?.messageProvider,
        accountId: hookCtx?.accountId ?? hookCtx?.channelContext?.accountId,
        chatId: hookCtx?.chatId,
        sessionKey: hookCtx?.sessionKey ?? event?.sessionKey,
        sessionId: hookCtx?.sessionId ?? event?.sessionId,
      }, { workspaceAliases: memoryWorkspaceAliases });
    } catch (err) {
      host.logger.debug(`memory-lancedb-namespaced: capture memory context unavailable: ${String(err)}`);
    }
    if (!workspacePolicyGuard.automatic(memoryCtx).allowed) return undefined;

    // Rückgabe des Capture-Promises ermöglicht Tests, auf Abschluss zu warten.
    return runtimeScheduler.enqueueCapture(agentId, { background }, async (signal) => {
      const captureStartedAt = Date.now();
      const throwIfCaptureAborted = () => {
        if (!signal?.aborted) return;
        if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
        const abortError = new Error("auto-capture aborted");
        abortError.name = "AbortError";
        throw abortError;
      };
      // Der Embedding-Drain ist Wartungsarbeit und lief bisher VOR der
      // Erfassung im selben 60s-Budget. Bei vollem Rueckstau (250 Items)
      // verbrauchte er es komplett, die eigentliche Erfassung wurde danach
      // jedes Mal abgebrochen — beobachtet am 2026-08-20 fuer bernhardine:
      // "found 276 texts to capture" gefolgt vom Timeout ~30ms spaeter.
      // Jetzt laeuft er nach der Erfassung mit dem, was uebrig bleibt.
      let runNeoEmbeddingDrain = null;
      if (neoEnabled) {
        try {
          const neoWorkspaceKey = rememberNeoWorkspace(hookCtx, event);
          const neoStore = createNeoStore(neoRoot, neoWorkspaceKey);
          const neoHookMeta = {
            agentId,
            sessionId: event?.sessionId || event?.sessionKey || event?.runId ||
              hookCtx?.sessionId || hookCtx?.sessionKey || hookCtx?.runId || "",
            runner: event?.runner || event?.provider || "",
            background,
          };
          neoStore.recordHook("agent_end", neoHookMeta);
          const neoEvent = {
            workspaceKey: neoWorkspaceKey,
            workspaceId: snapshotNeoString(event?.workspaceId),
            workspaceDir: snapshotNeoString(event?.workspaceDir),
            workspace: snapshotNeoString(event?.workspace),
            agentSessionKey: snapshotNeoString(event?.agentSessionKey),
            sessionKey: snapshotNeoString(event?.sessionKey),
            sessionId: snapshotNeoString(event?.sessionId),
            runId: snapshotNeoString(event?.runId),
            runner: snapshotNeoString(event?.runner),
            provider: snapshotNeoString(event?.provider),
            messages: snapshotNeoMessages(event?.messages),
          };
          const neoCtx = {
            agentId,
            workspaceKey: neoWorkspaceKey,
            workspaceId: snapshotNeoString(hookCtx?.workspaceId),
            workspaceDir: snapshotNeoString(hookCtx?.workspaceDir),
            workspace: snapshotNeoString(hookCtx?.workspace),
            agentSessionKey: snapshotNeoString(hookCtx?.agentSessionKey),
            sessionKey: snapshotNeoString(hookCtx?.sessionKey),
            sessionId: snapshotNeoString(hookCtx?.sessionId),
            runId: snapshotNeoString(hookCtx?.runId),
          };
          const neoResult = await neoWorkerRuntime.runNeoAgentEnd(neoEvent, neoCtx, {
            rootDir: neoRoot,
            defaultWorkspaceKey: neoCfg.corpusDefaultWorkspaceKey,
            workspaceAliases: neoWorkspaceAliases,
            // Provider instances and credentials remain on the main thread.
            embeddingDrainEnabled: false,
            embeddingDrainImpact: neoEmbeddingDrainImpact,
            embeddingDrainMaxItems: neoEmbeddingDrainMaxItems,
            signal: deriveBudgetedSignal(signal, neoAgentEndBudgetMs),
          });
          if (neoResult?.capture) {
            const transcriptTurns = neoResult.capture.transcript?.turns;
            const neoTimings = neoResult.timings && typeof neoResult.timings === "object"
              ? ` timings=${JSON.stringify(neoResult.timings)}`
              : "";
            host.logger.info(`plur1bus-neo: worker captured new turns=${neoResult.capture.turns}, candidates=${neoResult.capture.candidates}, reactions=${neoResult.capture.reactions}, behaviorCards=${neoResult.capture.behaviorCards}${Number.isFinite(transcriptTurns) ? ` (transcript turns=${transcriptTurns})` : ""}${neoTimings}${background ? " (background)" : ""}`);
          }
          const logDrain = (drain) => {
            if (drain && (drain.processed || drain.skipped || drain.parseErrors)) {
              host.logger.info(`plur1bus-neo: embedding queue worker-drain processed=${drain.processed} pending=${drain.pending} skipped=${drain.skipped} parseErrors=${drain.parseErrors}${drain.stoppedEarly ? " (fruehzeitig gestoppt)" : ""}`);
            }
          };
          if (neoEmbeddingAutoDrainEnabled) {
            runNeoEmbeddingDrain = async () => {
              // Der Drain bekommt nur, was vom Capture-Budget uebrig ist,
              // abzueglich einer Marge fuer den laufenden Embed-Aufruf.
              // Ohne Frist lief er bis zum Worker-Abbruch (55 s) und der
              // Hook kehrte erst nach ~62 s zurueck — jenseits der 60 s
              // des Hosts; bei Bernhardine an jedem Turn (09.09.2026).
              const remainingMs = runtimeScheduler.config.captureTimeoutMs
                - (Date.now() - captureStartedAt) - NEO_HOOK_DRAIN_MARGIN_MS;
              if (remainingMs < NEO_HOOK_DRAIN_MIN_MS) {
                host.logger.info(`plur1bus-neo: embedding queue drain skipped — ${Math.max(0, remainingMs)}ms left in the capture budget`);
                return;
              }
              logDrain(await neoStore.drainEmbeddingQueue({
                impact: neoEmbeddingDrainImpact,
                maxItems: neoEmbeddingDrainMaxItems,
                dimensions: vectorDim,
                embedder: (text) => embeddings.embed(text, { agentId }),
                signal,
                deadlineMs: remainingMs,
              }));
            };
          } else {
            logDrain(neoResult?.drain);
          }
        } catch (neoErr) {
          if (isBudgetExhaustion(neoErr, signal)) {
            host.logger.warn(`plur1bus-neo: worker capture exceeded its ${neoAgentEndBudgetMs}ms budget (kalter Store?) — die Erfassung laeuft weiter, Neo holt beim naechsten Turn auf`);
          } else {
            host.logger.warn(`plur1bus-neo: worker capture failed: ${String(neoErr)}`);
          }
        }
      }

      try {
      throwIfCaptureAborted();

      if (!event.success || !event.messages || event.messages.length === 0) {
        host.logger.info(`memory-lancedb-namespaced: skipping capture - success=${event.success}, messages=${event.messages?.length || 0}`);
        return;
      }

      // await ist hier zwingend: ohne es liefe das finally unten los,
      // waehrend die Erfassung noch laeuft — genau die Gleichzeitigkeit,
      // die dieser Umbau beseitigen soll.
      return await pool.withDb(agentId, async (db) => {
      try {
        throwIfCaptureAborted();
        // Extrahiere Text aus User- und Assistant-Nachrichten + Provenance
        const maxChars = cfg.captureMaxChars || 15000;
        const turnId = event.turnId || event.runId || "";
        const items = [];      // {text, role, isUserUrl, sourceUrl}
        const mediaOutputIds = new Set();
        const urlPattern = /https?:\/\/[^\s]{10,}/;

        const extractUrl = (t) => {
          const m = (t || "").match(urlPattern);
          return m ? m[0].slice(0, 500) : "";
        };

        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const isUser = msg.role === "user";
          const isAssistant = msg.role === "assistant";
          if (!isUser && !isAssistant) continue;
          const role = msg.role;
          const content = msg.content;

          if (typeof content === "string") {
            if (content && content.length > 20) {
              const sourceUrl = isUser ? extractUrl(content) : "";
              const cleaned = stripMediaOutputIdToken(content);
              extractMediaOutputIds(content).forEach((id) => mediaOutputIds.add(id));
              items.push({ text: cleaned, role, isUserUrl: isUser && !!sourceUrl, sourceUrl });
            }
            continue;
          }

          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || typeof block !== "object") continue;

              if (block.type === "text" && typeof block.text === "string" && block.text.length > 20) {
                const sourceUrl = isUser ? extractUrl(block.text) : "";
                const cleaned = stripMediaOutputIdToken(block.text);
                extractMediaOutputIds(block.text).forEach((id) => mediaOutputIds.add(id));
                items.push({ text: cleaned, role, isUserUrl: isUser && !!sourceUrl, sourceUrl });
                continue;
              }

              if (isUser && block.type && block.type !== "text") {
                const name = block.name || block.fileName || block.filename || "";
                const mediaType = block.mediaType || block.mimeType || block.mime_type || "";
                const stub = [
                  `[User schickte ${block.type}`,
                  name ? `: ${name}` : "",
                  mediaType ? ` (${mediaType})` : "",
                  "]",
                ].join("").trim();
                if (stub.length > 20) {
                  items.push({ text: stub, role, isUserUrl: true, sourceUrl: "" }); // Attachments wie URLs priorisieren
                }
              }
            }
          }
        }

        // Systemisch injizierten Kontext (Recall-Blöcke, Status-Reminder,
        // Cron) niemals re-capturen → bricht die Recall/Capture-Rückkopplung.
        const beforeFilter = items.length;
        for (let i = items.length - 1; i >= 0; i--) {
          if (isInjectedContextText(items[i].text)) items.splice(i, 1);
        }
        if (items.length < beforeFilter) {
          host.logger.info(`memory-lancedb-namespaced: filtered ${beforeFilter - items.length} injected-context item(s) before capture`);
        }

        if (items.length === 0) {
          host.logger.info(`memory-lancedb-namespaced: no texts to capture`);
          return;
        }

        host.logger.info(`memory-lancedb-namespaced: found ${items.length} texts to capture for agent=${agentId}${background ? " (background)" : ""}`);
        const contextOrigin = String(event?.origin || event?.source || hookCtx?.origin || hookCtx?.source || "").toLowerCase();
        const contextKind = String(event?.kind || event?.type || hookCtx?.kind || hookCtx?.type || "").toLowerCase();
        // v2.2.0: hookCtx.chatType direkt prüfen (zuverlässiger als Text-Heuristik)
        const ctxChatType = String(event?.chatType || hookCtx?.chatType || "").toLowerCase();
        const isGroupSession = ctxChatType === "group" || ctxChatType === "supergroup" || ctxChatType === "channel" ||
          String(event?.sessionKey || hookCtx?.sessionKey || "").includes(":group:") ||
          String(event?.sessionKey || hookCtx?.sessionKey || "").includes(":channel:");
        const captureOrigin = contextOrigin === "cron" || contextKind === "cron"
          ? "cron"
          : isGroupSession || items.some((it) => textSuggestsGroupOrigin(it.text))
            ? "group"
            : "dm";

        // Priorisierung: User-Nachrichten mit URLs zuerst (max 3), dann neueste (max 5)
        const userUrlItems = items.filter(it => it.isUserUrl);
        const seenTexts = new Set();
        const captureList = [];
        for (const it of [...userUrlItems.slice(-3), ...items.slice(-5)]) {
          if (!seenTexts.has(it.text)) { seenTexts.add(it.text); captureList.push(it); }
          if (captureList.length >= 8) break;
        }

        let stored = 0;
        let skipped = 0;
        const captureTimestamp = Date.now();

        // Phase 1: Prepare texts (summarize/truncate) — alle parallel
        const textPrep = await Promise.all(captureList.map(async (it) => {
          let text = it.text;
          try {
            if (text.length > maxChars) {
              if (mergingEnabled && isLlmRouteAvailable(captureSummaryLlmCfg)) {
                host.logger.info(`memory-lancedb-namespaced: summarizing oversized text (${text.length} chars) for agent=${agentId}`);
                text = await summarizeForCapture(
                  text,
                  maxChars,
                  captureSummaryLlmCfg,
                  host.logger,
                  agentId,
                  { agentId, signal },
                );
              } else {
                text = text.slice(0, maxChars);
              }
            }
            return { it, text, ok: true };
          } catch (err) {
            host.logger.warn(`memory-lancedb-namespaced: text prep failed for capture item: ${String(err)}`);
            return { it, text, ok: false };
          }
        }));
        throwIfCaptureAborted();

        // Phase 1b: Batch-Embedding, falls der Provider es unterstützt.
        const batchSize = cfg.embeddingBatchSize || 8;
        // Aufteilung VOR der Einbettung: nur so bekommt jedes Teilstueck
        // einen eigenen Vektor. Enthaelt eine Nachricht mehrere
        // unabhaengige Aussagen, ist ein gemeinsamer Vektor deren
        // Schwerpunkt und liegt von jeder einzelnen weiter entfernt als
        // noetig — die Zeile wird dann nicht gefunden, obwohl die
        // Information darin steht. Abschaltbar ueber captureChunking.
        const preppedOk = textPrep.filter((p) => p.ok);
        // Drei Speicherweisen, im configSchema als zwei Schalter:
        //   captureChunking: false                     -> ganz
        //   true + captureChunkingMode "beides" (Vorgabe) -> Ganzes und Teile
        //   true + captureChunkingMode "geteilt"       -> nur die Teile
        // Gemessen an 100 schweren Faellen: 36 % / 64 % / 49 %.
        const chunkPlan = expandForCapture(preppedOk, {
          enabled: cfg.captureChunking !== false,
          keepWhole: cfg.captureChunkingMode !== "geteilt",
          makeGroupId: randomUUID,
        });
        const validPreps = chunkPlan.items;
        if (chunkPlan.split > 0 || chunkPlan.needsLlm > 0) {
          host.logger.info(`memory-lancedb-namespaced: chunking split ${chunkPlan.split} of ${preppedOk.length} item(s) into ${chunkPlan.parts} part(s), ${chunkPlan.needsLlm} would need a model for agent=${agentId}`);
        }
        const textToVector = new Map();
        if (validPreps.length > 0 && typeof embeddings.embedBatch === "function") {
          const textsToEmbed = validPreps.map((p) => p.text);
          try {
            for (let i = 0; i < textsToEmbed.length; i += batchSize) {
              throwIfCaptureAborted();
              const batch = textsToEmbed.slice(i, i + batchSize);
              const batchVectors = await embeddings.embedBatch(batch, 3, { agentId });
              throwIfCaptureAborted();
              for (let j = 0; j < batch.length; j++) {
                textToVector.set(batch[j], batchVectors[j]);
              }
            }
            host.logger.info(`memory-lancedb-namespaced: embedded ${textsToEmbed.length} capture item(s) in batch for agent=${agentId}${background ? " (background)" : ""}`);
          } catch (batchErr) {
            host.logger.warn(`memory-lancedb-namespaced: batch embed failed, falling back to individual embeddings: ${String(batchErr)}`);
            textToVector.clear();
          }
        }
        throwIfCaptureAborted();

        // Phase 1c: Einzel-Embedding-Fallback für nicht gebatchte/fehlgeschlagene Items.
        // chunkGroupId MUSS hier mitgereicht werden. Bis 7.12.70 baute diese
        // Phase ein frisches Objekt aus nur { it, text, vector, ok } und warf
        // das von expandForCapture gesetzte Gruppenkennzeichen weg — der
        // Zeilenbau weiter unten las `p.chunkGroupId` und bekam immer "".
        // Folge: Ganzes und Teile fielen beide auf denselben sourceTurnId
        // zurueck (alle Zeilen eines Capture-Laufs teilen ihn), landeten in
        // EINER Dedup-Gruppe, und DEFAULT_MAX_PER_GROUP = 2 haette hoechstens
        // zwei davon durchgelassen statt "Ganzes und bis zu zwei Teile".
        const prepared = await Promise.all(validPreps.map(async (p) => {
          let vector = textToVector.get(p.text);
          if (!vector) {
            try {
              vector = await embeddings.embed(p.text, { agentId });
            } catch (err) {
              host.logger.warn(`memory-lancedb-namespaced: embed failed for capture item: ${String(err)}`);
              return { it: p.it, text: p.text, chunkGroupId: p.chunkGroupId || "", vector: null, ok: false };
            }
          }
          return { it: p.it, text: p.text, chunkGroupId: p.chunkGroupId || "", vector, ok: true };
        }));
        throwIfCaptureAborted();

        // Phase 2: Dedup-Checks parallel (schnell mit ANN-Index)
        const toStore = (await Promise.all(
          prepared.filter(p => p.ok).map(async (p) => {
            try {
              const existing = await db.search(p.vector, 1, duplicateThreshold);
              if (existing.length > 0) return null;
              return p;
            } catch (err) {
              host.logger.warn(`memory-lancedb-namespaced: dedup-check failed: ${String(err)}`);
              return null;
            }
          })
        )).filter(Boolean);
        throwIfCaptureAborted();

        skipped = prepared.filter(p => p.ok).length - toStore.length;

        // Phase 3: Writes sequentiell (LanceDB-Versioning erfordert serielle Writes)
        const storedMemoryRows = [];
        for (const p of toStore) {
          try {
            throwIfCaptureAborted();
            const categoryResult = categorizeMemoryWithReason(p.text);
            const category = categoryResult.category;
            // Bis der stündliche Cron geurteilt hat, zählt die neutrale
            // 0.5. Ein geschätzter Zwischenwert wäre wieder die
            // Heuristik, die hier abgelöst wird. In derselben Session
            // steht die Erinnerung in dieser Zeit ohnehin noch im
            // Kontextfenster.
            const importance = 0.5;
            const summary = generateSummary(p.text, summaryMaxWords);
            const evidenceQuote = p.it.text.slice(0, 200);
            const { emotion: captureEmotion, emotionStatus: captureEmotionStatus } = await classifyEmotionForStore(p.text, { agentId, signal, importance });
            throwIfCaptureAborted();
            const captureMoodContext = emotionalPool.snapshot(agentId);
            const graphSignals = extractGraphSignals(p.text, { category, sourceUrl: p.it.sourceUrl, role: p.it.role });
            const memoryId = randomUUID();

            const row = applyDynamicsDefaults({
              id: memoryId,
              text: p.text,
              summary,
              origin: captureOrigin,
              vector: p.vector,
              importance,
              importanceStatus: IMPORTANCE_STATUS.PENDING,
              category,
              createdAt: captureTimestamp,
              mergedFrom: "[]",
              expiresAt: 0,
              storedBy: agentId,
              sourceTurnId: turnId || "",
              // Leer, wenn nicht aufgeteilt — die Recall-Seite faellt dann
              // auf sourceTurnId zurueck (lib/recall-pipeline.js).
              chunkGroupId: p.chunkGroupId || "",
              sourceMessageRole: p.it.role || "",
              epistemicStatus: decideEpistemicStatusForCapture({
                text: p.text,
                sourceMessageRole: p.it.role || "",
                origin: captureOrigin,
                cutoffFailed: !epistemicCutoffBoot.ok,
              }),
              sourceTimestamp: captureTimestamp,
              sourceUrl: p.it.sourceUrl || "",
              evidenceQuote,
              scope: "agent-private",
              emotionalValence: serializeEmotionalValence(captureEmotion),
              emotionalIntensity: captureEmotion.emotionalIntensity,
              emotionalDominant: captureEmotion.emotionalDominant,
              moodContextAtCapture: serializeEmotionalValence(captureMoodContext),
              emotionStatus: captureEmotionStatus,
              topics: graphSignals.topics,
              entities: graphSignals.entities,
              people: graphSignals.people,
              projects: graphSignals.projects,
            }, captureTimestamp, halfLifeOverrides, { intensityHalfLifeFactor: emotionIntensityHalfLifeFactor, flashbulbEncodingEnabled });
            await db.store(row);
            storedMemoryRows.push(row);
            stored++;
            host.logger.info(`memory-lancedb-namespaced: stored memory [${category}|${captureOrigin}] for agent=${agentId}`);
          } catch (err) {
            const settlement = await waitForTimeoutSettlement(err);
            if (settlement.status === "rejected") {
              host.logger.warn(`memory-lancedb-namespaced: late capture store settlement failed: ${String(settlement.error)}`);
            }
            // Ist das Budget alle, scheitert jeder weitere Eintrag am selben
            // Abbruch. Frueher stand deshalb je Restposten eine eigene
            // Fehlerzeile im Log (09.09.2026: vier Stueck fuer bernhardine),
            // was nach Datenverlust aussah, obwohl das Bereits-Gespeicherte
            // steht und der Rest beim naechsten Turn drankommt. Einmal
            // abbrechen, der aeussere Block meldet den Zaehlstand.
            if (isAbortError(err)) throw err;
            host.logger.warn(`memory-lancedb-namespaced: failed to store capture: ${String(err)}`);
          }
        }
        throwIfCaptureAborted();

        host.logger.info(`memory-lancedb-namespaced: capture complete - stored=${stored}, skipped=${skipped}${background ? " (background)" : ""}`);

        // Speaker naming pipeline: propose display names from merged diarization segments.
        await runSpeakerProposalPipeline(agentId, [...mediaOutputIds]);
        throwIfCaptureAborted();

        // Meta-Cognition: Session-Counter erhöhen, ggf. Reflection triggern
        if (metaCognitionEnabled && stored > 0) {
          metaReflectionState.sessionCount++;
          const shouldReflect = shouldTriggerReflection(
            metaReflectionState.sessionCount,
            metaCognitionSessionThreshold,
            metaReflectionState.lastAt,
            { intervalMs: metaCognitionIntervalMs },
          );
          if (shouldReflect) {
            try {
              const neoStore = createNeoStore(neoRoot, rememberNeoWorkspace(hookCtx, event));
              const reflectionWorkspaceDir = memoryCtx?.workspaceDir || snapshotNeoString(hookCtx?.workspaceDir) || snapshotNeoString(event?.workspaceDir);
              const reflectResult = await runReflectionJob({
                store: neoStore,
                workspaceDir: reflectionWorkspaceDir,
                logger: host.logger,
                llmReport: metaCognitionLlmReport,
              });
              if (reflectResult.ok) {
                metaReflectionState.sessionCount = 0;
                metaReflectionState.lastAt = Date.now();
                const metaStatePath = join(baseDbPath, "_meta-cognition-state.json");
                writeFileSync(metaStatePath, JSON.stringify({ sessionCountSinceReflection: metaReflectionState.sessionCount, lastReflectionAt: metaReflectionState.lastAt }, null, 2));
                host.logger.info(`memory-lancedb-namespaced: meta-reflection triggered after ${metaCognitionSessionThreshold} sessions`);
              }
            } catch (err) {
              host.logger.warn(`memory-lancedb-namespaced: meta-reflection failed: ${String(err)}`);
            }
          }
        }

        // --- Reminder Extraction ---
        for (const it of items) {
          try {
            throwIfCaptureAborted();
            const plan = planReminderExtraction(it, {
              enabled: reminderAutoExtract,
              now: Date.now(),
            });
            if (!plan.skip) {
              const parsed = plan.parsed;
              const wsKey = hookCtx?.workspaceDir || "default";
              const source = "user";
              // Ursprungssatz statt blosser Zeitfloskel — sonst hat der
              // Reminder kein Thema (siehe buildReminderText).
              const reminderText = plan.reminderText;
              if (parsed.requiresConfirmation) {
                await saveReminder(db, {
                  text: reminderText,
                  remindAt: parsed.remindAt,
                  agentId,
                  workspaceKey: wsKey,
                  source,
                  embeddings,
                  initialStatus: "pending_confirmation",
                });
                host.logger.info(`plur1bus-reminder: stored pending-confirmation reminder for ${agentId}`);
              } else {
                await saveReminder(db, {
                  text: reminderText,
                  remindAt: parsed.remindAt,
                  agentId,
                  workspaceKey: wsKey,
                  source,
                  embeddings,
                });
                host.logger.info(`plur1bus-reminder: stored reminder for ${agentId} at ${new Date(parsed.remindAt).toISOString()} (${parsed.timePrecision})`);
              }
            }
          } catch (reminderStoreErr) {
            const settlement = await waitForTimeoutSettlement(reminderStoreErr);
            if (settlement.status === "rejected") {
              host.logger.warn(`plur1bus-reminder: late store settlement failed: ${String(settlement.error)}`);
            }
            host.logger.warn(`plur1bus-reminder: store failed: ${String(reminderStoreErr)}`);
          }
        }

        throwIfCaptureAborted();

        // High-Watermark: Nur neue Messages seit letztem Durchlauf verarbeiten
        const neoStore = getNeoStore(hookCtx, event);
        const hooks = neoStore.readHooks();
        const recordedCount = hooks?.agent_end?.lastProcessedMessageCount || 0;
        const currentCount = event.messages?.length || 0;
        // 7.12.24: Nach einer Kompaktierung ist der Verlauf kuerzer als die
        // Marke (z. B. 274 → 221); ohne Reset blieb dieser Block stumm, bis
        // der Verlauf die alte Laenge wieder ueberschritt.
        let lastCount = recordedCount;
        if (currentCount < recordedCount) {
          host.logger.info(`memory-lancedb-namespaced: message count dropped (${recordedCount} → ${currentCount}), resetting the agent_end watermark`);
          lastCount = 0;
        }

        if (currentCount <= lastCount) {
          host.logger.info(`memory-lancedb-namespaced: no new messages since last processing (${lastCount} → ${currentCount})`);
        } else {
          // Nur die neuen Messages normalisieren
          const newMessages = event.messages.slice(lastCount);
          // 7.12.44: gleiche Turn-Identitaet wie das Journal des Workers
          // (normierter Workspace-Schluessel + stabiler Sitzungsschluessel),
          // sonst zeigen Episoden auf Turn-IDs, die es nirgends gibt.
          const normalizedTurns = turnEventsFromMessages(newMessages, {
            ...turnIdentityParams(event, hookCtx, rememberNeoWorkspace(hookCtx, event)),
            createdAt: new Date().toISOString(),
          });

          // Idempotenz: Session-Digest für Dreams/Episoden (nur neue Turns)
          const sessionDigest = normalizedTurns.map(t => `${t.role}:${t.content}`).join("\n");
          const { createHash } = await import("node:crypto");
          const digestHash = createHash("sha256").update(sessionDigest).digest("hex").slice(0, 16);

          // Die beiden folgenden Pfade (Light-Dream, Episoden) laufen
          // fire-and-forget. Das High-Watermark darf erst hochgezaehlt
          // werden, wenn sie durch sind — sonst liegen die Turns eines
          // fehlgeschlagenen Laufs darunter und werden NIE wieder
          // betrachtet (dauerhafter Episodenverlust, im Feld beobachtet).
          // Jeder Eintrag ist ein Promise<boolean>: true = erledigt.
          const postProcessing = [];

          // v5.3.0 — Light Dreaming: Nach-Session-Reflexion (fire-and-forget)
          if (!background && mergingEnabled && isLlmRouteAvailable(conversationInsightsLlmCfg) && neoEnabled) {
            const processedDreams = hooks?.agent_end?.processedDreams || [];
            if (processedDreams.includes(digestHash)) {
              host.logger.info(`memory-lancedb-namespaced: light dream already processed for this session (digest=${digestHash})`);
            } else if (normalizedTurns.length < 3) {
              host.logger.info(`memory-lancedb-namespaced: skipping light dream - too few turns (${normalizedTurns.length})`);
            } else if (normalizedTurns.length > 50) {
              host.logger.info(`memory-lancedb-namespaced: skipping light dream - too many turns (${normalizedTurns.length})`);
            } else {
              // Fire-and-forget: nicht awaiten, damit der Hook nicht blockiert
              let personaIdentityText = "";
              if (hookCtx?.workspaceDir) {
                for (const identityFile of ["SOUL.md", "IDENTITY.md", "AGENT.md"]) {
                  try {
                    personaIdentityText = readFileSync(join(hookCtx.workspaceDir, identityFile), "utf8").slice(0, 2000);
                    break;
                  } catch (_) { /* try next */ }
                }
              }
              let lightRequestContext = null;
              try {
                lightRequestContext = resolveMemoryRequestContext({
                  agentId,
                  workspaceDir: hookCtx?.workspaceDir,
                  workspaceKey: hookCtx?.workspaceKey,
                  userId: hookCtx?.userId ?? hookCtx?.senderId,
                  channel: hookCtx?.channel ?? hookCtx?.messageProvider,
                  accountId: hookCtx?.accountId ?? hookCtx?.channelContext?.accountId,
                  chatId: hookCtx?.chatId,
                }, { workspaceAliases: memoryWorkspaceAliases });
              } catch (_) {
                lightRequestContext = null;
              }
              const lightAclBindings = lightRequestContext
                ? (lightRequestContext.userPrincipal
                  ? { scope: "user", agentId: lightRequestContext.agentId, workspaceIdentity: "", ownerUserId: lightRequestContext.userPrincipal }
                  : { scope: "workspace", agentId: lightRequestContext.agentId, workspaceIdentity: lightRequestContext.workspaceIdentity, ownerUserId: "" })
                : null;
              const lightDreamWork = () => lightDream({
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
                logger: host.logger,
                narrativeCfg: dreamNarrativeCfg,
                workspaceDir: hookCtx?.workspaceDir || null,
                temperamentName: resolveTemperamentName(agentId),
                personaSeedCfg: (cfg.personaVoice?.enabled ?? true) !== false
                  ? { agentId, lang: cfg.language || "de", identityText: personaIdentityText }
                  : null,
                requestContext: lightRequestContext,
                aclBindings: lightAclBindings,
                signal,
              }).then((dreamResult) => {
                throwIfAborted(signal, "light dream commit aborted");
                if (hookCtx?.workspaceDir) {
                  throwIfAborted(signal, "light dream commit aborted");
                  writeLightDreamToVault(dreamResult, hookCtx.workspaceDir, normalizedTurns);
                }
                // Markiere als verarbeitet
                const mergedDreams = [...processedDreams.slice(-100), digestHash];
                throwIfAborted(signal, "light dream commit aborted");
                neoStore.recordHook("agent_end", { processedDreams: mergedDreams });
                return true;
              });
              postProcessing.push(jobs
                ? jobs.run("light-dream", agentId, { trigger: "capture", signal, input: { work: lightDreamWork } })
                  .then((dreamRun) => {
                    if (dreamRun.outcome === "failed") {
                      host.logger.warn?.(`memory-lancedb-namespaced: light dream failed: ${String(dreamRun.error)}`);
                    }
                    return dreamRun.outcome === "completed";
                  })
                : lightDreamWork().catch((dreamErr) => {
                  host.logger.warn?.(`memory-lancedb-namespaced: light dream failed: ${String(dreamErr)}`);
                  return false;
                }));
            }
          }

          // v5.3.0 — Episoden-Extraktion: Turns zu Geschichten gruppieren (fire-and-forget)
          if (!background && neoEnabled) {
            const processedEpisodes = hooks?.agent_end?.processedEpisodes || [];
            if (processedEpisodes.includes(digestHash)) {
              host.logger.info(`memory-lancedb-namespaced: episodes already processed for this session (digest=${digestHash})`);
            } else {
              // Dedup MUSS pro Turn greifen, nicht pro Batch: Bleibt das
              // Watermark nach einem Fehlschlag stehen, ist die naechste
              // Slice BREITER (currentCount ist gewachsen) und damit auch
              // der digestHash ein anderer — processedEpisodes wuerde nicht
              // greifen und bereits geschriebene Spannen doppelt anlegen.
              // Die Turn-IDs dagegen sind stabil, solange der Slice-START
              // gleich bleibt, und genau das garantiert das haengende
              // Watermark.
              const episodedTurnIds = new Set(hooks?.agent_end?.episodedTurnIds || []);
              // 7.12.40: die zuletzt geschriebene Episode wird fortgeschrieben,
              // solange die Pause unter 30 Minuten liegt (Zustand im Hook-Record).
              const openEpisodeState = hooks?.agent_end?.openEpisode || null;
              // Fire-and-forget: nicht awaiten, damit der Hook nicht blockiert
              // 7.12.40: Namen aus USER.md/IDENTITY.md, Stimmung der
              // EmotionEngine und Session-Art fuer brauchbare Karten-Metadaten.
              postProcessing.push(extractEpisodesWithState(normalizedTurns, {
                // 7.12.55: vor der Anreicherung bekannt geben, was bereits
                // episodiert ist — sonst zahlt jede verworfene Spanne einen
                // Modellaufruf.
                episodedTurnIds,
                workspaceKey: hookCtx?.workspaceKey,
                workspaceDir: hookCtx?.workspaceDir,
                sessionKey: event?.sessionKey || hookCtx?.sessionKey || "",
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
                // Nur vollstaendig bereits episodierte Spannen verwerfen.
                // Teilueberlappung bleibt erhalten — sie enthaelt neue Turns.
                const { fresh, skipped } = filterAlreadyEpisoded(episodes, episodedTurnIds);
                if (skipped > 0) {
                  host.logger.info(`memory-lancedb-namespaced: ${skipped} bereits episodierte Spanne(n) uebersprungen (agent=${agentId})`);
                }
                const vaultPaths = new Map();
                if (fresh.length > 0) {
                  throwIfAborted(signal, "episode commit aborted");
                  // 7.12.40: async mit langer Lock-Frist statt 5-s-Sync-Lock
                  // (Backpressure gegen den Embedding-Drain, s. neo-arch.js).
                  if (typeof neoStore.appendEpisodesAsync === "function") await neoStore.appendEpisodesAsync(fresh);
                  else neoStore.appendEpisodes(fresh);
                  const continuedCount = fresh.filter((ep) => ep.id === continuedId).length;
                  host.logger.info(`memory-lancedb-namespaced: ${fresh.length} episode(s) extracted for agent=${agentId} (continued=${continuedCount}, turns=${fresh.map((ep) => ep.turnCount).join("/")})`);
                  if (hookCtx?.workspaceDir) {
                    for (const ep of fresh) {
                      throwIfAborted(signal, "episode commit aborted");
                      const replacePath = continuedId && ep.id === continuedId ? openEpisodeState?.vaultPath || null : null;
                      const written = writeEpisodeToVault(ep, hookCtx.workspaceDir, { replacePath });
                      if (written?.written) vaultPaths.set(ep.id, written.path);
                      else if (written?.error) host.logger.warn?.(`memory-lancedb-namespaced: episode card not written: ${written.error}`);
                    }
                  }
                }
                // Markiere als verarbeitet
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
                host.logger.warn?.(`memory-lancedb-namespaced: episode extraction failed: ${String(epErr)}`);
                return false;
              }));
            }
          }

          // High-Watermark aktualisieren — aber erst, wenn die
          // fire-and-forget-Nachverarbeitung durch ist. Wird es wie
          // frueher synchron hochgezaehlt, sind die Turns eines
          // fehlgeschlagenen Laufs dauerhaft verloren.
          const advanceWatermark = () => {
            neoStore.recordHook("agent_end", {
              lastProcessedMessageCount: currentCount,
              postProcessingFailures: 0,
            });
          };
          if (postProcessing.length === 0) {
            advanceWatermark();
          } else {
            const failures = Number(hooks?.agent_end?.postProcessingFailures) || 0;
            Promise.all(postProcessing).then((results) => {
              const decision = resolveWatermarkAdvance({
                results,
                failures,
                maxRetries: MAX_POSTPROCESSING_RETRIES,
              });
              if (decision.gaveUp) {
                host.logger.warn?.(`memory-lancedb-namespaced: Nachverarbeitung ${MAX_POSTPROCESSING_RETRIES}x gescheitert — Watermark wird nachgezogen, Turns ${lastCount}..${currentCount} bleiben unverarbeitet (agent=${agentId})`);
              }
              if (decision.advance) {
                advanceWatermark();
                return;
              }
              host.logger.warn?.(`memory-lancedb-namespaced: Nachverarbeitung unvollstaendig — Watermark bleibt bei ${lastCount}, Bereich wird erneut versucht (${decision.nextFailures}/${MAX_POSTPROCESSING_RETRIES}, agent=${agentId})`);
              neoStore.recordHook("agent_end", { postProcessingFailures: decision.nextFailures });
            }).catch((aggErr) => {
              host.logger.warn?.(`memory-lancedb-namespaced: Watermark-Nachlauf fehlgeschlagen: ${String(aggErr)}`);
            });
          }
        }

        // v5.4.0 — Memory-Graph: Assoziative Verknüpfung
        if (!background && neoEnabled && storedMemoryRows.length > 0) {
          try {
            throwIfCaptureAborted();
            const neoStore = getNeoStore(hookCtx, event);
            const graphMetrics = createGraphMetrics();

            // Baue newMemories aus stored captures
            const newMemories = storedMemoryRows.map(row => ({
              id: row.id,
              createdAt: new Date(captureTimestamp).toISOString(),
              sessionId: event?.sessionId || event?.sessionKey || event?.runId || "",
              vector: row.vector,
              topics: row.topics || [],
              entities: row.entities || [],
              emotionalDominant: row.emotionalDominant,
              emotionalIntensity: row.emotionalIntensity,
              status: row.status || "active",
              epistemicStatus: row.epistemicStatus || "",
              expiresAt: row.expiresAt ?? 0,
              scope: row.scope,
              agentId: row.agentId,
              storedBy: row.storedBy,
              workspaceId: row.workspaceId || "",
              workspaceKey: row.workspaceKey || "",
              ownerUserId: row.ownerUserId || "",
            }));

            // Lade existierende Edges für Deduplizierung
            const existingEdges = neoStore.readGraphEdges(10_000);
            const { adjacency: existingAdj } = readBoundGraph(existingEdges);

            // Lade recent existing memories für vollständigen Edge-Aufbau
            let recentExisting = [];
            try {
              recentExisting = await db.getRecentForGraph({
                limit: 100,
                sessionId: event?.sessionId || event?.sessionKey || event?.runId || "",
                includeGlobalRecent: true,
                fields: [
                  "id", "createdAt", "sessionId", "topics", "entities", "emotionalDominant", "emotionalIntensity",
                  "status", "epistemicStatus", "expiresAt", "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId",
                ],
              });
            } catch (err) {
              host.logger.debug(`memory-graph: recent ownership projection failed: ${String(err)}`);
            }

            // Baue neue Edges
            const allEdges = memoryCtx ? await buildEdgesForSession(
              newMemories.filter(m => m.vector),
              [...recentExisting, ...newMemories],
              db.table,
              host.logger,
              { requestContext: memoryCtx },
            ) : [];

            // Episode-Anchor-Edges — nur für Episoden im aktuellen Zeitfenster
            const allEpisodes = neoStore.readEpisodes(100);
            const twoHoursAgo = captureTimestamp - 2 * 60 * 60 * 1000;
            const recentEpisodes = allEpisodes.filter(ep => {
              const epStart = new Date(ep.startTime).getTime();
              return epStart >= twoHoursAgo;
            });
            const episodeEdges = buildEpisodeAnchorEdges(
              recentEpisodes,
              newMemories,
              { requestContext: memoryCtx },
            );

            const combinedEdges = [...allEdges, ...episodeEdges];

            // Dedupliziere gegen existierende Edges
            const newUniqueEdges = combinedEdges.filter(edge => {
              const existing = existingAdj.get(edge.source)?.find(e =>
                e.target === edge.target && e.type === edge.type
              );
              return !existing;
            });

            if (newUniqueEdges.length > 0) {
              neoStore.appendGraphEdges(newUniqueEdges);
              for (const edge of newUniqueEdges) {
                graphMetrics.record(edge.type);
              }
              host.logger.info(`memory-graph: ${newUniqueEdges.length} edges added for agent=${agentId}`);
            }

            // Vault-Ausgabe: Memory Constellation Report
            if (hookCtx?.workspaceDir && Math.random() < 0.1) {
              try {
                const allEdges = neoStore.readGraphEdges(5_000);
                const reportPath = writeGraphConstellationReport(allEdges, hookCtx.workspaceDir);
                if (reportPath) {
                  host.logger.info(`memory-graph: constellation report written to ${reportPath}`);
                }
              } catch (vaultErr) {
                host.logger.warn?.(`memory-graph: vault report failed: ${String(vaultErr)}`);
              }
            }
          } catch (graphErr) {
            host.logger.warn?.(`memory-lancedb-namespaced: graph build failed: ${String(graphErr)}`);
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          // Ohne Zaehler: `stored`/`skipped` leben im try-Block und sind
          // hier nicht sichtbar. Was gespeichert wurde, steht ohnehin je
          // Eintrag im Log ("stored memory ...").
          host.logger.info(`memory-lancedb-namespaced: capture budget exhausted for agent=${agentId} — das bereits Gespeicherte steht, der Rest folgt beim naechsten Turn`);
        } else {
          host.logger.warn(`memory-lancedb-namespaced: capture failed for agent=${agentId}: ${String(err)}`);
        }
      }
      });
      } finally {
        // Rest des Budgets fuer die Wartung. Ist es schon aufgebraucht,
        // bleibt der Rueckstau stehen und der naechste Lauf macht weiter —
        // besser als die Erfassung ein weiteres Mal auszuhungern.
        if (runNeoEmbeddingDrain && !signal?.aborted) {
          try {
            await runNeoEmbeddingDrain();
          } catch (drainErr) {
            host.logger.warn(`plur1bus-neo: embedding queue drain failed: ${String(drainErr)}`);
          }
        }
      }
    }); // runtimeScheduler.enqueueCapture
  };
}
