/**
 * engine/memory-ops/rebind-ledger.js — sidecar JSONL for `memory.rebind`
 * (contract 1.12.0). One file per apply at `{baseDbPath}/_rebinds/<rebindId>.jsonl`.
 *
 * The sidecar is the source of truth for resume and unbind. Identity keys
 * appear only as hashed principals. Append is fsynced; a torn last line is
 * truncated to the last complete newline before the next write. A file with
 * no newline is quarantined, never truncated to empty.
 *
 * N:1 is engine-wide: `_rebinds/by-identity/<sha256(fromOwner)>.json` plus
 * applied sidecar headers. Writers take `_rebinds/.lock` (O_EXCL).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync,
  mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside, safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

export const REBIND_LEDGER_VERSION = 1;
export const REBIND_LOCK_STALE_MS = 60_000;
export const REBIND_LOCK_WAIT_MS = 20_000;

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

/**
 * @param {string} fromOwner
 * @returns {string}
 */
export function identityClaimFileName(fromOwner) {
  return `${createHash("sha256").update(String(fromOwner)).digest("hex")}.json`;
}

/**
 * fsync a directory so a newly created name survives a crash. No-op on
 * Windows, where directory descriptors cannot be synced.
 * @param {string} dir
 */
export function fsyncParentDirectory(dir) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse directory fsync; the file fsync still ran.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function parseLine(line) {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== REBIND_LEDGER_VERSION) return null;
  if (typeof parsed.kind !== "string") return null;
  return parsed;
}

function ledgerCorrupt() {
  const err = new Error("rebind ledger has no complete line");
  err.code = "LEDGER_CORRUPT";
  return err;
}

/**
 * Drop a torn last line (no terminating newline) by truncating to the last
 * complete newline, scanning backwards in 64 KiB chunks. A file that already
 * ends in newline is left alone. A non-empty file with no newline is not
 * truncated to 0: the caller quarantines it.
 * @param {number} fd
 */
export function repairTornLastLine(fd) {
  const { size } = fstatSync(fd);
  if (size <= 0) return;
  const lastByte = Buffer.alloc(1);
  readSync(fd, lastByte, 0, 1, size - 1);
  if (lastByte[0] === 0x0a) return;
  const chunkSize = 64 * 1024;
  let pos = size;
  let nl = -1;
  while (pos > 0) {
    const start = Math.max(0, pos - chunkSize);
    const len = pos - start;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    for (let i = n - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) {
        nl = start + i;
        break;
      }
    }
    if (nl >= 0) break;
    pos = start;
  }
  if (nl < 0) throw ledgerCorrupt();
  ftruncateSync(fd, nl + 1);
}

/**
 * @param {string} path
 * @param {number} [ts]
 * @returns {string}
 */
export function quarantineLedgerPath(path, ts = Date.now()) {
  return `${path}.corrupt-${ts}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{baseDbPath: string, logger?: object, fsyncParent?: (dir: string) => void, clock?: () => number}} deps
 */
export function createRebindLedger({
  baseDbPath,
  logger,
  fsyncParent = fsyncParentDirectory,
  clock = Date.now,
} = {}) {
  let lockTail = Promise.resolve();

  function ensureRoot() {
    const root = rebindsRoot(baseDbPath);
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }

  function pathFor(rebindId) {
    ensureRoot();
    return rebindLedgerPath(baseDbPath, rebindId);
  }

  function identityClaimPath(fromOwner) {
    return resolveInside(baseDbPath, "_rebinds", "by-identity", identityClaimFileName(fromOwner));
  }

  function quarantine(path) {
    const dest = quarantineLedgerPath(path, clock());
    try {
      renameSync(path, dest);
    } catch (err) {
      logger?.warn?.(`memory-ops.rebind.ledger: quarantine failed: ${err?.code || "error"}`);
    }
  }

  function appendLine(path, row) {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const created = !existsSync(path);
    const line = `${JSON.stringify(row)}\n`;
    let fd;
    try {
      fd = openSync(path, "a+", 0o600);
      try {
        repairTornLastLine(fd);
      } catch (err) {
        if (err?.code === "LEDGER_CORRUPT") {
          try { closeSync(fd); } catch { /* already closed */ }
          fd = undefined;
          quarantine(path);
          throw memoryOpError("ledger-corrupt", "rebind ledger is corrupt");
        }
        throw err;
      }
      appendFileSync(fd, line);
      fsyncSync(fd);
    } catch (err) {
      if (err?.name === "MemoryOpError") throw err;
      logger?.warn?.(`memory-ops.rebind.ledger: append failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "rebind ledger write failed");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
    if (created) fsyncParent(parent);
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

  function readClaim(fromOwner) {
    let path;
    try {
      path = identityClaimPath(fromOwner);
    } catch {
      return null;
    }
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (!raw || typeof raw !== "object" || typeof raw.toOwner !== "string") return null;
      return raw;
    } catch (err) {
      logger?.warn?.(`memory-ops.rebind.ledger: claim read failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "rebind identity claim unreadable");
    }
  }

  function writeClaim(fromOwner, toOwner) {
    ensureRoot();
    const dir = join(rebindsRoot(baseDbPath), "by-identity");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = identityClaimPath(fromOwner);
    const existing = existsSync(path) ? readClaim(fromOwner) : null;
    if (existing && existing.toOwner === toOwner) return;
    if (existing && existing.toOwner !== toOwner) {
      // Sidecars are truth. A leftover claim with no applied sidecar is stale.
      try { unlinkSync(path); } catch { /* retry wx below */ }
    }
    const body = `${JSON.stringify({
      v: REBIND_LEDGER_VERSION,
      fromOwner,
      toOwner,
      createdAt: clock(),
    })}\n`;
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, body);
      fsyncSync(fd);
    } catch (err) {
      if (err?.code === "EEXIST") {
        const again = readClaim(fromOwner);
        if (again && again.toOwner !== toOwner) {
          throw memoryOpError("identity-already-bound", "identity already bound");
        }
        return;
      }
      logger?.warn?.(`memory-ops.rebind.ledger: claim write failed: ${err?.code || "error"}`);
      throw memoryOpError("storage", "rebind identity claim write failed");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
    fsyncParent(dirname(path));
  }

  function releaseClaimIfFree(fromOwner) {
    const still = listApplied().some((rec) => rec.header.fromOwner === fromOwner);
    if (still) return;
    try {
      const path = identityClaimPath(fromOwner);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      logger?.warn?.(`memory-ops.rebind.ledger: claim release failed: ${err?.code || "error"}`);
    }
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
    });
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
    });
  }

  function appendReversed(rebindId, reversedAt) {
    const path = pathFor(rebindId);
    appendLine(path, {
      v: REBIND_LEDGER_VERSION,
      kind: "reversed",
      rebindId,
      reversedAt,
    });
  }

  function acquireFileLockSync() {
    const root = ensureRoot();
    const lockPath = join(root, ".lock");
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: clock() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncParent(root);
    return lockPath;
  }

  async function acquireFileLock() {
    const root = ensureRoot();
    const lockPath = join(root, ".lock");
    const deadline = clock() + REBIND_LOCK_WAIT_MS;
    for (;;) {
      try {
        return acquireFileLockSync();
      } catch (err) {
        if (err?.code !== "EEXIST") {
          logger?.warn?.(`memory-ops.rebind.ledger: lock failed: ${err?.code || "error"}`);
          throw memoryOpError("storage", "rebind lock failed");
        }
        try {
          const age = clock() - statSync(lockPath).mtimeMs;
          if (age > REBIND_LOCK_STALE_MS) unlinkSync(lockPath);
        } catch {
          // Lost the race to another waiter, or the file vanished.
        }
        if (clock() > deadline) throw memoryOpError("storage", "rebind lock timeout");
        await sleep(15);
      }
    }
  }

  function releaseFileLock(lockPath) {
    try {
      if (lockPath && existsSync(lockPath)) unlinkSync(lockPath);
    } catch (err) {
      logger?.warn?.(`memory-ops.rebind.ledger: lock release failed: ${err?.code || "error"}`);
    }
  }

  /**
   * In-process mutex, plus a cross-process O_EXCL lock when `exclusive` is
   * true (apply / unbind writes). dryRun skips the file lock so `_rebinds/`
   * is not created.
   * @param {{exclusive: boolean}} opts
   * @param {() => Promise<unknown>} fn
   */
  function withLock({ exclusive }, fn) {
    const run = lockTail.then(async () => {
      let lockPath = null;
      try {
        if (exclusive) lockPath = await acquireFileLock();
        return await fn();
      } finally {
        if (lockPath) releaseFileLock(lockPath);
      }
    });
    lockTail = run.then(() => {}, () => {});
    return run;
  }

  return {
    load,
    listApplied,
    writeHeader,
    appendCard,
    appendReversed,
    pathFor,
    readClaim,
    writeClaim,
    releaseClaimIfFree,
    withLock,
  };
}
