/**
 * adapter/openclaw/register-prompt-supplements.js
 *
 * Registers the static system-prompt supplement (built by
 * engine/recall/system-supplement.js, was index.js:7082-7087) and the Neo
 * corpus supplement (was index.js:7090-7166). The supplement returns
 * constants, which is what makes the system prompt stable per turn and
 * therefore cacheable (ADR-010).
 * The `typeof api.registerX === "function"` guards are kept: an older host
 * does not have these methods.
 */

import { sanitizeMemoryTextForPrompt } from "../../lib/memory-context-sanitize.js";
import { routeNeoRecall, workspaceKeyFromContext } from "../../lib/neo-arch.js";
import { buildSystemSupplement } from "../../engine/recall/system-supplement.js";

/**
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerPromptSupplements(ctx) {
  const {
    api,
    embeddings,
    findNeoRecord,
    getNeoStore,
    host,
    neoCfg,
    neoEnabled,
    neoRequester,
    neoRoot,
    neoWorkspaceAliases,
    runNeoGlobalSearch,
    sessionWorkspaceKeys,
  } = ctx;

  // The supplement text is the engine's (engine/recall/system-supplement.js);
  // Engine.systemSupplement() returns the same lines.
  if (!neoEnabled && typeof api.registerMemoryPromptSupplement === "function") {
    // Wenn Neo deaktiviert ist, gibt es keinen anderen Pfad für den vollen
    // Action-Safety-Header. Compact-Marker in relevant-memory-context reicht
    // nicht — explizit registrieren.
    api.registerMemoryPromptSupplement(() => buildSystemSupplement({ neoEnabled }));
  }

  if (neoEnabled && typeof api.registerMemoryPromptSupplement === "function") {
    api.registerMemoryPromptSupplement(() => buildSystemSupplement({ neoEnabled }));
  }

  if (neoEnabled && typeof api.registerMemoryCorpusSupplement === "function") {
    api.registerMemoryCorpusSupplement({
      async search(params) {
        const requester = neoRequester({ agentId: params?.agentId, ownerId: params?.ownerId || params?.userId }, { agentSessionKey: params?.agentSessionKey, workspaceKey: params?.workspaceKey });
        const store = getNeoStore({}, { agentSessionKey: params?.agentSessionKey, workspaceKey: params?.workspaceKey });
        const workspaceKey = workspaceKeyFromContext({}, {
          event: { agentSessionKey: params?.agentSessionKey, workspaceKey: params?.workspaceKey },
          defaultWorkspaceKey: neoCfg.corpusDefaultWorkspaceKey,
          rootDir: neoRoot,
          runtime: host.runtime ?? undefined,
          sessionWorkspaceKeys,
          workspaceAliases: neoWorkspaceAliases,
        });
        const items = [...store.readCandidates(500, requester), ...store.readBehaviorCards(200, requester)];
        let queryVector = null;
        try { queryVector = await (typeof embeddings.embedQuery === "function" ? embeddings.embedQuery(params?.query || "", { agentId: requester.requesterAgentId }) : embeddings.embed(params?.query || "", { agentId: requester.requesterAgentId })); }
        catch (error) { host.logger.debug(`plur1bus-neo: corpus query embedding unavailable: ${String(error)}`); }
        try { runNeoGlobalSearch(store, items, queryVector, requester); }
        catch (globalErr) { host.logger.debug(`plur1bus-neo: corpus global search failed: ${String(globalErr)}`); }
        const lanes = routeNeoRecall(items, params?.query || "", { ...requester, queryVector, maxPerLane: Math.max(1, Math.ceil((params?.maxResults || 8) / 4)) });
        return Object.entries(lanes)
          .flatMap(([lane, rows]) => rows.map(row => ({ lane, row })))
          .sort((a, b) => b.row.score - a.row.score)
          .slice(0, params?.maxResults || 8)
          .map(({ lane, row }) => ({
            corpus: "plur1bus",
            path: `neo/${row.item.workspaceKey || workspaceKey}/${row.item.id}`,
            title: row.item.category,
            kind: lane,
            score: row.score,
            snippet: sanitizeMemoryTextForPrompt(row.item.statement || row.item.content || "", 500),
            id: row.item.id,
            source: "plur1bus-neo",
            provenanceLabel: row.item.origin?.kind || "unknown",
            sourceType: row.item.origin?.trustLevel || "untrusted",
            updatedAt: row.item.updatedAt || row.item.createdAt,
          }));
      },
      async get(params) {
        const requester = neoRequester({ agentId: params?.agentId, ownerId: params?.ownerId || params?.userId }, { agentSessionKey: params?.agentSessionKey, workspaceKey: params?.workspaceKey });
        const workspaceKey = workspaceKeyFromContext({}, {
          event: { agentSessionKey: params?.agentSessionKey, workspaceKey: params?.workspaceKey },
          defaultWorkspaceKey: neoCfg.corpusDefaultWorkspaceKey,
          rootDir: neoRoot,
          runtime: host.runtime ?? undefined,
          sessionWorkspaceKeys,
          workspaceAliases: neoWorkspaceAliases,
        });
        const store = getNeoStore({}, { agentSessionKey: params?.agentSessionKey, workspaceKey: params?.workspaceKey });
        const id = String(params?.lookup || "").split("/").pop();
        const record = findNeoRecord(store, id, requester);
        if (!record) return null;
        return {
          corpus: "plur1bus",
          path: `neo/${record.workspaceKey || workspaceKey}/${record.id}`,
          title: record.category,
          kind: record.status,
          content: JSON.stringify(record, null, 2),
          fromLine: 1,
          lineCount: 1,
          id: record.id,
          provenanceLabel: record.origin?.kind || "unknown",
          sourceType: record.origin?.trustLevel || "untrusted",
          updatedAt: record.updatedAt || record.createdAt,
        };
      },
    });
  }
}
