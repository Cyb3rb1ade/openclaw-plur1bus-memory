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

/**
 * Hard-Ceiling-Faktor für Job-Locks: ein Lock, dessen Halter nicht per pid
 * beurteilt werden kann (Hostname geändert: Container neu erzeugt, macOS-
 * Netzwerkwechsel), wird nach `staleMs × 4` statt 10× übernommen. Die staleMs
 * der Aufrufer sind bereits die erwartete Maximallaufzeit (vorher die alleinige
 * Reap-Schwelle), 4× lässt also einem lebenden, nur langsamen Halter reichlich
 * Luft, begrenzt die Blockade aber auf z. B. 2 h (Konsolidierung), 3 h
 * (Skill-Miner), 6 h (REM), 10 min (Reminder), 2 min (Config), 1 h (Drain).
 */
export const JOB_LOCK_HARD_CEILING_FACTOR = 4;

// Pfad → Handle der in DIESEM Prozess gehaltenen Locks. Ein zweiter Erwerb
// desselben Pfads im selben Prozess scheitert ohnehin (eigene pid lebt).
const held = new Map();

/**
 * @param {string} lockPath
 * @param {{staleMs?: number, hardCeilingMs?: number}} [opts] `hardCeilingMs` default: `staleMs × 10` (registry-lock)
 * @returns {string} `lockPath` (an `releaseJobLock` zurückgeben).
 * @throws {Error} „lock held: …“, wenn ein lebender bzw. nicht veralteter Halter existiert.
 */
export function acquireJobLock(lockPath, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Ein Lock, den dieser Prozess noch hält, wird nie vom selben Prozess übernommen
  // (auch nicht jenseits des Hard-Ceilings): sonst gäbe die späte Freigabe des
  // ersten Halters den Lock des zweiten frei.
  if (held.has(lockPath)) throw new Error(`lock held: ${lockPath} (held by this process)`);
  const handle = tryAcquireOwnedLock(lockPath, { staleMs, hardCeilingMs: opts.hardCeilingMs });
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
