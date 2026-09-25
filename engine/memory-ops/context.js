import { join } from "node:path";
import { memoryContextFromPrincipal } from "../identity/principal.js";
import { memoryOpError } from "./errors.js";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Binds MemoryOps calls to the host: Principal → memory request context, plus the fail-closed guards. */
export function createMemoryOpsContext({ host, logger }) {
  return {
    async resolve(p, a, { destructive = false, target = null } = {}) {
      if (!p || typeof p.agentId !== "string" || !AGENT_ID.test(p.agentId)) throw memoryOpError("invalid-input", "principal.agentId is invalid");
      if (!a || typeof a.origin !== "string") throw memoryOpError("invalid-input", "agent context is required");
      if (destructive && (a.origin !== "user" || a.background !== false)) {
        throw memoryOpError("denied", "destructive memory operations require origin \"user\" and background false");
      }
      const workspaceDir = await host.workspaceDir(p.agentId);
      const memoryCtx = memoryContextFromPrincipal(p, { workspaceDir, logger });
      if (target && memoryCtx.trust !== "proved") throw memoryOpError("denied", `sharing to ${target} requires a proved principal`);
      return { agentId: memoryCtx.agentId, memoryCtx, workspaceDir, archiveDir: join(host.stateDir, "memory", "_archive") };
    },
  };
}
