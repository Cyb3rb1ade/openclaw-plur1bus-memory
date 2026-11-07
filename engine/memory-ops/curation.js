/** Public human curation surface, separate from D31 memory.proposals. */
import { appendDestructiveOpLog } from '../../lib/sql-safety.js';
import { resolveCurationRecord } from '../../lib/curation-resolve.js';
import { isNeoRecordAccessible } from '../../lib/neo-arch.js';
import { validateInput } from '../../lib/input-limits.js';
import { memoryOpError } from './errors.js';

/** @param {{opsContext: object, getNeoStore: Function}} deps @returns {{list: Function, resolve: Function}} */
export function createMemoryCuration({ opsContext, getNeoStore }) {
  async function context(p, a) {
    const resolved = await opsContext.resolve(p, a, { destructive: true });
    const { agentId, memoryCtx, workspaceDir } = resolved;
    return {
      ...resolved,
      store: getNeoStore({ agentId, workspaceDir }),
      requester: { requesterAgentId: agentId, requesterWorkspaceKey: memoryCtx.workspaceIdentity || '', requesterOwnerId: memoryCtx.userPrincipal || '' },
    };
  }
  function queue(store, requester) {
    const latest = new Map();
    const rows = [...store.readCandidates(10_000), ...store.readBehaviorCards(10_000)];
    for (const row of rows) {
      const previous = latest.get(row.id);
      const time = item => { const value = item?.updatedAt || item?.createdAt; return (typeof value === 'number' ? value : Date.parse(value || '')) || 0; };
      if (!previous || time(row) >= time(previous)) latest.set(row.id, row);
    }
    return [...latest.values()].filter(row => !row.hardDeleted && row.epistemicStatus !== 'invalidated' && isNeoRecordAccessible(row, requester) && ['candidate', 'conflict', 'stale'].includes(row.status));
  }
  return {
    /** Latest visible unresolved candidate revisions only; at most 100 per call. */
    async list(q, p, a) {
      const { agentId, store, requester } = await context(p, a);
      const limit = q?.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw memoryOpError('invalid-input', 'limit must be 1..100');
      const rows = queue(store, requester);
      return { agentId, items: rows.slice(0, limit).map(row => ({ id: row.id, status: row.status, text: String(row.statement || row.text || ''), category: row.category || null })), truncated: rows.length > limit };
    },
    /** Keep/drop are human-only and write a mandatory audit receipt before mutation. */
    async resolve(id, action, p, a) {
      const { agentId, store, requester, workspaceDir } = await context(p, a);
      // Neo IDs are stable mem_<hash>/behavior_<hash> keys, not LanceDB UUIDs.
      const input = validateInput(id, { name: 'curation id', required: true, maxLength: 200 });
      if (!input.ok || typeof id !== 'string' || !id.trim()) throw memoryOpError('invalid-input', 'invalid curation record id');
      if (!['keep', 'drop'].includes(action)) throw memoryOpError('invalid-input', 'action must be keep or drop');
      const record = queue(store, requester).find(row => row.id === id);
      if (!record) throw memoryOpError('not-found', 'curation record not found');
      opsContext.assertOpen();
      if (!appendDestructiveOpLog(workspaceDir, { event: 'curation.resolve', source: 'engine.memory.curation', agentId, recordId: id, action, timestamp: new Date().toISOString() })) throw memoryOpError('storage', 'curation audit unavailable');
      return { id, ...resolveCurationRecord(store, record, action, { authorized: true }) };
    },
  };
}
