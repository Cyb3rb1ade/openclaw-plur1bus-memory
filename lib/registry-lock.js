/**
 * lib/registry-lock.js — synchroner, prozessübergreifender Lock für die
 * append-only Tombstone-Registry.
 *
 * Bewusst SYNCHRON: die Registry-Pfade (`readTombstoneRegistry`,
 * `appendTombstoneToRegistry`, `findBlockingTombstoneForCapture`) sind synchron
 * und werden aus synchronem Kontext auf dem Capture-Pfad aufgerufen.
 *
 * Wechselseitiger Ausschluss über `open(..., "wx")` — atomar auch über
 * Prozessgrenzen. Ein Lock, dessen mtime älter als `staleMs` ist, gilt als
 * verwaist (Prozess gestorben, bevor er freigeben konnte) und wird übernommen.
 */

import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 25;

// Windows: ein noch delete-pending Lock (anderes Handle offen, Defender) lässt
// CreateFile mit ERROR_ACCESS_DENIED scheitern → EPERM/EACCES/EBUSY statt EEXIST.
const WIN32_TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Synchrones Schlafen ohne Busy-Loop. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Entfernt einen Lock, dessen mtime älter als staleMs ist. */
function reapIfStale(lockPath, staleMs) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > staleMs) rmSync(lockPath, { force: true });
  } catch {
    // Weg, nicht lesbar oder (Windows) Sharing-Fehler beim Löschen — der nächste Erwerbsversuch klärt es.
  }
}

/**
 * Führt `fn` unter exklusivem Lock aus. Der Lock wird immer freigegeben, auch
 * wenn `fn` wirft.
 *
 * @param {string} lockPath Pfad der Lockdatei.
 * @param {Function} fn Synchroner Block.
 * @param {object} [opts] `{ staleMs, timeoutMs, retryMs, platform, openSync }`;
 *   `platform` (Default `process.platform`) und `openSync` (Default `fs.openSync`)
 *   sind Test-Nähte.
 * @returns {*} Rückgabewert von `fn`.
 * @throws {Error} Wenn der Lock innerhalb von `timeoutMs` nicht erworben wird.
 */
export function withRegistryLock(lockPath, fn, opts = {}) {
  const staleMs = Number(opts.staleMs ?? DEFAULT_STALE_MS);
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryMs = Math.max(1, Number(opts.retryMs ?? DEFAULT_RETRY_MS));

  const platform = opts.platform ?? process.platform;
  const open = opts.openSync ?? openSync;

  const deadline = Date.now() + timeoutMs;
  let fd = null;
  for (;;) {
    try {
      fd = open(lockPath, "wx");
      break;
    } catch (err) {
      const code = err?.code;
      const transientWin = platform === "win32" && WIN32_TRANSIENT_CODES.has(code);
      if (code !== "EEXIST" && !transientWin) throw err;
      // Bei Windows-Transientfehlern nicht reapen: die Datei kann mitten im Löschen sein.
      if (code === "EEXIST") reapIfStale(lockPath, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`registry lock busy: ${lockPath} (timeout after ${timeoutMs}ms)`);
      }
      sleepSync(retryMs);
    }
  }

  try {
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    } catch {
      // Diagnose-Inhalt ist optional — der Lock hält auch ohne ihn.
    }
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* egal */ }
    rmSync(lockPath, { force: true });
  }
}
