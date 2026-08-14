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
import { safeAgentId, safeUuid, resolveInside, appendDestructiveOpLog } from "../sql-safety.js";
import { storeSharedMemory } from "../shared-memory.js";
import { checkAccess, logAclViolation } from "../acl-middleware.js";
import { safeWarn } from "../safe-logging.js";
import { buildTombstone, appendTombstoneToRegistry, backfillCommittedTombstone } from "../tombstone.js";

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
 * Tombstoniert eine Karte mit Archive-First-Garantie (kanonischer Vorgang).
 *
 * Statt physisch zu löschen wird die Zeile soft-deleted (`status="deleted"`,
 * `epistemicStatus="invalidated"`) und ein dauerhafter Tombstone in der
 * append-only Registry persistiert. Zweiphasig: attempted → Mutation → committed.
 *
 * @returns {{ok: boolean, archivePath?: string, error?: string, alreadyTombstoned?: boolean}}
 */
export async function forgetCard(db, agent, id, opts = {}) {
  const {
    lang = "en",
    tone = "default",
    archiveDir = DEFAULT_ARCHIVE_DIR,
    workspaceDir,
    logger,
    baseDbPath,
    actor = "",
    actorType = "human",
    reason = "",
  } = opts;
  let card;
  try {
    card = await db.getCard(agent, id);
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.forget.getCard", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("forget.db_read_error", { lang, tone, vars: { error } }) };
  }
  if (!card) return { ok: false, error: t("forget.card_not_found", { lang, tone, vars: { id } }) };

  // ACL/Autorisierung MUSS vor jeder idempotenten Erfolgsauskunft geprüft
  // werden (sonst Information-Leak: ein Unbefugter erführe „Existenz + gelöscht").
  const aclDenied = denyIfAclBlocked(card, opts);
  if (aclDenied) return { ok: false, error: `access denied: ${aclDenied}` };

  // Idempotenz + Crash-Recovery: bereits tombstoned → falls der committed
  // Tombstone (und das Audit) aus einem früheren, unterbrochenen Lauf fehlen,
  // werden sie nachgetragen. Kein zweiter widersprüchlicher Delete.
  if (String(card.status || "") === "deleted") {
    if (baseDbPath) {
      try {
        const backfill = backfillCommittedTombstone(baseDbPath, card, {
          agentId: agent,
          actor,
          actorType,
          reason,
          sourceOp: "forget",
          archiveRef: "",
          previousVersion: String(card.previousVersion || ""),
        });
        // Audit IMMER schreiben (auch bei alreadyCommitted), damit ein zuvor
        // verschluckter Audit-Schreibfehler nicht dauerhaft unerfasst bleibt.
        const auditOk = appendDestructiveOpLog(workspaceDir, {
          event: "memory.deleted",
          source: "telegram_forget",
          agentId: agent,
          memoryId: id,
          canonicalOriginId: backfill.tombstone.canonicalOriginId,
          via: "id",
          archivePath: "",
          tombstoneId: backfill.tombstone.tombstoneId,
          result: backfill.alreadyCommitted ? "already_tombstoned" : "committed",
          timestamp: new Date().toISOString(),
        });
        if (!auditOk) {
          return { ok: false, error: t("forget.audit_failed", { lang, tone }), archivePath: "" };
        }
      } catch (err) {
        const error = logInternalError(logger, "memory-edit.forget.backfill", err, { agentId: agent, memoryId: id });
        return { ok: false, error: t("forget.delete_error", { lang, tone, vars: { error } }) };
      }
    }
    return { ok: true, alreadyTombstoned: true, archivePath: "", id };
  }

  let archivePath;
  try {
    archivePath = archiveCard(card, agent, archiveDir);
  } catch (err) {
    const error = logInternalError(logger, "memory-edit.forget.archive", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("forget.archive_failed", { lang, tone, vars: { error } }) };
  }

  const tombstone = buildTombstone({
    card,
    agentId: agent,
    actor,
    actorType,
    reason,
    sourceOp: "forget",
    archiveRef: archivePath,
    previousVersion: String(card.previousVersion || ""),
  });

  // Phase 1: attempted (vor der Mutation, damit eine Crash-Lücke erkennbar ist).
  if (baseDbPath) {
    appendTombstoneToRegistry(baseDbPath, agent, { ...tombstone, status: "attempted" });
  }

  let tombResult;
  try {
    tombResult = await db.tombstoneCard(agent, id);
  } catch (err) {
    if (baseDbPath) {
      appendTombstoneToRegistry(baseDbPath, agent, { ...tombstone, status: "failed" });
    }
    appendDestructiveOpLog(workspaceDir, {
      event: "memory.deleted",
      source: "telegram_forget",
      agentId: agent,
      memoryId: id,
      via: "id",
      archivePath,
      tombstoneId: tombstone.tombstoneId,
      result: "failed",
      errorClass: err?.name || "Error",
      timestamp: new Date().toISOString(),
    });
    const error = logInternalError(logger, "memory-edit.forget.tombstone", err, { agentId: agent, memoryId: id });
    return { ok: false, error: t("forget.delete_error", { lang, tone, vars: { error } }), archivePath };
  }

  if (tombResult?.notFound) {
    if (baseDbPath) {
      appendTombstoneToRegistry(baseDbPath, agent, { ...tombstone, status: "failed" });
    }
    return { ok: false, error: t("forget.card_not_found", { lang, tone, vars: { id } }), archivePath };
  }

  // Phase 2: committed (erst nach bestätigter Mutation) + Commit-Audit.
  if (baseDbPath && !tombResult?.alreadyTombstoned) {
    appendTombstoneToRegistry(baseDbPath, agent, { ...tombstone, status: "committed" });
  }
  const committedAuditOk = appendDestructiveOpLog(workspaceDir, {
    event: "memory.deleted",
    source: "telegram_forget",
    agentId: agent,
    memoryId: id,
    canonicalOriginId: tombstone.canonicalOriginId,
    via: "id",
    archivePath,
    tombstoneId: tombstone.tombstoneId,
    result: tombResult?.alreadyTombstoned ? "already_tombstoned" : "committed",
    timestamp: new Date().toISOString(),
  });
  if (!committedAuditOk) {
    // Mutation ist erfolgt, aber das Audit fehlt — kein Erfolg melden; der
    // idempotente Wiederholungsaufruf trägt das Audit nach.
    return { ok: false, error: t("forget.audit_failed", { lang, tone }), archivePath, id };
  }
  return { ok: true, archivePath, id, alreadyTombstoned: Boolean(tombResult?.alreadyTombstoned) };
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
  // Tombstone-Guard: getCard() hat keinen Status-Filter. Ohne diese Prüfung
  // legte updateCard() eine neue AKTIVE Zeile mit dem korrigierten Text an und
  // überschriebe den Tombstone der alten mit "superseded" — eine Resurrection,
  // die reapply-tombstones.mjs nicht einfängt, weil die Registry nur die alte
  // ID kennt. Erreichbar über: suchen → Bestätigung anfordern → vergessen →
  // Bestätigung einlösen.
  //
  // Bewusst dieselbe Meldung wie "nicht gefunden": ein eigener Text wäre ein
  // Existenz-Orakel für gelöschte IDs.
  if (!card || String(card.status || "") === "deleted") {
    return { ok: false, error: t("correct.card_not_found", { lang, tone, vars: { id } }) };
  }
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
  const category = String(card?.category || "").toLowerCase();
  const type = String(card?.type || card?.memoryType || "").toLowerCase();
  const criticalType = String(card?.criticalType || card?.criticalPushType || "").toLowerCase();
  const importance = Number(card?.importance);
  const importanceBand = String(card?.importanceBand || card?.factQuality?.importanceBand || "").toLowerCase();

  if (card?.memoryClass === "core") return "core memory";
  if (card?.neverForget === true || card?.neverForget === 1 || card?.neverForget === "1") return "neverForget memory";
  if (SENSITIVE_SHARE_CATEGORIES.has(category)) return `sensitive category: ${category}`;
  if (SENSITIVE_SHARE_CATEGORIES.has(type)) return `sensitive type: ${type}`;
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
export async function shareCard(privatePool, sharedPool, embeddings, agent, id, opts = {}) {
  let sourceId; let sourceAgent;
  try { sourceId = safeUuid(id); sourceAgent = safeAgentId(agent); } catch { return { ok: false, error: "share.invalid_id" }; }
  const targetScope = opts.targetScope || "workspace";
  if (!['workspace', 'user'].includes(targetScope)) return { ok: false, error: "share.invalid_target_scope" };
  if (typeof privatePool?.withWriteDb !== "function" || typeof embeddings?.embed !== "function") return { ok: false, error: "share.db_read_error: internal error; details were logged" };
  try {
    return await privatePool.withWriteDb(agent, async (sourceDb) => {
      await sourceDb.init();
      let card = await sourceDb.getById(sourceId);
      if (!card) return { ok: false, error: `share.card_not_found: ${sourceId}` };
      const sourceProblem = validateShareSource(card, sourceAgent, opts);
      if (sourceProblem) return sourceProblem;
      const fingerprint = shareSourceFingerprint(card);
      const vector = await embeddings.embed(card.text || card.summary, { agentId: sourceAgent });
      const lease = targetScope === "workspace" ? sharedPool?.withWorkspaceDb : sharedPool?.withUserDb;
      if (typeof lease !== "function") throw new Error("shared target pool is unavailable");
      card = await sourceDb.getById(sourceId);
      if (!card) return { ok: false, error: "share.source_not_live" };
      const completionProblem = validateShareSource(card, sourceAgent, opts);
      if (completionProblem) return completionProblem;
      if (shareSourceFingerprint(card) !== fingerprint) return { ok: false, error: "share.source_changed" };
      const result = await lease.call(sharedPool, opts.ctx || {}, async (targetDb) => {
        await targetDb.init();
        return storeSharedMemory(targetDb, card, opts.ctx || {}, { targetScope, vector, sourceAgentId: sourceAgent, allowSensitiveShare: opts.allowSensitiveShare === true, logger: opts.logger });
      });
      return { ok: true, originalId: sourceId, sharedId: result.id };
    });
  } catch (err) {
    if (isSafeSharePolicyError(err)) return { ok: false, error: `share.store_error: ${err.message}` };
    const error = logInternalError(opts.logger, "memory-edit.share.store", err, { agentId: agent, memoryId: sourceId });
    return { ok: false, error: `share.store_error: ${error}` };
  }
}

function liveShareExpiry(value, now) {
  return value == null || value === 0 || (typeof value === "number" && Number.isFinite(value) && value > now);
}

function validateShareSource(card, agent, opts) {
  if ((card.status != null && card.status !== "active") || !liveShareExpiry(card.expiresAt, Date.now())) return { ok: false, error: "share.source_not_live" };
  if (!['agent-private', 'workspace', 'user'].includes(card.scope || 'agent-private')) return { ok: false, error: "share.source_scope_denied" };
  for (const alias of [card.agentId, card.storedBy]) {
    if (alias != null && alias !== "" && alias !== agent) return { ok: false, error: "share.source_owner_conflict" };
  }
  if (!opts.ctx) return { ok: false, error: "access denied: acl.request.missing_context" };
  const aclDenied = denyIfAclBlocked(card, opts);
  if (aclDenied) return { ok: false, error: `access denied: ${aclDenied}` };
  const reason = sensitiveShareReason(card);
  return reason && opts.allowSensitiveShare !== true ? { ok: false, error: `share.explicit approval required (${reason})` } : null;
}

function shareSourceFingerprint(card) {
  return JSON.stringify([
    card.id, card.text, card.summary, card.category, card.type, card.memoryType,
    card.criticalType, card.criticalPushType, card.importance, card.importanceBand,
    card.memoryClass, card.neverForget, card.scope, card.agentId, card.storedBy,
    card.ownerUserId, card.workspaceId, card.workspaceKey, card.status, card.expiresAt,
  ]);
}

export function renderShareResult(result, card, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  if (!result?.ok) return `Share failed: ${result?.error || ""}`;
  const title = card?.title || result.originalId;
  return `Shared "${title}" to workspace pool (id: ${result.sharedId}).`;
}
