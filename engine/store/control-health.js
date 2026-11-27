/**
 * engine/store/control-health.js — control-plane health constants and the partition/row inspectors.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveInside, safeAgentId } from "../../lib/sql-safety.js";
import { AgentDbPool } from "./agent-db-pool.js";

const CONTROL_HEALTH_MAX_PARTITIONS = 128;
// The health scan opens every partition table (50+ on a busy install) and
// walks the store directory; measured 2-21 s depending on gateway load. The
// dashboard therefore serves the last snapshot at once and refreshes behind it.
const CONTROL_HEALTH_CACHE_TTL_MS = 5 * 60_000;
const CONTROL_HEALTH_REFRESH_INTERVAL_MS = 10 * 60_000;
const CONTROL_HEALTH_FAILED_RETRY_MS = 30_000;
const CONTROL_HEALTH_SAFE_DIRECTORY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_HEALTH_TABLE_PATH_NAMES = Object.freeze(["memories.lance", "memories"]);

function isAbsentControlHealthPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function hasControlHealthLanceTable(partitionPath) {
  for (const tableName of CONTROL_HEALTH_TABLE_PATH_NAMES) {
    try {
      const tablePath = resolveInside(partitionPath, tableName);
      const stat = lstatSync(tablePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return true;
    } catch (error) {
      if (isAbsentControlHealthPath(error)) continue;
      throw error;
    }
  }
  return false;
}

/** List only existing, ordinary, validated PLUR1BUS partition directory names. */
function listControlHealthPartitions(basePath) {
  let root;
  try {
    root = resolveInside(basePath);
  } catch (error) {
    if (isAbsentControlHealthPath(error)) return [];
    throw error;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isAbsentControlHealthPath(error)) return [];
    throw error;
  }
  const partitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !CONTROL_HEALTH_SAFE_DIRECTORY_NAME_RE.test(entry.name)) {
      continue;
    }
    const expected = resolve(root, entry.name);
    const canonical = resolveInside(root, entry.name);
    if (canonical !== expected) continue;
    if (!hasControlHealthLanceTable(canonical)) continue;
    partitions.push(safeAgentId(entry.name));
  }
  return partitions.toSorted((left, right) => left.localeCompare(right));
}


/** Create an isolated non-mutating LanceDB row-counter for control-plane health. */
function createControlHealthRowInspector(vectorDim, logger) {
  return async ({ basePath, partitionId }) => {
    const readPool = new AgentDbPool(basePath, vectorDim, logger, { readOnly: true });
    let result;
    let operationError = null;
    try {
      result = await readPool.withDb(partitionId, async (db) => {
        const initialized = await db.init();
        if (!initialized || !db.table) return 0;
        const count = await db.table.countRows();
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error("invalid read-only PLUR1BUS health row count");
        }
        return count;
      });
    } catch (error) {
      operationError = error;
    }

    let shutdownError = null;
    try {
      await readPool.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    if (operationError && shutdownError) {
      throw new AggregateError([operationError, shutdownError], "PLUR1BUS health row inspection and shutdown failed");
    }
    if (operationError) throw operationError;
    if (shutdownError) throw shutdownError;
    return result;
  };
}

export { CONTROL_HEALTH_MAX_PARTITIONS, CONTROL_HEALTH_CACHE_TTL_MS, CONTROL_HEALTH_REFRESH_INTERVAL_MS, CONTROL_HEALTH_FAILED_RETRY_MS, listControlHealthPartitions, createControlHealthRowInspector };
