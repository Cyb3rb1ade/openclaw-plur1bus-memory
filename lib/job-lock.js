/**
 * lib/job-lock.js — prozessübergreifender Try-once-Lock für Cron-Jobs und
 * kurze Read-modify-write-Abschnitte (Config-Lock, Post-Turn-Drain).
 *
 * Seit N1 nur noch eine dünne Hülle um `tryAcquireOwnedLock`
 * (lib/registry-lock.js), d. h. dasselbe Eigentumsprotokoll wie der
 * Registry-Lock:
 *  - der Lock trägt eine Nonce (+ pid, host, acquiredAt);
 *  - `releaseJobLock` löscht nur einen Lock, der noch unsere Nonce trägt
 *    (Rename-aside → prüfen → löschen oder zurücklegen). Früher wurde
 *    unbedingt gelöscht: ein nach `staleMs` übernommener Lock eines anderen
 *    Halters ging bei unserer verspäteten Freigabe verloren;
 *  - veraltet ist ein Lock erst bei age > staleMs UND (Halter tot ODER
 *    age > 10 × staleMs). Früher reichte das mtime-Alter allein — ein
 *    lebender, nur langsamer Job (Konsolidierung > 30 min) verlor seinen Lock
 *    und ein zweiter Lauf startete parallel.
 *
 * Die API bleibt: `acquireJobLock` gibt den Pfad zurück oder wirft
 * „lock held“; `releaseJobLock(pfad)` ist best-effort und wirft nie.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireOwnedLock } from "./registry-lock.js";

const DEFAULT_STALE_MS = 10 * 60 * 1000; // 10 Minuten

// Pfad → Handle der in DIESEM Prozess gehaltenen Locks. Ein zweiter Erwerb
// desselben Pfads im selben Prozess scheitert ohnehin (eigene pid lebt).
const held = new Map();

/**
 * @param {string} lockPath
 * @param {{staleMs?: number}} [opts]
 * @returns {string} `lockPath` (an `releaseJobLock` zurückgeben).
 * @throws {Error} „lock held: …“, wenn ein lebender bzw. nicht veralteter Halter existiert.
 */
export function acquireJobLock(lockPath, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const handle = tryAcquireOwnedLock(lockPath, { staleMs });
  if (!handle) {
    let age = NaN;
    try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { /* inzwischen weg */ }
    throw new Error(`lock held: ${lockPath} (age=${age}ms)`);
  }
  held.set(lockPath, handle);
  return lockPath;
}

/** Gibt einen von `acquireJobLock` erworbenen Lock frei — nur, wenn er noch uns gehört. */
export function releaseJobLock(lockPath) {
  if (!lockPath) return;
  const handle = held.get(lockPath);
  if (!handle) return; // nie (oder schon) freigegeben: einen fremden Lock nie anfassen
  held.delete(lockPath);
  handle.release();
}
