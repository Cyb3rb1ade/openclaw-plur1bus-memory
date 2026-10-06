/**
 * lib/registry-lock.js — synchroner, prozessübergreifender Lock für die
 * append-only Tombstone-Registry.
 *
 * Bewusst SYNCHRON: die Registry-Pfade (`readTombstoneRegistry`,
 * `appendTombstoneToRegistry`, `findBlockingTombstoneForCapture`) sind synchron
 * und werden aus synchronem Kontext auf dem Capture-Pfad aufgerufen.
 *
 * Wechselseitiger Ausschluss über `open(..., "wx")` — atomar auch über
 * Prozessgrenzen. Der Lock-Inhalt trägt eine zufällige Nonce (+ pid, host,
 * acquiredAt); damit gilt:
 *  - Freigabe nur, wenn die Datei noch UNSERE Nonce enthält. Statt
 *    prüfen-dann-löschen (racy) wird der Lock erst unter einen eindeutigen
 *    `<lock>.rel-<nonce>`-Namen verschoben, dort gelesen und nur bei eigener
 *    Nonce gelöscht; sonst wird er zurückgelegt (ohne einen neuen Lock zu
 *    überschreiben).
 *  - Veraltet ist ein Lock nur, wenn age > staleMs UND (Halter-Prozess tot ODER
 *    age > Hard-Ceiling = 10 × staleMs). Ein lebender Halter mit langsamem `fn`
 *    (fs-Stall, Laptop-Schlaf) verliert den Lock also nicht nach 10 s.
 *    Unlesbarer/kaputter Inhalt mit age > staleMs zählt weiter als veraltet
 *    (Crash-Recovery wie bisher).
 *  - Ein veralteter Lock wird per Rename unter `<lock>.break-*` beiseitegelegt,
 *    als dieselbe Datei re-verifiziert (dev/ino + Inhalt) und erst dann
 *    gelöscht; hat er sich geändert, wird er zurückgelegt.
 *  - Optional `hardCeilingMs` (pro Aufruf) ersetzt das 10 × staleMs-Ceiling,
 *    z. B. für Job-Locks, bei denen Stunden Blockade nach einem Hostnamen-
 *    wechsel (Container neu erzeugt) schaden. Default unverändert.
 *  - Bleibt die Freigabe unter Windows über 250 ms busy (EPERM/EACCES/EBUSY),
 *    versucht ein begrenzter, unref'd Timer-Retry sie weiter (siehe
 *    `scheduleDeferredRelease`); entfernt wird nur ein Lock mit unserer Nonce.
 *  - Bewusst KEINE „gleiche machine-id"-Regel: /etc/machine-id fehlt auf macOS
 *    und im Container, und über Container-Grenzen hinweg sind pids aus
 *    unterschiedlichen pid-Namespaces ohnehin nicht vergleichbar.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync, fstatSync, linkSync, openSync, readdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 25;
// Hard-Ceiling: selbst ein lebender Halter verliert den Lock nach 10 × staleMs.
const HARD_CEILING_FACTOR = 10;
// Wie lange die Freigabe auf einen laufenden Put-Back eines Wartenden wartet.
const RELEASE_SETTLE_MS = 250;
const SETTLE_POLL_MS = 5;
// Windows: bleibt die Freigabe busy, wird sie auf Timern wiederholt (Summe ≈ 3,1 s).
const DEFERRED_RELEASE_DELAYS_MS = [50, 100, 200, 400, 800, 1_500];

// Windows: ein noch delete-pending Lock (anderes Handle offen, Defender) lässt
// CreateFile mit ERROR_ACCESS_DENIED scheitern → EPERM/EACCES/EBUSY statt EEXIST.
const WIN32_TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Synchrones Schlafen ohne Busy-Loop. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Datei als Text lesen; null, wenn weg oder nicht lesbar. */
function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Identität (dev/ino/mtime) oder null, wenn weg. */
function statId(p) {
  try {
    const st = statSync(p);
    return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Geparster Lock-Inhalt oder null (leer, kaputt, kein Objekt). */
function parseLock(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function holds(text, nonce) {
  return text !== null && parseLock(text)?.nonce === nonce;
}

/** Lebt der Prozess? ESRCH = tot; EPERM (fremder User) und alles andere zählt als lebendig. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/**
 * Veraltet-Urteil: age > staleMs UND (Halter tot ODER age > Hard-Ceiling).
 * Kaputter Inhalt oder ungültige pid mit age > staleMs → veraltet. Ein Lock von
 * einem anderen Host kann nicht per pid beurteilt werden → nur das Ceiling.
 * Unsere eigene pid gilt als tot, wenn `procStart` eine frühere Inkarnation zeigt.
 */
function ceilingOf(staleMs, hardCeilingMs) {
  const c = Number(hardCeilingMs);
  return Number.isFinite(c) && c > 0 ? c : staleMs * HARD_CEILING_FACTOR;
}

function judgedStale(text, mtimeMs, staleMs, ceilingMs = staleMs * HARD_CEILING_FACTOR) {
  const age = Date.now() - mtimeMs;
  if (age <= staleMs) return false;
  const info = parseLock(text);
  const pid = info?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (age > ceilingMs) return true;
  if (typeof info.host === "string" && info.host !== hostname()) return false;
  if (pid === process.pid) return isEarlierIncarnation(info.procStart);
  return !pidAlive(pid);
}

// Prozess-Inkarnation (N1-Fix-Runde, I1): eine Lock-Datei mit UNSERER pid und
// unserem Host stammt entweder von uns (lebt) oder von einem früheren Prozess
// mit derselben pid — der Normalfall eines Container-Gateways (PID 1) nach
// Crash oder `docker restart`. `pidAlive(process.pid)` ist immer true; ohne
// diese Unterscheidung bliebe so ein Lock bis zum Hard-Ceiling liegen.
//  - `mono`: Prozessstart auf der monotonen Uhr (hrtime − uptime) in ms; über
//    Worker-Threads und Modul-Instanzen desselben Prozesses gleich (±1 ms),
//    unabhängig von Wanduhr-Sprüngen, für eine neue Inkarnation verschieden.
//  - `boot`: Linux-boot_id (auch im Container lesbar), sonst null — trennt
//    gleiche `mono`-Werte über einen Reboot hinweg.
const INCARNATION_TOLERANCE_MS = 1_000;
let bootIdCache;

function bootId() {
  if (bootIdCache === undefined) {
    try {
      bootIdCache = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      bootIdCache = null;
    }
  }
  return bootIdCache;
}

/** Start-Identität dieses Prozesses, wie sie in Locks steht. */
export function processIncarnation() {
  const mono = Number(process.hrtime.bigint() / 1_000_000n) - process.uptime() * 1000;
  return { mono: Math.round(mono), boot: bootId() };
}

/**
 * true, wenn `procStart` (aus einem Lock mit unserer pid und unserem Host)
 * sicher von einem FRÜHEREN Prozess stammt. Fehlt die Angabe (Alt-Format)
 * oder ist sie unbrauchbar, gilt der Halter als lebend (bisheriges Verhalten).
 */
export function isEarlierIncarnation(procStart) {
  if (!procStart || typeof procStart !== "object" || !Number.isFinite(procStart.mono)) return false;
  const own = processIncarnation();
  if (typeof procStart.boot === "string" && own.boot !== null && procStart.boot !== own.boot) return true;
  return Math.abs(procStart.mono - own.mono) > INCARNATION_TOLERANCE_MS;
}

/** Löscht eine beiseitegelegte Datei; Fehler (z. B. Windows-Sharing) bleiben als Leftover für den Sweep. */
function unlinkMoved(p) {
  try {
    unlinkSync(p);
  } catch {
    // weg oder gesperrt — `sweepLeftovers` räumt nach staleMs auf
  }
}

/** Legt einen beiseitegelegten Lock zurück, ohne einen neueren Lock zu überschreiben. */
function putBack(moved, lock) {
  try {
    linkSync(moved, lock);
  } catch (err) {
    if (err?.code !== "EEXIST" && statId(lock) === null) {
      // Dateisystem ohne Hardlinks: Fallback auf Rename, aber nur wenn kein neuer Lock da ist.
      try { renameSync(moved, lock); return; } catch { /* Leftover — Sweep */ }
    }
    // EEXIST: ein neuer Halter existiert, der beiseitegelegte wird nicht mehr gebraucht.
  }
  unlinkMoved(moved);
}

/** Räumt liegengebliebene `.rel-*`/`.break-*`-Dateien (älter als staleMs) neben dem Lock weg. */
function sweepLeftovers(lock, staleMs, ceilingMs) {
  const dir = dirname(lock);
  const prefix = `${basename(lock)}.`;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(prefix) || !/^(rel|break)-/.test(n.slice(prefix.length))) continue;
    const p = join(dir, n);
    const st = statId(p);
    // Ein umbenannter Lock behält die mtime des Originals (= Erwerbszeit): nur nach denselben
    // Regeln wie ein echter Lock als veraltet werten, sonst verliert ein lebender Halter ihn im Put-Back-Fenster.
    if (st && judgedStale(readText(p) ?? "", st.mtimeMs, staleMs, ceilingMs)) unlinkMoved(p);
  }
}

/**
 * Gibt den Lock frei, wenn `isOurs(text, movedPath)` ihn als unseren erkennt.
 * Rename → lesen → bei Treffer löschen, sonst zurücklegen. Wirft nie (läuft im
 * finally und darf eine Exception aus `fn` nicht überdecken).
 */
function releaseLock(lock, tag, isOurs, platform, rename = renameSync, settleMs = RELEASE_SETTLE_MS) {
  const moved = `${lock}.rel-${tag}`;
  const deadline = Date.now() + settleMs;
  for (;;) {
    try {
      rename(lock, moved);
      break;
    } catch (err) {
      const code = err?.code;
      if (code === "ENOENT") {
        // Weg: entweder wurde unser Lock gebrochen (nichts zu tun) oder ein Wartender
        // hat ihn gerade beiseitegelegt und legt ihn zurück → darauf warten und erneut versuchen.
        if (!movedAsideOurs(lock, isOurs) || Date.now() >= deadline) return "done";
      } else if (!(platform === "win32" && WIN32_TRANSIENT_CODES.has(code))) {
        return "done"; // z. B. read-only Verzeichnis: die Stale-Regeln greifen später
      } else if (Date.now() >= deadline) {
        return "busy"; // Windows dauerhaft busy: Aufrufer plant einen verzögerten Retry
      }
      if (settleMs > 0) sleepSync(SETTLE_POLL_MS);
    }
  }
  try {
    const text = readText(moved);
    if (text !== null && isOurs(text, moved)) unlinkMoved(moved);
    else if (text !== null) putBack(moved, lock); // fremder Lock: niemals löschen
    else unlinkMoved(moved);
  } catch {
    // Leftover — Sweep
  }
  return "done";
}

/**
 * Windows: eine Freigabe, die über das Settle-Fenster hinaus busy bleibt, ließe
 * unseren Lock bis zum Prozessende liegen. Begrenzte Timer-Retries (unref'd, nie
 * mehr als `delays.length` Versuche) wiederholen sie; jeder Versuch geht durch
 * `releaseLock` und löscht daher nur einen Lock, der noch `isOurs` erfüllt —
 * ein fremder Lock wird zurückgelegt, ein verschwundener beendet die Schleife.
 */
function scheduleDeferredRelease(lock, tag, isOurs, platform, rename, delays = DEFERRED_RELEASE_DELAYS_MS) {
  let attempt = 0;
  const step = () => {
    if (attempt >= delays.length) return;
    const t = setTimeout(() => {
      let res = "done";
      try {
        res = releaseLock(lock, `${tag}-d${attempt}`, isOurs, platform, rename, 0);
      } catch {
        // wirft nie; Sicherheitsnetz
      }
      attempt += 1;
      if (res === "busy") step();
    }, delays[attempt]);
    t.unref?.();
  };
  step();
}

/** Freigabe + bei Windows-busy der verzögerte Retry. Wirft nie. */
function releaseWithRetry(lock, tag, isOurs, platform, rename = renameSync, delays) {
  if (releaseLock(lock, tag, isOurs, platform, rename) === "busy") {
    scheduleDeferredRelease(lock, tag, isOurs, platform, rename, delays);
  }
}

/** Liegt ein beiseitegelegter Lock, den `isOurs` als unseren erkennt (Put-Back eines Wartenden)? */
function movedAsideOurs(lock, isOurs) {
  const dir = dirname(lock);
  const base = basename(lock);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => {
    if (!n.startsWith(`${base}.break-`) && !n.startsWith(`${base}.rel-`)) return false;
    const p = join(dir, n);
    const text = readText(p);
    return text !== null && isOurs(text, p);
  });
}

/**
 * Bricht einen als veraltet beurteilten Lock: beiseitelegen, als dieselbe Datei
 * re-verifizieren, löschen. true nur, wenn genau der beurteilte Lock entfernt wurde.
 */
function breakStale(lock, judged, text) {
  const moved = `${lock}.break-${randomUUID()}`;
  try {
    renameSync(lock, moved);
  } catch {
    return false; // weg oder (Windows) busy — der nächste Versuch entscheidet
  }
  const st2 = statId(moved);
  if (!st2) return false;
  if (st2.dev === judged.dev && st2.ino === judged.ino && readText(moved) === text) {
    unlinkMoved(moved);
    return true;
  }
  putBack(moved, lock); // inzwischen ein frischer Lock eines anderen: zurücklegen
  return false;
}

/**
 * Entfernt einen veralteten Lock (siehe `judgedStale`). true, wenn genau dieser
 * Lock gebrochen wurde oder inzwischen verschwunden ist (ein sofortiger neuer
 * Erwerbsversuch lohnt).
 */
function reapIfStale(lock, staleMs, ceilingMs) {
  const judged = statId(lock);
  if (!judged) return true; // inzwischen freigegeben: sofort neu versuchen statt „belegt“ zu melden
  const text = readText(lock);
  if (text === null) return statId(lock) === null; // weg → neu versuchen; unlesbar (Windows-Sharing) → nächster Versuch
  const broken = judgedStale(text, judged.mtimeMs, staleMs, ceilingMs) && breakStale(lock, judged, text);
  sweepLeftovers(lock, staleMs, ceilingMs);
  return broken;
}

/**
 * Schreibt die Nonce in den gerade per "wx" angelegten Lock und schließt `fd`.
 * Scheitert das Schreiben, wird die eigene (nonce-lose) Datei über dev/ino
 * erkannt und entfernt, dann wird der Fehler geworfen.
 * @returns {string} die Nonce.
 */
function stampLock(fd, lockPath, platform, rename = renameSync, delays) {
  const nonce = randomUUID();
  try {
    writeSync(fd, JSON.stringify({
      nonce, pid: process.pid, host: hostname(), procStart: processIncarnation(),
      acquiredAt: new Date().toISOString(),
    }));
  } catch (err) {
    let ownId = null;
    try { const st = fstatSync(fd); ownId = { dev: st.dev, ino: st.ino }; } catch { /* egal */ }
    try { closeSync(fd); } catch { /* egal */ }
    releaseWithRetry(lockPath, `${nonce}-w`, (_text, moved) => {
      const st = statId(moved);
      return ownId !== null && st !== null && st.dev === ownId.dev && st.ino === ownId.ino;
    }, platform, rename, delays);
    throw err;
  }
  try { closeSync(fd); } catch { /* egal */ } // Windows: offenes Handle würde das Rename bei der Freigabe blockieren
  return nonce;
}

/**
 * Nicht blockierender Erwerb nach denselben Regeln wie `withRegistryLock`:
 * ein Versuch; ist der Lock belegt und nach `judgedStale` veraltet (oder
 * inzwischen verschwunden), wird genau einmal neu versucht; unter Windows
 * werden Delete-pending-Fehler (EPERM/EACCES/EBUSY) zweimal nach 25 ms
 * wiederholt. Für Aufrufer, die einen Lock über
 * `await` hinweg halten oder bei Belegung sofort aufgeben (Cron-Jobs,
 * Knowledge-Update, Governor-artige Try-once-Locks).
 *
 * @param {string} lockPath Pfad der Lockdatei (Verzeichnis muss existieren).
 * @param {object} [opts] `{ staleMs, hardCeilingMs, platform, openSync, renameSync, releaseRetryDelaysMs }`;
 *   `hardCeilingMs` ersetzt (pro Aufruf) das Default-Ceiling 10 × staleMs; `platform`, `openSync`,
 *   `renameSync`, `releaseRetryDelaysMs` sind Test-Nähte.
 * @returns {{path: string, nonce: string, release: () => void} | null} Handle,
 *   oder null, wenn ein lebender bzw. noch nicht veralteter Halter existiert.
 *   `release()` ist idempotent, wirft nie und löscht nur einen Lock, der noch
 *   unsere Nonce trägt.
 * @throws {Error} Bei anderen Fehlern als „belegt“ (z. B. ENOENT, EACCES).
 */
export function tryAcquireOwnedLock(lockPath, opts = {}) {
  const staleMs = Number(opts.staleMs ?? DEFAULT_STALE_MS);
  const platform = opts.platform ?? process.platform;
  const open = opts.openSync ?? openSync;
  const rename = opts.renameSync; // undefined → live fs.renameSync (Default-Parameter), damit Test-Hooks greifen
  const ceilingMs = ceilingOf(staleMs, opts.hardCeilingMs);
  const delays = opts.releaseRetryDelaysMs;
  let reaped = false;
  let transient = 0;
  for (;;) {
    let fd;
    try {
      fd = open(lockPath, "wx");
    } catch (err) {
      const code = err?.code;
      if (code === "EEXIST") {
        if (!reaped && reapIfStale(lockPath, staleMs, ceilingMs)) {
          reaped = true;
          continue;
        }
        return null;
      }
      if (platform === "win32" && WIN32_TRANSIENT_CODES.has(code)) {
        // Delete-pending direkt nach einer Freigabe: kurz nachfassen statt den Job auszulassen.
        if (transient++ < 2) {
          sleepSync(25);
          continue;
        }
        return null;
      }
      throw err;
    }
    const nonce = stampLock(fd, lockPath, platform, rename, delays);
    let released = false;
    return {
      path: lockPath,
      nonce,
      release() {
        if (released) return;
        released = true;
        releaseWithRetry(lockPath, nonce, (text) => holds(text, nonce), platform, rename, delays);
      },
    };
  }
}

/**
 * Führt `fn` unter exklusivem Lock aus. Der Lock wird immer freigegeben, auch
 * wenn `fn` wirft — aber nur, wenn er noch uns gehört.
 *
 * @param {string} lockPath Pfad der Lockdatei.
 * @param {Function} fn Synchroner Block.
 * @param {object} [opts] `{ staleMs, hardCeilingMs, timeoutMs, retryMs, platform, openSync, renameSync }`;
 *   `platform` (Default `process.platform`) und `openSync` (Default `fs.openSync`)
 *   sind Test-Nähte.
 * @returns {*} Rückgabewert von `fn`.
 * @throws {Error} Wenn der Lock innerhalb von `timeoutMs` nicht erworben wird
 *   oder die Nonce nicht geschrieben werden kann.
 */
export function withRegistryLock(lockPath, fn, opts = {}) {
  const staleMs = Number(opts.staleMs ?? DEFAULT_STALE_MS);
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryMs = Math.max(1, Number(opts.retryMs ?? DEFAULT_RETRY_MS));

  const platform = opts.platform ?? process.platform;
  const open = opts.openSync ?? openSync;
  const rename = opts.renameSync; // undefined → live fs.renameSync (Default-Parameter), damit Test-Hooks greifen
  const ceilingMs = ceilingOf(staleMs, opts.hardCeilingMs);
  const delays = opts.releaseRetryDelaysMs;

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
      if (code === "EEXIST") reapIfStale(lockPath, staleMs, ceilingMs);
      if (Date.now() >= deadline) {
        throw new Error(`registry lock busy: ${lockPath} (timeout after ${timeoutMs}ms)`);
      }
      sleepSync(retryMs);
    }
  }

  // Ohne Nonce lässt sich der Lock nicht sicher freigeben: Schreiben MUSS gelingen.
  const nonce = stampLock(fd, lockPath, platform, rename, delays);

  try {
    return fn();
  } finally {
    releaseWithRetry(lockPath, nonce, (text) => holds(text, nonce), platform, rename, delays);
  }
}
