/**
 * lib/bounded-cache.js — refCount-aware bounded cache with soft limit.
 *
 * Soft limit: cache may temporarily exceed max when all entries are active.
 * refCount prevents eviction of entries currently in use.
 */

export function makeBoundedCache(max = 50) {
  const map = new Map();
  const refs = new Map();
  return {
    get: (k) => {
      const entry = map.get(k);
      if (entry) { entry.lastUsedAt = Date.now(); return entry.value; }
      return undefined;
    },
    acquire: (k) => { refs.set(k, (refs.get(k) || 0) + 1); },
    release: (k) => {
      const next = Math.max(0, (refs.get(k) || 0) - 1);
      if (next === 0) refs.delete(k);
      else refs.set(k, next);
    },
    set: (k, v) => {
      while (map.size >= max) {
        const entries = [...map.entries()];
        entries.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        const oldest = entries.find(([key]) => (refs.get(key) || 0) === 0);
        if (!oldest) break; // all in use, soft limit exceeded temporarily
        map.delete(oldest[0]);
        refs.delete(oldest[0]);
      }
      map.set(k, { value: v, lastUsedAt: Date.now() });
    },
    has: (k) => map.has(k),
    clear: () => { map.clear(); refs.clear(); },
  };
}
