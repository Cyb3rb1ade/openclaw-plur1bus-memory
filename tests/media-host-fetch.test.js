import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { bindHostNetwork, resetHostNetwork } from '../lib/host-network.js';
import { createMediaEmbeddingProvider } from '../lib/providers/embedding-media.js';

afterEach(resetHostNetwork);

// Removing hostFetch at the provider boundary would send these requests to global fetch.
test('media sidecar uses the bound host fetch and preserves the local protocol', async t => {
  const recorded = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    recorded.push(JSON.parse(Buffer.concat(chunks)));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: [[3, 4, ...Array(126).fill(0)]] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const liveFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('bypassed HostServices.fetch'); });
  const admitted = [];
  bindHostNetwork({ fetch: async (url, init) => { admitted.push(String(url)); return liveFetch(url, init); } });
  const endpoint = `http://127.0.0.1:${server.address().port}/embeddings`;
  const provider = createMediaEmbeddingProvider({ provider: 'local-transformers', model: 'google/embeddinggemma-2', modalities: ['image'], dimensions: 128, transport: 'sidecar', endpoint, privacyPin: 'local' });
  const query = await provider.embedText('a red square');
  const image = await provider.embedMedia({ kind: 'image', bytes: new Uint8Array([1, 2]) });
  assert.deepEqual(query.slice(0, 2), [0.6, 0.8]);
  assert.deepEqual(image, query);
  assert.deepEqual(admitted, [endpoint, endpoint]);
  assert.equal(recorded[0].task, 'retrieval.query');
  assert.deepEqual(recorded[1].input, [{ image: 'AQI=' }]);
  assert.equal(recorded[1].revision, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0');
});

// A Jina local sidecar must not accidentally select the hosted Jina API.
test('Jina sidecar remains local without a cloud credential', async () => {
  const requests = [];
  bindHostNetwork({ fetch: async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), auth: new Headers(init.headers).get('authorization') });
    return Response.json({ data: [{ embedding: [1, ...Array(31).fill(0)] }] });
  } });
  const provider = createMediaEmbeddingProvider({ provider: 'jina', model: 'jina-clip-v2', modalities: ['image'], dimensions: 32,
    licenseAccepted: true, privacyPin: 'local', transport: 'sidecar', endpoint: 'http://127.0.0.1:9000/embeddings' });
  assert.equal((await provider.embedText('cat')).length, 32);
  assert.equal(requests[0].url, 'http://127.0.0.1:9000/embeddings');
  assert.equal(requests[0].auth, null);
  assert.equal(requests[0].body.precision, 'fp32');
});
