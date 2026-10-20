/** Deterministic, host-neutral promotion to the canonical workspace knowledge file. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveInside, safeUuid, safeAgentId } from '../../lib/sql-safety.js';
import { writeFileAtomicSync } from '../../lib/atomic-file.js';
import { tryAcquireOwnedLock } from '../../lib/registry-lock.js';
import { memoryOpError } from '../memory-ops/errors.js';
import { readKnowledgePendingSnapshot, removeKnowledgePending, KNOWLEDGE_LOCK_FILE } from './knowledge-pending.js';
import { checkAccess } from '../../lib/acl-middleware.js';
import { isRecallEntryLive } from '../../lib/recall-pipeline.js';

/**
 * Shared job/host primitive: reads authoritative rows; never trusts host-provided text.
 * Only agent-private cards are eligible: user/workspace copies need a separate
 * publication policy before entering the workspace-wide Markdown file.
 * @param {{pool: object, cfg: object}} deps
 * @returns {{run: Function}}
 */
export function createKnowledgePromotion({ pool, cfg }) {
  return {
    async run({ agentId, workspaceDir, ids, memoryCtx, assertOpen = () => {} }) {
      safeAgentId(agentId);
      if (!workspaceDir) throw memoryOpError('invalid-input', 'agent has no workspace');
      const snapshot = readKnowledgePendingSnapshot(workspaceDir);
      const pending = snapshot.pending.filter(item => item.sourceAgent === agentId);
      const selected = [...new Set((ids ?? pending.map(item => item.memoryId)).map(safeUuid))];
      const cap = cfg.schicht15?.maxPromotionsPerRun ?? 0;
      if (!Number.isSafeInteger(cap) || cap < 0) throw memoryOpError('invalid-input', 'promotion cap must be a nonnegative integer');
      if (ids != null && selected.length > 500) throw memoryOpError('invalid-input', 'at most 500 promotion ids');
      const skipAll = reason => ({ agentId, items: selected.map(id => ({ id, outcome: 'skipped', reason })) });
      if (cfg.schicht15?.enabled === false) return skipAll('disabled');
      const lockPath = resolveInside(workspaceDir, '.adaptive-learning', KNOWLEDGE_LOCK_FILE);
      mkdirSync(dirname(lockPath), { recursive: true });
      const lock = tryAcquireOwnedLock(lockPath, { staleMs: 5 * 60 * 1000 });
      if (!lock) return skipAll('lock-busy');
      try {
        return await pool.withWriteDb(agentId, async db => {
          await db.init();
          const path = resolveInside(workspaceDir, 'memory', 'KNOWLEDGE.md');
          let content = existsSync(path) ? readFileSync(path, 'utf8') : '# Knowledge\n';
          const items = [];
          const removeKeys = [];
          let promoted = 0;
          for (const id of selected) {
            const row = await db.getById(id);
            let reason = null;
            if (!row || !checkAccess(memoryCtx, row).allowed) reason = 'not-found';
            else if (!isRecallEntryLive(row, Date.now())) reason = 'not-live';
            else if (row.scope && row.scope !== 'agent-private') reason = 'scope-not-publishable';
            else if (row.agentId && row.agentId !== agentId) reason = 'not-found';
            const digest = row ? createHash('sha256').update(`${agentId}\0${id}\0${row.text}`).digest('hex') : '';
            const marker = `<!-- plur1bus-promotion:${digest} -->`;
            if (!reason && content.includes(marker)) reason = 'already-promoted';
            if (!reason && cap > 0 && promoted >= cap) reason = 'cap-reached';
            if (!reason) {
              // Quote as evidence; raw HTML/control characters cannot create new markers.
              const evidence = String(row.text || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').split('\n').map(line => `> ${line}`).join('\n');
              content += `\n${marker}\n## ${new Date().toISOString().slice(0, 10)} · ${id}\n\n${evidence}\n`;
              promoted++;
              items.push({ id, outcome: 'promoted', reason: 'integrated' });
            } else items.push({ id, outcome: 'skipped', reason });
            if (!reason || ['already-promoted', 'not-found', 'not-live'].includes(reason)) {
              removeKeys.push(...pending.filter(item => item.memoryId === id).map(item => item.key));
            }
          }
          assertOpen();
          if (promoted > 0) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileAtomicSync(path, content);
          }
          // The source marker is the commit receipt. A crash before queue cleanup
          // replays as already-promoted, never a duplicate nor a false success.
          removeKnowledgePending(workspaceDir, removeKeys);
          return { agentId, items };
        });
      } finally { lock.release(); }
    },
  };
}
