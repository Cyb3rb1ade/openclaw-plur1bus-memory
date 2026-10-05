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
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync,
  readFileSync, readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside, safeAgentId } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

export const IMPORT_LEDGER_VERSION = 1;

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
 * @param {{baseDbPath: string, logger?: object}} deps
 */
export function createImportLedger({ baseDbPath, logger } = {}) {
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
   * Last line wins per key and per card id.
   * @param {string} agentId
   * @returns {{byKey: Map<string, object>, byCardId: Map<string, object>}}
   */
  function load(agentId) {
    const byKey = new Map();
    const byCardId = new Map();
    let path;
    try {
      path = importLedgerPath(baseDbPath, agentId);
    } catch {
      return { byKey, byCardId };
    }
    if (!existsSync(path)) return { byKey, byCardId };
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      logger?.warn?.(`memory-ops.import.ledger: read failed for agent '${safeAgentId(agentId)}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "import ledger unreadable");
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = parseLine(line);
        if (!row) continue;
        byKey.set(row.idempotencyKey, row);
        byCardId.set(row.cardId, row);
      } catch {
        // A torn or foreign line does not hide the rest (same anti-oracle as proposals).
      }
    }
    return { byKey, byCardId };
  }

  function append(agentId, row) {
    const path = pathFor(agentId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({
      v: IMPORT_LEDGER_VERSION,
      idempotencyKey: row.idempotencyKey,
      cardId: row.cardId,
      importedAt: row.importedAt,
      sourceRef: typeof row.sourceRef === "string" ? row.sourceRef : "",
    })}\n`;
    let fd;
    try {
      fd = openSync(path, "a+", 0o600);
      const { size } = fstatSync(fd);
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) appendFileSync(fd, "\n");
      }
      appendFileSync(fd, line);
    } catch (err) {
      logger?.warn?.(`memory-ops.import.ledger: append failed for agent '${safeAgentId(agentId)}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "import ledger write failed");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  return { load, append, pathFor };
}
