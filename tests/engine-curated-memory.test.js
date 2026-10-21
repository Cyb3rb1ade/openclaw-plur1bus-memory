import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRecallStats } from '../engine/recall/recall-stats.js';
import { createEngine } from '../engine/create-engine.js';
import { createStubHost } from '../lib/host-services.js';
import { trackKnowledgePending, readKnowledgePendingSnapshot } from '../engine/knowledge/knowledge-pending.js';
import { config, flatEmbedder, principal, seedAndGetId, setup, twoWorkspaceHost, userAgent, code } from './helpers/shared-workspace-engine.js';
import { makeTempDir } from './helpers/temp-dir.js';

const systemAgent = { origin: 'system', background: false };

describe('curated memory contract 1.17.0', () => {
  it('persistent recall stats count repeats and distinct queries without retaining query text; agent isolated; v0 migration idempotent', () => {
    const base = makeTempDir('recall-stats-');
    const stats = createRecallStats({ baseDbPath: base });
    const id = '11111111-1111-4111-8111-111111111111';
    stats.record('anna', [id, id], 'PRIVATE QUERY SENTINEL', 20);
    stats.record('anna', [id], 'PRIVATE QUERY SENTINEL', 30);
    stats.record('anna', [id], 'another query', 40);
    const reopened = createRecallStats({ baseDbPath: base });
    assert.deepEqual(reopened.read('anna', [id]), [{ id, recalls: 3, distinctQueries: 2, lastRecalledAt: 40 }]);
    assert.deepEqual(reopened.read('bernd', [id]), [{ id, recalls: 0, distinctQueries: 0, lastRecalledAt: null }]);
    assert.ok(!readFileSync(stats.path('anna')).includes(Buffer.from('PRIVATE QUERY SENTINEL')));
    const db = new DatabaseSync(stats.path('anna'));
    db.exec('PRAGMA user_version = 0'); db.close();
    assert.equal(reopened.read('anna', [id])[0].recalls, 3);
    assert.equal(reopened.read('anna', [id])[0].distinctQueries, 2);
    assert.throws(() => stats.read('../bad', [id]));
    assert.throws(() => stats.record('anna', ['bad'], 'query', 50));
  });

  it('real recall advances public stats and survives an engine restart; warm-only and foreign principal do not leak stats', { timeout: 90_000 }, async () => {
    const { engine, stateDir, baseDbPath, workspaceDir } = setup('curated-recall-');
    const id = await seedAndGetId(engine, 'anna', 'The durable lighthouse colour is red and white.', 'lighthouse');
    assert.deepEqual((await engine.memory.stats([id], principal('anna'), userAgent)).items[0], { id, recalls: 0, distinctQueries: 0, lastRecalledAt: null });
    const recall = (query, warmOnly = false) => engine.recall({ query, principal: principal('anna'), agent: userAgent, signal: AbortSignal.timeout(10_000), warmOnly });
    await recall('what colour is the lighthouse');
    await recall('what colour is the lighthouse');
    await recall('tell me about lighthouse colour');
    const before = (await engine.memory.stats([id], principal('anna'), userAgent)).items[0];
    assert.equal(before.recalls, 3); assert.equal(before.distinctQueries, 2); assert.ok(before.lastRecalledAt > 0);
    await recall('warm lighthouse colour', true);
    assert.deepEqual((await engine.memory.stats([id], principal('anna'), userAgent)).items[0], before);
    assert.deepEqual((await engine.memory.stats([id], principal('bernd'), userAgent)).items, []);
    await engine.close({ budgetMs: 5_000 });
    const reopened = createEngine(createStubHost({ stateDir, workspaceDir: async () => workspaceDir }), config(baseDbPath), { internals: { embeddings: flatEmbedder() } });
    assert.deepEqual((await reopened.memory.stats([id], principal('anna'), userAgent)).items[0], before);
    assert.equal((await reopened.memory.stats(undefined, principal('anna'), userAgent)).items[0].recalls, 3);
    await reopened.close({ budgetMs: 5_000 });
    await assert.rejects(reopened.memory.stats([id], principal('anna'), userAgent), code('storage'));
  });

  it('knowledge job consumes only own pending queue, enforces per-run cap and supports unlimited/idempotent host promotion', { timeout: 90_000 }, async () => {
    const stateDir = makeTempDir('curated-job-state-');
    const { host, workspaceDir } = twoWorkspaceHost(stateDir);
    host.runtime = { llm: { complete: async () => ({ text: '{"importance":0.9,"intensity":0,"dominant":"neutral","emotions":{}}', provider: 'fixture', model: 'fixture' }) } };
    const engine = createEngine(host, { ...config(makeTempDir('curated-job-db-')), schicht15: { enabled: true, maxPromotionsPerRun: 3 } }, { internals: { embeddings: flatEmbedder() } });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = await seedAndGetId(engine, 'anna', `Lighthouse ${i} project decision is final.`, 'lighthouse');
      ids.push(id); trackKnowledgePending(workspaceDir, { sourceAgent: 'anna', memoryId: id, importance: 0.95 });
    }
    trackKnowledgePending(workspaceDir, { sourceAgent: 'bernd', memoryId: ids[0] });
    await engine.jobs.run('emotion-refine', 'anna');
    const spec = engine.jobs.list().find(j => j.name === 'knowledge-update');
    assert.ok(spec); assert.equal(spec.needsLlm, false);
    const run = await engine.jobs.run('knowledge-update', 'anna');
    assert.equal(run.outcome, 'completed');
    const path = join(workspaceDir, 'memory', 'KNOWLEDGE.md');
    assert.ok(existsSync(path));
    assert.equal((readFileSync(path, 'utf8').match(/<!-- plur1bus-promotion:/g) || []).length, 3);
    assert.equal(readKnowledgePendingSnapshot(workspaceDir).pending.filter(p => p.sourceAgent === 'anna').length, 1);
    const results = await engine.memory.promote({ ids }, principal('anna'), systemAgent);
    assert.equal(results.items.filter(i => i.outcome === 'promoted').length, 1);
    assert.equal(results.items.filter(i => i.reason === 'already-promoted').length, 3);
    assert.equal((readFileSync(path, 'utf8').match(/<!-- plur1bus-promotion:/g) || []).length, 4);
    assert.equal(readKnowledgePendingSnapshot(workspaceDir).pending.length, 1, 'other agent pending entry retained');
    const foreign = await engine.memory.promote({ ids: [ids[0]] }, principal('bernd'), systemAgent);
    assert.equal(foreign.items[0].reason, 'not-found');
    await assert.rejects(engine.memory.promote({ ids }, principal('anna'), { origin: 'model', background: false }), code('denied'));
    await engine.close({ budgetMs: 5_000 });
  });
});

describe('curation, migration and promotion failure guards', () => {
  it('curation list/keep/drop use ACL and human foreground guards, newest revision and mandatory audit', async () => {
    const { engine, workspaceDir } = setup('public-curation-');
    const { internalsOf } = await import('../engine/internals.js');
    const store = internalsOf(engine).getNeoStore({ agentId: 'anna', workspaceDir });
    const id = 'mem_0123456789abcdefabcd';
    const other = 'behavior_0123456789abcdefabcd';
    store.appendCandidates([
      { id, agentId: 'anna', visibility: { scope: 'agent_private' }, status: 'conflict', statement: 'curation evidence' },
      { id: other, agentId: 'bernd', visibility: { scope: 'agent_private' }, status: 'conflict', statement: 'foreign evidence' },
    ]);
    assert.deepEqual((await engine.memory.curation.list({}, principal('anna'), userAgent)).items.map(row => row.id), [id]);
    await assert.rejects(engine.memory.curation.resolve(other, 'keep', principal('anna'), userAgent), code('not-found'));
    await assert.rejects(engine.memory.curation.list({}, principal('anna'), systemAgent), code('denied'));
    await assert.rejects(engine.memory.curation.resolve(id, 'drop', principal('anna'), { origin: 'user', background: true }), code('denied'));
    await assert.rejects(engine.memory.curation.resolve(id, 'invalid', principal('anna'), userAgent), code('invalid-input'));
    assert.equal((await engine.memory.curation.resolve(id, 'keep', principal('anna'), userAgent)).status, 'promoted');
    assert.deepEqual((await engine.memory.curation.list({}, principal('anna'), userAgent)).items, []);
    await assert.rejects(engine.memory.curation.resolve(id, 'drop', principal('anna'), userAgent), code('not-found'));
    store.appendCandidates([{ id, agentId: 'anna', visibility: { scope: 'agent_private' }, status: 'conflict', updatedAt: new Date(Date.now() + 1).toISOString(), statement: 'new conflict evidence' }]);
    assert.equal((await engine.memory.curation.resolve(id, 'drop', principal('anna'), userAgent)).status, 'demoted');
    const audit = readFileSync(join(workspaceDir, '.adaptive-learning', 'destructive-ops.jsonl'), 'utf8');
    assert.equal(audit.split('\n').filter(Boolean).length, 2);
    assert.ok(!audit.includes('curation evidence'));
    await engine.close({ budgetMs: 5_000 });
    await assert.rejects(engine.memory.curation.list({}, principal('anna'), userAgent), code('storage'));
  });

  it('knowledge-update cap 0 really processes more than the default cap and preserves existing content', { timeout: 90_000 }, async () => {
    const stateDir = makeTempDir('unlimited-state-');
    const { host, workspaceDir } = twoWorkspaceHost(stateDir);
    host.runtime = { llm: { complete: async () => ({ text: '{"importance":0.9,"intensity":0,"dominant":"neutral","emotions":{}}', provider: 'fixture', model: 'fixture' }) } };
    const engine = createEngine(host, { ...config(makeTempDir('unlimited-db-')), schicht15: { enabled: true, maxPromotionsPerRun: 0 } }, { internals: { embeddings: flatEmbedder() } });
    for (let i = 0; i < 5; i++) {
      const id = await seedAndGetId(engine, 'anna', `Lighthouse ${i} unlimited decision must be kept.`, 'lighthouse');
      trackKnowledgePending(workspaceDir, { sourceAgent: 'anna', memoryId: id });
    }
    await engine.jobs.run('emotion-refine', 'anna');
    assert.equal((await engine.jobs.run('knowledge-update', 'anna')).outcome, 'completed');
    const path = join(workspaceDir, 'memory', 'KNOWLEDGE.md');
    const body = readFileSync(path, 'utf8');
    assert.equal((body.match(/<!-- plur1bus-promotion:/g) || []).length, 5);
    await engine.jobs.run('knowledge-update', 'anna');
    assert.equal(readFileSync(path, 'utf8'), body);
    await engine.close({ budgetMs: 5_000 });
  });

  it('migrates legacy v0 counters and preserves them through repeat migration', () => {
    const stats = createRecallStats({ baseDbPath: makeTempDir('legacy-stats-') });
    const id = '11111111-1111-4111-8111-111111111111';
    stats.read('anna', []);
    const db = new DatabaseSync(stats.path('anna'));
    db.exec('DROP TABLE queries; DROP TABLE metadata; PRAGMA user_version = 0');
    db.prepare('INSERT INTO stats VALUES (?, 8, 100)').run(id); db.close();
    assert.deepEqual(stats.read('anna', [id]), [{ id, recalls: 8, distinctQueries: 0, lastRecalledAt: 100 }]);
    stats.record('anna', [id], 'new query', 120);
    assert.deepEqual(stats.read('anna', [id]), [{ id, recalls: 9, distinctQueries: 1, lastRecalledAt: 120 }]);
  });
});

it('promotion rejects inactive sources, preserves pending work on file failure, never weakens scope policy', { timeout: 90_000 }, async () => {
  const { internalsOf } = await import('../engine/internals.js');
  const { mkdirSync } = await import('node:fs');
  const stateDir = makeTempDir('promotion-guards-state-');
  const { host, workspaceDir } = twoWorkspaceHost(stateDir);
  const engine = createEngine(host, { ...config(makeTempDir('promotion-guards-db-')), schicht15: { enabled: true, maxPromotionsPerRun: 0 } }, { internals: { embeddings: flatEmbedder() } });
  const id = await seedAndGetId(engine, 'anna', 'The lighthouse source may only be promoted while valid.', 'lighthouse');
  const invalid = await seedAndGetId(engine, 'anna', 'An invalidated source must never become curated knowledge.', 'invalidated');
  await internalsOf(engine).pool.withWriteDb('anna', db => db.update(invalid, { epistemicStatus: 'invalidated' }));
  assert.equal((await engine.memory.promote({ ids: [invalid] }, principal('anna'), systemAgent)).items[0].reason, 'not-live');
  trackKnowledgePending(workspaceDir, { sourceAgent: 'anna', memoryId: id });
  const path = join(workspaceDir, 'memory', 'KNOWLEDGE.md');
  mkdirSync(path, { recursive: true }); // An unwritable destination must never produce a promotion receipt.
  await assert.rejects(engine.memory.promote({ ids: [id] }, principal('anna'), systemAgent), code('storage'));
  assert.ok(readKnowledgePendingSnapshot(workspaceDir).pending.some(item => item.memoryId === id));
  await assert.rejects(engine.memory.stats(['not-a-uuid'], principal('anna'), userAgent), code('invalid-input'));
  await assert.rejects(engine.memory.promote({ ids: ['not-a-uuid'] }, principal('anna'), systemAgent), code('invalid-input'));
  await engine.close({ budgetMs: 5_000 });
});

it('trusted knowledge job drains the full 200-entry queue with cap 0; explicit host ids remain limited to 500', async () => {
  const { createKnowledgePromotion } = await import('../engine/knowledge/promote.js');
  const workspaceDir = makeTempDir('full-knowledge-queue-');
  const rows = new Map();
  for (let i = 0; i < 200; i++) {
    const id = `11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`;
    rows.set(id, { id, agentId: 'anna', scope: 'agent-private', status: 'active', text: `source ${i}` });
    trackKnowledgePending(workspaceDir, { sourceAgent: 'anna', memoryId: id });
  }
  const promotion = createKnowledgePromotion({ cfg: { schicht15: { enabled: true, maxPromotionsPerRun: 0 } }, pool: { withWriteDb: async (_agentId, run) => run({ init: async () => {}, getById: async id => rows.get(id) }) } });
  assert.equal(readKnowledgePendingSnapshot(workspaceDir).pending.length, 200);
  const excessiveIds = Array.from({ length: 501 }, (_, i) => `22222222-2222-4222-8222-${i.toString(16).padStart(12, '0')}`);
  await assert.rejects(promotion.run({ agentId: 'anna', workspaceDir, memoryCtx: { agentId: 'anna' }, ids: excessiveIds }), code('invalid-input'));
  assert.equal(readKnowledgePendingSnapshot(workspaceDir).pending.length, 200);
  const outcome = await promotion.run({ agentId: 'anna', workspaceDir, memoryCtx: { agentId: 'anna' } });
  assert.equal(outcome.items.filter(item => item.outcome === 'promoted').length, 200);
  assert.equal(readKnowledgePendingSnapshot(workspaceDir).pending.length, 0);
});

it('explicit memory_recall and memory_search tools update the same public recall counters', { timeout: 90_000 }, async () => {
  const { internalsOf } = await import('../engine/internals.js');
  const { engine, workspaceDir } = setup('recall-tool-stats-');
  const id = await seedAndGetId(engine, 'anna', 'A lighthouse keeper named Bjorn maintains the lamp.', 'lighthouse');
  const tools = internalsOf(engine).getToolFactory()({ agentId: 'anna', workspaceDir });
  for (const name of ['memory_recall', 'memory_search']) {
    const result = await tools.find(tool => tool.name === name).execute(name, { query: 'lighthouse keeper' });
    assert.ok(result.content[0].text.includes(id));
  }
  const stat = (await engine.memory.stats([id], principal('anna'), userAgent)).items[0];
  assert.equal(stat.recalls, 2); assert.equal(stat.distinctQueries, 1);
  await engine.close({ budgetMs: 5_000 });
});
