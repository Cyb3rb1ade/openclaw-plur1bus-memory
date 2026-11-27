/**
 * engine/memory-ops/import-ledger.js — sidecar JSONL for `memory.import`
 * (contract 1.11.0). One file per agent at `{baseDbPath}/_imports/<agentId>.jsonl`.
 *
 * The store row (deterministic id) is the source of truth. This ledger records
 * provenance (`sourceRef`) for list/show and is a cache of idempotency keys.
 * A missing line after a successful store is a crash window the resume path
 * closes by looking the card up in the store first.
 */

import {
  appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside, safeAgentId } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

export const IMPORT_LEDGER_VERSION = 1;

/**
 * fsync a directory so a newly created entry in it survives a power loss.
 * No-op on win32 (directories cannot be opened for fsync there).
 * @param {string} dir
 * @param {{platform?: string, openSync?: Function, fsyncSync?: Function, closeSync?: Function}} [fsImpl] test seam
 */
export function fsyncDirectory(dir, fsImpl = {}) {
  const platform = fsImpl.platform ?? process.platform;
  if (platform === "win32") return;
  const open = fsImpl.openSync ?? openSync;
  const sync = fsImpl.fsyncSync ?? fsyncSync;
  const close = fsImpl.closeSync ?? closeSync;
  const fd = open(dir, "r");
  try {
    sync(fd);
  } finally {
    try { close(fd); } catch { /* already closed */ }
  }
}

/**
 * @param {string} baseDbPath
 * @returns {string}
 */
export function importsRoot(baseDbPath) {
  return join(baseDbPath, "_imports");
}

/**
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {string}
 */
export function importLedgerPath(baseDbPath, agentId) {
  return resolveInside(baseDbPath, "_imports", `${safeAgentId(agentId)}.jsonl`);
}

function parseLine(line) {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== IMPORT_LEDGER_VERSION) return null;
  if (typeof parsed.idempotencyKey !== "string" || typeof parsed.cardId !== "string") return null;
  return parsed;
}

/**
 * @param {{baseDbPath: string, logger?: object, syncFile?: Function, syncDir?: Function}} deps
 *   `syncFile(fd)` / `syncDir(path)` are test seams (default `fsyncSync` / `fsyncDirectory`).
 */
export function createImportLedger({
  baseDbPath, logger, syncFile = fsyncSync, syncDir = fsyncDirectory,
} = {}) {
  let dirSyncWarned = false;

  /**
   * Directory fsync is best-effort: some filesystems refuse it (EINVAL/ENOTSUP/
   * EPERM/EISDIR on FUSE, SMB, Docker Desktop bind mounts). The line itself is
   * already appended and file-fsynced, and the store row (written before the
   * ledger) is the source of truth, so a refusal must not turn a stored card
   * into a failure. Warned once per ledger.
   */
  function syncDirBestEffort(dir) {
    try {
      syncDir(dir);
    } catch (err) {
      if (dirSyncWarned) return;
      dirSyncWarned = true;
      logger?.warn?.(`memory-ops.import.ledger: directory fsync not supported here (${err?.code || "error"}); continuing without it`);
    }
  }

  function ensureRoot() {
    const root = importsRoot(baseDbPath);
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }

  function pathFor(agentId) {
    ensureRoot();
    return importLedgerPath(baseDbPath, agentId);
  }

  /**
   * Every parseable line in file order (raw, not last-line-wins). Used by
   * `memory.unimport` (1.13.0) to select the lines of one import run.
   * @param {string} agentId
   * @returns {object[]}
   */
  function readLines(agentId) {
    let path;
    try {
      path = importLedgerPath(baseDbPath, agentId);
    } catch {
      return [];
    }
    if (!existsSync(path)) return [];
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      logger?.warn?.(`memory-ops.import.ledger: read failed for agent '${safeAgentId(agentId)}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "import ledger unreadable");
    }
    const rows = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = parseLine(line);
        if (row) rows.push(row);
      } catch {
        // A torn or foreign line does not hide the rest (same anti-oracle as proposals).
      }
    }
    return rows;
  }

  /**
   * Last line wins per key and per card id. A 1.13.0 `kind: "unimported"`
   * line frees its key: it removes the key and card id from the index and
   * records the card id in `unimportedByCardId`; a later import line for the
   * same card re-adds it. (An engine before 1.13.0 reads the unimported line
   * as an ordinary line and keeps the key blocked — the safe direction.)
   * @param {string} agentId
   * @returns {{byKey: Map<string, object>, byCardId: Map<string, object>, unimportedByCardId: Map<string, object>}}
   */
  function load(agentId) {
    const byKey = new Map();
    const byCardId = new Map();
    const unimportedByCardId = new Map();
    for (const row of readLines(agentId)) {
      if (row.kind === "unimported") {
        if (byKey.get(row.idempotencyKey)?.cardId === row.cardId) byKey.delete(row.idempotencyKey);
        byCardId.delete(row.cardId);
        unimportedByCardId.set(row.cardId, row);
        continue;
      }
      if (row.kind != null) continue; // unknown future kind: ignore
      byKey.set(row.idempotencyKey, row);
      byCardId.set(row.cardId, row);
      unimportedByCardId.delete(row.cardId);
    }
    return { byKey, byCardId, unimportedByCardId };
  }

  function lineFor(row) {
    if (row.kind === "unimported") {
      return {
        v: IMPORT_LEDGER_VERSION,
        kind: "unimported",
        idempotencyKey: row.idempotencyKey,
        cardId: row.cardId,
        importRunId: row.importRunId,
        at: row.at,
      };
    }
    const out = {
      v: IMPORT_LEDGER_VERSION,
      idempotencyKey: row.idempotencyKey,
      cardId: row.cardId,
      importedAt: row.importedAt,
      sourceRef: typeof row.sourceRef === "string" ? row.sourceRef : "",
    };
    // 1.13.0 optional fields; parseLine of 1.11/1.12 checks only v/key/cardId.
    if (typeof row.importRunId === "string" && row.importRunId) out.importRunId = row.importRunId;
    if (row.backfilled === true) out.backfilled = true;
    if (row.digest && typeof row.digest === "object") out.digest = row.digest;
    return out;
  }

  function append(agentId, row) {
    const path = pathFor(agentId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const created = !existsSync(path);
    const line = `${JSON.stringify(lineFor(row))}\n`;
    let fd;
    try {
      fd = openSync(path, "a+", 0o600);
      const { size } = fstatSync(fd);
      if (size > 0) {
        // Torn last line (crash mid-append): terminate it so the new line stays parseable;
        // `load` skips the torn fragment.
        const lastByte = Buffer.alloc(1);
        readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) appendFileSync(fd, "\n");
      }
      appendFileSync(fd, line);
      // K1: the line must survive a power loss before the caller reports `created`.
      syncFile(fd);
      if (created) {
        // New file: make its entry durable in `_imports/`, and `_imports/` in baseDbPath
        // (the root may have been created by the import lock, not by ensureRoot).
        syncDirBestEffort(dirname(path));
        syncDirBestEffort(dirname(dirname(path)));
      }
    } catch (err) {
      logger?.warn?.(`memory-ops.import.ledger: append failed for agent '${safeAgentId(agentId)}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "import ledger write failed");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  return { load, readLines, append, pathFor };
}
