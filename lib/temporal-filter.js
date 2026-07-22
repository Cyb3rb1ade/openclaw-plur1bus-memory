/**
 * lib/temporal-filter.js — Filtert Memory-Results nach temporalem Range
 * und löst Anchor-Queries in echte Ranges auf.
 */

import { withTimeout } from "./with-timeout.js";
import { safeDebug } from "./safe-logging.js";

const HOUR_MS = 3600_000;
const LANCEDB_READ_TIMEOUT_MS = 10_000;

/**
 * Filtert eine Liste von Results nach einem temporalen Range.
 *
 * @param {Array} results — [{ entry: { createdAt: number, ... }, score: number, ... }]
 * @param {{type:"range",from:number,to:number}|{type:"anchor",referenceQuery:string}|null} temporal
 * @returns {Array} gefilterte Results
 */
export function applyTemporalFilter(results, temporal) {
  if (!temporal || temporal.type !== "range") {
    return results;
  }
  const { from, to } = temporal;
  return results.filter((r) => {
    const ts = r.entry?.createdAt ?? 0;
    return ts >= from && ts <= to;
  });
}

/**
 * Sucht einen Referenz-Memory per Vektorsuche und baut einen 48h-Range ab
 * dessen createdAt.
 *
 * @param {string} query — Referenz-Begriff (z.B. "Docker-Setup")
 * @param {Object} dbTable — LanceDB-Tabelle mit .vectorSearch().limit().toArray()
 * @param {{embed(text)→Promise<vector>}} embeddings
 * @param {{strictReadErrors?: boolean, embeddingContext?: Object, logger?: Object}} [options]
 * @returns {Promise<{type:"range",from:number,to:number}|null>}
 */
export async function temporalRangeFromAnchor(
  query,
  dbTable,
  embeddings,
  { strictReadErrors = false, embeddingContext, logger } = {},
) {
  if (!dbTable || !embeddings || typeof embeddings.embed !== "function") {
    return null;
  }
  try {
    const vector = await embeddings.embed(query, embeddingContext);
    if (!vector || !Array.isArray(vector) || vector.length === 0) {
      return null;
    }
    const rows = await withTimeout(
      dbTable.vectorSearch(vector).limit(1).toArray(),
      LANCEDB_READ_TIMEOUT_MS,
      "temporal-filter.vectorSearch",
    );
    if (!rows || rows.length === 0) {
      return null;
    }
    const ref = rows[0];
    const from = Number(ref.createdAt) || 0;
    if (from === 0) {
      return null;
    }
    return { type: "range", from, to: from + 48 * HOUR_MS };
  } catch (e) {
    if (strictReadErrors) throw e;
    safeDebug(logger, "temporal-filter.anchor", e);
    return null;
  }
}
