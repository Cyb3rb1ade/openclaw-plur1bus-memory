/**
 * lib/jsonl-utils.js — zentrale JSONL-Lesehilfe.
 *
 * Vorher hat fast jedes Modul (skill-miner, jobs, …) das gleiche
 * "read → split(/\r?\n/) → JSON.parse pro Zeile → kaputte Zeilen überspringen"
 * neu implementiert. Hier einmal, defensiv und mit optionalem Size-Cap.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/**
 * Liest eine JSONL-Datei (ein JSON-Objekt pro Zeile). Leere/unparsebare
 * Zeilen werden übersprungen. Fehlende Datei → [].
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] — Datei überspringen (→ []) wenn größer
 * @param {(msg: string) => void} [opts.onSkip] — Callback wenn Size-Cap greift
 * @returns {Array<object>}
 */
export function readJsonl(path, opts = {}) {
  if (!path || !existsSync(path)) return [];
  if (opts.maxBytes && opts.maxBytes > 0) {
    try {
      if (statSync(path).size > opts.maxBytes) {
        opts.onSkip?.(`readJsonl: ${path} exceeds ${opts.maxBytes} bytes — skipped`);
        return [];
      }
    } catch (_) {
      return [];
    }
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      /* kaputte Zeile überspringen */
    }
  }
  return out;
}

/**
 * Liest eine JSONL-Datei mit Bounded-Read-Semantik: passt die Datei in
 * maxBytes, wird sie komplett gelesen (Delegation an readJsonl). Ist sie
 * größer, werden nur die LETZTEN maxBytes gelesen — bei append-only Logs
 * liegen die neuesten Einträge am Dateiende, der Tail ist also das richtige
 * Fenster. Die erste (potenziell angeschnittene) Zeile im Fenster wird
 * verworfen; kaputte Zeilen werden übersprungen.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] — Fenstergröße; ohne/≤0 → Volllese via readJsonl
 * @param {(msg: string) => void} [opts.onSkip] — Info-Hook wenn truncated wird
 * @returns {Array<object>}
 */
export function readJsonlTail(path, opts = {}) {
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 0;
  if (!path || !existsSync(path)) return [];
  if (!maxBytes) return readJsonl(path);

  let size;
  try {
    size = statSync(path).size;
  } catch (_) {
    return [];
  }
  if (size <= maxBytes) return readJsonl(path);

  opts.onSkip?.(`readJsonlTail: ${path} exceeds ${maxBytes} bytes — reading last ${maxBytes} bytes only`);

  let raw;
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, size - maxBytes);
    raw = buf.toString("utf8", 0, bytesRead);
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Erste Zeile im Fenster ist fast sicher angeschnitten → bis inkl. erstem \n verwerfen.
  const firstNewline = raw.indexOf("\n");
  if (firstNewline === -1) return [];
  raw = raw.slice(firstNewline + 1);

  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      /* kaputte Zeile überspringen */
    }
  }
  return out;
}
