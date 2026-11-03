/**
 * lib/jobs/schicht15-tracker.js — Schicht 1.5 KNOWLEDGE.md Promotion Tracking.
 *
 * Verhindert Doppel-Promotion derselben Memory in KNOWLEDGE.md.
 * Tracks promotedKnowledgeIds pro workspace+agent in run-state.json; das
 * Promotion-Limit zaehlt workspace-weit.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { describeErrorForLog } from "../safe-logging.js";
import { atomicJsonUpdate } from "../atomic-json.js";

function readJson(path, fallback = {}) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) { console.warn(`[schicht15-tracker] readJson failed: ${describeErrorForLog(err)}`); }
  return fallback;
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

/**
 * Record one promotion. Read-modify-write goes through `atomicJsonUpdate`, the
 * same per-file queue the other run-state.json writers use, so a concurrent
 * metrics or rate-limit update neither loses nor overwrites this entry. An
 * unreadable run-state.json is left as it is (strict mode) instead of being
 * rewritten from `{}`, which used to drop every other key in it.
 *
 * Callers should `await` it; it never rejects.
 *
 * @returns {Promise<boolean>} true when the promotion was recorded.
 */
export async function recordKnowledgePromotion(workspaceDir, workspaceKey, agentId, memoryId, contentHash) {
  const statePath = join(workspaceDir, "run-state.json");
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await atomicJsonUpdate(statePath, (data) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("run-state.json is not an object");
      const state = data;
      state.promotedKnowledge = state.promotedKnowledge && typeof state.promotedKnowledge === "object" ? state.promotedKnowledge : {};
      const key = getPromotedKey(workspaceKey, agentId);
      const existing = state.promotedKnowledge[key] || { ids: [], hashes: [], count: 0, lastRunAt: 0 };
      existing.ids = Array.isArray(existing.ids) ? existing.ids : [];
      existing.hashes = Array.isArray(existing.hashes) ? existing.hashes : [];
      if (!existing.ids.includes(memoryId)) {
        existing.ids.push(memoryId);
      }
      if (contentHash && !existing.hashes.includes(contentHash)) {
        existing.hashes.push(contentHash);
      }
      // Timestamp per promotion: the rate limit below counts a time window, the
      // id/hash lists above stay lifetime dedup.
      existing.promotedAt = existing.promotedAt && typeof existing.promotedAt === "object" ? existing.promotedAt : {};
      existing.promotedAt[memoryId] = Date.now();
      existing.count = existing.ids.length;
      existing.lastRunAt = Date.now();
      state.promotedKnowledge[key] = existing;
      return state;
    }, { strict: true });
    return true;
  } catch (err) {
    console.warn(`[schicht15-tracker] recordKnowledgePromotion failed: ${describeErrorForLog(err)}`);
    return false;
  }
}

export function isKnowledgePromoted(workspaceDir, workspaceKey, agentId, memoryId, contentHash) {
  const promoted = readPromotedKnowledgeIds(workspaceDir, workspaceKey, agentId);
  if (memoryId && promoted.ids.includes(memoryId)) return true;
  if (contentHash && promoted.hashes.includes(contentHash)) return true;
  return false;
}

/** Window the promotion rate limit counts over (24 h). */
export const PROMOTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Rate limit for KNOWLEDGE.md promotions. Until 7.12.2 this compared the
 * lifetime number of promoted ids against `maxPromotionsPerRun`, so a
 * workspace that had ever promoted `max` cards was blocked forever (live:
 * "7/3" since 2026-06-27). Now only promotions inside the window count;
 * entries recorded before timestamps existed do not count at all.
 *
 * @param {string} workspaceDir
 * @param {string} workspaceKey
 * @param {string} agentId
 * @param {number} maxPromotionsPerRun
 * @param {{windowMs?: number, now?: number}} [opts]
 * @returns {{allowed: boolean, current: number, max?: number, windowMs?: number}}
 */
export function checkMaxPromotions(workspaceDir, workspaceKey, agentId, maxPromotionsPerRun, opts = {}) {
  if (!maxPromotionsPerRun || maxPromotionsPerRun <= 0) return { allowed: true, current: 0 };
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : PROMOTION_WINDOW_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  // KNOWLEDGE.md and run-state.json belong to the workspace, not to one agent:
  // the cap counts the promotions of every agent recorded in this workspace's
  // run-state.json (`workspaceKey`/`agentId` stay in the signature).
  const state = readJson(join(workspaceDir, "run-state.json"), {});
  const stamps = [];
  for (const entry of Object.values(state?.promotedKnowledge && typeof state.promotedKnowledge === "object" ? state.promotedKnowledge : {})) {
    if (entry?.promotedAt && typeof entry.promotedAt === "object") stamps.push(...Object.values(entry.promotedAt));
  }
  const current = stamps.filter((at) => Number.isFinite(at) && at > now - windowMs && at <= now).length;
  return { allowed: current < maxPromotionsPerRun, current, max: maxPromotionsPerRun, windowMs };
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
