import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GemmaMediaEmbeddingProvider } from '../lib/providers/embedding-media.js';
import { LocalTransformersEmbeddingProvider } from '../lib/providers/embedding-local-transformers.js';

const real = process.env.PLUR1BUS_MEDIA_REAL_MODELS === '1';
const config = { model: 'google/embeddinggemma-2', dimensions: 128, precision: 'fp32', variant: 'full', ...(process.env.PLUR1BUS_MEDIA_MODEL_CACHE ? { cacheDir: process.env.PLUR1BUS_MEDIA_MODEL_CACHE } : {}) };
// Explicit opt-in: may download ~2.96 GB of hash-verified model artifacts.
test('real full Gemma: image/text retrieval sanity and variant text identity', { skip: !real, timeout: 300000 }, async t => {
  const media = new GemmaMediaEmbeddingProvider(config);
  const text = new LocalTransformersEmbeddingProvider({ model: config.model, dimensions: 128, dtype: 'fp32', ...(config.cacheDir ? { cacheDir: config.cacheDir } : {}) });
  t.after(async () => { await media.close(); await text.shutdown(); });
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>');
  const image = await media.embedMedia({ kind: 'image', bytes: svg });
  assert.equal(image.length, 128);
  assert.ok(image.every(Number.isFinite));
  const query = 'a solid green square';
  const full = await media.embedText(query), textOnly = await text.embedQuery(query);
  assert.equal(full.length, textOnly.length);
  const delta = Math.max(...full.map((value, i) => Math.abs(value - textOnly[i])));
  t.diagnostic(`full/text maximum absolute difference: ${delta}; fingerprints remain variant-specific regardless`);
  assert.ok(full.every(Number.isFinite));
  const distractor = await media.embedText('a pink butterfly');
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  assert.ok(dot(image, full) > dot(image, distractor), 'image must rank its description above the distractor');
  if (process.env.PLUR1BUS_MEDIA_REQUIRE_IDENTICAL === '1') assert.ok(delta < 1e-4);
});
