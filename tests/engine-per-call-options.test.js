import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../engine/create-engine.js';
import { internalsOf } from '../engine/internals.js';
import { createWarmRecallPath } from '../engine/recall/warm-recall-path.js';
import { createStubHost } from '../lib/host-services.js';
import { countPostTurnWork } from '../lib/post-turn-queue.js';
import { shouldDeferPostTurnLlm } from '../engine/capture/post-turn-work.js';
import { hashEmbedder } from './helpers/hash-embedder.js';
import { makeTempDir } from './helpers/temp-dir.js';
const agent = { origin: 'user', background: false };
const principal = id => ({ agentId: id, channel: 'cli', accountId: 'local', trust: 'inferred' });
const query = (text, warmOnly = true) => ({ query: text, principal: principal('agent-a'), agent, signal: new AbortController().signal, warmOnly });
const turn = id => ({ agentId: id, principal: principal(id), agent, messages: [{ role: 'user', content: 'Remember that the planning meeting starts on Thursday morning.' }], incognito: false, signal: new AbortController().signal });
function rig({ reranker = null, capability = false, defer = false, extra = {}, llm } = {}) {
  const stateDir = makeTempDir('per-call-state-'); const baseDbPath = makeTempDir('per-call-data-');
  const host = createStubHost({ stateDir, ...(llm ? { runtime: { llm } } : {}), capabilities: { postTurnRefineScheduled: capability }, workspaceDir: async id => { const p = join(stateDir, id); mkdirSync(p, { recursive: true }); return p; } });
  const engine = createEngine(host, { baseDbPath, embedding: { provider: 'local-transformers', local: { dimensions: 384 } }, autoCapture: true, autoRecall: true, neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, runtime: { recallTimeoutMs: 10000, maxConcurrentRecall: 2, deferPostTurnLlm: defer }, ...extra }, { internals: { embeddings: hashEmbedder(), reranker } });
  return { engine, host, baseDbPath, internals: internalsOf(engine) };
}
function recallSpy(f, calls) {
  const db = { init: async () => true, table: {} };
  const context = { ...f.internals.recallContext, pool: { withWriteDb: async (_id, fn) => fn(db), withReadDbs: async (_id, fn) => fn([{ namespace: 'private', db }]), withReadOnlyReadDbs: async (_id, fn) => fn([{ namespace: 'private', db }]) },
    async runMergedNamespaceRecall(_dbs, params) { await new Promise(resolve => setImmediate(resolve)); if (params.reranker) await params.reranker.rerank(params.query, ['a', 'b'], 2); calls.push([params.query, !!params.reranker]); return { memories: [], canonical: [] }; } };
  context.warmRecallPath = createWarmRecallPath(context); f.internals.recallContext = context;
}
test('recall without options keeps the configured reranker call snapshot', async () => {
  const calls = [], ranked = []; const reranker = { rerank: async text => { ranked.push(text); return []; } }; const f = rig({ reranker }); recallSpy(f, calls);
  try { const result = await f.engine.recall(query('default recall')); assert.equal(result.degraded, null); assert.deepEqual(calls, [['default recall', true]]); assert.deepEqual(ranked, ['default recall']); assert.equal(Object.hasOwn(result, 'diagnostics'), false); } finally { await f.engine.close(); }
});
test('concurrent recall options bypass only their own reranker and do not mutate context', async () => {
  const calls = [], ranked = []; const reranker = { rerank: async text => { ranked.push(text); return []; } }; const f = rig({ reranker }); recallSpy(f, calls);
  try { const results = await Promise.all([f.engine.recall(query('off recall'), { reranker: 'off' }), f.engine.recall(query('on recall'), { reranker: 'on' })]); assert.ok(results.every(result => result.degraded === null)); assert.deepEqual(ranked, ['on recall']); assert.deepEqual(calls.sort(), [['off recall', false], ['on recall', true]]); assert.equal(f.internals.recallContext.reranker, reranker);
    await f.engine.recall(query('later default')); assert.deepEqual(ranked, ['on recall', 'later default']);
  } finally { await f.engine.close(); }
});
test('reranker on without a configured provider returns an explicit diagnostic without an error', async () => {
  const f = rig(); recallSpy(f, []); try { const result = await f.engine.recall(query('no reranker'), { reranker: 'on' }); assert.equal(result.degraded, null); assert.deepEqual(result.diagnostics, [{ feature: 'reranker', reason: 'reranker-not-configured', fallback: 'unreranked' }]); } finally { await f.engine.close(); }
});
test('capture options are snapshotted per invocation and defaults keep the old scheduler decision', async () => {
  const f = rig({ capability: true }); const calls = [];
  f.internals.getCaptureTurn = () => async (_event, ctx, opts) => { await new Promise(resolve => setImmediate(resolve)); calls.push([ctx.agentId, shouldDeferPostTurnLlm(f.internals.cfg, f.host, opts.deferPostTurnLlm)]); opts.report.stored = 1; return { ok: true }; };
  try {
    const changing = { deferPostTurnLlm: true }; const first = f.engine.capture(turn('agent-a'), changing); changing.deferPostTurnLlm = false;
    const second = f.engine.capture(turn('agent-b'), { deferPostTurnLlm: false }); assert.deepEqual(await Promise.all([first.done, second.done]), [{ stored: 1, skipped: 0 }, { stored: 1, skipped: 0 }]);
    await f.engine.capture(turn('agent-c')).done; assert.deepEqual(calls.sort(), [['agent-a', true], ['agent-b', false], ['agent-c', false]]); assert.equal(f.internals.cfg.runtime.deferPostTurnLlm, false);
  } finally { await f.engine.close(); }
});
test('capture defer request without a scheduler falls back inline with a result diagnostic', async () => {
  const f = rig(); let inline = false;
  f.internals.getCaptureTurn = () => async (_event, _ctx, opts) => { inline = !shouldDeferPostTurnLlm(f.internals.cfg, f.host, opts.deferPostTurnLlm); opts.report.stored = 1; return { ok: true }; };
  try { const result = await f.engine.capture(turn('agent-a'), { deferPostTurnLlm: true }).done; assert.equal(inline, true); assert.equal(result.stored, 1); assert.deepEqual(result.diagnostics, [{ feature: 'postTurnLlm', reason: 'post-turn-refine-unscheduled', fallback: 'inline' }]); } finally { await f.engine.close(); }
});
test('defer decision overrides are local and do not change configuration', () => {
  const cfg = { runtime: { deferPostTurnLlm: true } }; const host = { capabilities: { postTurnRefineScheduled: true } };
  assert.equal(shouldDeferPostTurnLlm(cfg, host), true); assert.equal(shouldDeferPostTurnLlm(cfg, host, false), false); assert.equal(shouldDeferPostTurnLlm(cfg, host, true), true); assert.equal(cfg.runtime.deferPostTurnLlm, true);
});

test('real parallel captures queue only the deferred turn; scheduler drains its refinement', async () => {
  const purposes = [];
  const f = rig({ capability: true, extra: { neo: { enabled: true }, merging: { enabled: true }, duplicateThreshold: 1.01 }, llm: { async complete(params) { purposes.push(params.purpose); return { text: '[]', provider: 'test', model: 'test', usage: {} }; } } });
  const record = id => ({ ...turn(id), messages: [
    { role: 'user', content: 'We decided to move the weekly planning meeting to Thursday mornings from now on.' },
    { role: 'assistant', content: 'Noted: weekly planning moves to Thursday mornings.' },
    { role: 'user', content: 'Also remember that the release freeze starts two days before every planning meeting.' },
    { role: 'assistant', content: 'Understood, the release freeze begins two days earlier.' },
  ] });
  try {
    const [deferred, inline] = await Promise.all([f.engine.capture(record('agent-deferred'), { deferPostTurnLlm: true }).done, f.engine.capture(record('agent-inline'), { deferPostTurnLlm: false }).done]);
    assert.ok(deferred.stored >= 1, JSON.stringify(deferred)); assert.ok(inline.stored >= 1, JSON.stringify(inline));
    assert.equal(countPostTurnWork(f.baseDbPath, 'agent-deferred'), 1); assert.equal(countPostTurnWork(f.baseDbPath, 'agent-inline'), 0);
    const before = purposes.filter(p => p === 'conversation-insights' || p === 'episode-analysis').length; assert.ok(before > 0, 'inline refinement ran');
    const outcome = await f.engine.jobs.run('post-turn-refine', 'agent-deferred'); assert.equal(outcome.outcome, 'completed');
    assert.equal(countPostTurnWork(f.baseDbPath, 'agent-deferred'), 0); assert.ok(purposes.filter(p => p === 'conversation-insights' || p === 'episode-analysis').length > before);
    assert.equal(f.internals.cfg.runtime.deferPostTurnLlm, false);
  } finally { await f.engine.close({ budgetMs: 5000 }); }
});

test('ordinary recall bypasses ranking and isolates scheduler fallback cache keys', async () => {
  const ranked = [], calls = [], keys = []; const reranker = { rerank: async text => { ranked.push(text); return []; } }; const f = rig({ reranker }); recallSpy(f, calls);
  const scheduler = f.internals.recallContext.runtimeScheduler;
  f.internals.recallContext = { ...f.internals.recallContext, runtimeScheduler: { ...scheduler, runRecall(request, work) { keys.push(request.cacheKey); return scheduler.runRecall(request, work); } } };
  try {
    const off = await f.engine.recall(query('ordinary recall', false), { reranker: 'off' });
    const normal = await f.engine.recall(query('ordinary recall', false));
    assert.equal(off.degraded, null); assert.equal(normal.degraded, null);
    assert.deepEqual(ranked, ['ordinary recall']); assert.deepEqual(calls, [['ordinary recall', false], ['ordinary recall', true]]);
    assert.notEqual(keys[0], keys[1]); assert.ok(keys[0].includes('reranker-off')); assert.ok(!keys[1].includes('reranker-off'));
  } finally { await f.engine.close(); }
});
test('capture without options retains the configured deferred scheduler snapshot', async () => {
  const f = rig({ capability: true, defer: true }); const calls = [];
  f.internals.getCaptureTurn = () => async (_event, _ctx, opts) => { calls.push(shouldDeferPostTurnLlm(f.internals.cfg, f.host, opts.deferPostTurnLlm)); opts.report.stored = 1; return { ok: true }; };
  try { assert.deepEqual(await f.engine.capture(turn('agent-a')).done, { stored: 1, skipped: 0 }); assert.deepEqual(calls, [true]); } finally { await f.engine.close(); }
});
