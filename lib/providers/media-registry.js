import { embeddingFingerprintId, normalizeEmbeddingFingerprint } from "../reembedding/fingerprint.js";
import { createHash } from 'node:crypto';
import { EMBEDDINGGEMMA2_EMBEDDING_PROFILE } from './local-model-artifacts.js';

const gemma = { id: 'google/embeddinggemma-2', license: 'Apache-2.0', dimensions: [128, 256, 512, 768], nativeDim: 768,
  revision: EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision, variants: ['text', 'vision', 'audio', 'full'], maxFrames: 32, maxAudioSeconds: 300, sampleRate: 16000, precision: ['fp32'] };
const localModels = [gemma, { id: 'intfloat/multilingual-e5-small', license: 'MIT', dimensions: [384], nativeDim: 384, precision: ['q8'] },
  { id: 'jinaai/jina-embeddings-v3', license: 'CC-BY-NC-4.0', dimensions: [128, 256, 512, 1024], nativeDim: 1024, precision: ['q8'], licenseRequired: true },
  { id: 'jinaai/jina-embeddings-v5-text-nano-retrieval', license: 'CC-BY-NC-4.0', dimensions: [32, 64, 128, 256, 512, 768], nativeDim: 768, precision: ['q8'], licenseRequired: true }];
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Common capability catalogue; model properties, never provider pairings, govern admission. */
export const PROVIDERS = deepFreeze([
  { id: 'local-transformers', capabilities: { text: true, image: true, video: true, audio: true }, models: localModels, egressHosts: ['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co'], cloud: false },
  { id: 'openai', capabilities: { text: true, image: false, video: false, audio: false }, models: [
    { id: 'text-embedding-3-small', nativeDim: 1536, dimensions: { min: 1, max: 1536 }, license: 'service-terms' },
    { id: 'text-embedding-3-large', nativeDim: 3072, dimensions: { min: 1, max: 3072 }, license: 'service-terms' }], egressHosts: [['api', 'openai', 'com'].join('.')], cloud: true },
  { id: 'openai-compatible', capabilities: { text: true, image: false, video: false, audio: false }, models: [], egressHosts: [], cloud: true, customEndpoint: true },
  { id: 'jina', capabilities: { text: true, image: true, video: true, audio: false }, models: [
    { id: 'jina-embeddings-v4', license: 'Qwen-Research', licenseRequired: true, nativeDim: 2048, dimensions: [128, 256, 512, 1024, 2048], maxFrames: 1, precision: ['fp32'] },
    { id: 'jina-clip-v2', license: 'CC-BY-NC-4.0', licenseRequired: true, nativeDim: 1024, dimensions: [32, 64, 128, 256, 512, 768, 1024], localRevision: 'e10d47f5691d0454a0fb5d13f46f2199b74cb436', maxFrames: 32, precision: ['fp32'] }], egressHosts: [['api', 'jina', 'ai'].join('.')], cloud: true },
]);
/** Stable machine-readable media failure.
 * @param {string} code Error code.
 * @param {string} message Public explanation.
 * @returns {Error} Coded error. */
export function mediaError(code, message) { return Object.assign(new Error(message), { code }); }
/** Select the modular encoder using only requested modalities.
 * @param {string[]} modalities Requested media encoders.
 * @returns {string} Modular variant. */
export function mediaVariant(modalities = []) {
  const vision = modalities.some(x => x === 'image' || x === 'video');
  return vision ? (modalities.includes('audio') ? 'full' : 'vision') : (modalities.includes('audio') ? 'audio' : 'text');
}
/** Validate before loading models, reading source bytes or issuing an HTTP request.
 * @param {object} input Independent media selection.
 * @returns {object} Validated selection with catalogue metadata. */
export function validateMediaConfig(input = {}) {
  const provider = PROVIDERS.find(p => p.id === input.provider);
  const modalities = input.modalities ?? ['image', 'video', 'audio'];
  if (!Array.isArray(modalities) || !modalities.length || !provider || modalities.some(k => !['image', 'video', 'audio'].includes(k) || !provider.capabilities[k])) throw mediaError('E_MEDIA_CAPABILITY', 'provider cannot encode requested modalities');
  const model = provider.models.find(m => m.id === input.model);
  if (!model) throw mediaError('E_MEDIA_UNAVAILABLE', 'model is not in the provider catalogue');
  if (modalities.length && !model.variants && provider.id === 'local-transformers') throw mediaError('E_MEDIA_CAPABILITY', 'model has only a text encoder');
  if (model.licenseRequired && input.licenseAccepted !== true) throw mediaError('E_MEDIA_LICENSE', 'model-specific non-commercial license acceptance required');
  const endpoint = input.endpoint ? new URL(input.endpoint) : null;
  const localEndpoint = endpoint && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((input.privacyPin === 'local' && ((provider.cloud && input.transport !== 'local') || (endpoint && !localEndpoint))) || (input.transport === 'sidecar' && !localEndpoint && input.allowRemoteSidecar !== true)) throw mediaError('E_MEDIA_PRIVACY', 'privacy policy forbids endpoint');
  if (endpoint && (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)) throw mediaError('E_MEDIA_PRIVACY', 'endpoint must be credential-free HTTP');
  if (provider.id === 'jina' && input.transport === 'local' && input.model !== 'jina-clip-v2') throw mediaError('E_MEDIA_UNAVAILABLE', 'no verified local ONNX runtime for this Jina model');
  if (input.transport && !['local', 'api', 'sidecar'].includes(input.transport)) throw mediaError('E_MEDIA_UNAVAILABLE', 'unknown transport');
  if (provider.id === 'local-transformers' && input.transport === 'api') throw mediaError('E_MEDIA_UNAVAILABLE', 'local provider has no cloud API');
  if (input.transport === 'sidecar' && !endpoint) throw mediaError('E_MEDIA_UNAVAILABLE', 'sidecar endpoint required');
  const dimensions = input.dimensions ?? model.nativeDim;
  const validDim = Array.isArray(model.dimensions) ? model.dimensions.includes(dimensions) : Number.isInteger(dimensions) && dimensions >= model.dimensions.min && dimensions <= model.dimensions.max;
  const precision = input.precision ?? 'fp32';
  if (!validDim || !(model.precision || ['fp32']).includes(precision)) throw mediaError('E_MEDIA_UNAVAILABLE', 'unsupported dimension or precision (fp16 is forbidden)');
  for (const key of ['segmentMs', 'maxFrames', 'maxAudioSeconds', 'maxBytes', 'maxAttempts', 'batchSize']) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1)) throw mediaError('E_MEDIA_UNAVAILABLE', `invalid ${key}`);
  }
  const pinnedRevision = (input.transport === 'local' ? model.localRevision : null) || model.revision;
  if (input.revision && pinnedRevision && input.revision !== pinnedRevision) throw mediaError('E_MEDIA_UNAVAILABLE', 'unpinned revision');
  if (input.available === false) throw mediaError('E_MEDIA_UNAVAILABLE', 'provider unavailable');
  return { ...input, modalities: [...new Set(modalities)], dimensions, precision, variant: mediaVariant(modalities), revision: (input.transport === 'local' ? model.localRevision : null) || model.revision || input.revision || 'service', modelInfo: model };
}
/** Hash media identity independently of the primary text fingerprint.
 * @param {object} config Effective media configuration.
 * @returns {string} Media re-embedding identity. */
export function mediaFingerprint(config) {
  const segmentation = createHash('sha256').update(JSON.stringify({ segmentMs: config.segmentMs || 10000,
    maxFrames: config.maxFrames || 32, maxAudioSeconds: config.maxAudioSeconds || 300, vad: config.vad === true,
    vadThreshold: config.vadThreshold ?? 0.01 })).digest('hex');
  // Reuse the existing re-embedding identity codec, in a distinct media namespace.
  return `media:${embeddingFingerprintId(normalizeEmbeddingFingerprint({ provider: config.provider || 'disabled',
    model: config.model || 'disabled', revision: config.revision || (config.provider === 'local-transformers' ? gemma.revision : undefined),
    dimensions: config.dimensions || 768, variant: mediaVariant(config.modalities), dtype: config.precision || 'fp32',
    pooling: `segments:${segmentation}`, normalize: true, ...(config.endpoint ? { endpoint: config.endpoint } : {}) }))}`;

}
/** Truncate Matryoshka output then renormalize; refuse query/document width drift.
 * @param {Iterable<number>} vector Encoder output.
 * @param {number} dim Requested width.
 * @param {number} nativeDim Expected encoder width.
 * @returns {number[]} Unit vector. */
export function projectVector(vector, dim, nativeDim) {
  const values = Array.from(vector, Number);
  if (values.length !== nativeDim || dim > nativeDim || dim < 1 || values.some(v => !Number.isFinite(v))) throw mediaError('E_MEDIA_DIMENSION', 'encoder output dimension differs from model');
  const result = values.slice(0, dim), norm = Math.hypot(...result);
  if (!Number.isFinite(norm) || norm === 0) throw mediaError('E_MEDIA_DIMENSION', 'invalid zero vector');
  return result.map(v => v / norm);
}
