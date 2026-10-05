/**
 * engine/memory-ops/rebind-ledger.js — sidecar JSONL for `memory.rebind`
 * (contract 1.12.0). One file per apply at `{baseDbPath}/_rebinds/<rebindId>.jsonl`.
 *
 * The sidecar is the source of truth for resume and unbind. Identity keys
 * appear only as hashed principals. Append is fsynced; a torn last line is
 * truncated to the last complete newline before the next write.
 */

import {
  appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync,
  mkdirSync, openSync, readdirSync, readFileSync, readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside, safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

export const REBIND_LEDGER_VERSION = 1;

/**
 * @param {string} baseDbPath
 * @returns {string}
 */
export function rebindsRoot(baseDbPath) {
  return join(baseDbPath, "_rebinds");
}

/**
 * @param {string} baseDbPath
 * @param {string} rebindId
 * @returns {string}
 */
export function rebindLedgerPath(baseDbPath, rebindId) {
  return resolveInside(baseDbPath, "_rebinds", `${safeUuid(rebindId)}.jsonl`);
}

function parseLine(line) {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== REBIND_LEDGER_VERSION) return null;
  if (typeof parsed.kind !== "string") return null;
  return parsed;
}

/**
 * Drop a torn last line (no terminating newline) by truncating to the last
 * complete newline. A file that already ends in newline is left alone.
 * @param {number} fd
 */
export function repairTornLastLine(fd) {
  const { size } = fstatSync(fd);
  if (size <= 0) return;
  const lastByte = Buffer.alloc(1);
  readSync(fd, lastByte, 0, 1, size - 1);
  if (lastByte[0] === 0x0a) return;
  const chunkSize = Math.min(size, 64 * 1024);
  const buf = Buffer.alloc(chunkSize);
  const start = size - chunkSize;
  const n = readSync(fd, buf, 0, chunkSize, start);
  let nl = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      nl = start + i;
      break;
    }
  }
  ftruncateSync(fd, nl >= 0 ? nl + 1 : 0);
}

function appendLine(path, row, logger) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(row)}\n`;
  let fd;
  try {
    fd = openSync(path, "a+", 0o600);
    repairTornLastLine(fd);
    appendFileSync(fd, line);
    fsyncSync(fd);
  } catch (err) {
    logger?.warn?.(`memory-ops.rebind.ledger: append failed: ${err?.code || "error"}`);
    throw memoryOpError("storage", "rebind ledger write failed");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * @param {{baseDbPath: string, logger?: object}} deps
 */
export function createRebindLedger({ baseDbPath, logger } = {}) {
  function ensureRoot() {
    const root = rebindsRoot(baseDbPath);
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }

  function pathFor(rebindId) {
    ensureRoot();
    return rebindLedgerPath(baseDbPath, rebindId);
  }

  /**
   * @param {string} rebindId
   * @returns {{header: object|null, cards: object[], reversed: boolean, path: string|null}}
   */
  function load(rebindId) {
    const cards = [];
    const seen = new Set();
    let header = null;
    let reversed = false;
    let path;
    try {
      path = rebindLedgerPath(baseDbPath, rebindId);
    } catch {
      return { header: null, cards, reversed: false, path: null };
    }
    if (!existsSync(path)) return { header: null, cards, reversed: false, path };
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      logger?.warn?.(`memory-ops.rebind.ledger: read failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "rebind ledger unreadable");
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = parseLine(line);
        if (!row) continue;
        if (row.kind === "header") {
          header = row;
          if (row.status === "reversed") reversed = true;
          else reversed = false;
        } else if (row.kind === "reversed") {
          reversed = true;
        } else if (row.kind === "card" && typeof row.cardId === "string") {
          if (seen.has(row.cardId)) continue;
          seen.add(row.cardId);
          cards.push(row);
        }
      } catch {
        // Torn or foreign line does not hide the rest.
      }
    }
    return { header, cards, reversed, path };
  }

  /**
   * @returns {Array<{header: object, cards: object[], reversed: boolean, rebindId: string}>}
   */
  function listApplied() {
    const root = rebindsRoot(baseDbPath);
    if (!existsSync(root)) return [];
    let names;
    try {
      names = readdirSync(root);
    } catch (err) {
      logger?.warn?.(`memory-ops.rebind.ledger: list failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "rebind ledger unreadable");
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      try { safeUuid(id); } catch { continue; }
      const rec = load(id);
      if (!rec.header || rec.reversed) continue;
      out.push({ ...rec, rebindId: rec.header.rebindId || id });
    }
    return out;
  }

  function writeHeader(rebindId, header) {
    const path = pathFor(rebindId);
    if (existsSync(path)) {
      throw memoryOpError("conflict", "rebind ledger already exists");
    }
    appendLine(path, {
      v: REBIND_LEDGER_VERSION,
      kind: "header",
      rebindId,
      agentId: header.agentId,
      fromOwner: header.fromOwner,
      toOwner: header.toOwner,
      status: "applied",
      createdAt: header.createdAt,
    }, logger);
  }

  function appendCard(rebindId, row) {
    const path = pathFor(rebindId);
    appendLine(path, {
      v: REBIND_LEDGER_VERSION,
      kind: "card",
      rebindId,
      cardId: row.cardId,
      fromOwner: row.fromOwner,
      toOwner: row.toOwner,
      fromUpdatedAt: row.fromUpdatedAt ?? 0,
    }, logger);
  }

  function appendReversed(rebindId, reversedAt) {
    const path = pathFor(rebindId);
    appendLine(path, {
      v: REBIND_LEDGER_VERSION,
      kind: "reversed",
      rebindId,
      reversedAt,
    }, logger);
  }

  return { load, listApplied, writeHeader, appendCard, appendReversed, pathFor };
}
