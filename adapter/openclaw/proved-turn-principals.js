/**
 * adapter/openclaw/proved-turn-principals.js — remembers, per turn, the user
 * principal the recall proved (7.21.1).
 *
 * The recall's turn-principal resolver proves the sender of a turn through
 * the turn-route ticket. The capture of the same turn (agent_end) has no
 * ticket any more; until 7.21.0 its light dream bound itself to the hook's
 * raw sender id instead (see engine/capture/light-dream-identity.js). This
 * memo hands the proved principal from recall to capture, keyed by agent,
 * session and run, for at most 30 minutes. Only user principals the resolver
 * proved are stored; nothing is written to disk.
 */

/** How long a proved principal is kept for the capture of its turn. */
export const PROVED_TURN_PRINCIPAL_TTL_MS = 30 * 60_000;
/** Most turns kept at once (oldest first out). */
export const PROVED_TURN_PRINCIPAL_MAX = 512;

function turnKey(event, hookCtx) {
  const agentId = String(hookCtx?.agentId || "");
  const sessionKey = String(hookCtx?.sessionKey ?? event?.sessionKey ?? "");
  const runId = String(hookCtx?.runId ?? event?.runId ?? "");
  if (!agentId || !sessionKey || !runId) return "";
  return JSON.stringify([agentId, sessionKey, runId]);
}

/**
 * @param {{ttlMs?: number, max?: number, now?: () => number}} [opts]
 * @returns {{record: (event: object, hookCtx: object, result: {trust?: string, memoryCtx?: object}) => void, userPrincipalFor: (event: object, hookCtx: object) => string, size: () => number}}
 */
export function createProvedTurnPrincipals({ ttlMs = PROVED_TURN_PRINCIPAL_TTL_MS, max = PROVED_TURN_PRINCIPAL_MAX, now = Date.now } = {}) {
  const entries = new Map();
  const sweep = (at) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > at) break;
      entries.delete(key);
    }
  };
  return {
    record(event, hookCtx, result) {
      const principal = result?.memoryCtx?.userPrincipal;
      if (result?.trust !== "proved" || typeof principal !== "string" || !principal) return;
      const key = turnKey(event, hookCtx);
      if (!key) return;
      const at = now();
      sweep(at);
      entries.delete(key);
      entries.set(key, { userPrincipal: principal, expiresAt: at + ttlMs });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    userPrincipalFor(event, hookCtx) {
      const key = turnKey(event, hookCtx);
      if (!key) return "";
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) return "";
      return entry.userPrincipal;
    },
    size: () => entries.size,
  };
}
