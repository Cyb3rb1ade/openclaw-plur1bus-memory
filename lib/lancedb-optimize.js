/**
 * lib/lancedb-optimize.js (7.12.31)
 *
 * Plan und Zusammenfassung fuer die naechtliche LanceDB-Kompaktierung in
 * consolidate-daily. Jede Zeilenaenderung (Dynamik, Abrufzaehler, Emotion)
 * legt in LanceDB ein neues Fragment und eine neue Version an; ohne
 * `optimize()` wuchsen die Tabellen auf 352 (main) bzw. 845 (Bernhardine)
 * Fragmente mit Median 1 Zeile und ueber 1000 Versionen. Gemessen auf einer
 * Kopie von main: Vektorsuche 191 → 23 ms, Update 734 → 74 ms nach einem
 * `optimize()` (352 → 12 Fragmente, 8 s).
 */

const DEFAULT_KEEP_VERSIONS_HOURS = 24;
const MIN_KEEP_VERSIONS_HOURS = 1;
// 240 s: der Feature-Cron-RPC bricht nach 540 s ab; consolidate-daily traegt
// davor noch Kompaktierung, Decay und Graph-Prune.
const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * @param {object} [cfg]  `dailyConsolidation.lancedbOptimize`
 * @param {number} [now]
 * @returns {{enabled: boolean, keepVersionsHours: number, cleanupOlderThan: Date, timeoutMs: number}}
 */
export function resolveLancedbOptimizePlan(cfg = {}, now = Date.now()) {
  const source = cfg && typeof cfg === "object" ? cfg : {};
  const enabled = source.enabled !== false;
  const rawHours = Number(source.keepVersionsHours);
  const keepVersionsHours = Number.isFinite(rawHours) && rawHours >= MIN_KEEP_VERSIONS_HOURS ? rawHours : DEFAULT_KEEP_VERSIONS_HOURS;
  const rawTimeout = Number(source.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 10_000 ? Math.floor(rawTimeout) : DEFAULT_TIMEOUT_MS;
  return {
    enabled,
    keepVersionsHours,
    cleanupOlderThan: new Date(now - keepVersionsHours * 3_600_000),
    timeoutMs,
  };
}

const toNumber = (value) => (typeof value === "bigint" ? Number(value) : Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Flache, JSON-taugliche Zusammenfassung (BigInt → Number).
 * @param {object} [stats]  Ergebnis von table.optimize()
 * @param {object} [before] table.stats() vor dem Lauf
 * @param {object} [after]  table.stats() danach
 */
export function summarizeLancedbOptimize(stats = {}, before = null, after = null) {
  const fragments = (snapshot) => (snapshot?.fragmentStats ? {
    fragments: toNumber(snapshot.fragmentStats.numFragments),
    smallFragments: toNumber(snapshot.fragmentStats.numSmallFragments),
    medianRows: toNumber(snapshot.fragmentStats.lengths?.p50),
    bytes: toNumber(snapshot.totalBytes),
  } : null);
  return {
    fragmentsRemoved: toNumber(stats?.compaction?.fragmentsRemoved),
    fragmentsAdded: toNumber(stats?.compaction?.fragmentsAdded),
    filesRemoved: toNumber(stats?.compaction?.filesRemoved),
    oldVersionsRemoved: toNumber(stats?.prune?.oldVersionsRemoved),
    bytesRemoved: toNumber(stats?.prune?.bytesRemoved),
    before: fragments(before),
    after: fragments(after),
  };
}
