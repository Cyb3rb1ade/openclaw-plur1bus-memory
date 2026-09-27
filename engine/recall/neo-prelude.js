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

import { routeNeoRecall } from "../../lib/neo-arch.js";

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
 * @returns {Promise<{neoItems: object[], queryVector: number[]|null, neoGlobalIds: Set<string>|null, neoLanes: object}>}
 */
export async function readNeoPrelude({ neoStore, requester, prompt, embeddings, embedTimeoutMs, timeoutSymbol, runNeoGlobalSearch, logger, prelude }) {
  const windowStartedAt = Date.now();
  const neoItems = [...neoStore.readCandidates(500, requester), ...neoStore.readBehaviorCards(200, requester)];
  prelude.windowMs = Date.now() - windowStartedAt;
  let queryVector = null;
  const embedStartedAt = Date.now();
  try {
    const embedPromise = Promise.resolve(typeof embeddings.embedQuery === "function" ? embeddings.embedQuery(prompt, { agentId: requester.requesterAgentId }) : embeddings.embed(prompt, { agentId: requester.requesterAgentId }));
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
  } catch (error) { logger.debug(`plur1bus-neo: prompt query embedding unavailable: ${String(error)}`); }
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
  const neoLanes = routeNeoRecall(neoItems, prompt, { ...requester, queryVector, maxPerLane: 2, minScore: 0.08 });
  prelude.lanesMs = Date.now() - lanesStartedAt;
  return { neoItems, queryVector, neoGlobalIds, neoLanes };
}
