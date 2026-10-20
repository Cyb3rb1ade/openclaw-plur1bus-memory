import { createHash } from 'node:crypto';

/** Canonical vector-space identity; credentials and transport are excluded. */
export function embeddingIdentity(input = {}) {
  const dimension = input.dimension ?? input.dimensions;
  if (!Number.isSafeInteger(dimension) || dimension < 1) throw new TypeError('embedding identity dimension must be positive');
  for (const key of ['provider', 'model']) {
    if (typeof input[key] !== 'string' || !input[key]) throw new TypeError(`embedding identity requires ${key}`);
  }
  const output = {
    provider: input.provider,
    model: input.model,
    revision: input.revision ?? 'unspecified',
    dimension,
    normalization: input.normalization ?? (input.normalize === true ? 'l2' : 'none'),
    prefixScheme: input.prefixScheme ?? JSON.stringify([input.queryPrefix ?? '', input.passagePrefix ?? '', input.pooling ?? '', input.tokenCap ?? null]),
    instruction: input.instruction ?? '',
    dtype: input.dtype ?? 'float32',
    tokenCap: input.tokenCap ?? input.maxTokens ?? null,
    pooling: input.pooling ?? 'unspecified',
    artifacts: (input.artifacts ?? []).map(({ path, sha256 }) => {
      if (typeof path !== 'string' || !path || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('invalid identity artifact');
      return Object.freeze({ path, sha256 });
    }).sort((x, y) => x.path < y.path ? -1 : x.path > y.path ? 1 : 0),
  };
  for (const key of ['revision', 'normalization', 'prefixScheme', 'instruction', 'dtype', 'pooling']) {
    if (typeof output[key] !== 'string') throw new TypeError(`invalid embedding identity ${key}`);
  }
  if (output.tokenCap !== null && (!Number.isSafeInteger(output.tokenCap) || output.tokenCap < 1)) throw new TypeError('invalid identity token cap');
  if (new Set(output.artifacts.map(artifact => artifact.path)).size !== output.artifacts.length) throw new TypeError('duplicate identity artifact');
  Object.freeze(output.artifacts);
  return Object.freeze(output);
}

/** Stable SHA-256 over the complete canonical identity. */
export function identityId(input) {
  return createHash('sha256').update(JSON.stringify(embeddingIdentity(input))).digest('hex');
}

/** Typed refusal: callers must never substitute another vector space. */
export function identityError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** RRF over identity-ranked lists; the single-identity path is unchanged. */
export function fuseIdentityResults(results, { k = 60 } = {}) {
  if (!Number.isFinite(k) || k <= 0) throw new TypeError('RRF k must be positive');
  if (new Set(results.map(x => x.identityId)).size <= 1) return results;
  const fuse = field => {
    const merged = new Map();
    let ordinal = 0;
    for (const result of results) {
      for (const [rank, item] of (result[field] ?? []).entries()) {
        const key = item.entry?.id ?? item.id ?? `${result.identityId}:${ordinal}`;
        const existing = merged.get(key);
        if (existing) existing.score += 1 / (k + rank + 1);
        else merged.set(key, { item, score: 1 / (k + rank + 1), ordinal: ordinal++ });
      }
    }
    return [...merged.values()].sort((x, y) => y.score - x.score || x.ordinal - y.ordinal)
      .map(({ item, score }) => ({ ...item, score }));
  };
  return [{ namespace: null, sourceKind: 'private', memories: fuse('memories'), canonical: fuse('canonical') }];
}

/** Embed once per identity under a shared deadline, including uncooperative providers. */
export async function embedIdentityQueries(query, identities, providers, { signal, budgetMs = 400, agentId } = {}) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('embedding budget must be positive');
  if (signal?.aborted) throw signal.reason;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(identityError('EMBEDDING_TIMEOUT', 'embedding deadline exceeded')), budgetMs);
  const vectors = new Map();
  const failures = [];
  try {
    await Promise.all([...new Map(identities.map(identity => [identityId(identity), identity])).entries()].map(async ([id, identity]) => {
      let onAbort;
      try {
        const provider = providers.get(id);
        if (!provider) throw identityError('EMBEDDER_UNAVAILABLE', 'no embedder for target identity');
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        const method = provider.embedQuery ?? provider.embed;
        const vector = await Promise.race([Promise.resolve().then(() => method.call(provider, query, { signal: controller.signal, agentId })), aborted]);
        const values = Array.from(vector);
        if (values.length !== embeddingIdentity(identity).dimension || !values.every(Number.isFinite)) {
          throw identityError('EMBEDDING_IDENTITY_MISMATCH', 'query vector does not match identity');
        }
        vectors.set(id, values);
      } catch (error) {
        failures.push({ identityId: id, code: error.code ?? 'EMBEDDING_FAILED' });
      } finally {
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      }
    }));
    if (signal?.aborted) throw signal.reason;
    return { vectors, failures };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
