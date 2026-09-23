/**
 * engine/checkpoint/checkpoint-store.js — PR-15.
 *
 * Hosts tell the engine that a transcript boundary happened (compaction,
 * session end, shutdown, a manual mark) through Engine.checkpoint(). The
 * reactivation recall keys off the last compaction timestamp; an explicit
 * `compactedAt` a host still puts on the turn event wins, so a host that only
 * does that sees exactly the old behaviour.
 */

import { createHash } from "node:crypto";

export const CHECKPOINT_REASONS = Object.freeze(["compaction", "session-end", "shutdown", "manual"]);

/**
 * @param {{clock?: () => number}} [options]
 * @returns {{checkpoint: (agentId: string, reason: string, opts?: {at?: number, sessionKey?: string}) => {agentId: string, reason: string, digest: string, written: boolean}, lastAt: (agentId: string, reason: string) => number|null}}
 */
export function createCheckpointStore({ clock = () => Date.now() } = {}) {
  const last = new Map();
  const keyOf = (agentId, reason) => `${agentId}\u0000${reason}`;
  return {
    checkpoint(agentId, reason, { at, sessionKey = "" } = {}) {
      if (!CHECKPOINT_REASONS.includes(reason)) throw new TypeError(`unknown checkpoint reason: ${reason}`);
      const when = Number.isFinite(at) ? at : clock();
      const digest = createHash("sha256")
        .update(JSON.stringify([String(agentId), reason, String(sessionKey), when]))
        .digest("hex")
        .slice(0, 32);
      const key = keyOf(agentId, reason);
      const previous = last.get(key);
      const written = !previous || previous.digest !== digest;
      if (written) last.set(key, { at: when, digest });
      return { agentId, reason, digest, written };
    },
    lastAt(agentId, reason) {
      return last.get(keyOf(agentId, reason))?.at ?? null;
    },
  };
}

/**
 * @param {{event?: object, hookCtx?: object, store?: {lastAt: Function}|null, agentId: string}} input
 * @returns {number|null}
 */
export function resolveCompactedAt({ event, hookCtx, store, agentId }) {
  const explicit = event?.compactedAt || hookCtx?.compactedAt || null;
  if (explicit) return explicit;
  return store?.lastAt(agentId, "compaction") ?? null;
}
