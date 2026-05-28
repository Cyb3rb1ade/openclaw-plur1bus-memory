/**
 * memory-card-writer — schreibt Memory-Karten als Markdown in den Obsidian-Vault.
 *
 * Pfad: <vaultPath>/memory/cards/YYYY/MM/<YYYY-MM-DD>-<slug>.md
 *
 * Workflow:
 *   1. polishContent(rawContent, model) → glättet Sprache via LLM
 *   2. buildCardMarkdown(card) → strukturiertes Markdown mit Frontmatter
 *   3. writeCard(card, opts) → atomic write
 *
 * Production-Wiring (Phase 5): Cron-Job ruft writeCard mit Model =
 * { complete: async ({prompt}) => callLlm(...) } (gleicher Pattern wie
 * active-memory).
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const POLISH_PROMPT_TEMPLATE = (raw) => `
Glätte den folgenden Memory-Inhalt zu einem grammatikalisch vollständigen,
natürlichen deutschen Satz (oder zwei). Behalte ALLE Fakten, Namen, Daten,
Zahlen, IDs. Kein Vorwort, kein Abschluss, NUR der geglättete Text.

Roh-Inhalt:
"""
${raw}
"""

Geglättet:`.trim();

/**
 * Glättet Roh-Inhalt via injected Modell.
 *
 * @param {string} raw
 * @param {object|null} model — { complete: async ({prompt}) => {text} }
 * @returns {Promise<string>} — geglätteter Text oder Original bei Fehler
 */
export async function polishContent(raw, model) {
  if (!raw) return "";
  if (!model || typeof model.complete !== "function") return raw;
  try {
    const prompt = POLISH_PROMPT_TEMPLATE(raw);
    const response = await model.complete({ prompt });
    const text = String(response?.text || "").trim();
    return text || raw;
  } catch (_) {
    return raw;
  }
}

/**
 * Wandelt einen Titel in einen ASCII-slug. Umlaute werden transliteriert.
 */
export function slugifyTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) return `card-${Date.now()}`;
  const map = { "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "ae", "Ö": "oe", "Ü": "ue" };
  let s = raw.toLowerCase().replace(/[äöüßÄÖÜ]/g, (c) => map[c] || c);
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); // entferne kombinierende Akzente
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) return `card-${Date.now()}`;
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/g, "");
  return s;
}

/**
 * Baut Card-Markdown mit YAML-Frontmatter + 5-Felder-Body.
 *
 * Erwartete card-Felder:
 *   id, type, created (ISO), source, title, polishedContent, why, learnedAt
 */
export function buildCardMarkdown(card) {
  const c = card || {};
  const fm = [
    "---",
    `id: ${c.id || ""}`,
    `type: ${c.type || "fakt"}`,
    `created: ${c.created || new Date().toISOString()}`,
    `source: ${c.source || ""}`,
    `title: "${(c.title || "").replace(/"/g, '\\"')}"`,
    "---",
  ].join("\n");

  const body = [
    `# ${c.title || "(ohne Titel)"}`,
    "",
    `**Was:** ${c.polishedContent || ""}`,
    "",
    `**Warum gespeichert:** ${c.why || "—"}`,
    "",
    `**Quelle:** ${c.source || "—"}`,
    "",
    `**Gelernt am:** ${c.learnedAt || c.created || ""}`,
    "",
    `**Typ:** ${c.type || "fakt"}`,
    "",
  ].join("\n");

  return `${fm}\n\n${body}`;
}

function atomicWriteFile(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Schreibt eine Card als Markdown in den Vault.
 *
 * @param {object} card — siehe buildCardMarkdown + .content (roh)
 * @param {object} opts — { vaultPath, model }
 */
export async function writeCard(card, opts = {}) {
  if (!opts.vaultPath) {
    throw new Error("writeCard: vaultPath erforderlich");
  }
  if (!card || !card.title) {
    throw new Error("writeCard: card.title erforderlich");
  }
  const polished = await polishContent(card.content || "", opts.model || null);
  const created = card.created || new Date().toISOString();
  const date = created.slice(0, 10);  // YYYY-MM-DD
  const year = created.slice(0, 4);
  const month = created.slice(5, 7);
  const slug = slugifyTitle(card.title);
  const dir = join(opts.vaultPath, "memory", "cards", year, month);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}-${slug}.md`);
  const md = buildCardMarkdown({ ...card, polishedContent: polished });
  atomicWriteFile(path, md);
  return { ok: true, path };
}
