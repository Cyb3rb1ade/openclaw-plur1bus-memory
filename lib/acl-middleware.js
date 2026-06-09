/**
 * lib/acl-middleware.js — Differentiated ACL for PLUR1BUS Memory System (v6).
 *
 * Rules:
 *   - agent-private: only the same agent may access
 *   - workspace:     agents in the same workspace may access
 *   - user:          any authenticated user may access
 *
 * Backwards-compatible: missing scope defaults to agent-private.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Critical memory types that receive default scope "agent-private"
 * unless explicitly set otherwise.
 */
export const CRITICAL_TYPES = Object.freeze([
  "person",
  "beziehung",
  "geburtstag",
  "geld_konto",
  "gesundheit",
  "zugang_passwort",
]);

/**
 * Checks whether the requesting context is allowed to access a memory.
 *
 * @param {object} ctx     — requesting context ({ agentId, workspaceId, userId })
 * @param {object} memory  — memory row/object ({ scope, agentId, workspaceId })
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkAccess(ctx, memory) {
  if (!ctx || typeof ctx !== "object") {
    return { allowed: false, reason: "acl.no_context" };
  }
  if (!memory || typeof memory !== "object") {
    return { allowed: false, reason: "acl.no_memory" };
  }

  const scope = memory.scope || "agent-private";

  if (scope === "agent-private") {
    // Backwards-compatible: legacy rows without agentId are treated as belonging
    // to the requesting agent (they predate differentiated ACL).
    if (!memory.agentId) {
      return { allowed: true };
    }
    if (ctx.agentId && ctx.agentId === memory.agentId) {
      return { allowed: true };
    }
    return { allowed: false, reason: "acl.agent_private.mismatch" };
  }

  if (scope === "workspace") {
    // Backwards-compatible: legacy rows without workspaceId are treated as accessible.
    if (!memory.workspaceId) {
      return { allowed: true };
    }
    if (ctx.workspaceId && ctx.workspaceId === memory.workspaceId) {
      return { allowed: true };
    }
    return { allowed: false, reason: "acl.workspace.mismatch" };
  }

  if (scope === "user") {
    if (ctx.userId != null && ctx.userId !== "") {
      return { allowed: true };
    }
    return { allowed: false, reason: "acl.user.not_authenticated" };
  }

  // Unknown scope → fail-closed
  return { allowed: false, reason: "acl.unknown_scope" };
}

/**
 * Enforces default scope on a memory object based on its type.
 * Critical types default to "agent-private" unless the scope is already set.
 *
 * @param {object} memory  — memory object to mutate (must have `type`)
 * @param {object} ctx     — optional context (reserved for future workspace defaults)
 * @returns {object}       — the mutated memory object
 */
export function enforceDefaultScope(memory, ctx = {}) {
  if (!memory || typeof memory !== "object") return memory;
  if (memory.scope) return memory; // already explicitly set

  const type = memory.type || "";
  if (CRITICAL_TYPES.includes(type)) {
    memory.scope = "agent-private";
  }
  // Non-critical types keep whatever they have (undefined until stored).
  return memory;
}

/**
 * Writes an ACL violation audit entry as JSONL.
 *
 * @param {object} ctx       — requesting context
 * @param {object} memory    — memory that was accessed
 * @param {string} reason    — human-readable reason
 * @param {string} [auditPath] — override path for the audit file
 */
export function logAclViolation(ctx, memory, reason, auditPath) {
  const workspaceDir = ctx?.workspaceDir || ".";
  const path = auditPath || join(workspaceDir, ".adaptive-learning", "acl-audit.jsonl");

  const entry = {
    timestamp: Date.now(),
    agentId: ctx?.agentId || null,
    workspaceId: ctx?.workspaceId || null,
    userId: ctx?.userId || null,
    memoryId: memory?.id || null,
    memoryScope: memory?.scope || "agent-private",
    reason: reason || "acl.violation",
  };

  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Audit logging must never crash the application.
    // eslint-disable-next-line no-console
    console?.warn?.(`acl-middleware: failed to write audit log: ${err.message}`);
  }
}

/**
 * Filters an array of memory results, keeping only those the context may access.
 * Optionally logs each violation.
 *
 * @param {object} ctx        — requesting context
 * @param {Array} memories    — array of memory objects
 * @param {object} [opts]     — { logViolations?: boolean, auditPath?: string }
 * @returns {Array}           — allowed memories
 */
export function filterMemoriesByAcl(ctx, memories, opts = {}) {
  if (!Array.isArray(memories)) return [];
  const out = [];
  for (const memory of memories) {
    const result = checkAccess(ctx, memory);
    if (result.allowed) {
      out.push(memory);
    } else if (opts.logViolations) {
      logAclViolation(ctx, memory, result.reason, opts.auditPath);
    }
  }
  return out;
}
