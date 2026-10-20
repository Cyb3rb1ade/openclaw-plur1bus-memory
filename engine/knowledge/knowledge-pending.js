/**
 * engine/knowledge/knowledge-pending.js — the KNOWLEDGE.md pending-queue, lock and update helpers, and the curation log they append to.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquireOwnedLock } from "../../lib/registry-lock.js";
import { dbg } from "../runtime/debug-log.js";
import { writeFileAtomicSync } from "../../lib/atomic-file.js";

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

// Eigentumsprotokoll wie lib/registry-lock.js (N1): Freigabe nur bei eigener
// Nonce, veraltet erst bei age > 60 s UND (Halter tot ODER age > 10 min).
// Früher: Existenz-Check + mtime-Alter + unbedingtes unlink — ein nach 60 s
// gebrochener Lock eines lebenden Halters und die Freigabe eines bereits
// übernommenen Locks löschten jeweils den Lock eines anderen.
const KNOWLEDGE_PENDING_LOCK_STALE_MS = 60 * 1000;

/** @returns {{release: () => void}} Handle; wirft, wenn der Lock belegt ist. */
function acquireKnowledgePendingLock(workspaceDir) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const handle = tryAcquireOwnedLock(join(dir, KNOWLEDGE_PENDING_LOCK_FILE), { staleMs: KNOWLEDGE_PENDING_LOCK_STALE_MS });
  if (!handle) throw new Error("knowledge pending lock held");
  return handle;
}

function releaseKnowledgePendingLock(handle) {
  try { handle?.release(); } catch (_e) { dbg(_e); }
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
  writeFileAtomicSync(p, JSON.stringify(normalized, null, 2));
  return normalized;
}

function readKnowledgePending(workspaceDir) {
  let pendingLock = null;
  try {
    pendingLock = acquireKnowledgePendingLock(workspaceDir);
    return readKnowledgePendingUnlocked(workspaceDir);
  } catch (_) {
    return normalizeKnowledgePending({});
  } finally {
    releaseKnowledgePendingLock(pendingLock);
  }
}

function readKnowledgePendingSnapshot(workspaceDir) {
  return readKnowledgePending(workspaceDir);
}

function trackKnowledgePending(workspaceDir, memory) {
  let pendingLock = null;
  try {
    if (!memory?.sourceAgent || !memory?.memoryId) return;
    pendingLock = acquireKnowledgePendingLock(workspaceDir);
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
  finally { releaseKnowledgePendingLock(pendingLock); }
}

function removeKnowledgePending(workspaceDir, removeKeys, removeLegacyIds = []) {
  let pendingLock = null;
  try {
    const keys = new Set(removeKeys || []);
    const legacy = new Set(removeLegacyIds || []);
    pendingLock = acquireKnowledgePendingLock(workspaceDir);
    const state = readKnowledgePendingUnlocked(workspaceDir);
    state.pending = state.pending.filter(item => !keys.has(item.key) && !(item.sourceAgent === null && legacy.has(item.memoryId)));
    state.lastUpdateAt = new Date().toISOString();
    writeKnowledgePendingUnlocked(workspaceDir, state);
  } catch (_e) { dbg(_e); }
  finally { releaseKnowledgePendingLock(pendingLock); }
}

export { appendCurationLog, KNOWLEDGE_LOCK_FILE, readKnowledgePending, readKnowledgePendingSnapshot, trackKnowledgePending, removeKnowledgePending };
