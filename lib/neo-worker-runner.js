import { isMainThread, parentPort } from "node:worker_threads";

import {
  captureNeoFromAgentEnd,
  createNeoStore,
  workspaceKeyFromContext,
} from "./neo-arch.js";

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack,
    code: error?.code,
  };
}

function emptyCaptureCounts() {
  return {
    turns: 0,
    candidates: 0,
    reactions: 0,
    behaviorCards: 0,
  };
}

function countCapture(capture) {
  return {
    turns: Array.isArray(capture?.turns) ? capture.turns.length : 0,
    candidates: Array.isArray(capture?.candidates) ? capture.candidates.length : 0,
    reactions: Array.isArray(capture?.reactions) ? capture.reactions.length : 0,
    behaviorCards: Array.isArray(capture?.behaviorCards) ? capture.behaviorCards.length : 0,
  };
}

function buildDrainOptions(jobOptions = {}) {
  const drainOptions = { ...(jobOptions.embeddingDrainOptions || {}) };
  if (jobOptions.embeddingDrainImpact !== undefined) drainOptions.impact = jobOptions.embeddingDrainImpact;
  if (jobOptions.embeddingDrainMaxItems !== undefined) drainOptions.maxItems = jobOptions.embeddingDrainMaxItems;
  return drainOptions;
}

/**
 * Runs one Neo agent_end job inside the Worker Thread.
 *
 * @param {object} job Worker job payload.
 * @returns {object} Neo workspace key, capture counts, and optional drain result.
 */
export async function runNeoAgentEndJob(job = {}) {
  const event = job.event || {};
  const ctx = job.ctx || {};
  const jobOptions = job.jobOptions || {};

  if (!jobOptions.rootDir) {
    throw new Error("rootDir is required for Neo worker jobs");
  }

  const workspaceKey = workspaceKeyFromContext(ctx, { ...jobOptions, event });
  const store = createNeoStore(jobOptions.rootDir, workspaceKey);

  let capture = emptyCaptureCounts();
  if (Array.isArray(event.messages) && event.messages.length > 0) {
    capture = countCapture(captureNeoFromAgentEnd(event, ctx, store, jobOptions.captureOptions || jobOptions));
  }

  const drain = jobOptions.embeddingDrainEnabled === true
    ? await store.drainEmbeddingQueue(buildDrainOptions(jobOptions))
    : null;

  return { workspaceKey, capture, drain };
}

if (!isMainThread && parentPort) {
  parentPort.on("message", async (message = {}) => {
    try {
      if (message.type !== "neoAgentEnd") {
        throw new Error(`Unsupported Neo worker job type: ${message.type || "unknown"}`);
      }
      const result = await runNeoAgentEndJob(message);
      parentPort.postMessage({ id: message.id, ok: true, result });
    } catch (error) {
      parentPort.postMessage({ id: message.id, ok: false, error: serializeError(error) });
    }
  });
}
