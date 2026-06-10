/**
 * lib/embedding-cache.js
 *
 * LRU + TTL embedding cache.
 */

/**
 * Baut den Cache-Key aus den Komponenten.
 * @param {string} agentId
 * @param {string} normalizedQuery
 * @param {string} modelVersion
 * @returns {string}
 */
function buildKey(agentId, normalizedQuery, modelVersion) {
  return `${agentId}\x00${normalizedQuery}\x00${modelVersion}`;
}

/**
 * Erstellt eine neue Cache-Instanz mit LRU- und TTL-Verhalten.
 *
 * @param {Object} options
 * @param {number} [options.maxEntries=500]
 * @param {number} [options.ttlMs=1800000]
 * @returns {{ get: Function, set: Function, clear: Function, size: number }}
 */
export function createEmbeddingCache({ maxEntries = 500, ttlMs = 1800000 } = {}) {
  /** @type {Map<string, { vector: number[], expiryTime: number }>} */
  const map = new Map();

  /** @type {Map<string, number>} */
  const expiryMap = new Map();

  /**
   * Räumt abgelaufene Einträge auf.
   */
  function sweepExpired() {
    const now = Date.now();
    for (const [key, expiryTime] of expiryMap) {
      if (expiryTime <= now) {
        map.delete(key);
        expiryMap.delete(key);
      }
    }
  }

  /**
   * Liest einen Eintrag aus dem Cache.
   *
   * @param {string} agentId
   * @param {string} normalizedQuery
   * @param {string} modelVersion
   * @returns {{ vector: number[] } | undefined}
   */
  function get(agentId, normalizedQuery, modelVersion) {
    sweepExpired();
    const key = buildKey(agentId, normalizedQuery, modelVersion);
    const entry = map.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiryTime) {
      map.delete(key);
      expiryMap.delete(key);
      return undefined;
    }
    // LRU: Eintrag nach hinten schieben (zuletzt verwendet)
    map.delete(key);
    map.set(key, entry);
    return { vector: entry.vector };
  }

  /**
   * Schreibt einen Eintrag in den Cache.
   *
   * @param {string} agentId
   * @param {string} normalizedQuery
   * @param {string} modelVersion
   * @param {number[]} vector
   */
  function set(agentId, normalizedQuery, modelVersion, vector) {
    sweepExpired();
    const key = buildKey(agentId, normalizedQuery, modelVersion);
    const expiryTime = Date.now() + ttlMs;

    // Bestehenden Eintrag überschreiben
    map.set(key, { vector, expiryTime });
    expiryMap.set(key, expiryTime);

    // LRU-Eviction: ältesten Eintrag entfernen, wenn maxEntries überschritten
    while (map.size > maxEntries) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) {
        map.delete(firstKey);
        expiryMap.delete(firstKey);
      } else {
        break;
      }
    }
  }

  /**
   * Leert den Cache vollständig.
   */
  function clear() {
    map.clear();
    expiryMap.clear();
  }

  return {
    get,
    set,
    clear,
    get size() {
      sweepExpired();
      return map.size;
    },
  };
}
