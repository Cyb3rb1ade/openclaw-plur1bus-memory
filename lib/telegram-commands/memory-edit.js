/**
 * /forget + /correct — direct user intervention in the Memory Store.
 *
 * Guarantees:
 *   - Archive-First: before EVERY delete/update, a JSON backup is written to
 *     <archiveDir>/<agent>/<ts>-<id>.json. If that fails, NOTHING is deleted/changed.
 *   - DB errors are caught and returned as friendly string responses,
 *     not crashes.
 *
 * Pure helpers (parseCorrection, resolveCandidates, renderCandidateChoice)
 * are testable without DB.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "../i18n.js";
import { safeAgentId, resolveInside } from "../sql-safety.js";
import { storeSharedMemory } from "../shared-memory.js";
import { checkAccess, logAclViolation } from "../acl-middleware.js";

export const DEFAULT_ARCHIVE_DIR = join(homedir(), ".openclaw", "memory", "_archive");

// ─── parseCorrection ─────────────────────────────────────────────────────

/**
 * Splits "alt zu neu" or "alt → neu" / "alt -> neu" at the LAST separator,
 * so the old fragment may also contain "zu".
 *
 * Heuristic for " zu ":
 *   - " zu " must be surrounded by whitespace (no "zubereitet" match).
 *   - We take the LAST matching index.
 *
 * @returns {{old: string, new: string} | null}
 */
export function parseCorrection(input) {
  const raw = (input || "").trim();
  if (!raw) return null;

  // Arrow variants first (unambiguous)
  const arrowMatch = raw.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
  if (arrowMatch) {
    return { old: arrowMatch[1].trim(), new: arrowMatch[2].trim() };
  }

  // " zu " — last standalone occurrence
  const tokens = raw.split(/(\s+)/); // keeps whitespace
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
 * Searches via DB.searchByTopic for matching cards. When exactly one
 * scores significantly higher than the rest, it is "unique". Otherwise selection.
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
  // Heuristic: if top score is clearly (>0.15) above #2 → unique
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

export function archiveCard(card, agent, archiveDir = DEFAULT_ARCHIVE_DIR) {
  const safeAgent = safeAgentId(agent || "default");
  const dir = resolveInside(archiveDir, safeAgent);
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
 * Deletes a card with Archive-First guarantee.
 *
 * @returns {{ok: boolean, archivePath?: string, error?: string}}
 */
export async function forgetCard(db, agent, id, opts = {}) {
  const { lang = "en", tone = "default", archiveDir = DEFAULT_ARCHIVE_DIR } = opts;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    return { ok: false, error: t("forget.db_read_error", { lang, tone, vars: { error: err.message } }) };
  }
  if (!card) return { ok: false, error: t("forget.card_not_found", { lang, tone, vars: { id } }) };

  let archivePath;
  try {
    archivePath = archiveCard(card, agent, archiveDir);
  } catch (err) {
    return { ok: false, error: t("forget.archive_failed", { lang, tone, vars: { error: err.message } }) };
  }
  try {
    await db.deleteCard(agent, id);
  } catch (err) {
    return { ok: false, error: t("forget.delete_error", { lang, tone, vars: { error: err.message } }), archivePath };
  }
  return { ok: true, archivePath, id };
}

// ─── correctCard ─────────────────────────────────────────────────────────

/**
 * Updates a card. Archive-First, then updateCard or opts.updateMemory.
 */
export async function correctCard(db, agent, id, newContent, opts = {}) {
  const { lang = "en", tone = "default", archiveDir = DEFAULT_ARCHIVE_DIR } = opts;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    return { ok: false, error: t("correct.db_read_error", { lang, tone, vars: { error: err.message } }) };
  }
  if (!card) return { ok: false, error: t("correct.card_not_found", { lang, tone, vars: { id } }) };

  let archivePath;
  try {
    archivePath = archiveCard(card, agent, archiveDir);
  } catch (err) {
    return { ok: false, error: t("correct.archive_failed", { lang, tone, vars: { error: err.message } }) };
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
      error: t("correct.update_error", { lang, tone, vars: { error: err.message } }),
      archivePath,
    };
  }
  return { ok: true, archivePath, id };
}

// ─── Render: Multiple Choice ────────────────────────────────────────────

/**
 * Renders a numbered list with inline buttons.
 *
 * @param {Array} candidates
 * @param {string} action — 'forget' | 'correct'
 * @param {object} opts
 * @returns {{text: string, inline_keyboard: Array}}
 */
export function renderCandidateChoice(candidates, action, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const key = action === "forget" ? "candidate_choice.forget" : "candidate_choice.correct";
  const lines = [t(key, { lang, tone }), ""];
  const kb = [];
  candidates.forEach((c, i) => {
    const n = i + 1;
    const title = c.title || c.summary || "(untitled)";
    const meta = `${c.source || "?"} · ${c.date || "?"}`;
    lines.push(t("candidate_item", { lang, tone, vars: { n, title, source: c.source || "?", date: c.date || "?" } }));
    kb.push([{ text: t("candidate_button", { lang, tone, vars: { n, title: title.slice(0, 30) } }), callback_data: `${action}:${c.id}` }]);
  });
  return { text: lines.join("\n"), inline_keyboard: kb };
}

// ─── Render: Success / Error ─────────────────────────────────────────────

export function renderForgetResult(result, card, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  if (!result?.ok) return t("forget.failed", { lang, tone, vars: { error: result?.error || "" } });
  const title = card?.title || result.id;
  return t("forget.success", { lang, tone, vars: { title, path: result.archivePath || "—" } });
}

export function renderCorrectResult(result, card, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  if (!result?.ok) return t("correct.failed", { lang, tone, vars: { error: result?.error || "" } });
  const title = card?.title || result.id;
  return t("correct.success", { lang, tone, vars: { title, path: result.archivePath || "—" } });
}

// ─── shareCard ─────────────────────────────────────────────────────────────

/**
 * Copies an existing memory card into the shared pool (workspace_shared).
 *
 * @param {object} db — db adapter (for getCard)
 * @param {object} dbPool — AgentDbPool (for storeSharedMemory)
 * @param {string} agent
 * @param {string} id — memory id to share
 * @param {object} [opts]
 * @returns {{ok: boolean, sharedId?: string, error?: string}}
 */
export async function shareCard(db, dbPool, agent, id, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    return { ok: false, error: `share.db_read_error: ${err.message}` };
  }
  if (!card) return { ok: false, error: `share.card_not_found: ${id}` };

  try {
    const result = await storeSharedMemory(dbPool, agent, card.text || card.summary || "", {
      summary: card.summary || "",
      origin: card.origin || "dm",
      category: card.category || "other",
      createdAt: Date.now(),
    });
    return { ok: true, originalId: id, sharedId: result.id };
  } catch (err) {
    return { ok: false, error: `share.store_error: ${err.message}` };
  }
}

export function renderShareResult(result, card, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  if (!result?.ok) return `Share failed: ${result?.error || ""}`;
  const title = card?.title || result.originalId;
  return `Shared "${title}" to workspace pool (id: ${result.sharedId}).`;
}
