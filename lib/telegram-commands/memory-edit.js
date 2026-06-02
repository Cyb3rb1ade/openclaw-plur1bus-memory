/**
 * /vergiss + /korrigier — direkter User-Eingriff in den Memory-Store.
 *
 * Garantien:
 *   - Archive-First: vor JEDEM delete/update wird ein JSON-Backup in
 *     <archiveDir>/<agent>/<ts>-<id>.json geschrieben. Schlägt das fehl,
 *     wird NICHT gelöscht/geändert.
 *   - DB-Fehler werden gefangen und als freundliche String-Antwort retourniert,
 *     nicht als Crash.
 *
 * Reine Helpers (parseCorrection, resolveCandidates, renderCandidateChoice)
 * sind testbar ohne DB.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ARCHIVE_DIR = join(homedir(), ".openclaw", "memory", "_archive");

// ─── parseCorrection ─────────────────────────────────────────────────────

/**
 * Splittet "alt zu neu" oder "alt → neu" / "alt -> neu" am LETZTEN Separator,
 * damit das alt-Fragment auch "zu" enthalten darf.
 *
 * Heuristik für " zu ":
 *   - " zu " muss von Whitespace umschlossen sein (kein "zubereitet"-Treffer).
 *   - Wir nehmen den LETZTEN passenden Index.
 *
 * @returns {{old: string, new: string} | null}
 */
export function parseCorrection(input) {
  const raw = (input || "").trim();
  if (!raw) return null;

  // Arrow-Varianten zuerst (eindeutig)
  const arrowMatch = raw.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
  if (arrowMatch) {
    return { old: arrowMatch[1].trim(), new: arrowMatch[2].trim() };
  }

  // " zu " — letztes freistehendes Vorkommen
  const tokens = raw.split(/(\s+)/); // behält Whitespace
  let lastZuIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "zu") lastZuIdx = i;
  }
  if (lastZuIdx > 0 && lastZuIdx < tokens.length - 1) {
    const before = tokens.slice(0, lastZuIdx).join("").trim();
    const after = tokens.slice(lastZuIdx + 1).join("").trim();
    if (before && after) return { old: before, new: after };
  }
  return null;
}

// ─── resolveCandidates ───────────────────────────────────────────────────

/**
 * Sucht über DB.searchByTopic nach passenden Cards. Wenn genau einer
 * deutlich höher als der Rest scort, ist er "unique". Sonst Auswahl.
 *
 * @returns {{unique: boolean, card?: object, candidates: Array, none?: boolean}}
 */
export async function resolveCandidates(db, agent, query) {
  const results = await db.searchByTopic(agent, query, { limit: 5 });
  if (!Array.isArray(results) || results.length === 0) {
    return { unique: false, candidates: [], none: true };
  }
  if (results.length === 1) {
    return { unique: true, card: results[0], candidates: results };
  }
  // Heuristik: wenn Top-Score deutlich (>0.15) über #2 → unique
  const top = results[0];
  const second = results[1];
  const topScore = top.score ?? 0;
  const secondScore = second.score ?? 0;
  if (topScore - secondScore > 0.15) {
    return { unique: true, card: top, candidates: results };
  }
  return { unique: false, candidates: results.slice(0, 5) };
}

// ─── Archive ─────────────────────────────────────────────────────────────

function archiveCard(card, agent, archiveDir) {
  const dir = join(archiveDir, agent);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = String(card.id || "unknown").replace(/[^a-zA-Z0-9\-]/g, "");
  const path = join(dir, `${ts}-${safeId}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(card, null, 2));
  renameSync(tmp, path);
  return path;
}

// ─── forgetCard ──────────────────────────────────────────────────────────

/**
 * Löscht eine Card mit Archive-First-Garantie.
 *
 * @returns {{ok: boolean, archivePath?: string, error?: string}}
 */
export async function forgetCard(db, agent, id, opts = {}) {
  const archiveDir = opts.archiveDir || DEFAULT_ARCHIVE_DIR;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    return { ok: false, error: `DB-Lesefehler: ${err.message}` };
  }
  if (!card) return { ok: false, error: `Card "${id}" nicht gefunden.` };

  let archivePath;
  try {
    archivePath = archiveCard(card, agent, archiveDir);
  } catch (err) {
    return { ok: false, error: `Archive fehlgeschlagen — NICHT gelöscht: ${err.message}` };
  }
  try {
    await db.deleteCard(agent, id);
  } catch (err) {
    return { ok: false, error: `Lösch-Fehler (Archive existiert): ${err.message}`, archivePath };
  }
  return { ok: true, archivePath, id };
}

// ─── correctCard ─────────────────────────────────────────────────────────

/**
 * Aktualisiert eine Card. Archive-First, dann updateCard oder opts.updateMemory.
 */
export async function correctCard(db, agent, id, newContent, opts = {}) {
  const archiveDir = opts.archiveDir || DEFAULT_ARCHIVE_DIR;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    return { ok: false, error: `DB-Lesefehler: ${err.message}` };
  }
  if (!card) return { ok: false, error: `Card "${id}" nicht gefunden.` };

  let archivePath;
  try {
    archivePath = archiveCard(card, agent, archiveDir);
  } catch (err) {
    return { ok: false, error: `Archive fehlgeschlagen — NICHT geändert: ${err.message}` };
  }
  try {
    if (typeof opts.updateMemory === "function") {
      await opts.updateMemory({ agent, id, newContent, card, archivePath });
    } else {
      await db.updateCard(agent, id, newContent);
    }
  } catch (err) {
    return {
      ok: false,
      error: `Update nicht möglich: ${err.message}`,
      archivePath,
    };
  }
  return { ok: true, archivePath, id };
}

// ─── Render: Mehrfach-Auswahl ────────────────────────────────────────────

/**
 * Rendert eine numerierte Liste mit Inline-Buttons.
 *
 * @param {Array} candidates
 * @param {string} action — 'forget' | 'correct'
 * @returns {{text: string, inline_keyboard: Array}}
 */
export function renderCandidateChoice(candidates, action) {
  const lines = [`🧠 Mehrere Treffer — welcher soll ${action === "forget" ? "vergessen" : "korrigiert"} werden?`, ""];
  const kb = [];
  candidates.forEach((c, i) => {
    const n = i + 1;
    const title = c.title || c.summary || "(ohne Titel)";
    const meta = `${c.source || "?"} · ${c.date || "?"}`;
    lines.push(`${n}. ${title}`);
    lines.push(`   _${meta}_`);
    kb.push([{ text: `${n}. ${title.slice(0, 30)}`, callback_data: `${action}:${c.id}` }]);
  });
  return { text: lines.join("\n"), inline_keyboard: kb };
}

// ─── Render: Erfolg / Fehler ─────────────────────────────────────────────

export function renderForgetResult(result, card) {
  if (!result?.ok) return `❌ ${result?.error || "Vergessen fehlgeschlagen."}`;
  const title = card?.title || result.id;
  return `✅ Vergessen: "${title}"\n_(Archiv: ${result.archivePath || "—"})_`;
}

export function renderCorrectResult(result, card) {
  if (!result?.ok) return `❌ ${result?.error || "Korrektur fehlgeschlagen."}`;
  const title = card?.title || result.id;
  return `✅ Korrigiert: "${title}"\n_(Archiv: ${result.archivePath || "—"})_`;
}
