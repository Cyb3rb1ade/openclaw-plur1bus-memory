import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingIdentity, identityId, fuseIdentityResults, embedIdentityQueries } from '../lib/providers/embedding-identity.js';
import { createEmbeddingCache } from '../lib/embedding-cache.js';

const a = { provider: 'fake', model: 'a', revision: 'r1', dimension: 2, normalization: 'l2', prefixScheme: 'query/passage', instruction: '', dtype: 'float32' };
const b = { ...a, model: 'b', dimension: 3 };
test('identity includes every vector-space property and ignores credentials', () => {
  const id = identityId(a);
  assert.equal(identityId({ ...a, apiKey: 'secret' }), id);
  for (const field of ['provider', 'model', 'revision', 'normalization', 'prefixScheme', 'instruction', 'dtype']) {
    assert.notEqual(identityId({ ...a, [field]: `${a[field]}-other` }), id, field);
  }
  assert.notEqual(identityId({ ...a, dimension: 3 }), id);
  assert.deepEqual(embeddingIdentity(a), embeddingIdentity({ ...a, apiKey: 'secret' }));
});
test('RRF cannot compare raw scores across identities; one identity is byte unchanged', () => {
  const list = (ids, score) => ids.map(id => ({ entry: { id, text: id }, score }));
  const first = { identityId: identityId(a), memories: list(['a1', 'a2'], -10000), canonical: [] };
  const second = { identityId: identityId(b), memories: list(['b1', 'b2'], 10000), canonical: [] };
  assert.deepEqual(fuseIdentityResults([first, second], { k: 60 }).flatMap(x => x.memories).map(x => x.entry.id), ['a1', 'b1', 'a2', 'b2']);
  assert.deepEqual(fuseIdentityResults([first]), [first]);
});
test('one query per identity, parallel and bounded even if provider ignores signal', async () => {
  const calls = [];
  const providers = new Map([
    [identityId(a), { embedQuery: async (_text, { signal }) => { calls.push(signal); return [1, 0]; } }],
    [identityId(b), { embedQuery: async (_text, { signal }) => { calls.push(signal); return new Promise(() => {}); } }],
  ]);
  const start = performance.now();
  const result = await embedIdentityQueries('query', [a, b, a], providers, { budgetMs: 35 });
  assert.deepEqual(result.vectors.get(identityId(a)), [1, 0]);
  assert.equal(result.failures.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(performance.now() - start < 400);
  assert.ok(calls[1].aborted);
});
test('embedding cache isolates same-dimension revision and prefix changes', async () => {
  const cache = createEmbeddingCache({ enabled: true, model: a.model, provider: a.provider, dimensions: 2 });
  let calls = 0;
  const compute = async texts => { calls++; return texts.map(() => [calls, 0]); };
  await cache.getMany(['hello'], { identity: a }, compute);
  await cache.getMany(['hello'], { identity: a }, compute);
  await cache.getMany(['hello'], { identity: { ...a, revision: 'r2' } }, compute);
  assert.equal(calls, 2);
  await cache.close();
});

import { runMergedNamespaceRecall } from '../engine/recall/namespace-recall.js';
import { makeRow, mockTable } from './helpers/golden-recall-harness.js';
import { shareCard } from '../lib/telegram-commands/memory-edit.js';

test('namespace recall routes different dimensions and shares one query per identity', async () => {
  const seen = [];
  const providers = new Map([a, b].map(identity => [identityId(identity), {
    embedQuery: async () => { seen.push(identity.model); return Array(identity.dimension).fill(0.1); },
  }]));
  const routes = [a, b, a].map((identity, i) => {
    const table = mockTable([makeRow({ id: `row-${i}`, text: `fact ${i}`, agentId: 'test', distance: i ? 0 : 1 })]);
    const search = table.vectorSearch;
    table.vectorSearch = vector => { assert.equal(vector.length, identity.dimension); return search(vector); };
    return { namespace: `n${i}`, sourceKind: 'private', db: { identity, table } };
  });
  const result = await runMergedNamespaceRecall(routes, {
    query: 'fact', agentId: 'test', embeddings: providers.get(identityId(a)), identityProviders: providers,
    canonicalEnabled: false, associativeEnabled: false, queryRefinerEnabled: false,
    minScore: 0, topN: 10, dedupEnabled: false, adaptiveBudget: { enabled: false },
  });
  assert.deepEqual(seen.sort(), ['a', 'b']);
  assert.equal(result.memories.length, 3);
});

test('share re-embeds with target identity and refuses missing target provider', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const card = { id, text: 'shared fact', expiresAt: 0, agentId: 'test', status: 'active', scope: 'agent-private' };
  const privatePool = { withWriteDb: async (_agent, fn) => fn({ init: async () => {}, getById: async () => card }) };
  const targetDb = { identity: b, vectorDim: 3, init: async () => {} };
  const sharedPool = { identity: b, withWorkspaceDb: async (_ctx, fn) => fn(targetDb) };
  let calls = 0;
  const result = await shareCard(privatePool, sharedPool, { embed: async () => { calls++; return [1, 0]; } }, 'test', id, { ctx: { agentId: 'test', workspaceIdentity: 'workspace-a' } });
  assert.equal(result.code, 'EMBEDDER_UNAVAILABLE');
  assert.equal(calls, 0);
});

import { MemoryDB } from '../engine/store/memory-db.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { makeTempDir } from './helpers/temp-dir.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('real stores keep distinct identities; share uses destination width and preserves provenance', async () => {
  const root = makeTempDir('pr10-store-');
  const source = new MemoryDB(join(root, 'source'), 2, null, { identity: a });
  const destination = new MemoryDB(join(root, 'destination'), 3, null, { identity: b });
  const id = randomUUID();
  const providers = new Map([[identityId(b), { embedPassage: async text => { assert.equal(text, 'different vector spaces'); return [0, 1, 0]; } }]]);
  try {
    await source.store({ id, text: 'different vector spaces', summary: '', vector: [1, 0], agentId: 'test', storedBy: 'test', scope: 'agent-private', status: 'active', expiresAt: 0 });
    const result = await shareCard({ withWriteDb: async (_id, fn) => fn(source) }, {
      identity: b, withWorkspaceDb: async (_ctx, fn) => fn(destination),
    }, { embed: async () => assert.fail('source embedder must not be called'), identityProviders: providers }, 'test', id, { ctx: { agentId: 'test', workspaceIdentity: 'workspace-a' } });
    assert.equal(result.ok, true, result.error);
    const copy = await destination.getById(result.sharedId);
    assert.deepEqual(Array.from(copy.vector), [0, 1, 0]);
    assert.equal(copy.sourceMemoryId, id);
    assert.equal(copy.sourceAgentId, 'test');
    assert.equal(destination.identityStatus, 'verified');
    await destination.shutdown();
    const reopened = new MemoryDB(join(root, 'destination'), 2);
    try { await reopened.init(); assert.equal(identityId(reopened.identity), identityId(b)); assert.equal(reopened.vectorDim, 3); }
    finally { await reopened.shutdown(); }
    const incompatible = new MemoryDB(join(root, 'destination'), 3, null, { identity: { ...b, revision: 'r2' } });
    try { await assert.rejects(incompatible.init(), error => error.code === 'EMBEDDING_IDENTITY_MISMATCH'); }
    finally { await incompatible.shutdown(); }
  } finally {
    await source.shutdown(); await destination.shutdown(); rmSync(root, { recursive: true, force: true });
  }
});

test('recall survives one identity outage and reranks the union exactly once', async () => {
  let reranks = 0;
  const providers = new Map([[identityId(a), { embedQuery: async () => [1, 0] }], [identityId(b), { embedQuery: async () => { throw new Error('offline'); } }]]);
  const routes = [a, b].map((identity, i) => ({ namespace: `n${i}`, sourceKind: 'private', db: { identity, table: mockTable([makeRow({ id: `row-${i}`, text: `fact ${i}`, agentId: 'test' })]) } }));
  const params = { query: 'fact', agentId: 'test', identityProviders: providers, embeddings: providers.get(identityId(a)), canonicalEnabled: false, associativeEnabled: false, dedupEnabled: false, minScore: 0, topN: 10, adaptiveBudget: { enabled: false }, logger: { warn() {} } };
  const start = performance.now();
  const result = await runMergedNamespaceRecall(routes, params);
  assert.equal(result.memories.length, 1);
  assert.equal(result.degraded.identities[0].identityId, identityId(b));
  assert.ok(performance.now() - start < 600);
  providers.set(identityId(b), { embedQuery: async () => [0, 1, 0] });
  const ranked = await runMergedNamespaceRecall(routes, { ...params, reranker: { rerank: async (_query, docs) => { reranks++; assert.equal(docs.length, 2); return [{ index: 1, score: 1 }, { index: 0, score: 0 }]; } } });
  assert.equal(reranks, 1);
  assert.deepEqual(ranked.memories.map(item => item.entry.id), ['row-1', 'row-0']);
});

import { createEngine } from '../engine/create-engine.js';
import { createStubHost } from '../lib/host-services.js';
import { internalsOf } from '../engine/internals.js';

test('engine opens two agents in parallel with their own dimensions and exposes all identities', async () => {
  const root = makeTempDir('pr10-engine-');
  const flat = { embed: async () => Array(384).fill(0.1), embedQuery: async () => Array(384).fill(0.1), embedPassage: async () => Array(384).fill(0.1), shutdown: async () => {} };
  const other = { embed: async () => [0, 1, 0], embedQuery: async () => [0, 1, 0], embedPassage: async () => [0, 1, 0], shutdown: async () => {} };
  const engine = createEngine(createStubHost({ stateDir: join(root, 'state') }), {
    baseDbPath: join(root, 'stores'), autoCapture: false, autoRecall: false,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    embedding: { routes: [{ agentId: 'agent-b', identity: b }] },
  }, { internals: { embeddings: flat, identityProviders: new Map([[identityId(b), other]]) } });
  try {
    await Promise.all([engine.open('agent-a'), engine.open('agent-b')]);
    const dimensions = await Promise.all(['agent-a', 'agent-b'].map(agent => internalsOf(engine).pool.withWriteDb(agent, async db => db.vectorDim)));
    assert.deepEqual(dimensions, [384, 3]);
    const identities = engine.embedding.identities();
    assert.equal(identities.length, 2);
    const vectors = await engine.embedding.embed(['query'], { kind: 'query', identity: identities[1], signal: AbortSignal.timeout(400) });
    assert.deepEqual(Array.from(vectors[0]), [0, 1, 0]);
    await assert.rejects(engine.embedding.embed(['query'], { kind: 'query', identity: { fingerprintId: 'missing' } }), error => error.code === 'EMBEDDER_UNAVAILABLE');
  } finally { await engine.close({ budgetMs: 5000 }); rmSync(root, { recursive: true, force: true }); }
});

import { embeddingFingerprintId } from '../lib/reembedding/fingerprint.js';
import { embeddingFingerprintFromNormalizedConfig } from '../lib/reembedding/runtime-config.js';

test('legacy generation fingerprints remain loadable while complete identity is exposed', async () => {
  const root = makeTempDir('pr10-legacy-generation-');
  const fake = () => ({ embed: async () => Array(384).fill(0), embedQuery: async () => Array(384).fill(0), embedPassage: async () => Array(384).fill(0), shutdown: async () => {} });
  const config = { baseDbPath: join(root, 'source'), autoCapture: false, neo: { enabled: false }, obsidianBridge: { enabled: false }, embedding: { provider: 'local-transformers', local: { dimensions: 384 } } };
  const source = createEngine(createStubHost({ stateDir: join(root, 'state') }), config, { internals: { embeddings: fake() } });
  const legacy = { ...embeddingFingerprintFromNormalizedConfig(internalsOf(source).normalizedEmbeddingCfg) };
  delete legacy.prefixScheme;
  delete legacy.tokenCap;
  const oldId = embeddingFingerprintId(legacy);
  await source.close({ budgetMs: 5000 });
  const warnings = [];
  const host = createStubHost({ stateDir: join(root, 'other-state'), logger: { warn: message => warnings.push(message), info() {}, error() {}, debug() {} } });
  mkdirSync(join(root, 'old-store', 'generations', 'old-generation'), { recursive: true });
  writeFileSync(join(root, 'old-store', 'generations', 'old-generation', 'generation.json'), JSON.stringify({ schemaVersion: 1, generation: 'old-generation', fingerprintId: oldId, dimensions: 384, tables: {} }));
  const migrated = createEngine(host, { ...config, baseDbPath: join(root, 'old-store'), reembedding: { activeGeneration: 'old-generation', fingerprintId: oldId, dimensions: 384 } }, { internals: { embeddings: fake() } });
  try {
    assert.ok(warnings.some(message => message.includes('embedding.identity.legacy')));
    assert.equal(migrated.embedding.identities()[0].space.dimension, 384);
    const result = await migrated.embedding.embed(['q'], { kind: 'query', identity: { fingerprintId: oldId }, signal: AbortSignal.timeout(400) });
    assert.equal(result[0].length, 384);
  } finally { await migrated.close({ budgetMs: 5000 }); }
});
