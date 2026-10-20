import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInternalJobBodies } from '../engine/jobs/internal-job-bodies.js';
import { createEngine } from '../engine/create-engine.js';
import { config, flatEmbedder, principal, userAgent } from './helpers/shared-workspace-engine.js';
import { readKnowledgePendingSnapshot, trackKnowledgePending } from '../engine/knowledge/knowledge-pending.js';
import { createKnowledgePromotion } from '../engine/knowledge/promote.js';
import { createStubHost } from '../lib/host-services.js';
import { tryAcquireOwnedLock } from '../lib/registry-lock.js';
import { makeTempDir } from './helpers/temp-dir.js';

const text = 'Remember this: we decided to deploy the Atlas production service only on Tuesdays after the security review.';
const encoding = JSON.stringify({ importance: 0.9, intensity: 0, dominant: 'neutral', emotions: {}, reason: 'durable deployment policy' });

async function refine(rows, cfg = {}, lockPending = false, failUpdate = false) {
  const workspaceDir = makeTempDir('capture-knowledge-refine-');
  const db = {
    schemaFieldNames: new Set(['emotionStatus', 'importanceStatus']),
    table: { query: () => ({ where() { return this; }, limit() { return this; }, async toArray() { return rows.filter(row => row.importanceStatus === 'pending'); } }) },
    async update(id, patch) { if (failUpdate) { failUpdate = false; throw new Error('fixture DB commit failed'); } Object.assign(rows.find(row => row.id === id), patch); },
  };
  const run = createInternalJobBodies({ cfg, host: createStubHost(), pool: { withDb: (_agent, fn) => fn(db) },
    encodingCallLlm: async () => encoding, EMOTION_REFINE_MAX_ROWS: 100, EMOTION_REFINE_DEADLINE_MS: 10_000,
    EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES: 3, formatJsonCommandResult: value => value });
  const invoke = () => run('emotion-refine', { input: { commandCtx: { agentId: 'alpha', workspaceDir }, memoryCtx: { agentId: 'alpha' } }, skip: (_reason, value) => value });
  mkdirSync(join(workspaceDir, '.adaptive-learning'), { recursive: true });
  const lock = lockPending ? tryAcquireOwnedLock(join(workspaceDir, '.adaptive-learning', 'knowledge-pending.lock'), { staleMs: 60_000 }) : null;
  if (failUpdate) await assert.rejects(invoke(), /fixture DB commit failed/);
  else await invoke();
  return { rows, snapshot: () => readKnowledgePendingSnapshot(workspaceDir), invoke, lock };
}

function captured(overrides = {}) {
  return { id: randomUUID(), text, category: 'decision', importance: 0.5, importanceStatus: 'pending', emotionStatus: 'final',
    scope: 'agent-private', storedBy: 'alpha', status: 'active', createdAt: Date.now(), expiresAt: 0, ...overrides };
}

test('importance refinement queues a genuine capture only after a successful high-importance verdict, once', async () => {
  const row = captured();
  const f = await refine([row]);
  assert.equal(row.importance, 0.9);
  assert.equal(row.importanceStatus, 'final');
  assert.deepEqual(f.snapshot().pending.map(({ sourceAgent, memoryId, importance }) => ({ sourceAgent, memoryId, importance })), [{ sourceAgent: 'alpha', memoryId: row.id, importance: 0.9 }]);
  await f.invoke();
  assert.equal(f.snapshot().pendingCount, 1);
});

test('refinement never queues shared, foreign, expired, archived, trivial or non-fact captures', async () => {
  const rows = [captured({ scope: 'user', ownerUserId: 'user:v2:0000000000000000000000000000000000000000000000000000000000000000' }),
    captured({ scope: 'workspace', workspaceId: 'workspace:v1:main' }), captured({ storedBy: 'beta' }),
    captured({ expiresAt: Date.now() - 1 }), captured({ status: 'archived' }), captured({ text: 'ok', category: 'fact' }),
    captured({ category: 'preference' }), captured({ epistemicStatus: 'invalidated' }), captured({ agentId: 'beta' })];
  assert.equal((await refine(rows)).snapshot().pendingCount, 0);
});

test('disabled knowledge promotion and a higher importance threshold leave the queue empty', async () => {
  assert.equal((await refine([captured()], { schicht15: { enabled: false } })).snapshot().pendingCount, 0);
  assert.equal((await refine([captured()], { schicht15: { minImportance: 0.94 } })).snapshot().pendingCount, 0);
});

test('queue lock failure leaves importance unresolved, so a later refinement retries rather than losing the capture', async () => {
  const row = captured();
  const f = await refine([row], {}, true);
  try {
    assert.equal(row.importanceStatus, 'pending');
    assert.equal(row.importance, 0.5);
  } finally { f.lock.release(); }
  await f.invoke();
  assert.equal(row.importanceStatus, 'final');
  assert.equal(f.snapshot().pendingCount, 1);
});

test('promotion retains staged pending-importance entries until the authoritative verdict commits', async () => {
  const workspaceDir = makeTempDir('capture-knowledge-stage-');
  const row = captured();
  trackKnowledgePending(workspaceDir, { sourceAgent: 'alpha', memoryId: row.id, category: 'decision', importance: 0.9 });
  const promotion = createKnowledgePromotion({ cfg: {}, pool: { withWriteDb: (_id, fn) => fn({ init: async () => {}, getById: async () => row }) } });
  const run = () => promotion.run({ agentId: 'alpha', workspaceDir, memoryCtx: { agentId: 'alpha' } });
  assert.deepEqual((await run()).items, [{ id: row.id, outcome: 'skipped', reason: 'importance-pending' }]);
  assert.equal(readKnowledgePendingSnapshot(workspaceDir).pendingCount, 1);
  assert.equal(existsSync(join(workspaceDir, 'memory', 'KNOWLEDGE.md')), false);
  row.importanceStatus = 'final'; row.importance = 0.9;
  assert.equal((await run()).items[0].outcome, 'promoted');
  assert.equal(readKnowledgePendingSnapshot(workspaceDir).pendingCount, 0);
});

test('DB commit failure retains the staged entry and unresolved row for an idempotent refinement retry', async () => {
  const row = captured();
  const f = await refine([row], {}, false, true);
  assert.equal(row.importanceStatus, 'pending');
  assert.equal(f.snapshot().pendingCount, 1);
  await f.invoke();
  assert.equal(row.importanceStatus, 'final');
  assert.equal(f.snapshot().pendingCount, 1);
});

test('a later low final verdict cannot publish a staged high verdict from a failed DB commit', async () => {
  const workspaceDir = makeTempDir('capture-knowledge-low-final-');
  const row = captured({ importance: 0.3, importanceStatus: 'final' });
  trackKnowledgePending(workspaceDir, { sourceAgent: 'alpha', memoryId: row.id, importance: 0.9, reason: 'importance-refinement' });
  const promotion = createKnowledgePromotion({ cfg: {}, pool: { withWriteDb: (_id, fn) => fn({ init: async () => {}, getById: async () => row }) } });
  const result = await promotion.run({ agentId: 'alpha', workspaceDir, memoryCtx: { agentId: 'alpha' } });
  assert.equal(result.items[0].reason, 'importance-below-threshold');
  assert.equal(readKnowledgePendingSnapshot(workspaceDir).pendingCount, 0);
  assert.equal(existsSync(join(workspaceDir, 'memory', 'KNOWLEDGE.md')), false);
});

test('real auto-capture, importance classification and public knowledge job produce canonical evidence', { timeout: 60_000 }, async () => {
  const workspaceDir = makeTempDir('capture-knowledge-real-');
  const host = createStubHost({ stateDir: makeTempDir('capture-knowledge-state-'), workspaceDir: async () => workspaceDir,
    runtime: { llm: { complete: async () => ({ text: encoding, provider: 'fixture', model: 'fixture', usage: {} }) } } });
  const engine = createEngine(host, { ...config(makeTempDir('capture-knowledge-db-')), autoCapture: true,
    duplicateThreshold: 1.01, schicht15: { enabled: true } }, { internals: { embeddings: flatEmbedder() } });
  try {
    const result = await engine.capture({ agentId: 'anna', principal: principal('anna'), agent: userAgent, incognito: false,
      sessionKey: 'agent:anna:direct:knowledge', runId: randomUUID(), messages: [{ role: 'user', content: text }], signal: AbortSignal.timeout(15_000) }).done;
    assert.ok(result.stored > 0);
    assert.equal(readKnowledgePendingSnapshot(workspaceDir).pendingCount, 0, 'neutral pending importance is not yet publication work');
    assert.equal((await engine.jobs.run('emotion-refine', 'anna')).outcome, 'completed');
    assert.ok(readKnowledgePendingSnapshot(workspaceDir).pending.some(row => row.importance === 0.9));
    assert.equal((await engine.jobs.run('knowledge-update', 'anna')).outcome, 'completed');
    assert.ok(readFileSync(join(workspaceDir, 'memory', 'KNOWLEDGE.md'), 'utf8').includes(text));
    assert.equal(readKnowledgePendingSnapshot(workspaceDir).pendingCount, 0);
  } finally { await engine.close({ budgetMs: 5000 }); }
});
