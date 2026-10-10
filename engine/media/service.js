import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { resolveCanonicalWorkspacePrincipal } from '../../lib/memory-request-context.js';
import { checkAccess } from '../../lib/acl-middleware.js';
import { safeAgentId, resolveInside, appendDestructiveOpLog } from '../../lib/sql-safety.js';
import { validateInput } from '../../lib/input-limits.js';
import { validateMediaConfig, mediaFingerprint, mediaError } from '../../lib/providers/media-registry.js';
import { createMediaEmbeddingProvider } from '../../lib/providers/embedding-media.js';
import { assertReembeddedRowsMatch } from '../../lib/reembedding/coordinator.js';
import { openMediaStore } from './store.js';
import { segmentMedia } from './segmenting.js';

function identifier(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/u.test(value)) throw mediaError('E_MEDIA_SOURCE', 'invalid mediaId');
  return value;
}
function context(scope) {
  if (!scope || typeof scope !== 'object') throw mediaError('E_MEDIA_SCOPE', 'scope with agentId is required');
  safeAgentId(scope.agentId);
  const aliases = scope.workspaceAliases || { paths: [], aliases: [] };
  return { ...scope, workspaceAliases: aliases, workspaceIdentity: scope.workspaceIdentity || (scope.workspaceId ? resolveCanonicalWorkspacePrincipal({ explicitId: scope.workspaceId }, aliases) : ''), userPrincipal: scope.userPrincipal || scope.ownerUserId };
}
function ownership(scope) {
  const row = { agentId: scope.agentId, scope: scope.scope || 'agent-private', ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), ...(scope.ownerUserId ? { ownerUserId: scope.ownerUserId } : {}) };
  if (!checkAccess(context(scope), row).allowed) throw mediaError('E_MEDIA_SCOPE', 'invalid ownership scope');
  if (row.workspaceId) row.workspaceId = context(scope).workspaceIdentity;
  return row;
}
function cosine(a, b) {
  if (a.length !== b.length) throw mediaError('E_MEDIA_DIMENSION', 'query/document width differs');
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  if (!na || !nb) throw mediaError('E_MEDIA_DIMENSION', 'zero vector');
  return a.reduce((sum, v, i) => sum + v * b[i], 0) / (na * nb);
}
/** Host-neutral media API. Scope is a trusted host-derived principal, as for memory operations.
 * @param {object} options Storage, providers, caption adapter and host decoder/budget ports.
 * @returns {object} Media operations and lifecycle. */
export function createMediaService({ root, config: input = {}, provider: injected, ports = {}, captions, budget = async () => true, sourceRoot = root, validate = true, logger } = {}) {
  const enabled = input.enabled === true;
  const config = enabled && validate ? validateMediaConfig(input) : { ...input, variant: input.variant || 'vision' };
  const fingerprint = mediaFingerprint(config);
  let store, provider, closed = false, closing = false, worker = null;
  let backfill = { state: 'idle', done: 0, total: 0 };
  let queue = Promise.resolve();
  // A single mutation queue also serializes foreground writes with one backfill item.
  const serial = operation => {
    const task = queue.then(operation);
    queue = task.then(() => {}, () => {});
    return task;
  };
  const assertOpen = () => { if (closed || closing) throw mediaError('E_MEDIA_UNAVAILABLE', 'media service closed'); };
  const initialize = () => {
    assertOpen();
    if (!store) {
      store = openMediaStore(root);
      backfill = store.meta('backfill') || backfill;
      const previous = store.meta('fingerprint');
      if (previous && previous !== fingerprint) {
        store.invalidate();
        backfill = { state: 'idle', done: 0, total: 0 };
        store.setMeta('backfill', backfill);
      }
      store.setMeta('fingerprint', fingerprint);
    }
    return store;
  };
  const persist = () => store.setMeta('backfill', backfill);
  const getProvider = () => provider ??= injected || createMediaEmbeddingProvider(config, { logger });
  const checkVector = vector => {
    if (!Array.isArray(vector) || vector.length !== config.dimensions || vector.some(v => !Number.isFinite(v)) || !Math.hypot(...vector)) throw mediaError('E_MEDIA_DIMENSION', 'provider returned invalid media vector');
    return vector;
  };
  const embedItem = async item => {
    if (!enabled) { store.patch(item.mediaId, { state: 'pending' }); return { segments: 0, state: 'pending' }; }
    if (validate && !config.modalities.includes(item.kind)) { store.patch(item.mediaId, { state: 'unsupported-kind' }); return { segments: 0, state: 'unsupported-kind' }; }
    const segments = await segmentMedia(item, new Uint8Array(item.source), config, ports);
    if (segments === null) { store.patch(item.mediaId, { state: 'unsupported-kind' }); return { segments: 0, state: 'unsupported-kind' }; }
    if (!segments.length) throw mediaError('E_MEDIA_SOURCE', 'no usable segments');
    for (const segment of segments) segment.vector = checkVector(await getProvider().embedMedia(segment));
    const rows = segments.map(({ idx, startMs, endMs }) => ({ id: `${item.mediaId}:${idx}`, mediaId: item.mediaId, idx, startMs, endMs, dim: config.dimensions }));
    store.replaceSegments(item.mediaId, segments, config.dimensions, () => {
      const readBack = store.segments(item.mediaId).map(row => ({ ...row, id: `${row.mediaId}:${row.idx}` }));
      assertReembeddedRowsMatch(rows, readBack, config.dimensions);
    });
    return { segments: segments.length, state: 'indexed' };
  };
  const caption = async (item, text, source) => {
    validateInput(text, { name: 'caption', required: true, maxLength: 10000 });
    if (!captions?.set) throw mediaError('E_MEDIA_UNAVAILABLE', 'text caption store is unavailable');
    const captionMemoryId = await captions.set(item, text, source);
    store.patch(item.mediaId, { captionMemoryId });
  };
  const runWorker = () => {
    if (worker || closing || closed || backfill.state !== 'running') return;
    worker = (async () => {
      while (!closing && backfill.state === 'running') {
        if (!await budget()) { backfill.state = 'paused'; backfill.pausedReason = 'budget'; persist(); break; }
        const pending = store.items().filter(item => item.state === 'pending' || (item.state === 'failed' && item.attempts < (config.maxAttempts || 3)));
        if (!pending.length) { backfill.state = 'completed'; persist(); break; }
        for (const item of pending.slice(0, config.batchSize || 8)) {
          if (closing || backfill.state !== 'running') break;
          await serial(async () => {
            const live = store.get(item.mediaId);
            if (!live || live.state === 'indexed') return;
            store.patch(item.mediaId, { attempts: live.attempts + 1 });
            try { await embedItem(live); }
            catch (error) { store.patch(item.mediaId, { state: 'failed' }); logger?.warn?.(`media backfill item failed: ${error.code || 'E_MEDIA_UNAVAILABLE'}`); }
            backfill.total = store.items().length;
            backfill.done = store.items().filter(row => row.state !== 'pending' && !(row.state === 'failed' && row.attempts < (config.maxAttempts || 3))).length;
            persist();
          });
        }
        await yieldTurn();
      }
    })().catch(error => { backfill.state = 'paused'; backfill.pausedReason = 'storage'; persist(); logger?.warn?.(`media backfill paused: ${error.code || 'storage'}`); }).finally(() => { worker = null; if (backfill.state === 'running' && !closing) runWorker(); });
  };
  const service = {
    index: req => serial(async () => {
      initialize(); identifier(req?.mediaId);
      if (!['image', 'video', 'audio'].includes(req.kind) || typeof req.mime !== 'string' || req.mime.length > 128) throw mediaError('E_MEDIA_SOURCE', 'invalid media kind/mime');
      const own = ownership(req.scope), old = store.get(req.mediaId);
      if (old && (!checkAccess(context(req.scope), old.ownership).allowed || JSON.stringify(old.ownership) !== JSON.stringify(own))) throw mediaError('E_MEDIA_SCOPE', 'media ownership cannot be replaced');
      if (!req.source || Number('path' in req.source) + Number('bytes' in req.source) !== 1) throw mediaError('E_MEDIA_SOURCE', 'exactly one byte/path source required');
      const maxBytes = config.maxBytes || 32 * 1024 * 1024;
      let bytes;
      if ('path' in req.source) {
        const rel = relative(sourceRoot, req.source.path);
        if (isAbsolute(rel) || rel.startsWith('..')) throw mediaError('E_MEDIA_SOURCE', 'source outside host sourceRoot');
        const path = resolveInside(sourceRoot, rel);
        if ((await stat(path)).size > maxBytes) throw mediaError('E_MEDIA_SOURCE', 'source byte limit');
        bytes = new Uint8Array(await readFile(path));
      } else {
        if (!(req.source.bytes instanceof Uint8Array)) throw mediaError('E_MEDIA_SOURCE', 'source must be Uint8Array');
        bytes = req.source.bytes;
      }
      if (!bytes.length || bytes.length > maxBytes) throw mediaError('E_MEDIA_SOURCE', 'source byte limit');
      const item = { mediaId: req.mediaId, kind: req.kind, mime: req.mime, createdAt: old?.createdAt || Date.now(), state: 'pending', ownership: own, captionMemoryId: old?.captionMemoryId, sha256: createHash('sha256').update(bytes).digest('hex') };
      store.put(item, bytes);
      await caption(store.get(req.mediaId), req.caption || `${req.kind} (${req.mime})`, req.captionSource || 'host');
      try { return await embedItem(store.get(req.mediaId)); }
      catch (error) { store.patch(req.mediaId, { state: 'failed', attempts: 1 }); throw error; }
    }),
    async search(req) {
      initialize();
      if (!enabled) return [];
      if (Number(req?.text !== undefined) + Number(req?.likeMediaId !== undefined) !== 1) throw mediaError('E_MEDIA_SOURCE', 'exactly one of text/likeMediaId required');
      const ctx = context(req.scope);
      const limit = req.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (req.minScore !== undefined && (!Number.isFinite(req.minScore) || req.minScore < -1 || req.minScore > 1))) throw mediaError('E_MEDIA_SOURCE', 'invalid search limits');
      let vector;
      if (req.text !== undefined) { validateInput(req.text, { name: 'media query', required: true, maxLength: 10000 }); vector = checkVector(await getProvider().embedText(req.text)); }
      else {
        const item = store.get(identifier(req.likeMediaId));
        if (!item || !checkAccess(ctx, item.ownership).allowed) return [];
        vector = store.segments(item.mediaId)[0]?.vector;
        if (!vector) return [];
      }
      const results = [];
      for (const item of store.items()) {
        if (item.state !== 'indexed' || !checkAccess(ctx, item.ownership).allowed || (req.kinds && !req.kinds.includes(item.kind))) continue;
        const segments = store.segments(item.mediaId).map(segment => ({ segment, score: cosine(vector, segment.vector) })).sort((a, b) => b.score - a.score);
        const best = segments[0];
        if (best && best.score >= (req.minScore ?? -1)) results.push({ mediaId: item.mediaId, kind: item.kind, score: best.score, segment: { idx: best.segment.idx, startMs: best.segment.startMs, endMs: best.segment.endMs }, ...(item.captionMemoryId ? { captionMemoryId: item.captionMemoryId } : {}) });
      }
      results.sort((a, b) => b.score - a.score || a.mediaId.localeCompare(b.mediaId));
      if (req.fuseCaptions && req.text !== undefined && captions?.search) {
        const ranked = await captions.search(req.text, ctx, limit);
        const fused = new Map(results.map((row, i) => [row.mediaId, { ...row, score: 1 / (60 + i + 1) }]));
        for (const [i, hit] of ranked.entries()) {
          const item = store.items().find(row => row.captionMemoryId === hit.id);
          if (!item || !checkAccess(ctx, item.ownership).allowed || (req.kinds && !req.kinds.includes(item.kind))) continue;
          const result = fused.get(item.mediaId) || { mediaId: item.mediaId, kind: item.kind, captionMemoryId: item.captionMemoryId, score: 0 };
          result.score += 1 / (60 + i + 1); fused.set(item.mediaId, result);
        }
        return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
      }
      return results.slice(0, limit);
    },
    remove: id => serial(async () => { initialize(); const item = store.get(identifier(id)); if (item) { if (!appendDestructiveOpLog(root, { action: 'media.remove', mediaId: id, timestamp: Date.now() })) throw mediaError('E_MEDIA_UNAVAILABLE', 'audit write failed'); await captions?.remove?.(item); store.remove(id); } }),
    setCaption: (id, text, source) => serial(async () => { initialize(); const item = store.get(identifier(id)); if (!item) throw mediaError('E_MEDIA_SOURCE', 'media not found'); await caption(item, text, source); }),
    status() {
      if (enabled) initialize();
      const counts = { indexed: 0, pending: 0, failed: 0, unsupported: 0 };
      for (const item of store?.items() || []) counts[item.state === 'unsupported-kind' ? 'unsupported' : item.state]++;
      return { enabled, provider: config.provider || null, model: config.model || null, variant: config.variant, dim: config.dimensions || null, fingerprint, counts, backfill: { ...backfill } };
    },
    backfill: {
      start: ({ reason } = {}) => serial(async () => {
        initialize(); if (!enabled) throw mediaError('E_MEDIA_UNAVAILABLE', 'media disabled');
        if (!['enable', 'model-change', 'manual'].includes(reason)) throw mediaError('E_MEDIA_SOURCE', 'invalid backfill reason');
        if (backfill.state === 'running') return;
        if (reason === 'manual') store.invalidate();
        backfill = { state: 'running', done: 0, total: store.items().length, startedAt: Date.now() }; persist(); runWorker();
      }),
      async pause() { initialize(); backfill.state = 'paused'; delete backfill.pausedReason; persist(); await worker; },
      async resume() { initialize(); if (!enabled) throw mediaError('E_MEDIA_UNAVAILABLE', 'media disabled'); backfill.state = 'running'; delete backfill.pausedReason; persist(); runWorker(); },
      async cancel() { initialize(); backfill.state = 'cancelled'; delete backfill.pausedReason; persist(); await worker; },
      async wait() { await worker; },
    },
    async close() {
      if (closed || closing) return;
      closing = true;
      await worker; await queue;
      await provider?.close?.(); store?.close(); closed = true;
    },
  };
  if (enabled) {
    initialize();
    if (backfill.state === 'running' || (config.backfill === 'auto' && ['idle', 'completed'].includes(backfill.state) && store.items().some(item => item.state === 'pending' || (item.state === 'failed' && item.attempts < (config.maxAttempts || 3))))) { backfill.state = 'running'; backfill.total = store.items().length; persist(); runWorker(); }
  }
  return service;
}
