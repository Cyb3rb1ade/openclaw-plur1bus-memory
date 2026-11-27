/**
 * engine/memory-ops/unimport-ledger.js — write-ahead audit sidecar for
 * `memory.unimport` (contract 1.13.0).
 *
 * One file per (agent, import run): `{baseDbPath}/_unimports/<agentId>/<importRunId>.jsonl`
 * (dirs 0700, file 0600). Lines carry ids, keys and reason codes only — no
 * card text, no sourceRef:
 *   {v:1, kind:"header", agentId, importRunId, createdAt}
 *   {v:1, kind:"intent", cardId, idempotencyKey, importedAt, archived:true}   before the store write
 *   {v:1, kind:"done",   cardId, importedAt}                                  after the key is freed
 *
 * The intent line is what tells "we soft-deleted this row" apart from "the
 * user forgot it" after a crash. Every append is fsynced (file; directory on
 * create) and is preceded by the caller's lock fence. A torn last line is
 * truncated to the last newline before the next write; a non-empty file with
 * no newline is quarantined as `.corrupt-<ts>` (never truncated to empty) and
 * the call fails with `ledger-corrupt`.
 */

import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside, safeAgentId } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";
import { fsyncParentDirectory, quarantineLedgerPath, repairTornLastLine } from "./rebind-ledger.js";

export const UNIMPORT_LEDGER_VERSION = 1;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {string} baseDbPath
 * @returns {string}
 */
export function unimportsRoot(baseDbPath) {
  return join(baseDbPath, "_unimports");
}

/**
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {string} importRunId
 * @returns {string}
 */
export function unimportLedgerPath(baseDbPath, agentId, importRunId) {
  if (typeof importRunId !== "string" || !RUN_ID_RE.test(importRunId)) {
    throw memoryOpError("invalid-input", "importRunId is invalid");
  }
  return resolveInside(baseDbPath, "_unimports", safeAgentId(agentId), `${importRunId}.jsonl`);
}

function parseLine(line) {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== UNIMPORT_LEDGER_VERSION || typeof parsed.kind !== "string") return null;
  return parsed;
}

const markerKey = (cardId, importedAt) => `${cardId}\u0000${Number(importedAt) || 0}`;

/**
 * @param {{baseDbPath: string, logger?: object, clock?: () => number, fsyncParent?: (dir: string) => void}} deps
 */
export function createUnimportLedger({
  baseDbPath, logger, clock = Date.now, fsyncParent = fsyncParentDirectory,
} = {}) {
  function quarantine(path) {
    try {
      renameSync(path, quarantineLedgerPath(path, clock()));
    } catch (err) {
      logger?.warn?.(`memory-ops.unimport.ledger: quarantine failed: ${err?.code || "error"}`);
    }
  }

  /**
   * Read-only. `intents` / `done` are keyed by (cardId, importedAt) so a card
   * re-imported under the same run id is not mistaken for the undone one.
   * @returns {{exists: boolean, header: object|null, intents: Set<string>, done: Set<string>}}
   */
  function load(agentId, importRunId) {
    const path = unimportLedgerPath(baseDbPath, agentId, importRunId);
    const out = { exists: false, header: null, intents: new Set(), done: new Set() };
    if (!existsSync(path)) return out;
    out.exists = true;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      logger?.warn?.(`memory-ops.unimport.ledger: read failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "unimport ledger unreadable");
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = parseLine(line);
        if (!row) continue;
        if (row.kind === "header") out.header = row;
        else if (row.kind === "intent" && typeof row.cardId === "string") out.intents.add(markerKey(row.cardId, row.importedAt));
        else if (row.kind === "done" && typeof row.cardId === "string") out.done.add(markerKey(row.cardId, row.importedAt));
      } catch {
        // A torn or foreign line does not hide the rest.
      }
    }
    return out;
  }

  /**
   * Repairs a torn tail before any store write of an apply (or quarantines a
   * file with no complete line → `ledger-corrupt`). Writes nothing when the
   * file is absent or already ends in a newline.
   */
  function prepare(agentId, importRunId) {
    const path = unimportLedgerPath(baseDbPath, agentId, importRunId);
    if (!existsSync(path)) return;
    let fd;
    try {
      fd = openSync(path, "r+");
      repairTornLastLine(fd);
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
        fd = undefined;
      }
      if (err?.code === "LEDGER_CORRUPT") {
        quarantine(path);
        throw memoryOpError("ledger-corrupt", "unimport ledger is corrupt");
      }
      logger?.warn?.(`memory-ops.unimport.ledger: repair failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "unimport ledger unwritable");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  function appendLine(agentId, importRunId, row, fence) {
    fence?.();
    const path = unimportLedgerPath(baseDbPath, agentId, importRunId);
    const parent = dirname(path);
    const root = unimportsRoot(baseDbPath);
    const rootCreated = !existsSync(root);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const created = !existsSync(path);
    let fd;
    try {
      // r+/wx, not a+: the torn-line repair needs ftruncate (refused on O_APPEND on Windows).
      fd = openSync(path, created ? "wx" : "r+", 0o600);
      try {
        repairTornLastLine(fd);
      } catch (err) {
        if (err?.code === "LEDGER_CORRUPT") {
          try { closeSync(fd); } catch { /* already closed */ }
          fd = undefined;
          quarantine(path);
          throw memoryOpError("ledger-corrupt", "unimport ledger is corrupt");
        }
        throw err;
      }
      const { size } = fstatSync(fd);
      writeSync(fd, `${JSON.stringify({ v: UNIMPORT_LEDGER_VERSION, ...row })}\n`, size);
      fsyncSync(fd);
    } catch (err) {
      if (err?.name === "MemoryOpError") throw err;
      logger?.warn?.(`memory-ops.unimport.ledger: append failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "unimport ledger write failed");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
    if (created) {
      fsyncParent(parent);
      fsyncParent(dirname(parent));
      if (rootCreated) fsyncParent(baseDbPath);
    }
  }

  function ensureHeader(agentId, importRunId, fence) {
    const state = load(agentId, importRunId);
    if (state.header) return;
    appendLine(agentId, importRunId, {
      kind: "header", agentId: safeAgentId(agentId), importRunId, createdAt: clock(),
    }, fence);
  }

  function appendIntent(agentId, importRunId, { cardId, idempotencyKey, importedAt }, fence) {
    appendLine(agentId, importRunId, {
      kind: "intent", cardId, idempotencyKey, importedAt: Number(importedAt) || 0, archived: true,
    }, fence);
  }

  function appendDone(agentId, importRunId, { cardId, importedAt }, fence) {
    appendLine(agentId, importRunId, { kind: "done", cardId, importedAt: Number(importedAt) || 0 }, fence);
  }

  return { load, prepare, ensureHeader, appendIntent, appendDone, markerKey };
}
