import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensurePinnedModelArtifacts } from './local-model-artifacts.js';
import { importTransformersBehindSharpProbe } from '../native/sharp-unavailable.js';
import { acquireMediaRuntime } from './media-runtime.js';
import { projectVector, validateMediaConfig, mediaError } from './media-registry.js';
import { DEFAULT_LOCAL_MODEL_CACHE } from './dimensions.js';
import { resolveEnvVars, resolveApiKey } from './env.js';

const pins = JSON.parse(readFileSync(new URL('./media-gemma-artifacts.json', import.meta.url), 'utf8'));
/** Select only the verified graphs required by the configured modular variant. */
export function mediaGemmaProfile(variant) {
  if (!['text', 'vision', 'audio', 'full'].includes(variant)) throw mediaError('E_MEDIA_CAPABILITY', 'unknown Gemma variant');
  return { ...pins, artifacts: pins.artifacts.filter(a => (!a.path.includes('vision_encoder') || ['vision', 'full'].includes(variant)) && (!a.path.includes('audio_encoder') || ['audio', 'full'].includes(variant))) };
}
async function disposeValues(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (typeof value.dispose === 'function') { await value.dispose(); return; }
  if (ArrayBuffer.isView(value)) return;
  for (const child of Object.values(value)) await disposeValues(child, seen);
}
/** Local fp32 ONNX provider. No host codec or external ffmpeg is loaded here. */
export class GemmaMediaEmbeddingProvider {
  constructor(config, { loadRuntime, logger } = {}) {
    this.config = config;
    const cacheDir = resolve(resolveEnvVars(config.cacheDir || DEFAULT_LOCAL_MODEL_CACHE, { groups: ['localPath'], label: 'media cacheDir' }));
    this.lease = acquireMediaRuntime({ model: config.model, revision: pins.revision, precision: 'fp32', variant: config.variant, cacheDir }, loadRuntime || (async () => {
      const profile = mediaGemmaProfile(config.variant);
      await ensurePinnedModelArtifacts(profile, cacheDir, { logger });
      const mod = await importTransformersBehindSharpProbe();
      const opts = { cache_dir: cacheDir, revision: profile.revision, local_files_only: true };
      const modelConfig = await mod.AutoConfig.from_pretrained(profile.model, opts);
      if (modelConfig.model_type !== 'embedding_gemma2' || modelConfig.text_config?.embedding_dim !== 768) throw mediaError('E_MEDIA_UNAVAILABLE', 'Gemma model drift');
      if (!['full', 'vision'].includes(config.variant)) modelConfig.vision_config = null;
      if (!['full', 'audio'].includes(config.variant)) modelConfig.audio_config = null;
      const processor = await mod.AutoProcessor.from_pretrained(profile.model, opts);
      const model = await mod.AutoModel.from_pretrained(profile.model, { ...opts, config: modelConfig, dtype: 'fp32', device: 'cpu' });
      return { mod, processor, model, dispose: () => model.dispose() };
    }));
  }
  async infer(text, segment) {
    return await this.lease.run(async ({ processor, model, mod }) => {
      let images = null, audio = null, videos = null, inputs, outputs;
      try {
        if (segment?.kind === 'audio') audio = segment.pcm;
        else if (segment) {
          const frames = segment.kind === 'video' ? segment.frames : [{ bytes: segment.bytes }];
          images = [];
          for (const frame of frames) {
            let image;
            if (frame.rgb && frame.width && frame.height) image = new mod.RawImage(new Uint8ClampedArray(frame.rgb), frame.width, frame.height, 3);
            else image = await mod.RawImage.fromBlob(new Blob([new Uint8Array(frame.bytes)]));
            // Bound pixel work before the model processor chooses its patch budget.
            if (Math.max(image.width, image.height) > 1024) {
              const ratio = 1024 / Math.max(image.width, image.height);
              image = await image.resize(Math.max(1, Math.round(image.width * ratio)), Math.max(1, Math.round(image.height * ratio)));
            }
            images.push(image);
          }
        }
        if (segment?.kind === 'video') {
          videos = new mod.RawVideo(images.map((image, i) => new mod.RawVideoFrame(image, segment.frames[i].timestampMs / 1000)), Math.max(0.001, (segment.endMs - segment.startMs) / 1000));
          images = null;
        }
        inputs = await processor(text, images, audio, videos);
        outputs = await model(inputs);
        const tensor = outputs.sentence_embedding;
        if (tensor?.dims?.length !== 2 || tensor.dims[0] !== 1 || tensor.dims[1] !== 768) throw mediaError('E_MEDIA_DIMENSION', 'Gemma output must be [1,768]');
        return projectVector(tensor.data, this.config.dimensions, 768);
      } finally { await disposeValues(inputs); await disposeValues(outputs); }
    });
  }
  /** Query text is encoded in the media model space. */
  embedText(text) { return this.infer(`task: search result | query: ${text}`); }
  /** Text captions use the document task prefix when this runtime also serves the text index. */
  embedPassage(text) { return this.infer(`title: none | text: ${text}`); }
  /** Embed one image/audio/frame segment into the same space as embedText. */
  embedMedia(segment) { return this.infer(null, segment); }
  /** Release after active inference; shared text leases keep the runtime alive. */
  close() { return this.lease.close(); }
}
/** Jina API or configured local sidecar using an embeddings JSON protocol. */
export class HttpMediaEmbeddingProvider {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) { this.config = config; this.fetch = fetchImpl; }
  async request(input, task) {
    const c = this.config;
    const jina = c.provider === 'jina';
    const url = jina ? 'https://api.jina.ai/v1/embeddings' : c.endpoint;
    const apiKey = jina ? (typeof c.credentialResolver === 'function'
      ? await c.credentialResolver({ value: c.apiKey, apiKeyEnv: c.apiKeyEnv, defaultEnv: 'JINA_API_KEY', path: 'plugins.entries.memory-lancedb-namespaced.config.embedding.apiKey' })
      : resolveApiKey(c, { defaultEnv: 'JINA_API_KEY', label: 'Jina media' })) : null;
    if (jina && (typeof apiKey !== 'string' || !apiKey)) throw mediaError('E_MEDIA_UNAVAILABLE', 'Jina credential is unavailable');
    const response = await this.fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(c.timeoutMs || 30000),
      headers: { 'content-type': 'application/json', ...(jina ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: c.model, input, task, dimensions: c.dimensions, embedding_type: 'float', normalized: true, ...(jina ? {} : { variant: c.variant, precision: c.precision, revision: c.revision }) }) });
    if (!response.ok) throw mediaError('E_MEDIA_UNAVAILABLE', `embedding HTTP ${response.status}`);
    const data = await response.json();
    const vector = data.data?.[0]?.embedding ?? data.embeddings?.[0];
    // Services may already truncate; query and document outputs must use the configured width.
    if (vector?.length === c.dimensions) return projectVector(vector, c.dimensions, c.dimensions);
    return projectVector(vector || [], c.dimensions, c.modelInfo.nativeDim);
  }
  /** Text query in the media encoder space. */
  embedText(text) { return this.request([{ text }], 'retrieval.query'); }
  /** Encode image frames or PCM; the sidecar implements decoding of this explicit payload. */
  async embedMedia(segment) {
    if (segment.kind === 'audio') return this.request([{ audio: Array.from(segment.pcm), sample_rate: segment.sampleRate }], 'retrieval.passage');
    const frames = segment.kind === 'video' ? segment.frames : [{ bytes: segment.bytes }];
    const vectors = [];
    for (const frame of frames) vectors.push(await this.request([{ image: Buffer.from(frame.bytes || []).toString('base64') }], 'retrieval.passage'));
    const mean = vectors[0].map((_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length);
    return projectVector(mean, this.config.dimensions, this.config.dimensions);
  }
  /** HTTP provider owns no persistent resources. */
  async close() {}
}
/** Pinned Jina CLIP artifact identity shared with the text re-embedding fingerprint. */
export const JINA_CLIP_MEDIA_PROFILE = Object.freeze(JSON.parse(readFileSync(new URL('./media-jina-artifacts.json', import.meta.url), 'utf8')));
const jinaPins = JINA_CLIP_MEDIA_PROFILE;
/** Verified Jina CLIP v2 fp32 ONNX, using the built-in JinaCLIPModel without remote code. */
export class JinaLocalMediaEmbeddingProvider {
  constructor(config, { loadRuntime, logger } = {}) {
    this.config = config;
    const cacheDir = resolve(resolveEnvVars(config.cacheDir || DEFAULT_LOCAL_MODEL_CACHE, { groups: ['localPath'], label: 'Jina media cacheDir' }));
    this.lease = acquireMediaRuntime({ model: jinaPins.model, revision: jinaPins.revision, precision: 'fp32', variant: 'vision', cacheDir }, loadRuntime || (async () => {
      await ensurePinnedModelArtifacts(jinaPins, cacheDir, { acceptNonCommercialLicense: config.licenseAccepted, logger });
      const mod = await importTransformersBehindSharpProbe({ logger });
      const opts = { cache_dir: cacheDir, revision: jinaPins.revision, local_files_only: true };
      const tokenizer = await mod.AutoTokenizer.from_pretrained(jinaPins.model, opts);
      const processor = await mod.AutoProcessor.from_pretrained(jinaPins.model, opts);
      const model = await mod.AutoModel.from_pretrained(jinaPins.model, { ...opts, dtype: 'fp32', device: 'cpu' });
      return { mod, tokenizer, processor, model, dispose: () => model.dispose() };
    }));
  }
  async infer(text, frame) {
    return await this.lease.run(async ({ mod, tokenizer, processor, model }) => {
      let input, output;
      try {
        if (text !== undefined) input = await tokenizer(text, { padding: true, truncation: true, max_length: 8192 });
        else {
          const image = frame.rgb ? new mod.RawImage(new Uint8ClampedArray(frame.rgb), frame.width, frame.height, 3) : await mod.RawImage.fromBlob(new Blob([new Uint8Array(frame.bytes)]));
          input = await processor(image);
        }
        output = await model(input);
        const vector = text !== undefined ? output.l2norm_text_embeddings : output.l2norm_image_embeddings;
        if (vector?.dims?.length !== 2 || vector.dims[0] !== 1 || vector.dims[1] !== 1024) throw mediaError('E_MEDIA_DIMENSION', 'Jina CLIP output must be [1,1024]');
        return projectVector(vector.data, this.config.dimensions, 1024);
      } finally { await disposeValues(input); await disposeValues(output); }
    });
  }
  /** Same text tower serves query and document embeddings. */
  embedText(text) { return this.infer(text); }
  /** Embed bounded video frames independently, then normalize their mean. */
  async embedMedia(segment) {
    const frames = segment.kind === 'video' ? segment.frames : [{ bytes: segment.bytes }];
    const vectors = [];
    for (const frame of frames) vectors.push(await this.infer(undefined, frame));
    const mean = vectors[0].map((_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length);
    return projectVector(mean, this.config.dimensions, this.config.dimensions);
  }
  /** Reference-counted disposal shared with a matching Jina text adapter. */
  close() { return this.lease.close(); }
}

/** Validate policy before constructing any transport or model runtime. */
export function createMediaEmbeddingProvider(input, options = {}) {
  const config = validateMediaConfig(input);
  if (config.provider === 'jina' && config.transport === 'local') return new JinaLocalMediaEmbeddingProvider(config, options);
  return config.provider === 'local-transformers' && config.transport !== 'sidecar'
    ? new GemmaMediaEmbeddingProvider(config, options)
    : new HttpMediaEmbeddingProvider(config, options);
}

/** Jina text adapter, independently selectable from the media provider. */
export function createJinaTextProvider(config, options = {}) {
  const transport = createMediaEmbeddingProvider({ ...config, provider: 'jina', modalities: ['image'], precision: 'fp32' }, options);
  return {
    id: 'jina', model: config.model, dim: config.dimensions,
    embedQuery: text => transport.embedText(text),
    embedPassage: text => transport.request ? transport.request([{ text }], 'retrieval.passage') : transport.embedText(text),
    embed: text => transport.request ? transport.request([{ text }], 'retrieval.passage') : transport.embedText(text),
    embedBatch: texts => Promise.all(texts.map(text => transport.request ? transport.request([{ text }], 'retrieval.passage') : transport.embedText(text))),
    warmup: async () => ({ ok: true }), shutdown: () => transport.close(),
  };
}
