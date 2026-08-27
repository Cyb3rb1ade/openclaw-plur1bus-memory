import { randomUUID } from "node:crypto";

import { safeAgentId, safeUuid } from "../sql-safety.js";

const PROBE_AGENT_ID = "plur1bus-reembedding-probe";
const PROBE_WORKSPACE_ID = "workspace:v1:plur1bus-reembedding-probe";

function finiteVector(value, dimensions, label) {
  const vector = ArrayBuffer.isView(value) ? Array.from(value) : value;
  if (
    !Array.isArray(vector)
    || vector.length !== dimensions
    || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) throw new Error(`reembedding ${label} vector is invalid`);
  return vector;
}

/** Build the real target-generation store/recall probe used during an atomic switch. */
export function createGenerationRuntimeProbe({
  readActiveSelection,
  embedTarget,
  withTargetDb,
  appendAudit,
  createId = randomUUID,
  now = Date.now,
} = {}) {
  if (typeof readActiveSelection !== "function") throw new Error("active selection reader is required");
  if (typeof embedTarget !== "function") throw new Error("target embedding capability is required");
  if (typeof withTargetDb !== "function") throw new Error("target generation DB capability is required");
  if (typeof appendAudit !== "function") throw new Error("synthetic probe audit capability is required");
  if (typeof createId !== "function" || typeof now !== "function") throw new Error("synthetic probe runtime capabilities are invalid");

  return async ({ expectedGeneration, fingerprint, secretRef } = {}) => {
    const selection = readActiveSelection();
    if (selection?.generation !== expectedGeneration) {
      throw new Error("active generation selection drift after OpenClaw config mutation");
    }
    if (!fingerprint || !Number.isSafeInteger(fingerprint.dimensions) || fingerprint.dimensions <= 0) {
      throw new Error("target embedding fingerprint is invalid");
    }
    const agentId = safeAgentId(PROBE_AGENT_ID);
    const id = safeUuid(createId());
    const text = `PLUR1BUS reembedding probe ${id}`;
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("synthetic probe clock is invalid");
    const passageVector = finiteVector(
      await embedTarget({ text, purpose: "passage", fingerprint, secretRef }),
      fingerprint.dimensions,
      "passage",
    );

    return withTargetDb({
      generation: expectedGeneration,
      agentId,
      dimensions: fingerprint.dimensions,
    }, async (db) => {
      let stored = false;
      let operationError = null;
      let result = null;
      try {
        await db.store({
          id,
          vector: passageVector,
          text,
          summary: text,
          agentId,
          storedBy: agentId,
          workspaceId: PROBE_WORKSPACE_ID,
          workspaceKey: PROBE_WORKSPACE_ID,
          ownerUserId: "",
          scope: "agent-private",
          origin: "system",
          category: "fact",
          importance: 0.5,
          createdAt,
          status: "active",
          epistemicStatus: "observed",
        });
        stored = true;
        const queryVector = finiteVector(
          await embedTarget({ text, purpose: "query", fingerprint, secretRef }),
          fingerprint.dimensions,
          "query",
        );
        const recalled = await db.search(queryVector, 5, 0);
        if (!Array.isArray(recalled) || !recalled.some((candidate) => candidate?.entry?.id === id)) {
          throw new Error("target runtime did not recall the synthetic reembedding probe");
        }
        result = Object.freeze({ readiness: true, store: true, recall: true });
      } catch (error) {
        operationError = error;
      }

      let cleanupError = null;
      if (stored) {
        const audited = appendAudit({
          event: "reembedding.synthetic_probe_delete",
          memoryId: id,
          agentId,
          workspaceId: PROBE_WORKSPACE_ID,
          createdAt,
        });
        if (!audited) {
          cleanupError = new Error("synthetic reembedding probe audit write failed; destructive cleanup refused");
        } else {
          try {
            await db.delete(id);
          } catch (error) {
            cleanupError = error;
          }
        }
      }
      if (operationError && cleanupError) {
        throw new AggregateError([operationError, cleanupError], "reembedding runtime probe and cleanup failed");
      }
      if (operationError) throw operationError;
      if (cleanupError) throw cleanupError;
      return result;
    });
  };
}
