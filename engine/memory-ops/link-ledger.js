/**
 * engine/memory-ops/link-ledger.js — sidecar JSONL for `memory.link`
 * (contract 1.16.0). One file per agent at `{baseDbPath}/_links/<agentId>.jsonl`.
 *
 * A link attaches an additional source (`sourceRef`, provenance) to an
 * existing card without touching the card's row: text, vector, digest and
 * `updatedAt` stay as they are, so `memory.unimport`'s modification checks are
 * not disturbed. The ledger is append-only:
 *   {v:1, kind:"linked",   linkId, cardId, sourceRef, provenance, importRunId?, idempotencyKey?, at}
 *   {v:1, kind:"unlinked", linkId, cardId, importRunId, at}
 * Last line per `linkId` wins. `linkId` is deterministic over
 * (agentId, cardId, sourceRef), which makes a repeated link a no-op.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside, safeAgentId } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";
import { fsyncDirectory } from "./import-ledger.js";

export const LINK_LEDGER_VERSION = 1;

/**
 * Deterministic link id: the same (agent, card, sourceRef) always maps to the same id.
 * @param {string} agentId
 * @param {string} cardId
 * @param {string} sourceRef
 * @returns {string} 32 lowercase hex characters
 */
export function linkIdFor(agentId, cardId, sourceRef) {
  return createHash("sha256")
    .update(`plur1bus.memory.link.v1\0${agentId}\0${cardId}\0${sourceRef}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {string}
 */
export function linkLedgerPath(baseDbPath, agentId) {
  return resolveInside(baseDbPath, "_links", `${safeAgentId(agentId)}.jsonl`);
}

function parseLine(line) {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== LINK_LEDGER_VERSION) return null;
  if (parsed.kind !== "linked" && parsed.kind !== "unlinked") return null;
  if (typeof parsed.linkId !== "string" || typeof parsed.cardId !== "string") return null;
  if (parsed.kind === "linked" && typeof parsed.sourceRef !== "string") return null;
  return parsed;
}

/**
 * @param {{baseDbPath: string, logger?: object, syncFile?: Function, syncDir?: Function}} deps
 *   `syncFile(fd)` / `syncDir(path)` are test seams (default `fsyncSync` / `fsyncDirectory`).
 * @returns {{readLines: Function, load: Function, append: Function}}
 */
export function createLinkLedger({ baseDbPath, logger, syncFile = fsyncSync, syncDir = fsyncDirectory } = {}) {
  let dirSyncWarned = false;

  function syncDirBestEffort(dir) {
    try {
      syncDir(dir);
    } catch (err) {
      if (dirSyncWarned) return;
      dirSyncWarned = true;
      logger?.warn?.(`memory-ops.link.ledger: directory fsync not supported here (${err?.code || "error"}); continuing without it`);
    }
  }

  /**
   * Every parseable line in file order. A torn or foreign line is skipped.
   * @param {string} agentId
   * @returns {object[]}
   */
  function readLines(agentId) {
    let path;
    try {
      path = linkLedgerPath(baseDbPath, agentId);
    } catch {
      return [];
    }
    if (!existsSync(path)) return [];
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      logger?.warn?.(`memory-ops.link.ledger: read failed for agent '${safeAgentId(agentId)}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "link ledger unreadable");
    }
    const rows = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = parseLine(line);
        if (row) rows.push(row);
      } catch {
        // torn tail or foreign line: skip, never hide the rest
      }
    }
    return rows;
  }

  /**
   * Last line per linkId wins.
   * @param {string} agentId
   * @returns {{active: Map<string, object>, byCardId: Map<string, object[]>, unlinked: Map<string, object>}}
   */
  function load(agentId) {
    const latest = new Map();
    for (const row of readLines(agentId)) {
      latest.delete(row.linkId);
      latest.set(row.linkId, row);
    }
    const active = new Map();
    const byCardId = new Map();
    const unlinked = new Map();
    for (const [linkId, row] of latest) {
      if (row.kind === "unlinked") {
        unlinked.set(linkId, row);
        continue;
      }
      active.set(linkId, row);
      const list = byCardId.get(row.cardId) ?? [];
      list.push(row);
      byCardId.set(row.cardId, list);
    }
    return { active, byCardId, unlinked };
  }

  function lineFor(row) {
    if (row.kind === "unlinked") {
      return {
        v: LINK_LEDGER_VERSION,
        kind: "unlinked",
        linkId: row.linkId,
        cardId: row.cardId,
        importRunId: row.importRunId,
        at: row.at,
      };
    }
    const out = {
      v: LINK_LEDGER_VERSION,
      kind: "linked",
      linkId: row.linkId,
      cardId: row.cardId,
      sourceRef: row.sourceRef,
      provenance: row.provenance,
      at: row.at,
    };
    if (typeof row.importRunId === "string" && row.importRunId) out.importRunId = row.importRunId;
    if (typeof row.idempotencyKey === "string" && row.idempotencyKey) out.idempotencyKey = row.idempotencyKey;
    return out;
  }

  /**
   * Appends one line and fsyncs it (and, for a new file, its directories).
   * @param {string} agentId
   * @param {object} row
   */
  function append(agentId, row) {
    const line = `${JSON.stringify(lineFor(row))}\n`;
    let fd;
    try {
      // resolveInside needs the root to exist; create `_links/` before resolving the file.
      const root = join(baseDbPath, "_links");
      if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
      const path = linkLedgerPath(baseDbPath, agentId);
      const created = !existsSync(path);
      fd = openSync(path, "a+", 0o600);
      const { size } = fstatSync(fd);
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) appendFileSync(fd, "\n");
      }
      appendFileSync(fd, line);
      syncFile(fd);
      if (created) {
        syncDirBestEffort(dirname(path));
        syncDirBestEffort(dirname(dirname(path)));
      }
    } catch (err) {
      logger?.warn?.(`memory-ops.link.ledger: append failed for agent '${String(agentId).slice(0, 128)}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "link ledger write failed");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  return { readLines, load, append };
}
