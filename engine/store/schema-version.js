/**
 * engine/store/schema-version.js — store schema version marker and migrator
 * (E2 Task 2, contract 1.6.0).
 *
 * A small JSON marker file at `{baseDbPath}/_schema.json` records which
 * on-disk schema shape a store was written with, so `admin.migrate` has
 * something to check against and advance. A fresh store (baseDbPath missing
 * or an empty directory) starts at `STORE_SCHEMA_VERSION` — there is nothing
 * to migrate. An existing, non-empty store with no marker predates this
 * mechanism and is `LEGACY_STORE_SCHEMA_VERSION` ("0") until the owner runs
 * `admin.migrate`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMemoryOpError, memoryOpError } from "../memory-ops/errors.js";
import { sweepStaleTmp } from "../../lib/atomic-file.js";
import { writeTextFsync } from "../../lib/fsync-atomic.js";

/** The schema version this engine build writes. */
export const STORE_SCHEMA_VERSION = "1";
/** The implicit version of a store with no marker file. */
export const LEGACY_STORE_SCHEMA_VERSION = "0";

/**
 * Migration steps, keyed `"<from>->to"`. Each step transforms the store
 * on-disk from `from` to `from + 1`; `migrate()` runs every step between
 * `from` and `to` in order.
 */
const STORE_MIGRATIONS = Object.freeze({
  // Version 1 records the column set of contract 1.5.0
  // (ensureSharedMemoryColumns, chunkGroupId seed row) as the schema
  // baseline; those columns are already applied by the existing LanceDB
  // migration path (memory-db.js) the first time a table is opened, so
  // there is nothing left to transform here — this step exists only to
  // mark a "0" store current once its owner confirms it has that shape.
  "0->1": async () => {},
});

/** Absolute path to a store's schema marker file. */
export function schemaMarkerPath(baseDbPath) {
  return join(baseDbPath, "_schema.json");
}

/**
 * Reads a store's current schema version.
 * @returns {string|null} `LEGACY_STORE_SCHEMA_VERSION` ("0") when the marker
 *   is missing; the recorded version when present and well-formed; `null`
 *   when the marker exists but is unparsable or not shaped
 *   `{ schemaVersion: /^\d+$/ }`.
 */
export function readStoreSchemaVersion(baseDbPath, { logger } = {}) {
  const markerPath = schemaMarkerPath(baseDbPath);
  if (!existsSync(markerPath)) return LEGACY_STORE_SCHEMA_VERSION;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (parsed && typeof parsed.schemaVersion === "string" && /^\d+$/.test(parsed.schemaVersion)) {
      return parsed.schemaVersion;
    }
    logger?.warn?.(`memory-lancedb-namespaced: store schema marker at ${markerPath} is not { schemaVersion: /^\\d+$/ }`);
    return null;
  } catch (error) {
    logger?.warn?.(`memory-lancedb-namespaced: store schema marker at ${markerPath} is unreadable (${error?.message || error})`);
    return null;
  }
}

/**
 * Writes the schema marker atomically (unique `.tmp` sibling, fsync, rename
 * over the marker path, directory fsync). Creates `baseDbPath` if it does not exist.
 */
export function writeStoreSchemaMarker(baseDbPath, version, { engineVersion, clock = Date.now } = {}) {
  mkdirSync(baseDbPath, { recursive: true });
  const markerPath = schemaMarkerPath(baseDbPath);
  const payload = {
    schemaVersion: String(version),
    writtenAt: new Date(clock()).toISOString(),
    engineVersion,
  };
  // Unique tmp + fsync + rename. Two processes initialising the same brand-new
  // store race here; a lost rename is forgiven when the marker already holds
  // the version this call meant to write (idempotent init).
  // Orphans of a crashed writer (SIGKILL between temp create and rename).
  sweepStaleTmp(baseDbPath, "_schema.json");
  writeTextFsync(markerPath, JSON.stringify(payload, null, 2), {
    mode: 0o666, // umask-governed, as the previous writeFileSync (not forced to 0600)
    acceptExisting: (text) => {
      try { return JSON.parse(text)?.schemaVersion === String(version); } catch { return false; }
    },
  });
  return payload;
}

/**
 * Builds a store migrator bound to one `baseDbPath`.
 * @returns {{ current(): (string|null), migrate(from: string, to: string): Promise<{from: string, to: string, applied: boolean}> }}
 */
export function createStoreMigrator({ baseDbPath, logger, engineVersion, clock = Date.now }) {
  // A raw fs error from a migration step or the marker write never reaches
  // the caller: it is logged and surfaced as `storage` with a fixed message.
  async function runGuarded(label, run) {
    try {
      return await run();
    } catch (error) {
      if (isMemoryOpError(error)) throw error;
      logger?.warn?.(`admin.migrate: ${label} failed: ${error?.code || ""} ${error?.message || error}`);
      throw memoryOpError("storage", "store migration failed");
    }
  }
  return {
    current() {
      return readStoreSchemaVersion(baseDbPath, { logger });
    },
    async migrate(from, to) {
      if (!/^\d+$/.test(String(from)) || !/^\d+$/.test(String(to))) {
        throw memoryOpError("invalid-input", "schema version must match /^\\d+$/");
      }
      const current = readStoreSchemaVersion(baseDbPath, { logger });
      if (current === null) {
        throw memoryOpError("storage", "store schema marker unreadable");
      }
      if (String(from) !== current) {
        throw memoryOpError("conflict", `store is at schema ${current}`);
      }
      const fromNum = Number(from);
      const toNum = Number(to);
      if (toNum < fromNum) {
        throw memoryOpError("invalid-input", "downgrade is not supported");
      }
      if (toNum > Number(STORE_SCHEMA_VERSION)) {
        throw memoryOpError("invalid-input", "unknown schema version");
      }
      if (fromNum === toNum) {
        return { from: String(from), to: String(to), applied: false };
      }
      for (let v = fromNum; v < toNum; v++) {
        const step = STORE_MIGRATIONS[`${v}->${v + 1}`];
        if (typeof step !== "function") {
          throw memoryOpError("invalid-input", `no migration step registered for ${v}->${v + 1}`);
        }
        await runGuarded(`step ${v}->${v + 1}`, () => step({ baseDbPath, logger }));
      }
      await runGuarded("marker write", () => writeStoreSchemaMarker(baseDbPath, String(to), { engineVersion, clock }));
      return { from: String(from), to: String(to), applied: true };
    },
  };
}
