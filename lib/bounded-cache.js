/**
 * lib/bounded-cache.js — refCount-aware bounded cache with soft limit.
 *
 * Soft limit: cache may temporarily exceed max when all entries are active.
 * refCount prevents eviction of entries currently in use.
 */

/**
 * Create a ref-count-aware bounded cache with observable eviction failures.
 * @param {number} [max=50] Soft maximum number of cached entries.
 * @param {(key: unknown, value: unknown) => unknown} [onEvict] Eviction callback.
 * @param {number} [maxIdleMs] Optional idle-expiry duration.
 * @returns {object} Bounded cache operations and an async eviction drain.
 */
export function makeBoundedCache(max = 50, onEvict, maxIdleMs) {
  const map = new Map();
  const refs = new Map();
  const pendingEvictions = new Set();
  const evictionErrors = [];

  function sweepIdle() {
    if (!maxIdleMs || maxIdleMs <= 0) return;
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      if ((refs.get(key) || 0) === 0 && now - entry.lastUsedAt > maxIdleMs) {
        map.delete(key);
        runEvict(key, entry?.value);
      }
    }
  }

  function contextualizeEvictionError(key, error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const contextual = new Error(
      `bounded cache eviction failed for key=${String(key)}: ${cause.message}`,
      { cause },
    );
    contextual.key = key;
    return contextual;
  }

  function trackEvictionPromise(key, promise) {
    let guarded;
    guarded = Promise.resolve(promise)
      .catch((error) => {
        evictionErrors.push(contextualizeEvictionError(key, error));
      })
      .finally(() => {
        pendingEvictions.delete(guarded);
      });
    pendingEvictions.add(guarded);
  }

  function runEvict(key, value) {
    if (typeof onEvict !== "function") return;
    try {
      const result = onEvict(key, value);
      if (result && typeof result.then === "function") {
        trackEvictionPromise(key, result);
      }
    } catch (error) {
      evictionErrors.push(contextualizeEvictionError(key, error));
    }
  }

  function trimOverflow() {
    while (map.size > max) {
      let evicted = false;
      for (const [key, entry] of map.entries()) {
        if ((refs.get(key) || 0) !== 0) continue;
        map.delete(key);
        refs.delete(key);
        runEvict(key, entry?.value);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  return {
    get: (k) => {
      const entry = map.get(k);
      if (entry) {
        if (maxIdleMs > 0 && (refs.get(k) || 0) === 0 && Date.now() - entry.lastUsedAt > maxIdleMs) {
          map.delete(k);
          runEvict(k, entry?.value);
          return undefined;
        }
        entry.lastUsedAt = Date.now();
        map.delete(k);
        map.set(k, entry);
        return entry.value;
      }
      sweepIdle();
      return undefined;
    },
    acquire: (k) => { refs.set(k, (refs.get(k) || 0) + 1); },
    release: (k) => {
      const next = Math.max(0, (refs.get(k) || 0) - 1);
      if (next === 0) refs.delete(k);
      else refs.set(k, next);
      if (next === 0) trimOverflow();
    },
    set: (k, v) => {
      if (map.has(k)) map.delete(k);
      while (map.size >= max) {
        let evicted = false;
        for (const [key, entry] of map.entries()) {
          if ((refs.get(key) || 0) !== 0) continue;
          map.delete(key);
          refs.delete(key);
          runEvict(key, entry?.value);
          evicted = true;
          break;
        }
        if (!evicted) break; // all in use, soft limit exceeded temporarily
      }
      map.set(k, { value: v, lastUsedAt: Date.now() });
    },
    has: (k) => map.has(k),
    clear: () => { map.clear(); refs.clear(); },
    entries: () => [...map.entries()].map(([key, entry]) => [key, entry.value]),
    values: () => [...map.values()].map(e => e.value),
    awaitPendingEvictions: async () => {
      while (pendingEvictions.size > 0) {
        await Promise.all([...pendingEvictions]);
      }
      if (evictionErrors.length === 0) return;
      const errors = evictionErrors.splice(0, evictionErrors.length);
      throw new AggregateError(errors, `bounded cache eviction failures (${errors.length})`);
    },
  };
}
