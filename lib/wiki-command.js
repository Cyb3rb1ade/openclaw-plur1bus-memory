/**
 * lib/wiki-command.js — /wiki Telegram command for PLUR1BUS.
 *
 * /wiki <Begriff>              — search + LLM synthesis
 * /wiki add <Begriff>: <Text>  — store new wiki entry
 * /wiki delete <Begriff>       — delete by query (archive-first)
 * /wiki delete id:<UUID>       — delete by UUID directly
 */

import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { distanceToScore } from "./score.js";
import { applyDynamicsDefaults } from "./memory-dynamics.js";
import { archiveCard } from "./telegram-commands/memory-edit.js";
import { resolveLocale, readSoulToneCached, pickTone, t } from "./i18n.js";
import { isAuthorized } from "./security.js";
import {
  appendDestructiveOpLog,
  resolveInside,
  safeUuid,
  sqlString,
} from "./sql-safety.js";
import { checkAccess } from "./acl-middleware.js";
import { resolveMemoryRequestContext } from "./memory-request-context.js";
import { validateCommandArgs } from "./input-limits.js";
import { safeDebug } from "./safe-logging.js";
import { identityId } from "./providers/embedding-identity.js";
import { ensureSharedMemoryColumns } from "./shared-memory.js";
import { SHARED_MEMORY_UNSUPPORTED } from "./shared-memory-pool.js";
import { normalizeEpistemicStatus } from "./epistemic-status.js";

const SEARCH_CANDIDATE_MULTIPLIER = 5;
const DELETE_COMMANDS = new Set(["delete", "löschen", "loeschen"]);

// ─── Locale ───────────────────────────────────────────────────────────────────

function resolveLocaleFromCtx(commandCtx) {
  const messages = commandCtx?.messages || [];
  const lang = resolveLocale({ ctx: commandCtx, messages, fallback: "en" });
  const toneHint = commandCtx?.workspaceDir ? readSoulToneCached(commandCtx.workspaceDir) : null;
  const tone = pickTone(toneHint);
  return { lang, tone };
}

// ─── Visibility ───────────────────────────────────────────────────────────────

function isActiveKindRow(row, kind, now) {
  const active = row?.status == null || row.status === "" || row.status === "active";
  if (!active) return false;

  // Converging JS-side safety net for both the WHERE-available and the
  // fallback vector-search path below — mirrors the pre-existing status
  // check, since this row shape has no separate per-path filter chain.
  if (normalizeEpistemicStatus(row?.epistemicStatus) === "invalidated") return false;

  const expiry = row?.expiresAt;
  const live = expiry == null
    || expiry === 0
    || (typeof expiry === "number" && Number.isFinite(expiry) && expiry > now);
  if (!live) return false;

  if (kind === "memory") return !row?.memoryKind || row.memoryKind === "memory";
  return row?.memoryKind === kind;
}

function visibleResults(ctx, results, kind, now) {
  return (Array.isArray(results) ? results : []).filter((result) => {
    const row = result?.entry || result;
    return isActiveKindRow(row, kind, now)
      && checkAccess(ctx, result?.entry || result).allowed;
  });
}

function sqlEqualsAny(field, values) {
  return [...values].map((value) => `${field} = ${sqlString(value)}`).join(" OR ");
}

function ownershipSqlPredicate(ctx) {
  const branches = [];
  if (typeof ctx?.agentId === "string" && ctx.agentId) {
    const agent = sqlString(ctx.agentId);
    const matchingAgent = `((agentId = ${agent} AND (storedBy = ${agent} OR storedBy IS NULL OR storedBy = '')) OR (storedBy = ${agent} AND (agentId = ${agent} OR agentId IS NULL OR agentId = '')))`;
    branches.push(`((scope IS NULL OR scope = '' OR scope = 'agent-private') AND ${matchingAgent})`);
  }

  if (typeof ctx?.workspaceIdentity === "string" && ctx.workspaceIdentity) {
    const workspaceValues = new Set([ctx.workspaceIdentity]);
    for (const alias of ctx.workspaceAliases?.aliases || []) {
      if (alias?.workspaceKey === ctx.workspaceIdentity && typeof alias.alias === "string") {
        workspaceValues.add(alias.alias);
      }
    }
    const workspaceId = sqlEqualsAny("workspaceId", workspaceValues);
    const workspaceKey = sqlEqualsAny("workspaceKey", workspaceValues);
    branches.push(`(scope = 'workspace' AND ((${workspaceId}) OR (${workspaceKey})))`);
  }

  if (typeof ctx?.userPrincipal === "string" && ctx.userPrincipal) {
    branches.push(`(scope = 'user' AND ownerUserId = ${sqlString(ctx.userPrincipal)})`);
  }

  return branches.length > 0 ? `(${branches.join(" OR ")})` : "(1 = 0)";
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Vector-searches a LanceDB table for live rows of one memory kind.
 * @param {object} table LanceDB table.
 * @param {Float32Array|number[]} vector Query vector.
 * @param {"wiki"|"memory"} kind Required memory kind.
 * @param {number} limit Maximum result count.
 * @param {number} minScore Minimum normalized score.
 * @param {number} requestNow Immutable request timestamp.
 * @param {object|null|undefined} logger Safe diagnostic logger.
 * @param {object} ctx Canonical ACL request context.
 * @returns {Promise<Array<{entry: object, score: number}>>}
 */
async function searchByKind(table, vector, kind, limit, minScore, requestNow, logger, ctx) {
  const kindFilter = kind === "memory"
    ? "memoryKind = 'memory' OR memoryKind IS NULL OR memoryKind = ''"
    : `memoryKind = '${kind}'`;
  const whereClause = `(${kindFilter}) AND (status = 'active' OR status IS NULL OR status = '') AND epistemicStatus != 'invalidated' AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > ${requestNow}) AND ${ownershipSqlPredicate(ctx)}`;
  const candidateLimit = limit * SEARCH_CANDIDATE_MULTIPLIER;

  try {
    const builder = table.vectorSearch(vector);
    if (typeof builder.where === "function") {
      const rows = await builder.where(whereClause).limit(candidateLimit).toArray();
      if (Array.isArray(rows)) {
        const candidates = rows
          .map((row) => ({ entry: row, score: distanceToScore(row._distance) }))
          .filter((result) => result.score >= minScore && isActiveKindRow(result.entry, kind, requestNow));
        return visibleResults(ctx, candidates, kind, requestNow).slice(0, limit);
      }
    }
  } catch (error) {
    safeDebug(logger, "wiki search failed", "filtered vector search unavailable");
  }

  try {
    const rows = await table.vectorSearch(vector).limit(candidateLimit).toArray();
    const candidates = rows
      .map((row) => ({ entry: row, score: distanceToScore(row._distance) }))
      .filter((result) => result.score >= minScore && isActiveKindRow(result.entry, kind, requestNow));
    return visibleResults(ctx, candidates, kind, requestNow).slice(0, limit);
  } catch (error) {
    safeDebug(logger, "wiki search failed", "fallback vector search unavailable");
    return [];
  }
}

/**
 * Parses and validates the complete Wiki command grammar without data access.
 * @param {unknown} rawArgs Optional PluginCommandContext arguments.
 * @returns {{ready: boolean, args: string, action?: string, subCmd?: string, rest?: string, term?: string, bodyText?: string, fullText?: string, destructive?: boolean, responseKey?: string, responseVars?: object}}
 */
export function parseWikiCommandInput(rawArgs) {
  const validation = validateCommandArgs(rawArgs);
  if (!validation.ok) {
    return {
      ready: false,
      args: "",
      responseKey: "wiki.input_error",
      responseVars: { error: validation.error },
    };
  }

  const args = (validation.value ?? "").trim();
  if (!args) {
    return { ready: false, args, responseKey: "wiki.usage", responseVars: {} };
  }

  const tokens = args.split(/\s+/);
  const subCmd = tokens[0]?.toLowerCase();
  const rest = args.slice(tokens[0].length).trim();
  if (subCmd === "add") {
    const colonIdx = rest.indexOf(":");
    const term = colonIdx >= 0 ? rest.slice(0, colonIdx).trim() : "";
    const bodyText = colonIdx >= 0 ? rest.slice(colonIdx + 1).trim() : "";
    if (colonIdx < 1 || !term || !bodyText) {
      return { ready: false, args, responseKey: "wiki.add_usage", responseVars: {} };
    }
    return {
      ready: true,
      action: "add",
      subCmd,
      args,
      rest,
      term,
      bodyText,
      fullText: `${term}: ${bodyText}`,
      destructive: true,
    };
  }

  if (DELETE_COMMANDS.has(subCmd)) {
    if (!rest) {
      return { ready: false, args, responseKey: "wiki.usage", responseVars: {} };
    }
    if (rest.startsWith("id:") && !validatedUuid(rest.slice(3).trim())) {
      return {
        ready: false,
        args,
        responseKey: "wiki.delete_not_found",
        responseVars: {},
      };
    }
    return {
      ready: true,
      action: "delete",
      subCmd,
      args,
      rest,
      destructive: true,
    };
  }

  return {
    ready: true,
    action: "search",
    subCmd,
    args,
    rest: args,
    destructive: false,
  };
}

async function embedQuery(embeddings, text, agentId) {
  const context = { agentId };
  if (typeof embeddings?.embedQuery === "function") {
    return embeddings.embedQuery(text, context);
  }
  return embeddings.embed(text, context);
}

/**
 * Builds an LLM-synthesized answer, with visible excerpts as fallback.
 */
async function synthesizeAnswer(results, query, lang, callLlm, llmCfg, logger) {
  const memoryLines = results
    .slice(0, 6)
    .map((result, index) => {
      const entry = result.entry || result;
      return `[${index + 1}] ${(entry.text || entry.summary || "").slice(0, 400)}`;
    })
    .join("\n\n");

  if (llmCfg && callLlm) {
    try {
      const prompt =
        lang === "de"
          ? `Du bist ein Wissens-Assistent. Der Nutzer fragt: "${query}"\n\nHier sind relevante gespeicherte Erinnerungen (intern, nicht extern verifiziert):\n\n${memoryLines}\n\nFasse zusammen, was bekannt ist. Kennzeichne Unsicherheit. Maximal 3–4 Sätze.`
          : `You are a knowledge assistant. The user asks: "${query}"\n\nHere are relevant stored memories (internal, not externally verified):\n\n${memoryLines}\n\nSummarize what is known. Flag uncertainty. Maximum 3–4 sentences.`;
      const raw = await callLlm(
        [{ role: "user", content: prompt }],
        { ...llmCfg, maxTokens: 400 },
      );
      if (raw) {
        return raw.replace(/^```(?:\w+)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
      }
    } catch (error) {
      safeDebug(logger, "wiki synthesis failed", error);
    }
  }

  return results
    .slice(0, 3)
    .map((result) => {
      const entry = result.entry || result;
      return `• ${(entry.summary || entry.text || "").slice(0, 200)}`;
    })
    .join("\n");
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Authorizes a Wiki request against its resolved immutable memory context.
 * @param {object} memoryCtx Canonical memory request context.
 * @param {object} cfg Plugin configuration.
 * @param {object} options Authorization and localization options.
 * @returns {{text: string}|null} A localized denial or null.
 */
export function checkWikiAuth(
  memoryCtx,
  cfg,
  {
    destructive = false,
    chatKind = memoryCtx.chatKind,
    localeCtx = null,
  } = {},
) {
  const auth = isAuthorized(memoryCtx, cfg, { destructive, sensitiveRead: !destructive, chatKind });
  if (!auth.authorized) {
    const { lang, tone } = resolveLocaleFromCtx(localeCtx);
    return { text: t("wiki.unauthorized", { lang, tone }) };
  }
  return null;
}

// ─── Shared workspace pool ────────────────────────────────────────────────────

/**
 * Leases the shared workspace pool as an OPTIONAL second source next to the
 * agent's private table. `/wiki add` writes `scope: "workspace"` rows there
 * (like every other workspace row), so search and delete must read it too.
 * `fn` always runs exactly once: with the shared DB, or with `null` when the
 * workspace is unbound, the pool is missing/unsupported or its lease could
 * not be acquired. An error thrown by `fn` itself is never swallowed.
 * @param {object|null|undefined} sharedPool Shared memory pool.
 * @param {object} ctx Canonical request context.
 * @param {{write?: boolean}} options `write` leases the writable pool.
 * @param {(db: object|null) => Promise<*>} fn Lease-bound callback.
 * @param {object|null|undefined} logger Safe diagnostic logger.
 * @returns {Promise<*>} Callback result.
 */
async function withSharedWorkspaceDb(sharedPool, ctx, { write = false } = {}, fn, logger) {
  const lease = write ? sharedPool?.withWorkspaceDb : sharedPool?.withWorkspaceReadDb;
  if (!ctx?.workspaceIdentity || typeof lease !== "function") return fn(null);
  let callbackEntered = false;
  try {
    return await lease.call(sharedPool, ctx, async (db) => {
      callbackEntered = true;
      if (!db) return fn(null);
      await db.init();
      return fn(db);
    });
  } catch (error) {
    if (callbackEntered) throw error;
    // A missing optional read source is skipped; a failing write must not
    // silently land somewhere else. Only "unsupported" keeps the old placement.
    if (write && error?.code !== SHARED_MEMORY_UNSUPPORTED) throw error;
    safeDebug(logger, "wiki shared workspace lease unavailable", error);
    return fn(null);
  }
}

/** Embeds `text` with the provider that matches the identity of `targetDb` (as /share does). */
async function embedForDb(embeddings, targetDb, text, agentId) {
  let provider = embeddings;
  if (targetDb?.identity) {
    provider = embeddings?.identityProviders?.get(identityId(targetDb.identity))
      ?? (embeddings?.identity && identityId(embeddings.identity) === identityId(targetDb.identity) ? embeddings : null);
    if (!provider) throw new Error("no embedder for the shared workspace store identity");
  }
  const vector = await provider.embed(text, { agentId });
  if (targetDb?.vectorDim != null && vector.length !== targetDb.vectorDim) {
    throw new Error("embedding does not match the shared workspace store dimension");
  }
  return vector;
}

/**
 * Merges per-source result lists: best score first, one entry per id.
 * @param {Array<Array<{entry: object, score: number}>>} lists Results per source.
 * @param {number} limit Maximum merged count.
 * @returns {Array<{entry: object, score: number}>}
 */
function mergeResults(lists, limit) {
  const seen = new Set();
  return lists.flat()
    .sort((left, right) => right.score - left.score)
    .filter((result) => {
      const id = result.entry?.id;
      if (id && seen.has(id)) return false;
      if (id) seen.add(id);
      return true;
    })
    .slice(0, limit);
}

// ─── Search ───────────────────────────────────────────────────────────────────

async function wikiSearch(
  query,
  {
    db,
    sharedDb = null,
    embeddings,
    callLlm,
    llmCfg,
    lang,
    tone,
    ctx,
    requestNow,
    logger,
  },
) {
  let vector;
  try {
    vector = await embedQuery(embeddings, query, ctx.agentId);
  } catch (error) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: error.message } }) };
  }

  const searchSources = async (kind) => mergeResults(
    await Promise.all([db, sharedDb].filter(Boolean).map((source) =>
      searchByKind(source.table, vector, kind, 8, 0.2, requestNow, logger, ctx))),
    8,
  );

  const wikiResults = visibleResults(ctx, await searchSources("wiki"), "wiki", requestNow);
  if (wikiResults.length > 0) {
    const answer = await synthesizeAnswer(wikiResults, query, lang, callLlm, llmCfg, logger);
    return { text: t("wiki.result_wiki", { lang, tone, vars: { query, answer } }) };
  }

  const memoryResults = visibleResults(ctx, await searchSources("memory"), "memory", requestNow);
  if (memoryResults.length > 0) {
    const answer = await synthesizeAnswer(memoryResults, query, lang, callLlm, llmCfg, logger);
    return { text: t("wiki.result_fallback", { lang, tone, vars: { query, answer } }) };
  }

  return { text: t("wiki.not_found", { lang, tone, vars: { query } }) };
}

// ─── Add ──────────────────────────────────────────────────────────────────────

async function wikiAdd(
  parsed,
  {
    db,
    sharedPool = null,
    embeddings,
    ctx,
    lang,
    tone,
    requestNow,
    logger,
  },
) {
  const { fullText, term } = parsed;
  let vector;
  try {
    vector = await embeddings.embed(fullText, { agentId: ctx.agentId });
  } catch (error) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: error.message } }) };
  }

  try {
    const existing = await db.findSimilar(vector, fullText, 0.92);
    const visibleDuplicates = visibleResults(ctx, existing, "wiki", requestNow);
    if (visibleDuplicates.length > 0) {
      const entry = visibleDuplicates[0].entry || visibleDuplicates[0];
      const preview = entry.summary || entry.text || "";
      return {
        text: t("wiki.duplicate", {
          lang,
          tone,
          vars: { existing: preview.slice(0, 100) },
        }),
      };
    }
  } catch (error) {
    safeDebug(logger, "wiki duplicate search failed", error);
  }

  const buildEntry = (entryVector) => applyDynamicsDefaults({
    id: randomUUID(),
    text: fullText,
    summary: `[Wiki] ${term}`,
    origin: "note",
    vector: entryVector,
    importance: 0.9,
    category: "knowledge",
    memoryKind: "wiki",
    createdAt: requestNow,
    mergedFrom: "[]",
    expiresAt: 0,
    agentId: ctx.agentId,
    storedBy: ctx.agentId,
    sourceTurnId: "",
    sourceMessageRole: "",
    sourceTimestamp: requestNow,
    sourceUrl: "",
    evidenceQuote: "",
    scope: "workspace",
    workspaceId: ctx.workspaceIdentity,
    workspaceKey: ctx.workspaceIdentity,
    ownerUserId: "",
    emotionalValence: "neutral",
    emotionalIntensity: 0,
    emotionalDominant: "neutral",
    moodContextAtCapture: "",
    emotionStatus: "final",
  }, requestNow, {});

  // scope "workspace" rows belong in the shared workspace pool (where every
  // other workspace row lives and where the other agents of the workspace
  // read), not in the author's private table. Only where that pool is
  // unavailable (no pool, unbound workspace, unsupported platform) the row
  // keeps the previous private-table placement.
  const shared = await withSharedWorkspaceDb(sharedPool, ctx, { write: true }, async (sharedDb) => {
    if (!sharedDb) return null;
    if (sharedDb.table) await ensureSharedMemoryColumns(sharedDb);
    const sharedVector = await embedForDb(embeddings, sharedDb, fullText, ctx.agentId);
    const duplicates = visibleResults(ctx, await sharedDb.findSimilar(sharedVector, fullText, 0.92), "wiki", requestNow);
    if (duplicates.length > 0) {
      const existingEntry = duplicates[0].entry || duplicates[0];
      return { duplicate: (existingEntry.summary || existingEntry.text || "").slice(0, 100) };
    }
    // The shared table carries the share-provenance columns; a native wiki
    // row has no source copy, so they hold the column defaults.
    await sharedDb.store({
      ...buildEntry(sharedVector),
      sourceMemoryId: "",
      sourceAgentId: "",
      shareIdempotencyKey: "",
      shareProvenance: "{}",
    });
    return { stored: true };
  }, logger);
  if (shared?.duplicate !== undefined) {
    return { text: t("wiki.duplicate", { lang, tone, vars: { existing: shared.duplicate } }) };
  }
  if (shared?.stored) {
    return { text: t("wiki.added", { lang, tone, vars: { term } }) };
  }

  await db.store(buildEntry(vector));
  return { text: t("wiki.added", { lang, tone, vars: { term } }) };
}

// ─── Delete ───────────────────────────────────────────────────────────────────

function genericDeleteNotFound(lang, tone) {
  return { text: t("wiki.delete_not_found", { lang, tone }) };
}

function validatedUuid(value) {
  try {
    return safeUuid(value);
  } catch {
    return null;
  }
}

async function deleteWikiCard(
  card,
  {
    db,
    agentId,
    lang,
    tone,
    archiveDir,
    workspaceDir,
    via,
  },
) {
  const safeId = validatedUuid(card?.id);
  if (!safeId) return genericDeleteNotFound(lang, tone);
  if (!workspaceDir) {
    return { text: t("wiki.audit_unavailable", { lang, tone }) };
  }

  let archivePath;
  try {
    archivePath = archiveCard(card, agentId, archiveDir);
  } catch (error) {
    return { text: t("wiki.archive_failed", { lang, tone, vars: { error: error.message } }) };
  }

  try {
    await db.table.delete(`id = "${safeId}"`);
  } catch (error) {
    return {
      text: t("wiki.archive_failed", { lang, tone, vars: { error: error.message } }),
      archivePath,
    };
  }

  appendDestructiveOpLog(workspaceDir, {
    event: "memory.deleted",
    source: "wiki.delete",
    agentId,
    memoryId: safeId,
    via,
    archivePath,
    timestamp: new Date().toISOString(),
  });
  return { text: t("wiki.deleted", { lang, tone }) };
}

async function wikiDelete(
  rawArgs,
  {
    db,
    sharedDb = null,
    embeddings,
    ctx,
    lang,
    tone,
    archiveDir,
    workspaceDir,
    requestNow,
    logger,
  },
) {
  if (rawArgs.startsWith("id:")) {
    const safeId = validatedUuid(rawArgs.slice(3).trim());
    if (!safeId) return genericDeleteNotFound(lang, tone);

    let card = null;
    let holder = db;
    for (const source of [db, sharedDb].filter(Boolean)) {
      try {
        card = await source.getById(safeId);
      } catch (error) {
        safeDebug(logger, "wiki getById failed", error);
      }
      if (!card) {
        try {
          const rows = await source.table.query().where(`id = "${safeId}"`).limit(1).toArray();
          if (rows.length > 0) card = rows[0];
        } catch (error) {
          safeDebug(logger, "wiki ID fallback failed", error);
        }
      }
      if (card) {
        holder = source;
        break;
      }
    }
    if (!card) return genericDeleteNotFound(lang, tone);

    const visibleWiki = visibleResults(ctx, [{ entry: card }], "wiki", requestNow);
    if (visibleWiki.length === 0) {
      const visibleMemory = visibleResults(ctx, [{ entry: card }], "memory", requestNow);
      if (visibleMemory.length > 0) {
        return { text: t("wiki.delete_not_wiki", { lang, tone, vars: { query: safeId } }) };
      }
      return genericDeleteNotFound(lang, tone);
    }

    return deleteWikiCard(visibleWiki[0].entry, {
      db: holder,
      agentId: ctx.agentId,
      lang,
      tone,
      archiveDir,
      workspaceDir,
      via: "id",
    });
  }

  const query = rawArgs.trim();
  if (!query) return { text: t("wiki.usage", { lang, tone }) };

  let vector;
  try {
    vector = await embedQuery(embeddings, query, ctx.agentId);
  } catch (error) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: error.message } }) };
  }

  const results = visibleResults(
    ctx,
    mergeResults(
      await Promise.all([db, sharedDb].filter(Boolean).map(async (source) =>
        (await searchByKind(source.table, vector, "wiki", 5, 0.25, requestNow, logger, ctx))
          .map((result) => ({ ...result, source })))),
      5,
    ),
    "wiki",
    requestNow,
  );
  if (results.length === 0) return genericDeleteNotFound(lang, tone);

  if (results.length === 1) {
    return deleteWikiCard(results[0].entry, {
      db: results[0].source,
      agentId: ctx.agentId,
      lang,
      tone,
      archiveDir,
      workspaceDir,
      via: "query",
    });
  }

  const list = results
    .map((result, index) => {
      const entry = result.entry;
      const preview = (entry.summary || entry.text || "").slice(0, 80);
      return `[${index + 1}] id:${entry.id}\n    ${preview}`;
    })
    .join("\n");
  return { text: t("wiki.delete_ambiguous", { lang, tone, vars: { query, list } }) };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function withDbLease(pool, agentId, fn) {
  if (typeof pool?.withDb === "function") return pool.withDb(agentId, fn);
  return fn(pool.getDb(agentId));
}

function canonicalAuditWorkspace(ctx, suppliedWorkspaceDir) {
  const workspaceDir = suppliedWorkspaceDir === undefined
    ? ctx?.workspaceDir
    : suppliedWorkspaceDir;
  if (
    typeof workspaceDir !== "string"
    || !workspaceDir
    || workspaceDir !== ctx?.workspaceDir
  ) {
    return "";
  }
  try {
    const auditDir = join(workspaceDir, ".adaptive-learning");
    resolveInside(workspaceDir, ".adaptive-learning");
    resolveInside(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    if (!isWritableDirectory(workspaceDir)) return "";
    if (!isAbsentOrWritableDirectory(auditDir)) return "";
    if (!isAbsentOrWritableRegularFile(join(auditDir, "destructive-ops.jsonl"))) return "";
    return workspaceDir;
  } catch {
    return "";
  }
}

function isWritableDirectory(path) {
  const stat = statSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o222) === 0) return false;
  accessSync(path, fsConstants.W_OK | fsConstants.X_OK);
  return true;
}

function isAbsentOrWritableDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o222) === 0) return false;
    accessSync(path, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function isAbsentOrWritableRegularFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) === 0) return false;
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

/**
 * Runs the Wiki command using a canonical request context supplied by the caller.
 * @param {object} commandCtx OpenClaw command context.
 * @param {object} deps Wiki command dependencies.
 * @returns {Promise<{text: string}>} Rendered command response.
 */
export async function runWikiCommand(
  commandCtx,
  {
    pool,
    sharedPool = null,
    embeddings,
    reranker,
    callLlm,
    cfg,
    api,
    llmCfg,
    archiveDir,
    ctx: suppliedCtx,
    memoryCtx: legacyCtx,
    now: suppliedNow,
    workspaceDir: suppliedWorkspaceDir,
    workspaceAliases,
  },
) {
  const parsed = parseWikiCommandInput(commandCtx?.args);
  const { lang, tone } = resolveLocaleFromCtx(commandCtx);
  if (!parsed.ready) {
    return {
      text: t(parsed.responseKey, {
        lang,
        tone,
        vars: parsed.responseVars,
      }),
    };
  }

  const memoryCtx = suppliedCtx
    || legacyCtx
    || resolveMemoryRequestContext(commandCtx, { workspaceAliases });
  const denied = checkWikiAuth(memoryCtx, cfg, {
    destructive: parsed.destructive,
    chatKind: memoryCtx.chatKind,
    localeCtx: commandCtx,
  });
  if (denied) return denied;

  const requestNow = typeof suppliedNow === "number" && Number.isFinite(suppliedNow)
    ? suppliedNow
    : Date.now();
  const logger = api?.logger;

  if (parsed.action === "add") {
    if (!memoryCtx.workspaceIdentity) {
      return {
        text: t("wiki.search_error", {
          lang,
          tone,
          vars: { error: "memory context requires a bound workspace" },
        }),
      };
    }
    try {
      return await withDbLease(pool, memoryCtx.agentId, async (db) => {
        await db.init();
        return wikiAdd(parsed, {
          db,
          sharedPool,
          embeddings,
          ctx: memoryCtx,
          lang,
          tone,
          requestNow,
          logger,
        });
      });
    } catch (error) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: error.message } }) };
    }
  }

  if (parsed.action === "delete") {
    const workspaceDir = canonicalAuditWorkspace(memoryCtx, suppliedWorkspaceDir);
    try {
      return await withDbLease(pool, memoryCtx.agentId, async (db) => {
        await db.init();
        return withSharedWorkspaceDb(sharedPool, memoryCtx, { write: true }, (sharedDb) => wikiDelete(parsed.rest, {
          db,
          sharedDb,
          embeddings,
          ctx: memoryCtx,
          lang,
          tone,
          archiveDir,
          workspaceDir,
          requestNow,
          logger,
        }), logger);
      });
    } catch (error) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: error.message } }) };
    }
  }

  try {
    return await withDbLease(pool, memoryCtx.agentId, async (db) => {
      await db.init();
      return withSharedWorkspaceDb(sharedPool, memoryCtx, {}, (sharedDb) => wikiSearch(parsed.args, {
        db,
        sharedDb,
        embeddings,
        reranker,
        callLlm,
        llmCfg,
        lang,
        tone,
        logger,
        ctx: memoryCtx,
        requestNow,
      }), logger);
    });
  } catch (error) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: error.message } }) };
  }
}
