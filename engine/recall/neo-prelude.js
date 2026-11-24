/**
 * engine/recall/neo-prelude.js — the read half of the recall's neo prelude.
 *
 * Moved unchanged out of engine/recall/assemble-prompt-context.js (E5 Task 9)
 * so the warm-only recall path runs the same reads: the candidate window,
 * the query embedding (bounded by `neo.recall.global.embedTimeoutMs`), the
 * global candidate search and the lane routing. It reads the neo store and
 * never writes it; the injection mark and the hook counter stay with the
 * caller.
 */

import { NEO_AUTO_RECALL_LANES, NEO_DEFAULT_MAX_REFLECTIONS, routeNeoRecall } from "../../lib/neo-arch.js";
import { describeError } from "../../lib/log-redact.js";

/**
 * Read the neo candidates for one prompt and route them into lanes. Fills
 * the prelude's `windowMs`, `embedMs`, `embedTimedOut`, `globalMs` and
 * `lanesMs` fields as it goes.
 *
 * @param {object} args
 * @param {object} args.neoStore A neo store (only its read methods are used).
 * @param {object} args.requester The neo requester (ACL filter and embedding agent).
 * @param {string} args.prompt The prompt text.
 * @param {object} args.embeddings Embedding provider (`embedQuery` or `embed`).
 * @param {number} args.embedTimeoutMs Budget for the query embedding.
 * @param {symbol} args.timeoutSymbol Sentinel the embedding timeout resolves with.
 * @param {(store: object, items: object[], queryVector: number[]|null, requester: object) => Set<string>|null} args.runNeoGlobalSearch Global candidate search.
 * @param {object} args.logger Host logger.
 * @param {Record<string, any>} args.prelude Prelude timing record, mutated.
 * @param {string} [args.embeddingQuery] 7.20.10: text the query vector is
 *   computed from (the prompt without host envelopes, cleanQueryForEmbedding),
 *   the same text the LanceDB recall embeds so the embedding cache hits.
 *   Empty or missing: the prompt.
 * @param {{sessionKey?: string, since?: number}} [args.sessionEcho] 7.20.10:
 *   the running conversation (normalized session key and the cutoff from
 *   resolveSessionEchoCutoff); its records still in context are left out.
 * @param {{maxReflections?: number, laneMinRelevance?: object|number|null}} [args.neoPromptRecall]
 *   7.20.10: neo.recall.maxReflections / laneMinRelevance.
 * @returns {Promise<{neoItems: object[], queryVector: number[]|null, neoGlobalIds: Set<string>|null, neoLanes: object, routeOptions: object}>}
 *   `routeOptions` are the lane options used, so the caller can route the
 *   pool again after its dedupe against the LanceDB block.
 */
export async function readNeoPrelude({ neoStore, requester, prompt, embeddings, embedTimeoutMs, timeoutSymbol, runNeoGlobalSearch, logger, prelude, embeddingQuery, sessionEcho, neoPromptRecall }) {
  const windowStartedAt = Date.now();
  // 7.20.10: keine Behavior Cards mehr im Auto-Recall (Lane
  // behavior_cards enthielt nur Überlauf; die Karten haben keinen
  // Scope und sind meist conflict/candidate). memory_search liest sie weiter.
  const neoItems = [...neoStore.readCandidates(500, requester)];
  prelude.windowMs = Date.now() - windowStartedAt;
  let queryVector = null;
  const embedStartedAt = Date.now();
  try {
    // 7.20.10: derselbe Einbettungstext wie im LanceDB-Recall
    // (embeddingQuery), damit der Embedding-Cache trifft.
    const neoEmbedQuery = typeof embeddingQuery === "string" && embeddingQuery.trim() ? embeddingQuery : prompt;
    const embedPromise = Promise.resolve(typeof embeddings.embedQuery === "function" ? embeddings.embedQuery(neoEmbedQuery, { agentId: requester.requesterAgentId }) : embeddings.embed(neoEmbedQuery, { agentId: requester.requesterAgentId }));
    let embedTimer = null;
    const embedTimeout = new Promise((resolve) => { embedTimer = setTimeout(() => resolve(timeoutSymbol), embedTimeoutMs); });
    try {
      const outcome = await Promise.race([embedPromise, embedTimeout]);
      if (outcome === timeoutSymbol) {
        prelude.embedTimedOut = true;
        embedPromise.catch(() => {});
        logger.warn(`plur1bus-neo: prompt query embedding exceeded ${embedTimeoutMs} ms, continuing without vector`);
      } else {
        queryVector = outcome;
      }
    } finally {
      if (embedTimer) clearTimeout(embedTimer);
    }
  } catch (error) { logger.debug(`plur1bus-neo: prompt query embedding unavailable: ${describeError(error)}`); }
  prelude.embedMs = Date.now() - embedStartedAt;
  let neoGlobalIds = null;
  const globalStartedAt = Date.now();
  try {
    neoGlobalIds = runNeoGlobalSearch(neoStore, neoItems, queryVector, requester);
  } catch (globalErr) {
    logger.warn(`plur1bus-neo: global candidate search failed: ${String(globalErr)}`);
  }
  prelude.globalMs = Date.now() - globalStartedAt;
  const lanesStartedAt = Date.now();
  // 7.20.10: Lanes nur bei passender Kategorie (assistant_* nur als
  // Reflexion, höchstens neo.recall.maxReflections), ohne recent_turns
  // und behavior_cards, ohne Selbst-Echo der aktuellen Anfrage und
  // ohne Einträge des laufenden Gesprächs, die noch im Kontext
  // stehen (gleicher Stichtag wie session-echo im LanceDB-Block).
  const routeOptions = {
    ...requester,
    queryVector,
    lanes: NEO_AUTO_RECALL_LANES,
    maxPerLane: 2,
    minScore: 0.08,
    excludeQueryEcho: true,
    sessionEcho: {
      sessionKey: sessionEcho?.sessionKey || "",
      since: sessionEcho?.since,
    },
    strictLanes: true,
    laneCaps: { agent_private_reflections: neoPromptRecall?.maxReflections ?? NEO_DEFAULT_MAX_REFLECTIONS },
    laneMinRelevance: neoPromptRecall?.laneMinRelevance ?? null,
  };
  const neoLanes = routeNeoRecall(neoItems, prompt, routeOptions);
  prelude.lanesMs = Date.now() - lanesStartedAt;
  return { neoItems, queryVector, neoGlobalIds, neoLanes, routeOptions };
}
