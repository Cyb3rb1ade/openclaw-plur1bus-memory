/**
 * lib/acl-middleware.js — Differentiated ACL for PLUR1BUS Memory System (v6).
 *
 * Rules:
 *   - agent-private: only the same agent may access
 *   - workspace:     agents in the same workspace may access
 *   - user:          only the owning authenticated user may access
 *
 * Backwards-compatible: missing scope defaults to agent-private.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INPUT_LIMITS } from "./input-limits.js";
import {
  normalizeAndFreezeWorkspaceAliases,
  normalizeWorkspaceTarget,
  resolveCanonicalWorkspacePrincipal,
  validatedIdentity,
} from "./memory-request-context.js";
import { safeAgentId } from "./sql-safety.js";

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

function canonicalStoredWorkspace(value, workspaceAliases) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string" && (value.startsWith("workspace:v1:") || value.startsWith("workspace-dir:v1:"))) {
    return normalizeWorkspaceTarget(value, "memory workspace binding");
  }
  return resolveCanonicalWorkspacePrincipal({ explicitId: value }, workspaceAliases);
}

/** Resolve independently validated legacy and canonical ownership aliases. */
export function resolveOwnershipBindings(memory, workspaceAliases) {
  if (!memory || typeof memory !== "object") throw new Error("invalid memory ownership tuple");
  const rawAgentId = validatedIdentity(memory.agentId, INPUT_LIMITS.AGENT_ID, "memory.agentId");
  const rawStoredBy = validatedIdentity(memory.storedBy, INPUT_LIMITS.AGENT_ID, "memory.storedBy");
  const agentId = rawAgentId ? safeAgentId(rawAgentId) : "";
  const storedBy = rawStoredBy ? safeAgentId(rawStoredBy) : "";
  if (agentId && storedBy && agentId !== storedBy) throw new Error("conflicting agent ownership binding");

  const rawWorkspaceId = memory.workspaceId;
  const rawWorkspaceKey = memory.workspaceKey;
  let workspaceId = "";
  let workspaceKey = "";
  const hasWorkspaceId = rawWorkspaceId !== undefined && rawWorkspaceId !== null && rawWorkspaceId !== "";
  const hasWorkspaceKey = rawWorkspaceKey !== undefined && rawWorkspaceKey !== null && rawWorkspaceKey !== "";
  if (hasWorkspaceId || hasWorkspaceKey) {
    if (!workspaceAliases) throw new Error("invalid workspace alias snapshot");
    const snapshot = normalizeAndFreezeWorkspaceAliases(workspaceAliases);
    workspaceId = canonicalStoredWorkspace(rawWorkspaceId, snapshot);
    workspaceKey = canonicalStoredWorkspace(rawWorkspaceKey, snapshot);
    if (workspaceId && workspaceKey && workspaceId !== workspaceKey) throw new Error("conflicting workspace ownership binding");
  }

  const ownerUserId = validatedIdentity(memory.ownerUserId, INPUT_LIMITS.PRINCIPAL, "memory.ownerUserId");
  if (ownerUserId && !/^user:v1:[a-f0-9]{64}$/.test(ownerUserId)) {
    throw new Error("invalid user ownership principal");
  }
  return Object.freeze({
    agentId: agentId || storedBy,
    workspaceIdentity: workspaceId || workspaceKey,
    ownerUserId,
  });
}

/** Validate a stored ownership tuple and return stable ACL reasons. */
export function validateOwnershipTuple(memory, workspaceAliases) {
  try {
    return { ok: true, bindings: resolveOwnershipBindings(memory, workspaceAliases) };
  } catch (error) {
    const message = String(error?.message || "");
    const workspace = message.includes("workspace");
    return {
      ok: false,
      reason: workspace && message.includes("conflicting")
        ? "acl.workspace.conflicting_binding"
        : workspace
          ? "acl.workspace.invalid_binding"
          : "acl.invalid_binding",
    };
  }
}

/**
 * Checks whether the requesting context is allowed to access a memory.
 *
 * @param {object} ctx     — canonical requesting memory context
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
  if (!new Set(["agent-private", "workspace", "user"]).has(scope)) {
    return { allowed: false, reason: "acl.unknown_scope" };
  }
  let requesterAgentId = "";
  try {
    requesterAgentId = safeAgentId(validatedIdentity(ctx.agentId, INPUT_LIMITS.AGENT_ID, "agentId", { required: true }));
  } catch {
    return { allowed: false, reason: "acl.request.missing_agent" };
  }
  const ownership = validateOwnershipTuple(memory, ctx.workspaceAliases);
  if (!ownership.ok) return { allowed: false, reason: ownership.reason };
  const { agentId: memoryAgentId, workspaceIdentity: memoryWorkspaceId, ownerUserId } = ownership.bindings;

  if (scope === "agent-private") {
    if (!memoryAgentId) {
      return { allowed: false, reason: "acl.agent_private.missing_owner" };
    }
    if (requesterAgentId === memoryAgentId) {
      return { allowed: true };
    }
    return { allowed: false, reason: "acl.agent_private.mismatch" };
  }

  if (scope === "workspace") {
    if (!memoryWorkspaceId) {
      return { allowed: false, reason: "acl.workspace.missing_workspace" };
    }
    if (ctx.workspaceIdentity && ctx.workspaceIdentity === memoryWorkspaceId) {
      return { allowed: true };
    }
    return { allowed: false, reason: "acl.workspace.mismatch" };
  }

  if (scope === "user") {
    const requestUserPrincipal = typeof ctx.userPrincipal === "string" ? ctx.userPrincipal.trim() : "";
    if (!/^user:v1:[a-f0-9]{64}$/.test(requestUserPrincipal)) {
      return { allowed: false, reason: "acl.user.missing_principal" };
    }
    if (!ownerUserId) {
      return { allowed: false, reason: "acl.user.missing_owner" };
    }
    if (requestUserPrincipal === ownerUserId) {
      return { allowed: true };
    }
    return { allowed: false, reason: "acl.user.mismatch" };
  }

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
