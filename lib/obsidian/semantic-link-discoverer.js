import { computeContentHash, loadLinkIndex, saveLinkIndex, buildPriorityQueue } from "./link-index.js";

function resolveDiscoveryConfig(rawConfig) {
  const g = rawConfig.graphLinks?.semanticDiscovery || {};
  return {
    maxPerRun: g.maxPerRun ?? 500,
    threshold: g.threshold ?? rawConfig.graphLinks?.semanticThreshold ?? 0.78,
    maxLinksPerRecord: g.maxLinksPerRecord ?? 5,
  };
}

export async function discoverSemanticLinks(rawConfig, records, options = {}) {
  const { pool, logger } = options;
  if (!pool) throw new Error("discoverSemanticLinks: options.pool is required");

  const vaultPath = rawConfig.vaultPath;
  const { maxPerRun, threshold, maxLinksPerRecord } = resolveDiscoveryConfig(rawConfig);

  if (!records.length) return { processed: 0, skipped: 0, unchanged: 0, errors: 0, indexUpdated: false };

  const existingIndex = loadLinkIndex(vaultPath);
  const queue = buildPriorityQueue(records, existingIndex).slice(0, maxPerRun);

  let processed = 0, skipped = 0, unchanged = 0, errors = 0;
  let dirty = false;

  for (const record of queue) {
    if (!record.vector) { skipped++; continue; }

    const currentHash = computeContentHash(record);
    const existing = existingIndex.entries[record.plur1bus_id];
    if (existing && existing.contentHash === currentHash) {
      unchanged++;
      continue;
    }

    let searchResults;
    try {
      const db = pool.getDb(record.agentId || "default");
      searchResults = await db.search(record.vector, 15, threshold);
    } catch (err) {
      const status = err?.status || err?.statusCode || (err?.message?.includes("429") ? 429 : 0);
      if (status === 429) {
        logger?.warn?.("plur1bus-semantic: 429 — aborting batch early");
        if (dirty) saveLinkIndex(vaultPath, existingIndex);
        return { processed, skipped, unchanged, errors, indexUpdated: dirty, batchAborted: true };
      }
      logger?.warn?.(`plur1bus-semantic: search failed for ${record.plur1bus_id}: ${err?.message}`);
      errors++;
      continue;
    }

    const selfId = record.plur1bus_id;
    const tier1Ids = new Set([
      ...(Array.isArray(record.memoryIds) ? record.memoryIds : []),
      ...(Array.isArray(record.sourceRefs) ? record.sourceRefs : []),
    ]);

    const similar = (searchResults || [])
      .map((r) => r.plur1bus_id || r.id || null)
      .filter((id) => id && id !== selfId && !tier1Ids.has(id))
      .slice(0, maxLinksPerRecord);

    const now = new Date().toISOString();
    existingIndex.entries[selfId] = {
      similar,
      contentHash: currentHash,
      firstDiscoveredAt: existing?.firstDiscoveredAt || now,
      lastCheckedAt: now,
    };

    dirty = true;
    processed++;
  }

  if (dirty) saveLinkIndex(vaultPath, existingIndex);
  return { processed, skipped, unchanged, errors, indexUpdated: dirty };
}
