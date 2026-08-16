/**
 * lib/tombstone-write-guard.js — shared pre-write tombstone check.
 */

import { findBlockingTombstoneForCapture } from "./tombstone.js";

/**
 * @param {object} opts
 * @returns {{allowed: boolean, action?: string, reason?: string, blocking?: object}}
 */
export function assertCardWriteAllowed(opts = {}) {
  const text = String(opts.text || opts.summary || "");
  if (!text) return { allowed: true };
  const blocking = findBlockingTombstoneForCapture(opts.baseDbPath, {
    agentId: opts.agentId,
    text,
    scope: opts.scope || "agent-private",
    workspaceIdentity: opts.workspaceIdentity || opts.workspaceId || opts.workspaceKey || "",
    ownerUserId: opts.ownerUserId || opts.userPrincipal || "",
  });
  if (!blocking) return { allowed: true };
  return {
    allowed: false,
    action: "tombstone_blocked",
    reason: "tombstone_blocked",
    blocking,
  };
}

/**
 * Whether an update patch changes recallable content.
 * @param {object} existing
 * @param {object} patch
 * @returns {boolean}
 */
export function isContentChangingUpdate(existing = {}, patch = {}) {
  if (!patch || typeof patch !== "object") return false;
  if (Object.hasOwn(patch, "text") && String(patch.text ?? "") !== String(existing.text ?? "")) return true;
  if (Object.hasOwn(patch, "summary") && String(patch.summary ?? "") !== String(existing.summary ?? "")) return true;
  return false;
}

/**
 * Resolve baseDbPath + agentId from a MemoryDB instance path `{base}/{agent}`.
 * @param {string} dbPath
 * @returns {{baseDbPath: string, agentId: string}}
 */
export function splitAgentDbPath(dbPath) {
  const normalized = String(dbPath || "").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return { baseDbPath: normalized, agentId: "" };
  return { baseDbPath: normalized.slice(0, idx), agentId: normalized.slice(idx + 1) };
}
