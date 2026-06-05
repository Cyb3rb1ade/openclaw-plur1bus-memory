/**
 * lib/jobs/schicht15-tracker.js — Schicht 1.5 KNOWLEDGE.md Promotion Tracking.
 *
 * Verhindert Doppel-Promotion derselben Memory in KNOWLEDGE.md.
 * Tracks promotedKnowledgeIds pro workspace+agent in run-state.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
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
