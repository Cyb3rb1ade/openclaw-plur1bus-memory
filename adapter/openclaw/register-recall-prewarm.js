/**
 * adapter/openclaw/register-recall-prewarm.js — warm the recall path after
 * the gateway comes up (7.21.1).
 *
 * The first recall after a restart paid for everything that is cold: the
 * embedding provider's connection, the Neo vector cache (7.20.9), the LanceDB
 * handles and index pages, the graph read. On 24.11.2026 (09:44 and 22:29)
 * that first recall ran out of budget and the turn got no memories. Shortly
 * after `gateway_start` this module runs one read-only warm recall per chat
 * agent (`Engine.recall` with `warmOnly`, reranker off: no Cohere call, no
 * write, no recall cache entry), one agent after the other.
 *
 * Config: `runtime.recallPrewarm` — `enabled` (default true), `delayMs`
 * (default 20 000), `agents` (default: the keys of `chatModels`, else the
 * agents of `obsidianBridge.workspaces`).
 */

import { describeError } from "../../lib/log-redact.js";

/** Default wait after gateway_start, so the warm-up does not compete with the host's own start. */
export const RECALL_PREWARM_DEFAULT_DELAY_MS = 20_000;
/** Budget of one warm recall. */
export const RECALL_PREWARM_TIMEOUT_MS = 30_000;
/** Most agents warmed per start. */
export const RECALL_PREWARM_MAX_AGENTS = 8;
/** Neutral query of the warm recall (embedded once per agent, memory-only). */
export const RECALL_PREWARM_QUERY = "Woran haben wir zuletzt gearbeitet, und was war dabei wichtig?";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * The agents to warm, in order, without duplicates.
 *
 * @param {Record<string, any>} cfg The plugin config.
 * @returns {string[]} agent ids
 */
export function recallPrewarmAgents(cfg) {
  const explicit = cfg?.runtime?.recallPrewarm?.agents;
  let candidates = [];
  if (Array.isArray(explicit)) {
    candidates = explicit;
  } else {
    if (cfg?.chatModels && typeof cfg.chatModels === "object" && !Array.isArray(cfg.chatModels)) {
      candidates = Object.keys(cfg.chatModels);
    }
    if (candidates.length === 0 && Array.isArray(cfg?.obsidianBridge?.workspaces)) {
      candidates = cfg.obsidianBridge.workspaces.map((ws) => ws?.agentId);
    }
  }
  const out = [];
  for (const id of candidates) {
    if (typeof id !== "string" || !AGENT_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= RECALL_PREWARM_MAX_AGENTS) break;
  }
  return out;
}

/**
 * Run the warm recalls now, one agent after the other. Never throws.
 *
 * @param {{engine: {recall: Function}, logger: object, agents: string[], timeoutMs?: number}} args
 * @returns {Promise<Array<{agentId: string, ms: number, outcome: string}>>}
 */
export async function runRecallPrewarm({ engine, logger, agents, timeoutMs = RECALL_PREWARM_TIMEOUT_MS }) {
  const results = [];
  for (const agentId of agents) {
    const startedAt = Date.now();
    let outcome = "ok";
    try {
      const result = await engine.recall({
        principal: { agentId },
        query: RECALL_PREWARM_QUERY,
        signal: AbortSignal.timeout(timeoutMs),
        agent: { origin: "system", background: true },
        warmOnly: true,
      }, { reranker: "off" });
      if (result?.degraded) outcome = String(result.degraded.reason || "degraded");
    } catch (error) {
      outcome = `error: ${describeError(error)}`;
    }
    const ms = Date.now() - startedAt;
    results.push({ agentId, ms, outcome });
    try { logger?.info?.(`plur1bus: recall prewarm agent=${agentId} ms=${ms} outcome=${outcome}`); } catch (_) { /* logging is best-effort */ }
    // Leave the event loop to the host between agents.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return results;
}

/**
 * Register the warm-up on `gateway_start`.
 *
 * @param {{api: object, host: object, engine: {recall: Function}, cfg: Record<string, any>}} ctx
 * @returns {void}
 */
export function registerRecallPrewarm({ api, host, engine, cfg }) {
  const prewarmCfg = cfg?.runtime?.recallPrewarm || {};
  if (prewarmCfg.enabled === false || cfg?.autoRecall === false) return;
  if (typeof api?.on !== "function" || typeof engine?.recall !== "function") return;
  const agents = recallPrewarmAgents(cfg);
  if (agents.length === 0) return;
  const delayRaw = Number(prewarmCfg.delayMs);
  const delayMs = Number.isFinite(delayRaw) && delayRaw >= 0 ? Math.min(600_000, delayRaw) : RECALL_PREWARM_DEFAULT_DELAY_MS;
  let started = false;
  api.on("gateway_start", () => {
    // gateway_start can reach a plugin instance more than once (hot reload).
    if (started) return;
    started = true;
    const timer = setTimeout(() => {
      runRecallPrewarm({ engine, logger: host.logger, agents }).catch((error) => {
        host.logger.warn?.(`plur1bus: recall prewarm failed: ${describeError(error)}`);
      });
    }, delayMs);
    timer?.unref?.();
  }, { timeoutMs: 5_000 });
}
