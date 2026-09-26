/**
 * engine/knowledge/knowledge-pending.js — the KNOWLEDGE.md pending-queue, lock and update helpers, and the curation log they append to.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripFrontmatter, withFrontmatter } from "../../lib/frontmatter.js";
import { LLM_RESULT_CACHE_PURPOSES } from "../../lib/llm-result-cache.js";
import { dbg } from "../runtime/debug-log.js";
import { callLlm, withDeterministicLlmContext } from "../runtime/llm-calls.js";

// ============================================================================
// Curation-Log
// ============================================================================

function appendCurationLog(workspaceDir, agentId, entry) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "curation-log.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (_) { /* non-blocking — log errors silently */ }
}

// ============================================================================
// Schicht 1.5 — Pending-Tracking & knowledge_update
// ============================================================================

const KNOWLEDGE_PENDING_FILE = "knowledge-pending.json";
const KNOWLEDGE_PENDING_LOCK_FILE = "knowledge-pending.lock";
const KNOWLEDGE_LOCK_FILE    = "knowledge-update.lock";
const KNOWLEDGE_MD_FILE      = "memory/KNOWLEDGE.md";
const KNOWLEDGE_PENDING_CAP  = 200;

function pendingKey(sourceAgent, memoryId) {
  return `${sourceAgent}:${memoryId}`;
}

function normalizeKnowledgePending(raw) {
  const now = new Date().toISOString();
  const pending = [];
  if (Array.isArray(raw?.pending)) {
    for (const item of raw.pending) {
      if (!item?.sourceAgent || !item?.memoryId) continue;
      pending.push({
        key: item.key || pendingKey(item.sourceAgent, item.memoryId),
        sourceAgent: item.sourceAgent,
        memoryId: item.memoryId,
        queuedAt: item.queuedAt || raw.lastStoreAt || now,
        reason: item.reason || "schicht15-store-pending",
        category: item.category || "fact",
        importance: Number(item.importance ?? 0.5),
      });
    }
  }
  if (Array.isArray(raw?.pendingMemoryIds)) {
    for (const id of raw.pendingMemoryIds.filter(Boolean)) {
      pending.push({
        key: id,
        sourceAgent: null,
        memoryId: id,
        queuedAt: raw.lastStoreAt || now,
        reason: "legacy-pending-id",
        category: "fact",
        importance: 0.5,
      });
    }
  }
  const deduped = new Map();
  for (const item of pending) deduped.set(item.key, item);
  const sorted = [...deduped.values()].sort((a, b) => {
    const imp = (b.importance ?? 0) - (a.importance ?? 0);
    if (imp !== 0) return imp;
    return String(b.queuedAt || "").localeCompare(String(a.queuedAt || ""));
  });
  return {
    schema: 2,
    pending: sorted.slice(0, KNOWLEDGE_PENDING_CAP),
    pendingCount: Math.min(sorted.length, KNOWLEDGE_PENDING_CAP),
    pendingOverflowCount: Math.max(0, sorted.length - KNOWLEDGE_PENDING_CAP),
    lastStoreAt: raw?.lastStoreAt || null,
    lastUpdateAt: raw?.lastUpdateAt || null,
  };
}

function acquireKnowledgePendingLock(workspaceDir) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, KNOWLEDGE_PENDING_LOCK_FILE);
  if (existsSync(lockPath)) {
    const lockAge = Date.now() - statSync(lockPath).mtimeMs;
    if (lockAge > 60 * 1000) unlinkSync(lockPath);
    else throw new Error("knowledge pending lock held");
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, new Date().toISOString());
  closeSync(fd);
  return lockPath;
}

function releaseKnowledgePendingLock(lockPath) {
  try { if (lockPath && existsSync(lockPath)) unlinkSync(lockPath); } catch (_e) { dbg(_e); }
}

function readKnowledgePendingUnlocked(workspaceDir) {
  try {
    const p = join(workspaceDir, ".adaptive-learning", KNOWLEDGE_PENDING_FILE);
    if (existsSync(p)) return normalizeKnowledgePending(JSON.parse(readFileSync(p, "utf8")));
  } catch (_e) { dbg(_e); }
  return normalizeKnowledgePending({});
}

function writeKnowledgePendingUnlocked(workspaceDir, state) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, KNOWLEDGE_PENDING_FILE);
  const normalized = normalizeKnowledgePending(state);
  const tmpPath = p + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), "utf8");
  renameSync(tmpPath, p);
  return normalized;
}

function readKnowledgePending(workspaceDir) {
  let lockPath = null;
  try {
    lockPath = acquireKnowledgePendingLock(workspaceDir);
    return readKnowledgePendingUnlocked(workspaceDir);
  } catch (_) {
    return normalizeKnowledgePending({});
  } finally {
    releaseKnowledgePendingLock(lockPath);
  }
}

function readKnowledgePendingSnapshot(workspaceDir) {
  return readKnowledgePending(workspaceDir);
}

function trackKnowledgePending(workspaceDir, memory) {
  let lockPath = null;
  try {
    if (!memory?.sourceAgent || !memory?.memoryId) return;
    lockPath = acquireKnowledgePendingLock(workspaceDir);
    const state = readKnowledgePendingUnlocked(workspaceDir);
    const entry = {
      key: pendingKey(memory.sourceAgent, memory.memoryId),
      sourceAgent: memory.sourceAgent,
      memoryId: memory.memoryId,
      queuedAt: new Date().toISOString(),
      reason: memory.reason || "schicht15-store-pending",
      category: memory.category || "fact",
      importance: Number(memory.importance ?? 0.5),
    };
    state.pending = [...state.pending.filter(it => it.key !== entry.key), entry];
    state.lastStoreAt = new Date().toISOString();
    const written = writeKnowledgePendingUnlocked(workspaceDir, state);
    if ((written.pendingOverflowCount || 0) > 0) {
      appendCurationLog(workspaceDir, memory.sourceAgent, {
        event: "knowledge_pending.overflow",
        timestamp: new Date().toISOString(),
        agentId: memory.sourceAgent,
        memoryId: memory.memoryId,
        text: "",
        category: memory.category || "fact",
        origin: "system",
        reason: `pending_cap:${KNOWLEDGE_PENDING_CAP}, overflow:${written.pendingOverflowCount}`,
        relatedId: null,
      });
    }
  } catch (_e) { dbg(_e); }
  finally { releaseKnowledgePendingLock(lockPath); }
}

function removeKnowledgePending(workspaceDir, removeKeys, removeLegacyIds = []) {
  let lockPath = null;
  try {
    const keys = new Set(removeKeys || []);
    const legacy = new Set(removeLegacyIds || []);
    lockPath = acquireKnowledgePendingLock(workspaceDir);
    const state = readKnowledgePendingUnlocked(workspaceDir);
    state.pending = state.pending.filter(item => !keys.has(item.key) && !(item.sourceAgent === null && legacy.has(item.memoryId)));
    state.lastUpdateAt = new Date().toISOString();
    writeKnowledgePendingUnlocked(workspaceDir, state);
  } catch (_e) { dbg(_e); }
  finally { releaseKnowledgePendingLock(lockPath); }
}

// ============================================================================
// Schicht 1.5 — KNOWLEDGE.md
// ============================================================================

/**
 * Integrate one memory into KNOWLEDGE.md with deterministic agent-scoped LLM calls.
 * @param {string} workspaceDir
 * @param {string} text
 * @param {string} category
 * @param {number} importance
 * @param {object} llmCfg
 * @param {object} logger
 * @param {string} agentId
 * @param {Array<string>} sourceMemoryIds
 * @returns {Promise<void>}
 */
async function updateKnowledgeMd(workspaceDir, text, category, importance, llmCfg, logger, agentId, sourceMemoryIds) {
  if (!workspaceDir || !llmCfg) return;
  const memDir = join(workspaceDir, "memory");
  const knowledgePath = join(memDir, "KNOWLEDGE.md");

  let currentContent = "";
  try {
    if (existsSync(knowledgePath)) currentContent = readFileSync(knowledgePath, "utf8");
  } catch (_e) { dbg(_e); }

  // Strip frontmatter before sending to LLM (LLM should not touch it)
  const { frontmatter: existingFm, body: currentBody } = stripFrontmatter(currentContent);
  let mergedSources = sourceMemoryIds || [];
  if (existingFm) {
    const m = existingFm.match(/source_memories:\s*\n((?:\s+-\s+.+\n?)*)/);
    if (m) {
      const oldIds = m[1].split("\n").map(l => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean);
      mergedSources = [...new Set([...oldIds, ...mergedSources])];
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  const updated = await callLlm([
    {
      role: "user",
      content: `Here is the current KNOWLEDGE.md body (empty = not yet created):\n${currentBody || "(empty)"}\n\nNew memory (category=${category}, importance=${importance.toFixed(1)}, date=${today}):\n${text}\n\nIntegrate this information into the KNOWLEDGE.md body.\n- Add a new entry under the appropriate section with today's date.\n- If an existing entry is logically identical, replace it instead of adding a duplicate.\n- Change NOTHING else.\n- Return ONLY the updated Markdown body, NO YAML frontmatter, NO code block wrapper.`,
    },
  ], withDeterministicLlmContext(
    llmCfg,
    agentId,
    LLM_RESULT_CACHE_PURPOSES.KNOWLEDGE_UPDATE,
    // No temperature: providers like the Kimi coding endpoint allow exactly
    // one value per thinking mode and answer HTTP 400 for anything else.
    { maxTokens: 3000 },
    llmCfg?.callContext,
  ));

  if (!updated) return;

  let finalBody = updated;

  if (finalBody.split("\n").length > 200) {
    const compacted = await callLlm([
      {
        role: "user",
        content: `The following KNOWLEDGE.md body has grown too large (>200 lines). Consolidate it thematically — do NOT simply truncate.\n\nRules:\n1. Keep ALL unique facts and decisions — lose no information.\n2. Group thematically related entries under a shared point.\n3. Structure: Domain → Category → consolidated fact (Context-Tree style).\n4. If multiple entries describe the same concept from different angles, write one entry covering all aspects.\n5. Keep the date of the oldest merged entry.\n6. Target: max 150 lines, achieved only through real consolidation.\n7. Return ONLY the updated Markdown body, NO YAML frontmatter, NO code block wrapper.\n\n${finalBody}`,
      },
    ], withDeterministicLlmContext(
      llmCfg,
      agentId,
      LLM_RESULT_CACHE_PURPOSES.KNOWLEDGE_UPDATE,
      // No temperature: providers like the Kimi coding endpoint allow exactly
      // one value per thinking mode and answer HTTP 400 for anything else.
      { maxTokens: 4000 },
      llmCfg?.callContext,
    ));

    const compactedLines = compacted?.split("\n").length ?? Infinity;
    if (compacted && compactedLines <= 150) {
      finalBody = compacted;
    } else {
      logger?.warn?.(`memory-lancedb-namespaced: KNOWLEDGE.md compaction skipped: result (${compactedLines} lines) not ≤150`);
    }
  }

  // Re-attach frontmatter
  const finalContent = withFrontmatter(finalBody, { agentId, sourceMemoryIds: mergedSources, today });

  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
  const tmpPath = knowledgePath + ".tmp";
  writeFileSync(tmpPath, finalContent, "utf8");
  renameSync(tmpPath, knowledgePath);
}

export { appendCurationLog, KNOWLEDGE_LOCK_FILE, readKnowledgePending, readKnowledgePendingSnapshot, trackKnowledgePending, removeKnowledgePending };
