import { mediaError } from '../../lib/providers/media-registry.js';

/** Bounded video frames with interval and scene boundaries; host owns decoding.
 * @param {object} item Media metadata.
 * @param {Uint8Array} bytes Owned source bytes.
 * @param {object} config Segmentation and model limits.
 * @param {object} ports Host decoders.
 * @returns {Promise<object[]|null>} Segments, or null for a missing decoder. */
export async function segmentMedia(item, bytes, config, ports) {
  if (item.kind === 'image') return [{ idx: 0, startMs: 0, endMs: 0, kind: 'image', bytes }];
  const interval = config.segmentMs || 10000;
  if (item.kind === 'video') {
    if (!ports.frameExtractor?.extract) return null;
    const maxFrames = Math.min(config.maxFrames || 32, config.modelInfo?.maxFrames || 32);
    const frames = await ports.frameExtractor.extract({ bytes, mime: item.mime, intervalMs: interval, sceneChanges: true });
    const segments = [];
    let current = null, previous = -1;
    for await (const frame of frames) {
      const time = frame.timestampMs;
      if (!Number.isFinite(time) || time < 0 || time < previous) throw mediaError('E_MEDIA_SOURCE', 'invalid frame timestamp');
      previous = time;
      if (!current || frame.sceneChange || time >= current.startMs + interval) {
        current = { idx: segments.length, kind: 'video', startMs: time, endMs: time, frames: [] };
        segments.push(current);
      }
      current.frames.push(frame);
      current.endMs = time;
      // Uniform selection retains endpoints rather than only the first N frames.
      if (current.frames.length > maxFrames) current.frames = Array.from({ length: maxFrames }, (_, i) => current.frames[Math.round(i * (current.frames.length - 1) / Math.max(1, maxFrames - 1))]);
      if (segments.length > 10000) throw mediaError('E_MEDIA_SOURCE', 'too many video segments');
    }
    return segments;
  }
  if (!ports.audioDecoder?.decode) return null;
  const sampleRate = config.modelInfo?.sampleRate || 16000;
  const maxSeconds = Math.min(config.maxAudioSeconds || 300, config.modelInfo?.maxAudioSeconds || 300);
  const chunks = await ports.audioDecoder.decode({ bytes, mime: item.mime, sampleRate, channels: 1, maxSeconds, segmentMs: interval });
  const segments = [], maxSamples = maxSeconds * sampleRate, perSegment = Math.min(Math.round(interval * sampleRate / 1000), maxSamples);
  let consumed = 0, previousEnd = 0;
  for await (const chunk of chunks) {
    if (chunk.sampleRate !== undefined && chunk.sampleRate !== sampleRate) throw mediaError('E_MEDIA_SOURCE', 'decoder sample rate mismatch');
    const pcm = chunk.pcm;
    if (!(pcm instanceof Float32Array) || pcm.some(x => !Number.isFinite(x))) throw mediaError('E_MEDIA_SOURCE', 'decoder must return finite mono PCM');
    const start = chunk.startMs ?? previousEnd;
    if (!Number.isFinite(start) || start < previousEnd) throw mediaError('E_MEDIA_SOURCE', 'invalid audio timestamp');
    const available = pcm.slice(0, Math.max(0, maxSamples - consumed));
    consumed += available.length;
    const windowSize = config.vad ? Math.max(1, Math.round(sampleRate * 0.02)) : perSegment;
    let runStart = null, runEnd = 0;
    const flush = () => {
      if (runStart === null) return;
      segments.push({ idx: segments.length, kind: 'audio', startMs: start + runStart * 1000 / sampleRate,
        endMs: start + runEnd * 1000 / sampleRate, pcm: available.slice(runStart, runEnd), sampleRate });
      runStart = null;
    };
    for (let offset = 0; offset < available.length; offset += windowSize) {
      const end = Math.min(offset + windowSize, available.length);
      const slice = available.subarray(offset, end);
      const energy = Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / Math.max(1, slice.length));
      if (config.vad && energy < (config.vadThreshold ?? 0.01)) { flush(); continue; }
      if (runStart !== null && end - runStart > perSegment) flush();
      runStart ??= offset;
      runEnd = end;
    }
    flush();
    previousEnd = start + available.length * 1000 / sampleRate;
    if (consumed >= maxSamples) break;
  }
  return segments;
}
