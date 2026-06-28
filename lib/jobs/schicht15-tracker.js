/**
 * lib/jobs/schicht15-tracker.js — Schicht 1.5 KNOWLEDGE.md Promotion Tracking.
 *
 * Verhindert Doppel-Promotion derselben Memory in KNOWLEDGE.md.
 * Tracks promotedKnowledgeIds pro workspace+agent in run-state.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { redactError } from "../safe-logging.js";

function readJson(path, fallback = {}) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) { console.warn(`[schicht15-tracker] readJson failed: ${redactError(err).message}`); }
  return fallback;
}

function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function getPromotedKey(workspaceKey, agentId) {
  return `schicht15:${workspaceKey || "default"}:${agentId || "all"}`;
}

export function readPromotedKnowledgeIds(workspaceDir, workspaceKey, agentId) {
  const statePath = join(workspaceDir, "run-state.json");
  const state = readJson(statePath, {});
  const key = getPromotedKey(workspaceKey, agentId);
  return state.promotedKnowledge?.[key] || { ids: [], hashes: [], count: 0, lastRunAt: 0 };
}

export function recordKnowledgePromotion(workspaceDir, workspaceKey, agentId, memoryId, contentHash) {
  const statePath = join(workspaceDir, "run-state.json");
  const state = readJson(statePath, {});
  state.promotedKnowledge = state.promotedKnowledge || {};
  const key = getPromotedKey(workspaceKey, agentId);
  const existing = state.promotedKnowledge[key] || { ids: [], hashes: [], count: 0, lastRunAt: 0 };
  if (!existing.ids.includes(memoryId)) {
    existing.ids.push(memoryId);
  }
  if (contentHash && !existing.hashes.includes(contentHash)) {
    existing.hashes.push(contentHash);
  }
  existing.count = existing.ids.length;
  existing.lastRunAt = Date.now();
  state.promotedKnowledge[key] = existing;
  writeJsonAtomic(statePath, state);
}

export function isKnowledgePromoted(workspaceDir, workspaceKey, agentId, memoryId, contentHash) {
  const promoted = readPromotedKnowledgeIds(workspaceDir, workspaceKey, agentId);
  if (memoryId && promoted.ids.includes(memoryId)) return true;
  if (contentHash && promoted.hashes.includes(contentHash)) return true;
  return false;
}

export function checkMaxPromotions(workspaceDir, workspaceKey, agentId, maxPromotionsPerRun) {
  if (!maxPromotionsPerRun || maxPromotionsPerRun <= 0) return { allowed: true, current: 0 };
  const promoted = readPromotedKnowledgeIds(workspaceDir, workspaceKey, agentId);
  const current = promoted.ids.length;
  return { allowed: current < maxPromotionsPerRun, current, max: maxPromotionsPerRun };
}

function normalizeHashText(text) {
  if (!text || typeof text !== "string") return null;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\s+$/gm, "").trim();
  if (normalized.length === 0) return null;
  return normalized;
}

/**
 * Compute a stable SHA-256 hash from memory content and promotion metadata.
 *
 * @param {string|object} input - Memory text or memory-like object
 * @returns {string|null} Hex digest, or null for empty/invalid text
 */
export function computeContentHash(input) {
  const normalized = normalizeHashText(typeof input === "string" ? input : input?.text);
  if (!normalized) return null;
  if (typeof input === "string") {
    return createHash("sha256").update(normalized, "utf8").digest("hex");
  }
  const payload = {
    text: normalized,
    category: String(input.category || ""),
    scope: String(input.scope || ""),
    importance: Number.isFinite(Number(input.importance)) ? Number(input.importance) : null,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
