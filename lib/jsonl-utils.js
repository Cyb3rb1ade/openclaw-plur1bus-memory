/**
 * lib/jsonl-utils.js — zentrale JSONL-Lesehilfe.
 *
 * Vorher hat fast jedes Modul (skill-miner, jobs, …) das gleiche
 * "read → split(/\r?\n/) → JSON.parse pro Zeile → kaputte Zeilen überspringen"
 * neu implementiert. Hier einmal, defensiv und mit optionalem Size-Cap.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

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
