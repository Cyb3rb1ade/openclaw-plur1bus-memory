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
import { safeAgentId, resolveInside, appendDestructiveOpLog } from "../sql-safety.js";
import { storeSharedMemory } from "../shared-memory.js";
import { checkAccess, logAclViolation } from "../acl-middleware.js";
import { safeWarn } from "../safe-logging.js";

const SENSITIVE_SHARE_CATEGORIES = new Set([
  "access/password",
  "account",
  "birthday",
  "credential",
  "health",
  "money",
  "money/account",
  "password",
  "person",
  "relationship",
  "secret",
]);
const SENSITIVE_SHARE_IMPORTANCE = 0.9;
const USER_SAFE_ERROR = "internal error; details were logged";

function logInternalError(logger, scope, err, extra = {}) {
  safeWarn(logger, scope, err, extra);
  return USER_SAFE_ERROR;
}

function denyIfAclBlocked(card, opts = {}) {
  if (!opts.ctx) return null;
  const acl = checkAccess(opts.ctx, card);
  if (acl.allowed) return null;
  logAclViolation(opts.ctx, card, acl.reason, opts.aclAuditPath);
  return acl.reason || "acl.denied";
}

function isSafeSharePolicyError(err) {
  return /sensitive shared memory requires explicit approval/i.test(err?.message || "");
}

function resolveDefaultArchiveDir() {
  return join(process.env.OPENCLAW_HOME || homedir(), ".openclaw", "memory", "_archive");
}

export const DEFAULT_ARCHIVE_DIR = resolveDefaultArchiveDir();

function archiveJsonReplacer(_key, value) {
  return typeof value === "bigint" ? String(value) : value;
}

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
 * @param {object} [opts]
 * @returns {Promise<{unique: boolean, card?: object, candidates: Array, none?: boolean}>}
 */
export async function resolveCandidates(db, agent, query, opts = {}) {
  const results = await db.searchByTopic(agent, query, { limit: 5, ctx: opts.ctx });
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

export function archiveCard(card, agent, archiveDir = resolveDefaultArchiveDir()) {
  const safeAgent = safeAgentId(agent || "default");
  mkdirSync(archiveDir, { recursive: true });
  const dir = resolveInside(archiveDir, safeAgent);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = String(card.id || "unknown").replace(/[^a-zA-Z0-9\-]/g, "");
  const path = join(dir, `${ts}-${safeId}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(card, archiveJsonReplacer, 2));
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
  const { lang = "en", tone = "default", archiveDir = DEFAULT_ARCHIVE_DIR, workspaceDir, logger } = opts;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.forget.getCard", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("forget.db_read_error", { lang, tone, vars: { error } }) };
  }
  if (!card) return { ok: false, error: t("forget.card_not_found", { lang, tone, vars: { id } }) };
  const aclDenied = denyIfAclBlocked(card, opts);
  if (aclDenied) return { ok: false, error: `access denied: ${aclDenied}` };

  let archivePath;
  try {
    archivePath = archiveCard(card, agent, archiveDir);
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.forget.archive", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("forget.archive_failed", { lang, tone, vars: { error } }) };
  }
  try {
    await db.deleteCard(agent, id);
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.forget.delete", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("forget.delete_error", { lang, tone, vars: { error } }), archivePath };
  }
  // v6.2.1 — Audit-Log für destructive Operation (P0-Fix)
  appendDestructiveOpLog(workspaceDir, { event: "memory.deleted", source: "telegram_forget", agentId: agent, memoryId: id, via: "id", archivePath, timestamp: new Date().toISOString() });
  return { ok: true, archivePath, id };
}

// ─── correctCard ─────────────────────────────────────────────────────────

/**
 * Updates a card. Archive-First, then updateCard or opts.updateMemory.
 */
export async function correctCard(db, agent, id, newContent, opts = {}) {
  const { lang = "en", tone = "default", archiveDir = DEFAULT_ARCHIVE_DIR, workspaceDir, logger } = opts;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.correct.getCard", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("correct.db_read_error", { lang, tone, vars: { error } }) };
  }
  if (!card) return { ok: false, error: t("correct.card_not_found", { lang, tone, vars: { id } }) };
  const aclDenied = denyIfAclBlocked(card, opts);
  if (aclDenied) return { ok: false, error: `access denied: ${aclDenied}` };

  let archivePath;
  try {
    archivePath = archiveCard(card, agent, archiveDir);
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.correct.archive", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("correct.archive_failed", { lang, tone, vars: { error } }) };
  }
  try {
    if (typeof opts.updateMemory === "function") {
      await opts.updateMemory({ agent, id, newContent, card, archivePath });
    } else {
      await db.updateCard(agent, id, newContent);
    }
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.correct.update", err, { agentId: agent, memoryId: id });
    return {
      ok: false,
      error: t("correct.update_error", { lang, tone, vars: { error } }),
      archivePath,
    };
  }
  // v6.2.1 — Audit-Log für destructive Operation (P0-Fix)
  appendDestructiveOpLog(workspaceDir, { event: "memory.updated", source: "telegram_correct", agentId: agent, memoryId: id, archivePath, timestamp: new Date().toISOString() });
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

function sensitiveShareReason(card) {
  const category = String(card?.category || card?.type || card?.memoryType || "").toLowerCase();
  const criticalType = String(card?.criticalType || card?.criticalPushType || "").toLowerCase();
  const importance = Number(card?.importance);
  const importanceBand = String(card?.importanceBand || card?.factQuality?.importanceBand || "").toLowerCase();

  if (SENSITIVE_SHARE_CATEGORIES.has(category)) return `sensitive category: ${category}`;
  if (SENSITIVE_SHARE_CATEGORIES.has(criticalType)) return `critical type: ${criticalType}`;
  if (importanceBand === "critical") return "critical importance band";
  if (Number.isFinite(importance) && importance >= SENSITIVE_SHARE_IMPORTANCE) {
    return `high importance: ${importance}`;
  }
  return null;
}

/**
 * Copies an existing memory card into the shared pool (workspace_shared).
 *
 * @param {object} db — db adapter (for getCard)
 * @param {object} dbPool — AgentDbPool (for storeSharedMemory)
 * @param {string} agent
 * @param {string} id — memory id to share
 * @param {object} [opts] — set allowSensitiveShare=true after explicit user approval
 * @returns {{ok: boolean, sharedId?: string, error?: string}}
 */
export async function shareCard(db, dbPool, agent, id, opts = {}) {
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    const error = logInternalError(opts.logger, "memory-edit.share.getCard", err, { agentId: agent, memoryId: id });
    return { ok: false, error: `share.db_read_error: ${error}` };
  }
  if (!card) return { ok: false, error: `share.card_not_found: ${id}` };
  const aclDenied = denyIfAclBlocked(card, opts);
  if (aclDenied) return { ok: false, error: `access denied: ${aclDenied}` };

  const reason = sensitiveShareReason(card);
  if (reason && opts.allowSensitiveShare !== true) {
    return { ok: false, error: `share.explicit approval required before workspace_shared promotion (${reason})` };
  }

  try {
    const result = await storeSharedMemory(dbPool, agent, card.text || card.summary || "", {
      summary: card.summary || "",
      origin: card.origin || "dm",
      category: card.category || "other",
      type: card.type,
      memoryType: card.memoryType,
      criticalType: card.criticalType,
      criticalPushType: card.criticalPushType,
      importance: card.importance,
      importanceBand: card.importanceBand,
      factQuality: card.factQuality,
      memoryClass: card.memoryClass,
      neverForget: card.neverForget,
      allowSensitiveShare: opts.allowSensitiveShare === true,
      createdAt: Date.now(),
    });
    return { ok: true, originalId: id, sharedId: result.id };
  } catch (err) {
    if (isSafeSharePolicyError(err)) {
      return { ok: false, error: `share.store_error: ${err.message}` };
    }
    const error = logInternalError(opts.logger, "memory-edit.share.store", err, { agentId: agent, memoryId: id });
    return { ok: false, error: `share.store_error: ${error}` };
  }
}

export function renderShareResult(result, card, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  if (!result?.ok) return `Share failed: ${result?.error || ""}`;
  const title = card?.title || result.originalId;
  return `Shared "${title}" to workspace pool (id: ${result.sharedId}).`;
}
