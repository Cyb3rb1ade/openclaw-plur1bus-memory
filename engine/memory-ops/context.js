import { join } from "node:path";
import { memoryContextFromPrincipal } from "../identity/principal.js";
import { memoryOpError } from "./errors.js";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Binds MemoryOps calls to the host: Principal → memory request context, plus the fail-closed guards.
 * `getWorkspaceAliases` returns the engine's current workspace alias snapshot, so MemoryOps resolve a
 * principal exactly like recall/capture/checkpoint do. Every failure surfaces as a MemoryOpError.
 */
export function createMemoryOpsContext({ host, logger, getWorkspaceAliases = () => undefined, isClosed = () => false }) {
  // Archive-first backups land in `<stateDir>/memory/_archive` unless the host
  // names its own location (host.capabilities.memoryArchiveDir, read per call):
  // the OpenClaw adapter hands over the directory /forget and /correct have
  // always written to, so routing them through MemoryOps moves nothing (E1 Task 8).
  const archiveDirOf = () => {
    let hostDir = "";
    try {
      hostDir = typeof host.capabilities?.memoryArchiveDir === "function" ? host.capabilities.memoryArchiveDir() : "";
    } catch (error) {
      logger?.warn?.(`memory-ops: host archive dir unavailable: ${error?.message ?? error}`);
      throw memoryOpError("storage", "archive directory unavailable");
    }
    return typeof hostDir === "string" && hostDir ? hostDir : join(host.stateDir, "memory", "_archive");
  };
  // Once the engine is closing, every MemoryOp refuses with "storage" (E1 final
  // review I2). resolve() checks on entry; the write members check again right
  // before they mutate, for a call that was already past resolve() when close() began.
  const assertOpen = () => {
    if (isClosed()) throw memoryOpError("storage", "engine is closed");
  };
  // In-flight tracking (E2 Task 3): the Engine.memory members and the
  // memory-backed Engine.admin members (share/forget aliases, migrate,
  // obsidian.*) run through track(); closeEngine drains the set before it
  // shuts the stores down, within its budget.
  const activeOperations = new Set();
  const track = (run) => {
    const promise = Promise.resolve().then(run);
    // The tracked copy never rejects: the caller handles the real promise.
    const settled = promise.then(() => {}, () => {});
    activeOperations.add(settled);
    settled.then(() => activeOperations.delete(settled));
    return promise;
  };
  const drain = async () => { await Promise.allSettled([...activeOperations]); };
  return {
    assertOpen,
    activeOperations,
    track,
    drain,
    async resolve(p, a, { destructive = false, target = null } = {}) {
      assertOpen();
      if (!p || typeof p.agentId !== "string" || !AGENT_ID.test(p.agentId)) throw memoryOpError("invalid-input", "principal.agentId is invalid");
      if (!a || typeof a.origin !== "string") throw memoryOpError("invalid-input", "agent context is required");
      if (destructive && (a.origin !== "user" || a.background !== false)) {
        throw memoryOpError("denied", "destructive memory operations require origin \"user\" and background false");
      }
      let workspaceDir;
      try {
        workspaceDir = await host.workspaceDir(p.agentId);
      } catch {
        throw memoryOpError("invalid-input", "unknown agent");
      }
      // fix round 1, E1-R10: a destructive op writes an audit line under
      // workspaceDir (appendDestructiveOpLog) and a falsy workspaceDir would
      // otherwise surface only much later, as that op's own generic
      // "storage"/"audit failed" — refuse it here, before any mutation.
      if (destructive && !workspaceDir) {
        throw memoryOpError("invalid-input", "agent has no workspace");
      }
      let memoryCtx;
      try {
        const workspaceAliases = getWorkspaceAliases();
        memoryCtx = memoryContextFromPrincipal(p, { workspaceDir, logger, ...(workspaceAliases ? { workspaceAliases } : {}) });
      } catch (error) {
        // A proved principal whose claims contradict the agent's workspace (e.g. "conflicting workspace identity").
        logger?.warn?.(`memory-ops: principal rejected: ${error?.message ?? error}`);
        throw memoryOpError("denied", "principal does not match the agent's workspace");
      }
      if (target && memoryCtx.trust !== "proved") throw memoryOpError("denied", `sharing to ${target} requires a proved principal`);
      return { agentId: memoryCtx.agentId, memoryCtx, workspaceDir, archiveDir: archiveDirOf() };
    },
  };
}
