import { lstat as lstatAsync, readdir as readdirAsync } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { resolveInside } from "./sql-safety.js";

/** Deckel gegen unbegrenzte Laeufe: so viele Eintraege werden hoechstens besucht. */
export const CONTROL_HEALTH_MAX_STORAGE_ENTRIES = 10_000;
/** Nach je so vielen Eintraegen wird die Ereignisschleife freigegeben. */
export const CONTROL_HEALTH_STORAGE_YIELD_EVERY = 200;

function isAbsentControlHealthPath(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Measure bytes below a trusted root without following links or reading file
 * contents.
 *
 * Asynchron und mit Zwischenpausen, weil diese Messung sonst die
 * Ereignisschleife blockiert: sie lief synchron ueber den ganzen Store und
 * brauchte am 09.09.2026 bis zu 16 Sekunden bei 12 646 Eintraegen. In der Zeit
 * kam kein anderer Handler dran — 11 der 25 before_prompt_build-Timeouts jenes
 * Tages lagen binnen 30 Sekunden eines Laufs von mindestens 4 Sekunden. Der
 * Recall wurde also nicht zu langsam, ihm wurde die Laufzeit entzogen.
 *
 * Der teuerste Teil war nicht readdir/lstat, sondern `resolveInside` je
 * Eintrag: das sind drei Dateisystem-Aufrufe (realpathSync, existsSync,
 * realpathSync), bei vollem Deckel also bis zu 30 000. Dieselbe Zusicherung —
 * keinem Link folgen, den Baum nicht verlassen — liefert das lstat, das
 * ohnehin gemacht wird: Symlinks werden uebersprungen, und wer keinem Link
 * folgt, kann unterhalb der einmal aufgeloesten Wurzel nicht herausfallen.
 */
export async function measureControlHealthStorage(basePath, maxEntries = CONTROL_HEALTH_MAX_STORAGE_ENTRIES) {
  let root;
  try {
    root = resolveInside(basePath);
  } catch (error) {
    if (isAbsentControlHealthPath(error)) return { bytes: 0, complete: true };
    throw error;
  }
  let bytes = 0;
  let entriesSeen = 0;
  let complete = true;

  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdirAsync(directory, { withFileTypes: true });
    } catch (error) {
      if (isAbsentControlHealthPath(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entriesSeen >= maxEntries) {
        complete = false;
        return;
      }
      const target = resolve(directory, entry.name);
      let stat;
      try {
        stat = await lstatAsync(target);
      } catch (error) {
        if (isAbsentControlHealthPath(error)) continue;
        throw error;
      }
      // Kein Link wird betreten und keiner gezaehlt — damit bleibt die Messung
      // unterhalb der Wurzel, ohne pro Eintrag realpath zu bemuehen.
      if (stat.isSymbolicLink()) continue;
      entriesSeen += 1;
      if (entriesSeen % CONTROL_HEALTH_STORAGE_YIELD_EVERY === 0) await yieldToEventLoop();
      if (stat.isDirectory()) {
        await visit(target);
        if (!complete) return;
      } else if (stat.isFile()) {
        const size = Number(stat.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > Number.MAX_SAFE_INTEGER - bytes) {
          bytes = Number.MAX_SAFE_INTEGER;
          complete = false;
          return;
        }
        bytes += size;
      }
    }
  };

  await visit(root);
  return { bytes, complete };
}
