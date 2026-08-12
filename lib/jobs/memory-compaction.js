/**
 * lib/jobs/memory-compaction.js — LanceDB Memory Compaction.
 *
 * Reduziert Redundanz in der LanceDB-Tabelle durch:
 *   1. Duplikat-Erkennung (identischer Text)
 *   2. Ähnlichkeits-Clustering (cosine similarity >= threshold)
 *   3. Merge kompatibler Memories via LLM
 *   4. Konflikt-Markierung bei Widersprüchen
 *
 * Batch-Operation: Sammelt alle Änderungen, führt sie sequentiell aus.
 * Idempotent via SHA256-Digest der betroffenen IDs.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cosineSimilarityVec } from "../text-utils.js";
import { safeUuid } from "../sql-safety.js";
import { withTimeout, TimeoutError } from "../with-timeout.js";
import { safeWarnLlmFailure, withAbortableLlmTimeout } from "../llm-failure.js";
import { normalizeEpistemicStatus, combineEpistemicStatusForMerge } from "../epistemic-status.js";
import {
  LLM_RESULT_CACHE_PURPOSES,
  withLlmCallContext,
  withLlmResultCacheContext,
} from "../llm-result-cache.js";

const DEFAULT_OPTS = {
  similarityThreshold: 0.88,
  lookbackDays: 30,
  maxBatchSize: 50,
  dryRun: false,
  autoApply: true,
  llmMergeTimeoutMs: 30000,
};

const DEFAULT_COMPACTION_TIMEOUT_MS = 300_000; // 5 minutes

// ─── Utilities ─────────────────────────────────────────────────────────────

function computeCompactionDigest(actions) {
  const canonical = actions
    .map(a => `${a.type}:${a.id}${a.targetId ? ":" + a.targetId : ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function isIdenticalText(a, b) {
  return String(a.text || "").trim().toLowerCase() === String(b.text || "").trim().toLowerCase();
}

function isCompatibleText(a, b) {
  const ta = String(a.text || "").trim().toLowerCase();
  const tb = String(b.text || "").trim().toLowerCase();
  if (ta === tb) return true;
  // Wenn einer den anderen komplett enthält → kompatibel
  if (ta.includes(tb) || tb.includes(ta)) return true;
  return false;
}

/**
 * Ask the LLM for one deterministic agent-scoped compaction merge decision.
 * @param {string} existingText
 * @param {string} newText
 * @param {object} llmCfg
 * @param {Function} callLlm
 * @param {number} timeoutMs
 * @param {string} agentId
 * @param {object} logger
 * @returns {Promise<object|null>}
 */
async function callMergeCheck(existingText, newText, llmCfg, callLlm, timeoutMs, agentId, logger) {
  const A = String(existingText || "").slice(0, 2000);
  const B = String(newText || "").slice(0, 2000);
  const prompt = `Two memory fragments — should they be merged into one?\n\nFragment A: ${A}\nFragment B: ${B}\n\nRespond with JSON only: {"merge": boolean, "reason": "brief explanation", "mergedText": "merged version (only if merge=true)"}\nRules:\n- merge=true only if both fragments describe the same subject/fact from different angles\n- mergedText must contain ALL information from both fragments\n- mergedText must be longer than the shorter of the two fragments`;
  const callContext = llmCfg?.callContext || {};

  try {
    const result = await withAbortableLlmTimeout(
      (signal) => callLlm(
        [{ role: "user", content: prompt }],
        withLlmCallContext(
          withLlmResultCacheContext(
            { ...llmCfg, jsonMode: true, maxTokens: 300, temperature: 0 },
            agentId,
            LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION,
          ),
          callContext.agentId || (typeof callContext.runtimeLlm?.complete === "function" ? undefined : agentId),
          LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION,
          { runtimeLlm: callContext.runtimeLlm, signal },
        ),
      ),
      {
        timeoutMs,
        signal: callContext.signal,
        label: "memory compaction merge check",
      },
    );
    if (!result) return null;
    const parsed = JSON.parse(result);
    if (typeof parsed?.merge !== "boolean" || typeof parsed?.reason !== "string") return null;
    if (parsed.merge && typeof parsed.mergedText !== "string") return null;
    return parsed;
  } catch (err) {
    safeWarnLlmFailure(logger, "memory-compaction.llm-merge", err);
    return null;
  }
}

// ─── Load Candidates ───────────────────────────────────────────────────────

async function loadCompactionCandidates(table, lookbackDays) {
  const cutoffMs = Date.now() - lookbackDays * 86400000;
  const rows = await table.query().limit(5000).toArray();
  return rows
    .filter(r => r.id !== '__schema__')
    .filter(r => (!r.status || r.status === 'active'))
    // An invalidated memory must never be auto-compacted (merged/aliased into
    // another memory, or used as a merge target) — that would let a retracted
    // fact re-enter the live memory graph under a different id (see plan §7a,
    // Blocker 1).
    .filter(r => normalizeEpistemicStatus(r.epistemicStatus) !== "invalidated")
    .filter(r => r.memoryClass !== "core" && r.neverForget !== true && r.neverForget !== 1)
    .filter(r => (r.createdAt || 0) >= cutoffMs)
    .map(r => ({
      id: r.id,
      text: r.text || "",
      summary: r.summary || "",
      vector: r.vector,
      createdAt: r.createdAt || 0,
      importance: r.importance ?? 0.5,
      category: r.category || "other",
      origin: r.origin || "dm",
      storedBy: r.storedBy || "",
      confirmed: r.confirmed === true || r.confirmed === 1,
      epistemicStatus: r.epistemicStatus || "",
    }));
}

// ─── Similarity Graph ──────────────────────────────────────────────────────

function buildSimilarityPairs(memories, threshold) {
  const pairs = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      if (!a.vector || !b.vector) continue;
      const sim = cosineSimilarityVec(a.vector, b.vector);
      if (sim >= threshold) {
        pairs.push({ a, b, similarity: sim });
      }
    }
  }
  return pairs.sort((p1, p2) => p2.similarity - p1.similarity);
}

// ─── Union-Find für Connected Components ───────────────────────────────────

class UnionFind {
  constructor(items) {
    this.parent = new Map();
    for (const item of items) this.parent.set(item.id, item.id);
  }
  find(id) {
    if (this.parent.get(id) !== id) {
      this.parent.set(id, this.find(this.parent.get(id)));
    }
    return this.parent.get(id);
  }
  union(idA, idB) {
    const rootA = this.find(idA);
    const rootB = this.find(idB);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

function clusterBySimilarity(pairs, memories) {
  const uf = new UnionFind(memories);
  for (const pair of pairs) {
    uf.union(pair.a.id, pair.b.id);
  }
  const groups = new Map();
  for (const mem of memories) {
    const root = uf.find(mem.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(mem);
  }
  // Nur Gruppen mit >= 2 Mitgliedern sind interessant
  return [...groups.values()].filter(g => g.length >= 2);
}

// ─── Action Generation ─────────────────────────────────────────────────────

/**
 * Generate compaction actions for a similarity cluster.
 * @param {Array<object>} cluster
 * @param {object} opts
 * @param {string} opts.agentId
 * @returns {Promise<Array<object>>}
 */
async function generateCompactionActions(cluster, opts) {
  const { llmCfg, callLlm, llmMergeTimeoutMs, logger, agentId } = opts;
  const actions = [];

  // Sortiere nach createdAt desc → neueste zuerst
  const sorted = [...cluster].sort((a, b) => b.createdAt - a.createdAt);
  const keep = sorted[0];

  // Prüfe auf identische Duplikate
  const duplicates = sorted.slice(1).filter(m => isIdenticalText(m, keep));
  for (const dup of duplicates) {
    actions.push({ type: "delete", id: dup.id, targetId: keep.id, reason: "identical_duplicate", similarity: 1.0 });
  }

  // Verbleibende: kompatibel oder widersprüchlich
  const remaining = sorted.slice(1).filter(m => !duplicates.includes(m));
  for (const mem of remaining) {
    if (isCompatibleText(mem, keep)) {
      // Versuche Merge via LLM
      if (llmCfg && callLlm) {
        const mergeResult = await callMergeCheck(
          keep.text,
          mem.text,
          llmCfg,
          callLlm,
          llmMergeTimeoutMs,
          agentId,
          logger,
        );
        if (mergeResult?.merge === true && mergeResult.mergedText && mergeResult.mergedText.length > Math.min(keep.text.length, mem.text.length)) {
          actions.push({
            type: "merge",
            id: keep.id,
            targetId: mem.id,
            mergedText: mergeResult.mergedText,
            reason: `llm_merge: ${mergeResult.reason || ""}`,
            similarity: cosineSimilarityVec(keep.vector, mem.vector),
          });
          continue;
        }
      }
      // Kein Merge möglich → behalte beide, aber markiere als potenziell redundant
      actions.push({ type: "mark_redundant", id: mem.id, targetId: keep.id, reason: "compatible_but_not_merged" });
    } else {
      // Widersprüchlich → Konflikt
      actions.push({ type: "mark_conflict", id: mem.id, targetId: keep.id, reason: "contradictory_content" });
    }
  }

  return actions;
}

// ─── Action Execution ──────────────────────────────────────────────────────

function appendAlias(workspaceDir, alias) {
  if (!workspaceDir) return;
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "memory-aliases.jsonl");
  appendFileSync(path, JSON.stringify(alias) + "\n", "utf8");
}

async function tryArchive(table, id, logger) {
  try {
    const safe = safeUuid(id);
    await table.update({
      where: `id = '${safe}'`,
      values: { status: "archived" },
    });
    logger?.info?.(`memory-compaction: archived ${id}`);
    return true;
  } catch (err) {
    logger?.warn?.(`memory-compaction: archive failed for ${id}: ${err.message}`);
    return false;
  }
}

function persistProposals(workspaceDir, actions, logger) {
  if (!workspaceDir) return;
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "merge-proposals.jsonl");
  const entry = {
    proposedAt: Date.now(),
    actions,
    status: "pending",
  };
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    logger?.info?.(`memory-compaction: persisted ${actions.length} proposals for approval`);
  } catch (err) {
    logger?.warn?.(`memory-compaction: failed to persist proposals: ${err.message}`);
  }
}

function isLowRiskAutoApplyAction(action) {
  return action?.type === "delete" && action.reason === "identical_duplicate";
}

async function executeActions(table, actions, candidates, dryRun, autoApply, logger, workspaceDir, embeddings) {
  if (dryRun) {
    logger?.info?.(`memory-compaction: dry-run, ${actions.length} actions would execute`);
    return { executed: 0, dryRun: true, actions };
  }

  if (!autoApply) {
    persistProposals(workspaceDir, actions, logger);
    return { executed: 0, autoApply: false, proposals: actions.length, actions };
  }

  const lowRiskActions = actions.filter(isLowRiskAutoApplyAction);
  const proposalActions = actions.filter((action) => !isLowRiskAutoApplyAction(action));
  if (proposalActions.length > 0) {
    persistProposals(workspaceDir, proposalActions, logger);
  }

  let executed = 0;
  const errors = [];
  const memoryMap = new Map(candidates.map(m => [m.id, m]));

  for (const action of lowRiskActions) {
    try {
      switch (action.type) {
        case "delete": {
          // Non-destructive: Alias statt hard delete
          appendAlias(workspaceDir, {
            oldId: action.id,
            canonicalId: action.targetId,
            reason: "duplicate",
            createdAt: Date.now(),
          });
          await tryArchive(table, action.id, logger);
          executed++;
          logger?.info?.(`memory-compaction: aliased duplicate ${action.id} → ${action.targetId}`);
          break;
        }
        case "merge": {
          const target = memoryMap.get(action.id);
          if (!target) {
            errors.push({ action, error: "target not found in candidates" });
            break;
          }
          // Blocker 1 / plan §7b: the previous code only ever loaded `target`
          // (action.id, the "keep" side) and spread it wholesale into the
          // merged row — the "other" side (action.targetId, the row being
          // merged away) was never consulted for epistemicStatus at all, so
          // a disputed/untrusted memory merged INTO a trusted one would
          // silently inherit "trusted". Load both sides explicitly.
          const other = memoryMap.get(action.targetId);
          const mergedId = randomUUID();
          // Archive both originals
          appendAlias(workspaceDir, {
            oldId: action.id,
            canonicalId: mergedId,
            reason: "merged",
            createdAt: Date.now(),
          });
          appendAlias(workspaceDir, {
            oldId: action.targetId,
            canonicalId: mergedId,
            reason: "merged",
            createdAt: Date.now(),
          });
          await tryArchive(table, action.id, logger);
          await tryArchive(table, action.targetId, logger);
          // Add merged with FRESH embedding for the new text
          try {
            let mergedVector = target.vector;
            if (embeddings && typeof embeddings.embed === "function") {
              try {
                mergedVector = await embeddings.embed(action.mergedText);
              } catch (embedErr) {
                logger?.warn?.(`memory-compaction: re-embed failed, using old vector: ${embedErr.message}`);
              }
            }
            const merged = {
              ...target,
              id: mergedId,
              text: action.mergedText,
              summary: action.mergedText.split("\n")[0].slice(0, 200),
              vector: mergedVector,
              createdAt: Date.now(),
              mergedFrom: JSON.stringify([action.id, action.targetId]),
              // See combineEpistemicStatusForMerge() (plan §7b): the merge
              // result takes the MORE CONSERVATIVE of the two source
              // statuses, not just `target`'s. `other` may be undefined if
              // it fell out of `candidates` between action-generation and
              // execution; normalizeEpistemicStatus(undefined) resolves
              // fail-closed to "untrusted", which is the correct
              // conservative default for that edge case too.
              epistemicStatus: combineEpistemicStatusForMerge(target.epistemicStatus, other?.epistemicStatus),
              epistemicStatusActor: "system:merge",
              epistemicStatusReason: `compaction merge of ${action.id} + ${action.targetId}`,
              epistemicStatusUpdatedAt: Date.now(),
              previousEpistemicStatus: normalizeEpistemicStatus(target.epistemicStatus),
            };
            if (merged.vector && !Array.isArray(merged.vector)) {
              merged.vector = Array.from(merged.vector);
            }
            await table.add([merged]);
          } catch (addErr) {
            logger?.warn?.(`memory-compaction: merged add failed, aliases preserved: ${addErr.message}`);
          }
          executed += 2;
          logger?.info?.(`memory-compaction: aliased merge ${action.id} + ${action.targetId} → ${mergedId}`);
          break;
        }
        case "mark_redundant":
        case "mark_conflict": {
          logger?.info?.(`memory-compaction: ${action.type} ${action.id} (vs ${action.targetId})`);
          break;
        }
      }
    } catch (err) {
      errors.push({ action, error: err.message });
      logger?.warn?.(`memory-compaction: action failed: ${action.type} ${action.id}: ${err.message}`);
    }
  }

  return {
    executed,
    errors: errors.length,
    errorDetails: errors.slice(0, 5),
    autoApply: true,
    autoApplyRisk: "low-only",
    proposals: proposalActions.length,
  };
}

// ─── Hauptfunktion ─────────────────────────────────────────────────────────

/**
 * Compact one agent's memory table and optionally use deterministic LLM merge decisions.
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 * @returns {Promise<object>}
 */
export async function runMemoryCompaction(db, opts = {}) {
  const mergedOpts = { ...DEFAULT_OPTS, ...opts };
  const {
    timeoutMs = DEFAULT_COMPACTION_TIMEOUT_MS,
    logger = { info: () => {}, warn: () => {} },
  } = mergedOpts;

  try {
    return await withTimeout(
      runMemoryCompactionBody(db, mergedOpts),
      timeoutMs,
      "memory-compaction",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      logger.warn?.(`memory-compaction: timed out after ${timeoutMs}ms`);
      return { compacted: 0, merged: 0, deleted: 0, note: "timeout", timeoutMs, durationMs: timeoutMs };
    }
    throw err;
  }
}

async function runMemoryCompactionBody(db, mergedOpts) {
  const {
    similarityThreshold,
    lookbackDays,
    maxBatchSize: requestedBatchSize,
    dryRun,
    autoApply,
    llmCfg,
    callLlm,
    llmMergeTimeoutMs,
    agentId,
    logger = { info: () => {}, warn: () => {} },
    neoStore,
    workspaceDir,
    embeddings,
  } = mergedOpts;

  // Lokale Provider (CPU/GPU) sind langsamer — Batch-Größe automatisch reduzieren
  const isLocalProvider = embeddings?.id === "local-transformers";
  const maxBatchSize = isLocalProvider
    ? Math.min(requestedBatchSize ?? 50, 10)
    : (requestedBatchSize ?? 50);

  const startTime = Date.now();

  if (!db || !db.table) {
    return { compacted: 0, merged: 0, deleted: 0, note: "db.table missing", durationMs: 0 };
  }

  // Idempotenz-Prüfung
  const statePath = neoStore?.paths?.runs;
  let previousDigest = "";
  if (statePath && neoStore.readRunState) {
    const state = neoStore.readRunState();
    previousDigest = state.compaction?.lastDigest || "";
  }

  const candidates = await loadCompactionCandidates(db.table, lookbackDays);
  if (candidates.length < 2) {
    return { compacted: 0, merged: 0, deleted: 0, candidates: candidates.length, note: "too_few_candidates", durationMs: Date.now() - startTime };
  }

  logger.info?.(`memory-compaction: ${candidates.length} candidates loaded`);

  // Begrenze auf maxBatchSize für Performance
  const batch = candidates.slice(0, maxBatchSize);
  const pairs = buildSimilarityPairs(batch, similarityThreshold);
  const clusters = clusterBySimilarity(pairs, batch);

  if (clusters.length === 0) {
    return { compacted: 0, merged: 0, deleted: 0, candidates: batch.length, note: "no_clusters", durationMs: Date.now() - startTime };
  }

  logger.info?.(`memory-compaction: ${clusters.length} clusters found`);

  const allActions = [];
  for (const cluster of clusters) {
    const actions = await generateCompactionActions(cluster, {
      llmCfg,
      callLlm,
      llmMergeTimeoutMs,
      logger,
      agentId,
    });
    allActions.push(...actions);
  }

  const digest = computeCompactionDigest(allActions);
  if (digest === previousDigest) {
    return { compacted: 0, merged: 0, deleted: 0, note: "already_compacted", durationMs: Date.now() - startTime };
  }

  const result = await executeActions(db.table, allActions, batch, dryRun, autoApply, logger, workspaceDir, embeddings);

  const deleted = allActions.filter(a => a.type === "delete").length;
  const merged = allActions.filter(a => a.type === "merge").length;

  // State speichern nur wenn autoApply aktiv (oder dryRun) — bei Pending-Proposals
  // soll der gleiche Digest beim nächsten Lauf erneut generiert werden.
  if (neoStore?.markRunCompleted && !dryRun && autoApply) {
    neoStore.markRunCompleted(`compaction:${db.dbPath || "unknown"}`, {
      digest,
      deleted,
      merged,
      clusters: clusters.length,
      durationMs: Date.now() - startTime,
    });
  }

  logger.info?.(`memory-compaction: ${deleted} deleted, ${merged} merged, ${result.errors || 0} errors`);

  return {
    compacted: allActions.length,
    deleted,
    merged,
    clusters: clusters.length,
    candidates: batch.length,
    dryRun,
    autoApply,
    autoApplyRisk: result.autoApplyRisk,
    executed: result.executed || 0,
    proposals: result.proposals || 0,
    durationMs: Date.now() - startTime,
    errors: result.errors || 0,
  };
}
