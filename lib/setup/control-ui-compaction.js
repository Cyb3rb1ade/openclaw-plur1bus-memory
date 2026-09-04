/**
 * lib/setup/control-ui-compaction.js — LanceDB fragment compaction started
 * from the dashboard.
 *
 * Every add()/update() leaves a new fragment behind; without compaction a
 * partition grows into thousands of small files and full scans slow down by
 * two orders of magnitude (see db-adapter optimizeTable). The adapter has had
 * the primitive since August 2026, but nothing ever called it. This runner
 * gives the operator a button per private partition and keeps the result
 * visible on the page.
 *
 * Rules:
 * - One compaction at a time, installation-wide. LanceDB compaction is IO
 *   heavy and the store lives on one disk.
 * - Only partitions the health scan has listed can be compacted. Any other id
 *   is refused before it reaches the store, so a crafted form cannot make
 *   LanceDB create a directory for it.
 * - The request returns at once; the work runs in the background with the
 *   adapter's ten-minute budget. The row shows running/done/failed.
 */

const DEFAULT_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;

export const PARTITION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;

export function isPartitionId(value) {
  return typeof value === "string" && PARTITION_ID_RE.test(value);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${bytes} B`;
}

/**
 * Turn LanceDB's optimize statistics into one short, number-safe sentence.
 * Unknown shapes degrade to "compacted" rather than leaking objects.
 */
export function summarizeOptimizeStats(stats) {
  const compaction = stats && typeof stats === "object" ? stats.compaction : null;
  const prune = stats && typeof stats === "object" ? stats.prune : null;
  const parts = [];
  const removed = safeCount(compaction?.fragmentsRemoved);
  const added = safeCount(compaction?.fragmentsAdded);
  if (removed !== null && added !== null) parts.push(`fragments ${removed} → ${added}`);
  const bytes = safeCount(prune?.bytesRemoved);
  if (bytes !== null && bytes > 0) parts.push(`${formatBytes(bytes)} freed`);
  const versions = safeCount(prune?.oldVersionsRemoved);
  if (versions !== null && versions > 0) parts.push(`${versions} old version${versions === 1 ? "" : "s"} pruned`);
  return parts.length > 0 ? parts.join(" · ") : "compacted";
}

/**
 * @param {{
 *   optimize: (partitionId: string) => Promise<{ok: boolean, stats?: object, reason?: string}>,
 *   knownPartitions: () => Promise<string[]> | string[],
 *   now?: () => number,
 *   logger?: object|null,
 *   historyTtlMs?: number,
 *   onFinished?: (entry: object) => void,
 * }} options
 */
export function createCompactionRunner({
  optimize,
  knownPartitions,
  now = Date.now,
  logger = null,
  historyTtlMs = DEFAULT_HISTORY_TTL_MS,
  onFinished = null,
} = {}) {
  if (typeof optimize !== "function") throw new Error("compaction optimize function is required");
  if (typeof knownPartitions !== "function") throw new Error("compaction partition lookup is required");
  const entries = new Map();
  let active = null;

  const prune = () => {
    const cutoff = now() - historyTtlMs;
    for (const [id, entry] of entries) {
      if (entry.status !== "running" && entry.finishedAt !== null && entry.finishedAt < cutoff) entries.delete(id);
    }
  };

  const finish = (id, patch) => {
    const entry = entries.get(id);
    if (entry) Object.assign(entry, patch, { finishedAt: now() });
    if (active === id) active = null;
    try {
      onFinished?.(entries.get(id) ?? null);
    } catch (error) {
      logger?.debug?.(`memory-lancedb-namespaced: compaction onFinished failed: ${error?.message || error}`);
    }
  };

  return Object.freeze({
    /** @returns {Promise<{ok: boolean, code: string}>} */
    async start({ id } = {}) {
      if (!isPartitionId(id)) return { ok: false, code: "denied_partition" };
      let known;
      try {
        known = await knownPartitions();
      } catch {
        known = [];
      }
      if (!Array.isArray(known) || !known.includes(id)) return { ok: false, code: "denied_partition" };
      if (active !== null) return { ok: false, code: "denied_busy" };
      prune();
      active = id;
      entries.set(id, { id, status: "running", startedAt: now(), finishedAt: null, summary: null });
      logger?.info?.(`memory-lancedb-namespaced: compaction started for partition ${id}`);
      Promise.resolve()
        .then(() => optimize(id))
        .then((result) => {
          if (result?.ok === true) {
            const summary = summarizeOptimizeStats(result.stats);
            logger?.info?.(`memory-lancedb-namespaced: compaction finished for partition ${id}: ${summary}`);
            finish(id, { status: "done", summary });
            return;
          }
          const reason = typeof result?.reason === "string" ? result.reason : "optimize returned no result";
          logger?.warn?.(`memory-lancedb-namespaced: compaction failed for partition ${id}: ${reason}`);
          finish(id, { status: "failed", summary: null });
        })
        .catch((error) => {
          logger?.warn?.(`memory-lancedb-namespaced: compaction failed for partition ${id}: ${error?.message || error}`);
          finish(id, { status: "failed", summary: null });
        });
      return { ok: true, code: "compaction_started" };
    },

    /** Snapshot for the page: which partition runs, and recent outcomes. */
    status() {
      prune();
      const byPartition = {};
      for (const [id, entry] of entries) byPartition[id] = { ...entry };
      return { active, byPartition };
    },
  });
}
