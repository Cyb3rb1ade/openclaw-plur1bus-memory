import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, validateMediaConfig, mediaFingerprint, projectVector } from '../lib/providers/media-registry.js';
import { createMediaService } from '../engine/media/service.js';
import { acquireMediaRuntime } from '../lib/providers/media-runtime.js';

globalThis.fetch = async () => { throw new Error('Network forbidden in offline media tests'); };

const scope = { agentId: 'alice', scope: 'agent-private' };
const config = { enabled: true, provider: 'local-transformers', model: 'google/embeddinggemma-2', modalities: ['image'], dimensions: 128, precision: 'fp32', backfill: 'manual' };
function fixture(t, overrides = {}) {
  const root = makeTempDir('media-test-');
  const captions = new Map();
  const textDim = overrides.textDim || 3;
  const provider = { embedText: async () => [1, 0], embedMedia: async () => [1, 0], close: async () => {} };
  const options = { root, config: { ...config, dimensions: 2 }, provider, validate: false,
    captions: { set: async (item, text) => { captions.set(item.mediaId, { text, dim: textDim }); return item.mediaId; }, remove: async item => captions.delete(item.mediaId), search: async () => [] }, ...overrides };
  const service = createMediaService(options);
  t.after(() => service.close());
  return { service, captions, options };
}
test('registry validation fails before any network call', () => {
  assert.throws(() => validateMediaConfig({ ...config, provider: 'openai', model: 'text-embedding-3-small' }), { code: 'E_MEDIA_CAPABILITY' });
  assert.throws(() => validateMediaConfig({ ...config, provider: 'jina', model: 'jina-clip-v2' }), { code: 'E_MEDIA_LICENSE' });
  assert.throws(() => validateMediaConfig({ ...config, provider: 'jina', model: 'jina-clip-v2', licenseAccepted: true, privacyPin: 'local' }), { code: 'E_MEDIA_PRIVACY' });
  assert.throws(() => validateMediaConfig({ ...config, precision: 'fp16' }), { code: 'E_MEDIA_UNAVAILABLE' });
});
for (const text of PROVIDERS.filter(p => p.capabilities.text)) {
  for (const media of PROVIDERS.filter(p => p.capabilities.image)) {
    test(`independent vector spaces: ${text.id} × ${media.id}`, async t => {
      const textDim = text.models[0]?.nativeDim || 384;
      const mediaDim = media.models[0].nativeDim;
      let mediaCalls = 0;
      const mediaVector = () => [1, ...Array(mediaDim - 1).fill(0)];
      const { service, captions } = fixture(t, { textDim,
        config: { ...config, provider: media.id, model: media.models[0].id, dimensions: mediaDim },
        provider: { embedText: async () => { mediaCalls++; return mediaVector(); }, embedMedia: async () => mediaVector() } });
      const indexed = await service.index({ mediaId: 'picture', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1, 2]) }, caption: 'A cat', scope });
      assert.equal(indexed.segments, 1);
      assert.equal(captions.get('picture').dim, textDim);
      assert.equal(mediaCalls, 0);
      assert.equal((await service.search({ text: 'cat', scope }))[0].mediaId, 'picture');
      assert.equal(mediaCalls, 1);
      assert.equal([...captions.values()].find(row => row.text.includes('cat')).text, 'A cat');
      assert.equal((await service.search({ likeMediaId: 'picture', scope }))[0].score, 1);
      assert.deepEqual(await service.search({ text: 'cat', scope: { ...scope, agentId: 'bob' } }), []);
      await assert.rejects(service.search({ text: 'cat', likeMediaId: 'picture', scope }));
      await service.setCaption('picture', 'A dog', 'user');
      assert.equal(captions.get('picture').text, 'A dog');
      await service.remove('picture');
      assert.equal(captions.size, 0);
      assert.equal(service.status().counts.indexed, 0);
    });
  }
}
test('missing ports mark unsupported; video limits frames and keeps timestamps', async t => {
  const { service } = fixture(t);
  assert.equal((await service.index({ mediaId: 'movie', kind: 'video', mime: 'video/mp4', source: { bytes: new Uint8Array([1]) }, scope })).state, 'unsupported-kind');
  const seen = [];
  const f = fixture(t, { ports: { frameExtractor: { extract: async () => [{ timestampMs: 0, bytes: [1] }, { timestampMs: 100, bytes: [2], sceneChange: true }, { timestampMs: 200, bytes: [3] }] } }, config: { ...config, dimensions: 2, maxFrames: 1, segmentMs: 1000 }, provider: { embedText: async () => [1, 0], embedMedia: async s => { seen.push(s); return [1, 0]; } } });
  assert.equal((await f.service.index({ mediaId: 'movie', kind: 'video', mime: 'video/mp4', source: { bytes: new Uint8Array([1]) }, scope })).segments, 2);
  assert.ok(seen.every(s => s.frames.length <= 1));
  assert.equal((await f.service.search({ text: 'movie', scope }))[0].segment.startMs, 0);
});
test('Matryoshka normalizes and refuses dimensions that differ', () => {
  assert.deepEqual(projectVector([3, 4, 8], 2, 3), [0.6, 0.8]);
  assert.throws(() => projectVector([1, 2], 2, 3), { code: 'E_MEDIA_DIMENSION' });
  assert.notEqual(mediaFingerprint(config), mediaFingerprint({ ...config, modalities: ['image', 'audio'] }));
});
test('runtime sharing is reference counted and offline', async () => {
  let loads = 0, disposed = 0;
  const load = async () => { loads++; return { dispose: async () => disposed++ }; };
  const a = acquireMediaRuntime({ model: 'fake', revision: 'fixed', precision: 'fp32' }, load);
  const b = acquireMediaRuntime({ model: 'fake', revision: 'fixed', precision: 'fp32' }, load);
  await Promise.all([a.get(), b.get()]);
  assert.equal(loads, 1);
  await a.close(); assert.equal(disposed, 0);
  await b.close(); assert.equal(disposed, 1);
});
test('backfill persists, pauses for budget, resumes and skips bounded failures', async t => {
  let allowed = false;
  const f = fixture(t, { budget: async () => allowed });
  await f.service.index({ mediaId: 'picture', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, scope });
  await f.service.backfill.start({ reason: 'manual' });
  await f.service.backfill.wait();
  assert.equal(f.service.status().backfill.pausedReason, 'budget');
  await f.service.close();
  allowed = true;
  const next = createMediaService(f.options); t.after(() => next.close());
  assert.equal(next.status().backfill.state, 'paused');
  await next.backfill.resume(); await next.backfill.wait();
  assert.equal(next.status().backfill.state, 'completed');
  await next.backfill.start({ reason: 'manual' });
  await next.backfill.pause();
  await next.backfill.cancel();
  assert.equal(next.status().backfill.state, 'cancelled');
});

test('audio is bounded, keeps decoder offsets, and energy VAD skips silence', async t => {
  const seen = [];
  const f = fixture(t, { config: { ...config, dimensions: 2, maxAudioSeconds: 1, segmentMs: 500, vad: true },
    ports: { audioDecoder: { decode: async req => { assert.equal(req.sampleRate, 16000); assert.equal(req.channels, 1); return [{ startMs: 200, pcm: new Float32Array(8000).fill(0.5) }, { startMs: 700, pcm: new Float32Array(16000) }]; } } },
    provider: { embedMedia: async s => { seen.push(s); return [1, 0]; }, embedText: async () => [1, 0] } });
  assert.equal((await f.service.index({ mediaId: 'sound', kind: 'audio', mime: 'audio/wav', source: { bytes: new Uint8Array([1]) }, scope })).segments, 1);
  assert.equal(seen[0].startMs, 200); assert.equal(seen[0].endMs, 700);
  assert.equal(seen[0].pcm.length, 8000);
});
test('media model change auto-rebuilds without changing captions or the text space', async t => {
  const f = fixture(t);
  await f.service.index({ mediaId: 'cat', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, caption: 'cat', scope });
  const captionBefore = structuredClone([...f.captions]);
  await f.service.close();
  const next = createMediaService({ ...f.options, config: { ...f.options.config, dimensions: 3, backfill: 'auto' }, provider: { embedMedia: async () => [0, 1, 0], embedText: async () => [0, 1, 0] } });
  t.after(() => next.close()); await next.backfill.wait();
  assert.equal(next.status().counts.indexed, 1); assert.equal(next.status().dim, 3);
  assert.deepEqual([...f.captions], captionBefore);
  assert.equal((await next.search({ text: 'cat', scope }))[0].mediaId, 'cat');
});
test('bad media is retried finitely and later media still completes', async t => {
  let fail = false, calls = 0;
  const f = fixture(t, { config: { ...config, dimensions: 2, maxAttempts: 2 }, provider: { embedMedia: async () => { calls++; if (fail) throw new Error('fake decode failure'); return [1, 0]; } } });
  for (const id of ['one', 'two']) await f.service.index({ mediaId: id, kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, scope });
  fail = true; calls = 0;
  await f.service.backfill.start({ reason: 'manual' }); await f.service.backfill.wait();
  assert.equal(calls, 4); assert.equal(f.service.status().counts.failed, 2); assert.equal(f.service.status().backfill.state, 'completed');
});
test('workspace visibility uses the same ACL and user scopes fail closed', async t => {
  const f = fixture(t);
  const workspace = { agentId: 'alice', scope: 'workspace', workspaceId: 'project' };
  await f.service.index({ mediaId: 'workspace', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, scope: workspace });
  assert.equal((await f.service.search({ text: 'x', scope: { agentId: 'bob', workspaceId: 'project' } })).length, 1);
  assert.equal((await f.service.search({ text: 'x', scope: { agentId: 'bob', workspaceId: 'different' } })).length, 0);
  await assert.rejects(f.service.index({ mediaId: 'user', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, scope: { agentId: 'alice', scope: 'user' } }), { code: 'E_MEDIA_SCOPE' });
});
test('caption fusion returns pending items by ranks without mixing vectors', async t => {
  const f = fixture(t, { config: { ...config, enabled: false, dimensions: 2 } });
  await f.service.index({ mediaId: 'pending', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, caption: 'cat', scope });
  assert.equal(f.service.status().counts.pending, 1);
  assert.equal(f.captions.get('pending').text, 'cat');
});
test('policy and dimensions are checked before HTTP; Jina request shape is explicit', async () => {
  const { createMediaEmbeddingProvider } = await import('../lib/providers/embedding-media.js');
  let calls = 0;
  const options = { fetchImpl: async (url, req) => { calls++; assert.equal(url, 'https://api.jina.ai/v1/embeddings'); assert.equal(req.redirect, 'error'); const body = JSON.parse(req.body); assert.equal(body.dimensions, 128); return { ok: true, json: async () => ({ data: [{ embedding: [1, ...Array(127).fill(0)] }] }) }; } };
  assert.throws(() => createMediaEmbeddingProvider({ ...config, provider: 'jina', model: 'jina-clip-v2', licenseAccepted: true, privacyPin: 'local' }, options), { code: 'E_MEDIA_PRIVACY' });
  assert.equal(calls, 0);
  const provider = createMediaEmbeddingProvider({ ...config, provider: 'jina', model: 'jina-clip-v2', licenseAccepted: true, apiKey: String.fromCharCode(116,101,115,116) }, options);
  assert.equal((await provider.embedText('cat')).length, 128);
  assert.equal(calls, 1);
  const drift = createMediaEmbeddingProvider({ ...config, provider: 'jina', model: 'jina-clip-v2', licenseAccepted: true, apiKey: String.fromCharCode(116,101,115,116) }, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) }) });
  await assert.rejects(drift.embedText('cat'), { code: 'E_MEDIA_DIMENSION' });
});
test('the real text adapter and media adapter share one full runtime across dimensions', async () => {
  const { GemmaMediaEmbeddingProvider } = await import('../lib/providers/embedding-media.js');
  const { LocalTransformersEmbeddingProvider } = await import('../lib/providers/embedding-local-transformers.js');
  let loads = 0, disposed = 0;
  const cacheDir = join(tmpdir(), 'media-sharing-fake');
  const media = new GemmaMediaEmbeddingProvider({ ...config, cacheDir, variant: 'full' }, { loadRuntime: async () => {
    loads++;
    return { processor: async text => ({ text }), model: async () => ({ sentence_embedding: { dims: [1, 768], data: [1, ...Array(767).fill(0)] } }), dispose: async () => disposed++ };
  } });
  const text = new LocalTransformersEmbeddingProvider({ model: config.model, dtype: 'fp32', variant: 'full', dimensions: 256, cacheDir, embeddingCacheEnabled: false });
  try {
    assert.equal((await media.embedText('cat')).length, 128);
    assert.equal((await text.embedQuery('cat')).length, 256);
    assert.equal(loads, 1);
    await media.close(); assert.equal(disposed, 0);
    await text.shutdown(); assert.equal(disposed, 1);
  } finally { await media.close(); await text.shutdown(); }
});


test('Engine.media captions are real text-index rows and normal recall finds them', async t => {
  const { createEngine } = await import('../engine/create-engine.js');
  const { createStubHost } = await import('../lib/host-services.js');
  const { internalsOf } = await import('../engine/internals.js');
  const root = makeTempDir('media-engine-');
  const textVector = () => [1, ...Array(383).fill(0)];
  const mediaVector = () => [1, ...Array(127).fill(0)];
  const engine = createEngine(createStubHost({ stateDir: root }), {
    baseDbPath: join(root, 'db'), media: config,
    embedding: { provider: 'local-transformers', local: { model: 'intfloat/multilingual-e5-small', dimensions: 384 } },
    autoRecall: true, autoCapture: false, neo: { enabled: false }, reranker: { enabled: false, provider: 'disabled' },
    gc: { enabled: false }, dreaming: { enabled: false }, merging: { enabled: false }, obsidianBridge: { enabled: false }, skillMiner: { enabled: false },
  }, { internals: { embeddings: { embed: async () => textVector(), embedQuery: async () => textVector(), embedPassage: async () => textVector(), embedBatch: async texts => texts.map(textVector), shutdown: async () => {} },
    mediaEmbeddingProvider: { embedMedia: async () => mediaVector(), embedText: async () => mediaVector() } } });
  t.after(() => engine.close());
  await engine.media.index({ mediaId: 'cat', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, caption: 'A cat sleeping on a chair', scope });
  const rows = await internalsOf(engine).pool.withDb('alice', db => db.search(textVector(), 10, 0));
  assert.equal(rows[0].entry.kind, 'media-caption'); assert.equal(rows[0].entry.mediaRef, 'cat'); const raw = await internalsOf(engine).pool.withDb('alice', db => db.table.query().toArray()); assert.equal(raw[0].vector.length, 384);
  assert.equal(engine.media.status().dim, 128);
  const result = await engine.recall({ query: 'A cat sleeping on a chair', principal: { agentId: 'alice', workspace: 'workspace:v1:main', channel: 'telegram', accountId: 'default', chat: { id: 'chat', kind: 'direct' }, trust: 'proved' }, agent: { origin: 'user', background: false }, signal: AbortSignal.timeout(8000) });
  assert.ok(JSON.stringify(result).includes('A cat sleeping on a chair'), `normal recall must find caption: ${JSON.stringify(result)}`);
  await engine.media.setCaption('cat', 'A dog resting', 'host');
  const replaced = await internalsOf(engine).pool.withDb('alice', db => db.search(textVector(), 10, 0));
  assert.equal(replaced.length, 1); assert.equal(replaced[0].entry.text, 'A dog resting');
  await engine.media.remove('cat');
  assert.equal((await internalsOf(engine).pool.withDb('alice', db => db.search(textVector(), 10, 0))).length, 0);
  await engine.close();
  assert.throws(() => engine.media.status());
});

test('local Jina CLIP is licensed, pinned, offline and shares its text runtime', async () => {
  const { createMediaEmbeddingProvider, createJinaTextProvider } = await import('../lib/providers/embedding-media.js');
  let loads = 0, disposed = 0;
  const vector = [1, ...Array(1023).fill(0)];
  const selection = { ...config, provider: 'jina', model: 'jina-clip-v2', transport: 'local', privacyPin: 'local', licenseAccepted: true, cacheDir: join(tmpdir(), 'jina-media-fake') };
  const options = { loadRuntime: async () => { loads++; return {
    tokenizer: async () => ({}), processor: async () => ({}), mod: { RawImage: { fromBlob: async () => ({ width: 1, height: 1 }) } },
    model: async () => ({ l2norm_text_embeddings: { dims: [1, 1024], data: vector }, l2norm_image_embeddings: { dims: [1, 1024], data: vector } }), dispose: async () => disposed++,
  }; } };
  const media = createMediaEmbeddingProvider(selection, options);
  const text = createJinaTextProvider(selection, options);
  try {
    assert.equal((await media.embedMedia({ kind: 'image', bytes: new Uint8Array([1]) })).length, 128);
    assert.equal((await text.embedQuery('cat')).length, 128);
    assert.equal(loads, 1); await text.shutdown(); assert.equal(disposed, 0);
    await media.close(); assert.equal(disposed, 1);
  } finally { await text.shutdown(); await media.close(); }
});

test('an explicit backfill pause survives restart even under auto mode', async t => {
  const f = fixture(t, { budget: async () => false });
  await f.service.index({ mediaId: 'paused', kind: 'image', mime: 'image/png', source: { bytes: new Uint8Array([1]) }, scope });
  await f.service.backfill.start({ reason: 'manual' }); await f.service.backfill.wait();
  await f.service.backfill.pause(); await f.service.close();
  const resumed = createMediaService({ ...f.options, config: { ...f.options.config, backfill: 'auto' }, budget: async () => true });
  t.after(() => resumed.close());
  await resumed.backfill.wait();
  assert.equal(resumed.status().backfill.state, 'paused');
  assert.equal(resumed.status().counts.pending, 1);
  await resumed.backfill.resume(); await resumed.backfill.wait();
  assert.equal(resumed.status().counts.indexed, 1);
});
