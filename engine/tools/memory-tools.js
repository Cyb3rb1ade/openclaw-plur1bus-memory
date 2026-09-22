/**
 * engine/tools/memory-tools.js
 *
 * The five model-facing memory tools — `memory_recall`, `memory_search`,
 * `memory_store`, `memory_forget` and `knowledge_update` (was
 * index.js:7672-8514, the body of the factory the OpenClaw host is
 * handed by `registerTool`).
 *
 * Pure engine: the factory never touches the OpenClaw plugin surface. Its only host
 * contact is the per-call tool context OpenClaw passes in, which arrives as
 * the arrow's `toolCtx` parameter (`workspaceDir`, `workspaceKey`, the agent
 * binding) and is handed straight to `resolveToolMemoryRequestContext`.
 * Everything else is destructured once, at construction time, from the engine
 * context.
 *
 * The destructive-op gate (`security.allowModelDestructiveMemoryOps`) is a
 * security boundary and moves verbatim: a model-facing tool call carries no
 * user-bound authorization context, unlike the chat commands.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkAccess } from "../../lib/acl-middleware.js";
import { categorizeMemoryWithReason, MEMORY_CATEGORIES, MEMORY_ORIGINS, MEMORY_SCOPES } from "../../lib/categorize.js";
import { serializeEmotionalValence } from "../../lib/emotion.js";
import { decideEpistemicStatusForCapture } from "../../lib/epistemic-capture.js";
import { normalizeEpistemicStatus } from "../../lib/epistemic-status.js";
import { stripFrontmatter, withFrontmatter } from "../../lib/frontmatter.js";
import { validateMemoryText } from "../../lib/input-limits.js";
import { checkMaxPromotions, computeContentHash, isKnowledgePromoted, recordKnowledgePromotion } from "../../lib/jobs/schicht15-tracker.js";
import { selectStalePendingKeys } from "../../lib/knowledge-pending-prune.js";
import { isTruncatedKnowledgeBody, resolveKnowledgeUpdateMaxTokens, resolveKnowledgeUpdateTimeoutMs } from "../../lib/knowledge-update-budget.js";
import { LLM_RESULT_CACHE_PURPOSES } from "../../lib/llm-result-cache.js";
import { DISPLAY_SOURCES } from "../../lib/memory-context-sanitize.js";
import { applyDynamicsDefaults, createRetrievalLedgerEntry } from "../../lib/memory-dynamics.js";
import { computeMemoryImportance, shouldPromoteMemory } from "../../lib/memory-fact-quality.js";
import { hasMeaningfulDifference, validateMergedTextPreservesFacts } from "../../lib/memory-merge-safety.js";
import { resolveToolMemoryRequestContext } from "../../lib/memory-request-context.js";
import { addTraceStoreDecision, createRecallDecisionTrace, summarizeTrace, textPreview } from "../../lib/recall-decision-trace.js";
import { createRecallPhaseTimer } from "../../lib/recall-phase-timer.js";
import { withAccessReadDbs } from "../../lib/shared-memory.js";
import { safeUuidList, selectSafeUuids } from "../../lib/sql-safety.js";
import { archiveCard } from "../../lib/telegram-commands/memory-edit.js";
import { generateSummary as libGenerateSummary } from "../../lib/text-utils.js";
import { findBlockingTombstoneForCapture } from "../../lib/tombstone.js";
import { combineValidTimeForMerge, hasDisjointValidityWindows, normalizeCapturedTimestamp, normalizeCapturedValidityWindow, validateValidTimeInputFields } from "../../lib/valid-time.js";
import { guardWorkspaceTools } from "../../lib/workspace-policy-guard.js";

/**
 * Build the OpenClaw tool factory from an already-resolved engine context.
 * The returned function is what the host's `registerTool` invokes once per agent
 * tool context; the OpenClaw registration itself lives in
 * `adapter/openclaw/register-tools.js`.
 *
 * @param {Record<string, any>} ctx Engine context; see the destructuring below.
 * @returns {(toolCtx: Record<string, any>) => object[]} The per-context tool list factory.
 */
export function createMemoryTools(ctx) {
  const {
    KNOWLEDGE_LOCK_FILE,
    TTL_MAP,
    adaptiveBudgetCfg,
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
  } = ctx;

  return (toolCtx) => {
    const memoryCtx = resolveToolMemoryRequestContext(toolCtx, { workspaceAliases: memoryWorkspaceAliases });
    const agentId = memoryCtx.agentId;
    const modelDestructiveToolsAllowed = () => (cfg.security?.allowModelDestructiveMemoryOps !== false);
    const blockModelDestructiveTool = (toolName) => ({
      content: [{
        type: "text",
        text: `${toolName} is disabled unless security.allowModelDestructiveMemoryOps=true because model-facing tool calls do not carry a user-bound authorization context.`,
      }],
    });

    const recallTool = {
        name: "memory_recall",
        label: "Memory Recall",
        description: "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for in memory" },
            limit: { type: "number", description: "Max results (default 5)" },
            full_text: { type: "boolean", description: "Return full text instead of summary (default false)" },
            validAt: { type: "string", description: "Optional: restrict recall to facts valid at this specific point in time (ISO date, e.g. '2025-06-01') when the user asks about a dated state explicitly ('where did he work in 2025', 'what was true as of last year'). Requires an actual date or a date you can resolve with certainty from context; omit it rather than guessing for vague phrases such as 'a while ago'. When omitted, recall is not Valid-Time-filtered: historical rows may be returned and known validity bounds are labeled in the output." },
          },
          required: ["query"],
        },
        async execute(_toolCallId, params) {
          try {
            const validTimeValidation = validateValidTimeInputFields(params, ["validAt"]);
            if (!validTimeValidation.ok) {
              return { content: [{ type: "text", text: `Memory recall rejected: ${validTimeValidation.error}` }] };
            }
            return await withAccessReadDbs(
              pool,
              sharedMemoryPool,
              agentId,
              { ...memoryCtx, logger: host.logger },
              async (readDbs) => {
            const limit = normalizeBoundedRecallInteger(params.limit, maxPromptMemories, 1, 100);
            const recallBudget = resolveRuntimeRecallBudget(params.query, limit, adaptiveBudgetCfg);
            const assocCfg = cfg?.continuityEngine?.associativeRecall || {};
            const initializedReadDbs = [];
            for (const entry of readDbs) {
              const initialized = await entry.db.init();
              if (initialized !== false && entry.db.table) initializedReadDbs.push(entry);
            }
            readDbs = initializedReadDbs;
            // v5.4.0 — Graph-Edges für assoziativen Spread laden
            let graphEdges = [];
            try {
              const neoStore = getNeoStore(toolCtx, {});
              graphEdges = neoStore.readGraphEdges(5_000);
            } catch (_e) { dbg(_e); }
            // v1.9.0 — komplette Pipeline aus shared module
            const trace = traceEnabled
              ? createRecallDecisionTrace({
                  query: params.query,
                  mode: "recall",
                  maxTextPreviewChars: traceCfg.maxTextPreviewChars ?? 160,
                  maxCandidates: traceCfg.maxCandidates ?? 50,
                })
              : undefined;
            const phaseTimer = createRecallPhaseTimer({
              softBudgetMs,
              hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs,
              logger: host.logger,
            });
            const _recallBaseParams = {
              query: params.query,
              // Phase 2 — Bi-Temporal Memory (§5d). Caller-supplied only,
              // never inferred/defaulted to "now" — an unparseable or
              // omitted value normalizes to 0, mapped to null so the
              // pipeline applies zero temporal filtering by default.
              validAt: (() => {
                const v = normalizeCapturedTimestamp(params.validAt);
                return v === 0 ? null : v;
              })(),
              phaseTimer,
              softBudgetFallback,
              embeddings,
              workspaceDir: toolCtx?.workspaceDir,
              topN: limit,
              budget: recallBudget,
              adaptiveBudget: adaptiveBudgetCfg,
              recallMinScore,
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
                { agentId },
              ),
              logger: host.logger,
              emotionalState: emotionalPool.get(agentId),
              graphEdges,
              associativeEnabled: true,
              graphConfig: {
                graphHydrationRelevanceThreshold: assocCfg.graphHydrationRelevanceThreshold ?? 0.25,
                graphIndex: { enabled: assocCfg.graphIndex?.enabled !== false },
              },
              workspaceKey: toolCtx?.workspaceKey || toolCtx?.workspaceDir || null,
              agentId,
              memoryCtx,
              queryRefinerEnabled,
              decisionTrace: trace,
              retrievalLogger: (ledgerInfo) => {
                try {
                  const neoStore = getNeoStore(toolCtx, {});
                  neoStore.appendRetrievalLedger([createRetrievalLedgerEntry({
                    ...ledgerInfo,
                    timestamp: Date.now(),
                  })]);
                } catch (_e) { dbg(_e); }
              },
            };
            const { canonical: canonicalHits, memories: ordered, trace: returnedTrace } = await runMergedNamespaceRecall(
              readDbs,
              _recallBaseParams,
              trace,
              phaseTimer,
              { strictReadErrors: namespaceLayout.recallReadNamespaces.length > 1 },
            );
            if (ordered.length === 0 && canonicalHits.length === 0) {
              return { content: [{ type: "text", text: "No relevant memories found." }] };
            }

            const fullText = params.full_text === true;
            const lines = [];
            for (const c of canonicalHits) {
              const head = c.heading.replace(/\s+/g, " ").slice(0, 80);
              const body = fullText ? c.text.trim() : libGenerateSummary(c.text.replace(/^#+\s+.+\n/, "").trim(), 80);
              lines.push(`[canonical|knowledge] ${head} — ${body} (score: ${c.score.toFixed(2)})`);
            }
            for (const r of ordered) {
              let display = fullText
                ? r.entry.text
                : (r.entry.summary || libGenerateSummary(r.entry.text, summaryMaxWords));
              if (r.entry.memoryClass === "dream") {
                const dreamDate = r.entry.createdAt ? new Date(Number(r.entry.createdAt)).toISOString().slice(0, 10) : "";
                display = `🌙 [Traum${dreamDate ? ` vom ${dreamDate}` : ""}] ${display} (geträumt, nicht geschehen)`;
              }
              const orig = DISPLAY_SOURCES.has(r.entry.origin) ? `|${r.entry.origin}` : "";
              lines.push(`[${r.entry.category}${orig}] ${display} (score: ${r.score.toFixed(2)}, ID: ${r.entry.id}${formatKnownValidityLabel(r.entry)})`);
            }
            if (traceEnabled && returnedTrace) {
              const summary = summarizeTrace(returnedTrace);
              lines.push(`[decision-trace] totalCandidates:${summary.totalCandidates} included:${summary.included} rejected:${summary.rejected} downranked:${summary.downranked} superseded:${summary.superseded} deduped:${summary.deduped} merged:${summary.merged} guardPass:${summary.guardPass} guardFail:${summary.guardFail}`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
            });
          } catch (err) {
            return { content: [{ type: "text", text: `Memory recall failed: ${String(err)}` }] };
          }
        },
      };
    const searchTool = {
      ...recallTool,
      name: "memory_search",
      label: "Memory Search",
      description: "Alias for memory_recall. Uses the same PLUR1BUS LanceDB vector search and reranked recall pipeline; Obsidian records are not a recall authority.",
    };

    const workspaceTools = [
      recallTool,
      searchTool,
      {
        name: "memory_store",
        label: "Memory Store",
        description: "Save important information in long-term memory. Use for preferences, facts, decisions. IMPORTANT: Proactively store significant user information! Set origin='group' when storing from a group chat so future recall shows the origin context.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Information to remember" },
            category: { type: "string", enum: MEMORY_CATEGORIES, description: "Memory category" },
            importance: { type: "number", description: "Importance 0-1 (default 0.5). Reserve exactly 1.0 for something you decide you must never forget — it marks the memory as permanent and exempt from garbage collection, compaction and merging. Use it sparingly and only on your own judgement; anything merely very important belongs at 0.85-0.95." },
            origin: { type: "string", enum: MEMORY_ORIGINS, description: "Origin context: 'dm' = direct message (default), 'group' = Telegram group chat, 'cron' = background job, 'internal' = agent-generated. ALWAYS set 'group' when storing from a group chat!" },
            ttl: { type: "string", enum: ["session", "short"], description: "Memory lifetime: 'session' = until tomorrow, 'short' = 14 days. Omit for permanent storage." },
            sourceUrl: { type: "string", description: "Optional URL this memory is derived from (provenance)" },
            evidenceQuote: { type: "string", description: "Optional original quote (≤200 chars) that backs this memory" },
            scope: { type: "string", enum: MEMORY_SCOPES, description: "Visibility scope: 'agent-private' (default), 'workspace' (shared within workspace), 'user' (shared across all agents of one user)" },
            validFrom: { type: "string", description: "Optional: when this fact became true in the real world (ISO date), if the user stated or clearly implied an actual date or a date you can resolve with certainty (e.g. 'since March 2026', 'starting last Monday' relative to today's known date). Do NOT set this for vague relative phrasing with no resolvable anchor — 'seit letztem Monat', 'vor einer Weile', 'damals', 'irgendwann' — leave the parameter out entirely in those cases; the original wording is preserved in the memory text regardless, so nothing is lost by omitting this. Never guess a date to fill the field." },
            validUntil: { type: "string", description: "Optional: when this fact stopped being true, ONLY if the user is stating a fact that has definitely ended (e.g. 'I worked there until June 2026', a correction of a previous fact with a known end date). Do NOT set this for something still ongoing or of unknown end — leave unset; unset means 'still valid / unknown', not 'ended now'. Never infer an end date from silence or from a new fact alone." },
          },
          required: ["text"],
        },
        async execute(_toolCallId, params) {
          try {
            // Keep the agent-facing store path aligned with storeMemoryFromToolParams:
            // reject invalid text before embedding or writing it.
            const textValidation = validateMemoryText(params.text);
            if (!textValidation.ok) {
              return {
                content: [{ type: "text", text: `Memory store rejected: ${textValidation.error}` }],
                details: { action: "rejected", reason: "invalid_text" },
              };
            }
            const validTimeValidation = validateValidTimeInputFields(params, ["validFrom", "validUntil"]);
            if (!validTimeValidation.ok) {
              return {
                content: [{ type: "text", text: `Memory store rejected: ${validTimeValidation.error}` }],
                details: { action: "rejected", reason: "invalid_valid_time" },
              };
            }
            const scopeAccess = resolveStoreScopeAccess(memoryCtx, params.scope);
            if (!scopeAccess.ok) {
              return {
                content: [{ type: "text", text: `Memory store rejected: ${scopeAccess.error}` }],
                details: { action: "rejected", reason: "missing_scope_owner" },
              };
            }
            const { scope, ownerUserId, ownershipFields } = scopeAccess;
            return await pool.withWriteDb(agentId, async (db) => {
            const trace = createRecallDecisionTrace({
              query: textPreview(params.text, traceCfg.maxTextPreviewChars ?? 160),
              mode: "store",
              maxTextPreviewChars: traceCfg.maxTextPreviewChars ?? 160,
              maxCandidates: traceCfg.maxCandidates ?? 50,
            });
            const vector = await embeddings.embed(params.text, { agentId });
            const workspaceKey = ownershipFields.workspaceKey;
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

            // 0. Tombstone-Block: gleichlautende, zuvor gelöschte Erinnerung
            // im selben autorisierten Scope darf nicht still reaktiviert werden.
            const blockingTombstone = findBlockingTombstoneForCapture(baseDbPath, {
              agentId,
              text: params.text,
              scope,
              workspaceIdentity: ownershipFields.workspaceId || ownershipFields.workspaceKey,
              ownerUserId,
            });
            if (blockingTombstone) {
              if (blockingTombstone._blockReason) {
                host.logger.warn(`memory-lancedb-namespaced: tombstone registry ${blockingTombstone._blockReason} for agent=${agentId}: ${blockingTombstone._diagnostic || ""} — blocking capture fail-closed`);
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
            const existing = (await db.findSimilar(vector, params.text, duplicateThreshold))
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
                if (toolCtx.workspaceDir) appendCurationLog(toolCtx.workspaceDir, agentId, { event: "memory.rejected_duplicate", timestamp: new Date().toISOString(), agentId, memoryId: safeDuplicate.entry.id, text: params.text.slice(0, 200), category, origin, reason: `duplicate_score:${safeDuplicate.score.toFixed(3)}`, relatedId: safeDuplicate.entry.id });
                addTraceStoreDecision(trace, { action: "safe_duplicate", memoryId: safeDuplicate.entry.id, reason: `duplicate_score:${safeDuplicate.score.toFixed(3)}` });
                return { content: [{ type: "text", text: `Similar memory already exists: "${safeDuplicate.entry.text}"` }], details: { action: "duplicate", id: safeDuplicate.entry.id, decisionTrace: trace } };
              }
            }

            // 2. Merge check (+ conflict detection for decision category)
            if (mergingEnabled && mergingLlmCfg && mergingAutoApply) {
              const mergeCandidateRaw = await db.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
              const mergeCandidate = candidateVisibleForStore(mergeCandidateRaw, storeAccessCtx) ? mergeCandidateRaw : null;
              if (mergeCandidate) {
                addTraceStoreDecision(trace, { action: "merge_candidate", memoryId: mergeCandidate.entry.id, reason: `merge_score:${mergeCandidate.score.toFixed(3)}` });
                const durableMerge = await withDurableMerge({
                  db,
                  agentId,
                  selectedCandidate: mergeCandidate,
                  accessCtx: storeAccessCtx,
                  workspaceDir: toolCtx?.workspaceDir,
                  writeKey: durableMergeWriteKey({
                    workspaceKey,
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
                          callMergeCheck(authoritativeCandidate.text, params.text, mergingLlmCfg, agentId),
                          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
                        ]);
                      } catch (mergeErr) {
                        host.logger.warn("memory-lancedb-namespaced: merge check skipped", {
                          errorClass: normalizedLlmErrorClass(mergeErr),
                        });
                      }
                    }
                    // Conflict detection: log if decision from different agent
                    if (category === "decision" && toolCtx.workspaceDir && authoritativeCandidate.storedBy && authoritativeCandidate.storedBy !== agentId) {
                      const mergeDecision = mergeResult?.merge === true ? "merged" : "stored_separately";
                      appendConflictLog(toolCtx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: agentId, newText: params.text.slice(0, 200), existingMemoryId: authoritativeCandidate.id, existingAgentId: authoritativeCandidate.storedBy, existingText: authoritativeCandidate.text.slice(0, 200), score: mergeCandidate.score, category, mergeDecision });
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
                    const mergedVector = await embeddings.embed(mergeResult.mergedText, { agentId });
                    const { emotion: mergedEmotion, emotionStatus: mergedEmotionStatus } = await classifyEmotionForStore(mergeResult.mergedText, { agentId, importance: mergedImportance });
                    const mergedMoodContext = emotionalPool.snapshot(agentId);
                    const mergedValidTime = combineValidTimeForMerge(authoritativeCandidate, { validFrom: capturedValidFrom, validUntil: capturedValidUntil });
                    const mergedEntry = applyDynamicsDefaults({
                      id: replacementId, text: mergeResult.mergedText, summary: generateSummary(mergeResult.mergedText, summaryMaxWords), origin, vector: mergedVector,
                      importance: mergedImportance, category, createdAt: Date.now(), mergedFrom: JSON.stringify(durableMergeLineage(authoritativeCandidate)),
                      expiresAt, ...ownershipFields, sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: Date.now(), sourceUrl, evidenceQuote, scope,
                      ...durableMergeEpistemicMetadata(authoritativeCandidate),
                      emotionalValence: serializeEmotionalValence(mergedEmotion),
                      emotionalIntensity: mergedEmotion.emotionalIntensity,
                      emotionalDominant: mergedEmotion.emotionalDominant,
                      moodContextAtCapture: serializeEmotionalValence(mergedMoodContext),
                      emotionStatus: mergedEmotionStatus,
                      validFrom: mergedValidTime.validFrom, validUntil: mergedValidTime.validUntil,
                    }, Date.now(), halfLifeOverrides, { intensityHalfLifeFactor: emotionIntensityHalfLifeFactor, flashbulbEncodingEnabled });
                    return { mergedEntry, mergeResult, mergedImportance };
                  },
                });
                if (durableMerge) {
                  const { mergedEntry, mergeResult, mergedImportance, authoritativeCandidate } = durableMerge;
                  if (toolCtx.workspaceDir) appendCurationLog(toolCtx.workspaceDir, agentId, { event: "memory.merged", timestamp: new Date().toISOString(), agentId, memoryId: mergedEntry.id, text: mergeResult.mergedText.slice(0, 200), category, origin, reason: `merged_with:${authoritativeCandidate.id} (${mergeResult.reason || ""})`, relatedId: authoritativeCandidate.id });
                  if (toolCtx.workspaceDir && shouldPromoteMemory(category, mergedImportance, importanceResult.factQuality, schicht15MinImportance)) {
                    trackKnowledgePending(toolCtx.workspaceDir, { sourceAgent: agentId, memoryId: mergedEntry.id, category, importance: mergedImportance });
                  }
                  addTraceStoreDecision(trace, { action: "merge_allowed", memoryId: mergedEntry.id, reason: `merged_with:${authoritativeCandidate.id} (${mergeResult.reason || ""})` });
                  return { content: [{ type: "text", text: `Memory merged [${category}|${origin}]: "${mergeResult.mergedText}" (ID: ${mergedEntry.id})` }], details: { action: "merged", id: mergedEntry.id, decisionTrace: trace } };
                }
              }
            } else if (category === "decision" && toolCtx.workspaceDir) {
              // Merging disabled: read-only conflict check for decision memories
              try {
                const conflictCandidateRaw = await db.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
                const conflictCandidate = candidateVisibleForStore(conflictCandidateRaw, storeAccessCtx) ? conflictCandidateRaw : null;
                if (conflictCandidate && conflictCandidate.entry.storedBy && conflictCandidate.entry.storedBy !== agentId) {
                  appendConflictLog(toolCtx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: agentId, newText: params.text.slice(0, 200), existingMemoryId: conflictCandidate.entry.id, existingAgentId: conflictCandidate.entry.storedBy, existingText: conflictCandidate.entry.text.slice(0, 200), score: conflictCandidate.score, category, mergeDecision: "no_merge_llm_call" });
                }
              } catch (_e) { dbg(_e); }
            }

            // 3. Normal store
            const summary = generateSummary(params.text, summaryMaxWords);
            const { emotion, emotionStatus } = await classifyEmotionForStore(params.text, { agentId, importance });
            const moodContext = emotionalPool.snapshot(agentId);
            const entry = applyDynamicsDefaults({
              id: randomUUID(), text: params.text, summary, origin, vector, importance, category,
              createdAt: Date.now(), mergedFrom: "[]", expiresAt, ...ownershipFields,
              sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: Date.now(), sourceUrl, evidenceQuote, scope,
              epistemicStatus: decideEpistemicStatusForCapture({ text: params.text, sourceMessageRole: "", origin, cutoffFailed: !epistemicCutoffBoot.ok }),
              emotionalValence: serializeEmotionalValence(emotion),
              emotionalIntensity: emotion.emotionalIntensity,
              emotionalDominant: emotion.emotionalDominant,
              moodContextAtCapture: serializeEmotionalValence(moodContext),
              emotionStatus,
              validFrom: capturedValidFrom, validUntil: capturedValidUntil,
            }, Date.now(), halfLifeOverrides, { intensityHalfLifeFactor: emotionIntensityHalfLifeFactor, flashbulbEncodingEnabled });
            await db.store(entry);
            if (toolCtx.workspaceDir) appendCurationLog(toolCtx.workspaceDir, agentId, { event: "memory.stored", timestamp: new Date().toISOString(), agentId, memoryId: entry.id, text: params.text.slice(0, 200), category, origin, reason: "stored", relatedId: null });
            if (toolCtx.workspaceDir && shouldPromoteMemory(category, importance, importanceResult.factQuality, schicht15MinImportance)) {
              trackKnowledgePending(toolCtx.workspaceDir, { sourceAgent: agentId, memoryId: entry.id, category, importance });
            }
            addTraceStoreDecision(trace, { action: "stored_separately", memoryId: entry.id, reason: "stored" });
            return { content: [{ type: "text", text: `Memory stored [${category}|${origin}]: ${summary} (ID: ${entry.id})` }], details: { action: "stored", id: entry.id, decisionTrace: trace } };
            });
          } catch (err) {
            return { content: [{ type: "text", text: `Memory store failed: ${String(err)}` }] };
          }
        },
      },
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Remove a memory from long-term storage.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search to find memory" },
            memoryId: { type: "string", description: "Specific memory ID" },
          },
        },
        async execute(_toolCallId, params) {
          try {
            if (!modelDestructiveToolsAllowed()) {
              return blockModelDestructiveTool("memory_forget");
            }
            return await pool.withWriteDb(agentId, async (db) => {
            // Fail-closed Scope-Gate: jeder Treffer (ID, aktiv, gelöscht) wird
            // vor Archivierung, Tombstone oder Audit-Recovery ACL-geprüft.
            const cardAllowedForForget = (card) => {
              if (!card) return false;
              return checkAccess(memoryCtx, card).allowed;
            };
            if (params.memoryId) {
              // Kanonischer Tombstone-Vorgang (Archive-First, kein physischer Delete).
              // Bereits gelöschte Karten laufen durch denselben Recovery-Vertrag
              // (tombstoneMemoryWithAudit trägt fehlendes Audit nach) — kein
              // früher Return, der die Audit-Recovery umgehen würde.
              const card = await db.getById(params.memoryId);
              // Bewusst dieselbe Meldung wie bei ACL-Verweigerung unten: ein
              // eigener "not found"-Text wäre ein Existenz-Orakel für fremde IDs.
              if (!card) return { content: [{ type: "text", text: "No matching memory found." }] };
              if (!cardAllowedForForget(card)) {
                return { content: [{ type: "text", text: "No matching memory found." }] };
              }
              let archivePath = "";
              if (String(card.status || "") !== "deleted") {
                try {
                  archivePath = archiveCard(card, agentId || "default");
                } catch (archiveErr) {
                  return { content: [{ type: "text", text: `Archive failed — NOT tombstoned: ${String(archiveErr)}` }] };
                }
              }
              try {
                await tombstoneMemoryWithAudit({
                  db, card, agentId,
                  workspaceDir: toolCtx?.workspaceDir,
                  baseDbPath,
                  source: "memory_forget",
                  via: "id",
                  archivePath,
                });
              } catch (err) {
                host.logger.warn(`memory-lancedb-namespaced: memory_forget tombstone failed for agent=${agentId} memory=${params.memoryId}: ${String(err)}`);
                return { content: [{ type: "text", text: `Memory forget failed: ${String(err)}` }] };
              }
              return { content: [{ type: "text", text: `Memory ${params.memoryId} forgotten (tombstoned).` }] };
            }
            if (params.query) {
              const vector = typeof embeddings.embedQuery === "function"
                ? await embeddings.embedQuery(params.query, { agentId })
                : await embeddings.embed(params.query, { agentId });
              // Aktive Treffer vor Zählung/Anzeige ACL-filtern; unberechtigte
              // Treffer werden wie "No matching memory found" behandelt.
              const results = (await db.search(vector, 5, forgetThreshold))
                .filter((r) => cardAllowedForForget(r.entry));
              if (results.length === 0) {
                // Audit-Recovery: die Query kann eine bereits gelöschte Karte
                // treffen (z. B. nach einem Forget mit fehlgeschlagenem Audit).
                // Gelöschte Kandidaten gezielt auflösen, mit forgetThreshold
                // bewertet, ACL-geprüft, und recovery-fähig machen. KEIN Klartext
                // gelöschter Inhalte in Kandidatenlisten oder Erfolgsmeldungen.
                const deleted = await db.searchDeleted(vector, 5, forgetThreshold);
                const accessibleIds = [];
                for (const deletedRow of deleted) {
                  const deletedCard = await db.getById(deletedRow.id);
                  if (cardAllowedForForget(deletedCard)) accessibleIds.push(deletedRow.id);
                }
                if (accessibleIds.length === 0) {
                  return { content: [{ type: "text", text: "No matching memory found." }] };
                }
                if (accessibleIds.length > 1) {
                  return { content: [{ type: "text", text: `Found ${accessibleIds.length} already-forgotten candidates. Specify memoryId:\n${accessibleIds.join("\n")}` }] };
                }
                const deletedId = accessibleIds[0];
                const deletedCard = await db.getById(deletedId);
                if (!deletedCard) {
                  return { content: [{ type: "text", text: "No matching memory found." }] };
                }
                try {
                  await tombstoneMemoryWithAudit({
                    db, card: deletedCard, agentId,
                    workspaceDir: toolCtx?.workspaceDir,
                    baseDbPath,
                    source: "memory_forget",
                    via: "query",
                    query: params.query.slice(0, 200),
                    archivePath: "",
                  });
                } catch (err) {
                  host.logger.warn(`memory-lancedb-namespaced: memory_forget recovery failed for agent=${agentId} memory=${deletedId}: ${String(err)}`);
                  return { content: [{ type: "text", text: `Memory forget failed for ${deletedId}: ${String(err)}` }] };
                }
                return { content: [{ type: "text", text: `Forgotten (audit recovered for ${deletedId}).` }] };
              }
              if (results.length > 1) {
                const list = results.map((r) => `${r.entry.id}: ${r.entry.text}`).join("\n");
                return { content: [{ type: "text", text: `Found ${results.length} candidates. Specify memoryId:\n${list}` }] };
              }
              const targetId = results[0].entry.id;
              let archivePath = "";
              let card;
              try {
                card = await db.getById(targetId);
                if (String(card?.status || "") !== "deleted") {
                  archivePath = archiveCard(card || results[0].entry, agentId || "default");
                }
              } catch (archiveErr) {
                return { content: [{ type: "text", text: `Archive failed — NOT tombstoned: ${String(archiveErr)}` }] };
              }
              try {
                await tombstoneMemoryWithAudit({
                  db, card: card || results[0].entry, agentId,
                  workspaceDir: toolCtx?.workspaceDir,
                  baseDbPath,
                  source: "memory_forget",
                  via: "query",
                  query: params.query.slice(0, 200),
                  archivePath,
                });
              } catch (err) {
                host.logger.warn(`memory-lancedb-namespaced: memory_forget tombstone failed for agent=${agentId} memory=${targetId}: ${String(err)}`);
                return { content: [{ type: "text", text: `Memory forget failed for ${targetId}: ${String(err)}` }] };
              }
              return { content: [{ type: "text", text: `Forgotten: "${results[0].entry.text}" (tombstoned).` }] };
            }
            return { content: [{ type: "text", text: "Provide query or memoryId." }] };
            });
          } catch (err) {
            return { content: [{ type: "text", text: `Memory forget failed: ${String(err)}` }] };
          }
        },
      },
      {
        name: "knowledge_update",
        label: "Knowledge Update",
        description: "Curate important memories (decisions, high-importance facts) into KNOWLEDGE.md. Call this when you make an architecture decision, formulate a stable preference, complete a project, or store something with importance ≥ 0.85. Only available when Schicht 1.5 is enabled.",
        parameters: {
          type: "object",
          properties: {
            note: { type: "string", description: "Optional context note for this update run" },
          },
        },
        async execute(_toolCallId, params) {
          if (!modelDestructiveToolsAllowed()) {
            return blockModelDestructiveTool("knowledge_update");
          }
          if (!schicht15Enabled || !schicht15LlmCfg) {
            return { content: [{ type: "text", text: "Schicht 1.5 is not enabled. Enable it in plugin config." }] };
          }
          if (!toolCtx.workspaceDir) {
            return { content: [{ type: "text", text: "knowledge_update: workspaceDir not available." }] };
          }

          return pool.withWriteDb(agentId, async (db) => {
          // Pending snapshot: hold only the short pending-file lock, then release
          // before attempting the KNOWLEDGE.md lock.
          const pendingSnapshot = readKnowledgePendingSnapshot(toolCtx.workspaceDir);
          const agentPending = pendingSnapshot.pending.filter(p => p.sourceAgent === agentId);
          const pendingIds = agentPending.map(p => p.memoryId);

          // Mutex via lock file — atomic acquire with wx flag (exclusive create)
          const lockPath = join(toolCtx.workspaceDir, ".adaptive-learning", KNOWLEDGE_LOCK_FILE);
          // Staleness check: remove lock files older than 5 minutes (crash recovery)
          if (existsSync(lockPath)) {
            try {
              const lockAge = Date.now() - statSync(lockPath).mtimeMs;
              if (lockAge > 5 * 60 * 1000) {
                const { unlinkSync } = await import("node:fs");
                unlinkSync(lockPath);
                host.logger.warn("memory-lancedb-namespaced: removed stale knowledge lock file");
              } else {
                return { content: [{ type: "text", text: "knowledge_update: another update is already running (lock file exists). Try again in a moment." }] };
              }
            } catch (_) {
              return { content: [{ type: "text", text: "knowledge_update: lock file check failed. Try again." }] };
            }
          }
          try {
            // Atomic lock acquire with exponential backoff retry
            const { closeSync } = await import("node:fs");
            let acquired = false;
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                const fd = openSync(lockPath, "wx");
                writeFileSync(fd, new Date().toISOString());
                closeSync(fd);
                acquired = true;
                break;
              } catch (lockErr) {
                if (lockErr.code !== "EEXIST") throw lockErr;
                // Lock exists — wait with backoff and retry
                await new Promise(r => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)));
              }
            }
            if (!acquired) {
              return { content: [{ type: "text", text: "knowledge_update: could not acquire lock after 5 attempts. Try again later." }] };
            }

            // Fetch pending memories from DB
            let pendingTexts = [];
            if (pendingIds.length > 0) {
              try {
                await db.init();
                const queriedIds = selectSafeUuids(pendingIds, 100);
                const inList = safeUuidList(pendingIds, 100);
                if (inList === null) {
                  host.logger.warn(`memory-lancedb-namespaced: knowledge_update — keine valid UUIDs in ${pendingIds.length} pending IDs`);
                } else {
                  const rows = await db.table.query().where(`id IN (${inList})`).toArray();
                  const keyById = new Map(agentPending.map(p => [p.memoryId, p.key]));
                  // Never promote an invalidated memory into canonical
                  // KNOWLEDGE.md — that store has no per-chapter status once
                  // written, so this is the only exclusion point available.
                  pendingTexts = rows
                    .filter(r => normalizeEpistemicStatus(r.epistemicStatus) !== "invalidated")
                    .map(r => ({ id: r.id, text: r.text, category: r.category || "fact", scope: r.scope || "agent-private", importance: r.importance ?? 0.5, pendingKey: keyById.get(r.id) }));
                  // Drop what can never be promoted (invalidated or gone from
                  // the table). Only the ids this query actually asked for —
                  // everything else stays queued. Without this the entries
                  // pile up forever and keep the maintenance nudge counting
                  // work that no longer exists.
                  const stalePendingKeys = selectStalePendingKeys({ pending: agentPending, rows, queriedIds });
                  if (stalePendingKeys.length > 0) {
                    removeKnowledgePending(toolCtx.workspaceDir, stalePendingKeys);
                    host.logger.info(`memory-lancedb-namespaced: knowledge_update — ${stalePendingKeys.length} nicht promotbare Warteschlangeneinträge entfernt (agent=${agentId})`);
                  }
                }
              } catch (fetchErr) {
                host.logger.warn(`memory-lancedb-namespaced: knowledge_update DB fetch failed: ${String(fetchErr)}`);
              }
            }

            // Dedupe: filter already promoted memories (by memoryId + contentHash)
            const workspaceKey = toolCtx.workspaceKey || toolCtx.workspaceDir || "default";
            pendingTexts = pendingTexts.filter(m => !isKnowledgePromoted(toolCtx.workspaceDir, workspaceKey, agentId, m.id, computeContentHash(m)));
            if (pendingTexts.length === 0 && !params?.note) {
              return { content: [{ type: "text", text: "No pending memories to integrate into KNOWLEDGE.md." }] };
            }

            // Respect maxPromotionsPerRun
            if (schicht15MaxPromotions > 0) {
              const promoCheck = checkMaxPromotions(toolCtx.workspaceDir, workspaceKey, agentId, schicht15MaxPromotions);
              if (!promoCheck.allowed) {
                return { content: [{ type: "text", text: `KNOWLEDGE.md promotion limit reached (${promoCheck.current}/${promoCheck.max}). Try again later.` }] };
              }
              const remaining = schicht15MaxPromotions - promoCheck.current;
              if (pendingTexts.length > remaining) {
                pendingTexts = pendingTexts.slice(0, remaining);
                host.logger.info(`memory-lancedb-namespaced: knowledge_update truncated to ${remaining} pending memories (maxPromotionsPerRun)`);
              }
            }

            // Build update prompt
            const memDir = join(toolCtx.workspaceDir, "memory");
            const knowledgePath = join(memDir, "KNOWLEDGE.md");
            let currentContent = "";
            try {
              if (existsSync(knowledgePath)) currentContent = readFileSync(knowledgePath, "utf8");
            } catch (_e) { dbg(_e); }

            // Strip frontmatter — LLM should never touch it
            const { frontmatter: existingFm, body: currentBody } = stripFrontmatter(currentContent);
            const sourceMemoryIds = pendingTexts.map(m => m.id);
            let mergedSources = sourceMemoryIds;
            if (existingFm) {
              const m = existingFm.match(/source_memories:\s*\n((?:\s+-\s+.+\n?)*)/);
              if (m) {
                const oldIds = m[1].split("\n").map(l => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean);
                mergedSources = [...new Set([...oldIds, ...sourceMemoryIds])];
              }
            }

            const today = new Date().toISOString().slice(0, 10);
            const newEntriesBlock = pendingTexts.length > 0
              ? pendingTexts.map(m => `- category=${m.category}, importance=${m.importance.toFixed(1)}: ${m.text}`).join("\n")
              : `(no pending memories — manual trigger${params?.note ? `: ${params.note}` : ""})`;

            const updated = await callLlm([
              {
                role: "user",
                content: `Current KNOWLEDGE.md body (empty = not yet created):\n${currentBody || "(empty)"}\n\nNew memories to integrate (date=${today}):\n${newEntriesBlock}${params?.note ? `\n\nCurator note: ${params.note}` : ""}\n\nIntegrate these into the KNOWLEDGE.md body.\n- Do not rewrite the document from scratch.\n- Preserve existing wording unless merging an exact duplicate or lightly compacting closely related points.\n- Only add or merge knowledge that is directly supported by the new memories.\n- Add entries under appropriate sections with today's date.\n- If an existing entry is logically identical, replace it instead of adding a duplicate.\n- Return ONLY the Markdown body, NO YAML frontmatter, NO explanation, NO code block wrapper.`,
              },
            ], withDeterministicLlmContext(
              schicht15LlmCfg,
              agentId,
              LLM_RESULT_CACHE_PURPOSES.KNOWLEDGE_UPDATE,
              // No temperature: providers like the Kimi coding endpoint allow exactly
              // one value per thinking mode and answer HTTP 400 for anything else.
              // Das Budget waechst mit dem Bestand: der Aufruf gibt den ganzen
              // Textkoerper zurueck, ein fester Deckel von 3000 lief mit der
              // Datei aus dem Ruder (09.09.2026: 2752 bzw. 3121 Token allein
              // fuer den Bestand, beide Laeufe schlugen fehl).
              // Zeit und Menge gehoeren zusammen: der Standard von 30 s reicht
              // nur fuer eine kleine Datei. Fuer die gewachsenen lief derselbe
              // Aufruf seit dem 01.07.2026 in TimeoutError.
              (() => {
                const maxTokens = resolveKnowledgeUpdateMaxTokens(currentBody);
                return { maxTokens, timeoutMs: resolveKnowledgeUpdateTimeoutMs(maxTokens) };
              })(),
              { agentId },
            ));

            if (!updated) {
              return { content: [{ type: "text", text: "knowledge_update: LLM returned empty result." }] };
            }
            // Der Aufruf soll integrieren, nicht kuerzen. Kaeme die Antwort
            // abgeschnitten zurueck, wuerde sie hier ungeprueft ueber den
            // Bestand geschrieben und Wissen vernichten.
            if (isTruncatedKnowledgeBody(currentBody, updated)) {
              host.logger.warn(`memory-lancedb-namespaced: knowledge_update verworfen — Antwort (${updated.trim().length} Zeichen) deutlich kuerzer als der Bestand (${currentBody.trim().length}); KNOWLEDGE.md bleibt unveraendert`);
              return { content: [{ type: "text", text: "knowledge_update: the model returned a shortened body; KNOWLEDGE.md was left untouched." }] };
            }

            let finalBody = updated;

            // Compaction if >200 lines
            if (finalBody.split("\n").length > 200) {
              const compacted = await callLlm([
                {
                  role: "user",
                  content: `The following KNOWLEDGE.md body has grown too large (>200 lines). Consolidate it thematically — do NOT simply truncate.\n\nRules:\n1. Keep ALL unique facts and decisions — lose no information.\n2. Group thematically related entries under a shared point.\n3. Structure: Domain → Category → consolidated fact (Context-Tree style).\n4. If multiple entries describe the same concept from different angles, write one entry covering all aspects.\n5. Keep the date of the oldest merged entry.\n6. Target: max 150 lines, achieved only through real consolidation.\n7. Return ONLY the updated Markdown body, NO YAML frontmatter, NO code block wrapper.\n\n${finalBody}`,
                },
              ], withDeterministicLlmContext(
                schicht15LlmCfg,
                agentId,
                LLM_RESULT_CACHE_PURPOSES.KNOWLEDGE_UPDATE,
                // No temperature: providers like the Kimi coding endpoint allow exactly
                // one value per thinking mode and answer HTTP 400 for anything else.
                // Die Verdichtung soll kuerzen, braucht aber Luft fuer den
                // Zwischenstand; das Ziel von 150 Zeilen deckelt das Ergebnis.
                (() => {
                  const maxTokens = resolveKnowledgeUpdateMaxTokens(finalBody, { floor: 4000 });
                  return { maxTokens, timeoutMs: resolveKnowledgeUpdateTimeoutMs(maxTokens) };
                })(),
                { agentId },
              ));

              const compactedLines = compacted?.split("\n").length ?? Infinity;
              if (compacted && compactedLines <= 150) {
                finalBody = compacted;
                host.logger.info(`memory-lancedb-namespaced: KNOWLEDGE.md compacted to ${compactedLines} lines`);
              } else {
                host.logger.warn(`memory-lancedb-namespaced: KNOWLEDGE.md compaction skipped: result (${compactedLines} lines) not ≤150`);
              }
            }

            // Re-attach frontmatter (last_verified updated, source_memories merged)
            const finalContent = withFrontmatter(finalBody, { agentId, sourceMemoryIds: mergedSources, today });

            // Atomic write
            if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
            const tmpPath = knowledgePath + ".tmp";
            writeFileSync(tmpPath, finalContent, "utf8");
            renameSync(tmpPath, knowledgePath);

            // Pending cleanup: under the KNOWLEDGE lock, briefly re-lock pending,
            // re-read current state, and subtract only successfully integrated keys.
            removeKnowledgePending(toolCtx.workspaceDir, pendingTexts.map(m => m.pendingKey).filter(Boolean));

            // Track promoted memories for dedupe (memoryId + contentHash)
            for (const m of pendingTexts) {
              recordKnowledgePromotion(toolCtx.workspaceDir, workspaceKey, agentId, m.id, computeContentHash(m));
            }

            const lineCount = finalContent.split("\n").length;
            return { content: [{ type: "text", text: `KNOWLEDGE.md updated (${pendingTexts.length} memories integrated, ${lineCount} lines total).` }] };
          } catch (err) {
            // Die Ursache stand bisher nur im strukturierten Teil, der nicht
            // serialisiert wird — im Log blieb eine Meldung ohne Aussage, und
            // der Agent gab sie so an den Nutzer weiter. Am 09.09.2026 hat das
            // die Suche nach dem eigentlichen Fehler mehrfach in die Irre
            // gefuehrt. Klasse und Meldung gehoeren in die Zeile.
            // Nur die Klasse, niemals die Meldung: Provider-Fehler tragen
            // Prompt-Fragmente und Zugangsdaten, und genau das sichert
            // "Schicht 1.5 sanitizes provider failures in responses and logs"
            // zu. Die Klasse stand bisher nur im strukturierten Teil des
            // Log-Aufrufs, der nicht serialisiert wird — im Log blieb eine
            // Zeile ohne Aussage, und die Sammelformel "provider or file
            // operation unavailable" warf zwei verschiedene Ursachen
            // zusammen. Am 09.09.2026 hat das die Fehlersuche mehrfach in
            // die Irre gefuehrt.
            const errorClass = normalizedLlmErrorClass(err);
            host.logger.warn(`memory-lancedb-namespaced: knowledge_update failed (class=${errorClass})`);
            return { content: [{ type: "text", text: `knowledge_update failed (${errorClass}).` }] };
          } finally {
            // Release lock
            try { if (existsSync(lockPath)) { const { unlinkSync } = await import("node:fs"); unlinkSync(lockPath); } } catch (_e) { dbg(_e); }
          }
          });
        },
      },
    ];
    return guardWorkspaceTools(workspaceTools, workspacePolicyGuard.decision(memoryCtx));
  };
}
