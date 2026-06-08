/**
 * lib/wiki-command.js — /wiki Telegram command for PLUR1BUS.
 *
 * /wiki <Begriff>              — search + LLM synthesis
 * /wiki add <Begriff>: <Text>  — store new wiki entry
 * /wiki delete <Begriff>       — delete by query (archive-first)
 * /wiki delete id:<UUID>       — delete by UUID directly
 */

import { randomUUID } from "node:crypto";
import { distanceToScore } from "./score.js";
import { applyDynamicsDefaults } from "./memory-dynamics.js";
import { archiveCard } from "./telegram-commands/memory-edit.js";
import { resolveLocale, readSoulToneCached, pickTone, t } from "./i18n.js";
import { isAuthorized, resolveIdentity } from "./security.js";
import { safeUuid } from "./sql-safety.js";

// ─── Locale ───────────────────────────────────────────────────────────────────

function resolveLocaleFromCtx(commandCtx) {
  const messages = commandCtx?.messages || [];
  const lang = resolveLocale({ ctx: commandCtx, messages, fallback: "en" });
  const toneHint = commandCtx?.workspaceDir ? readSoulToneCached(commandCtx.workspaceDir) : null;
  const tone = pickTone(toneHint);
  return { lang, tone };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Vector-searches a LanceDB table filtered to a specific memoryKind.
 * Phase 1: tries DB-level WHERE filter (modern LanceDB ≥0.9).
 * Phase 2: overfetch (limit*5) + JS post-filter (old LanceDB, fallback).
 *
 * For kind="memory", also includes legacy rows with empty/null memoryKind
 * so pre-migration entries remain visible.
 */
async function searchByKind(table, vector, kind, limit, minScore) {
  const kindFilter = kind === "memory"
    ? "memoryKind = 'memory' OR memoryKind IS NULL OR memoryKind = ''"
    : `memoryKind = '${kind}'`;
  const whereClause = `(${kindFilter}) AND (status = 'active' OR status IS NULL)`;

  // Phase 1: DB-level filter
  try {
    const builder = table.vectorSearch(vector);
    if (typeof builder.where === "function") {
      const rows = await builder.where(whereClause).limit(limit).toArray();
      // Array.isArray(rows) means DB answered — return even if empty (avoids
      // false fallback when the wiki is genuinely empty).
      if (Array.isArray(rows)) {
        return rows
          .map((r) => ({ entry: r, score: distanceToScore(r._distance) }))
          .filter((r) => r.score >= minScore);
      }
    }
  } catch (_) {}

  // Phase 2: Overfetch + JS post-filter
  try {
    const rows = await table.vectorSearch(vector).limit(limit * 5).toArray();
    const isMatch =
      kind === "memory"
        ? (r) => !r.memoryKind || r.memoryKind === "memory" || r.memoryKind === ""
        : (r) => r.memoryKind === kind;
    return rows
      .map((r) => ({ entry: r, score: distanceToScore(r._distance) }))
      .filter((r) => r.score >= minScore && isMatch(r.entry));
  } catch (_) {
    return [];
  }
}

/**
 * Builds an LLM-synthesized answer from recall results.
 * Falls back to bullet-point excerpts if callLlm is unavailable.
 */
async function synthesizeAnswer(results, query, lang, callLlm, llmCfg) {
  const memoryLines = results
    .slice(0, 6)
    .map((r, i) => {
      const entry = r.entry || r;
      return `[${i + 1}] ${(entry.text || entry.summary || "").slice(0, 400)}`;
    })
    .join("\n\n");

  if (llmCfg && callLlm) {
    try {
      const prompt =
        lang === "de"
          ? `Du bist ein Wissens-Assistent. Der Nutzer fragt: "${query}"\n\nHier sind relevante gespeicherte Erinnerungen (intern, nicht extern verifiziert):\n\n${memoryLines}\n\nFasse zusammen, was bekannt ist. Kennzeichne Unsicherheit. Maximal 3–4 Sätze.`
          : `You are a knowledge assistant. The user asks: "${query}"\n\nHere are relevant stored memories (internal, not externally verified):\n\n${memoryLines}\n\nSummarize what is known. Flag uncertainty. Maximum 3–4 sentences.`;
      const raw = await callLlm([{ role: "user", content: prompt }], { ...llmCfg, maxTokens: 400 });
      if (raw) {
        return raw.replace(/^```(?:\w+)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
      }
    } catch (_) {}
  }

  return results
    .slice(0, 3)
    .map((r) => {
      const entry = r.entry || r;
      return `• ${(entry.summary || entry.text || "").slice(0, 200)}`;
    })
    .join("\n");
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function checkWikiAuth(commandCtx, cfg, { destructive = false } = {}) {
  const identity = resolveIdentity(commandCtx);
  const auth = isAuthorized({ ...commandCtx, ...identity }, cfg, { destructive });
  if (!auth.authorized) {
    const { lang, tone } = resolveLocaleFromCtx(commandCtx);
    return { text: t("wiki.unauthorized", { lang, tone }) };
  }
  return null;
}

// ─── Search ───────────────────────────────────────────────────────────────────

async function wikiSearch(query, { db, embeddings, reranker, callLlm, llmCfg, lang, tone, logger }) {
  const { canonical, memories } = await runRecallPipeline({
    query,
    dbTable: db.table,
    embeddings,
    topN: 8,
    recallMinScore: 0.2,
    importanceBoost: 0.3,
    dedupEnabled: true,
    reranker: reranker || null,
    logger: logger || console,
  });

  const allResults = [...(canonical || []), ...(memories || [])];
  if (allResults.length === 0) {
    return { text: t("wiki.not_found", { lang, tone, vars: { query } }) };
  }

  // Build context block for synthesis
  const memoryLines = allResults.slice(0, 6).map((r, i) => {
    const entry = r.entry || r;
    const text = entry.text || entry.summary || "";
    return `[${i + 1}] ${text.slice(0, 400)}`;
  }).join("\n\n");

  let answer = null;
  if (llmCfg && callLlm) {
    try {
      const prompt = lang === "de"
        ? `Du bist ein Wissens-Assistent. Der Nutzer fragt: "${query}"\n\nHier sind relevante gespeicherte Erinnerungen (intern, nicht extern verifiziert):\n\n${memoryLines}\n\nFasse zusammen, was bekannt ist. Kennzeichne Unsicherheit. Maximal 3–4 Sätze.`
        : `You are a knowledge assistant. The user asks: "${query}"\n\nHere are relevant stored memories (internal, not externally verified):\n\n${memoryLines}\n\nSummarize what is known. Flag uncertainty. Maximum 3–4 sentences.`;
      const raw = await callLlm([{ role: "user", content: prompt }], { ...llmCfg, maxTokens: 400 });
      if (raw) {
        // Strip markdown code fences — some models wrap responses
        answer = raw.replace(/^```(?:\w+)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
      }
    } catch (_) {
      // Fallback to excerpts if LLM unavailable
    }
  }

  if (!answer) {
    // No LLM — return top excerpts directly
    answer = allResults.slice(0, 3).map(r => {
      const entry = r.entry || r;
      return `• ${(entry.summary || entry.text || "").slice(0, 200)}`;
    }).join("\n");
  }

  return { text: t("wiki.result", { lang, tone, vars: { query, answer } }) };
}

// ─── Add ──────────────────────────────────────────────────────────────────────

async function wikiAdd(rawArgs, { db, embeddings, agentId, lang, tone }) {
  // Parse: "Begriff: beschreibung"
  const colonIdx = rawArgs.indexOf(":");
  if (colonIdx < 1) {
    return { text: t("wiki.add_usage", { lang, tone }) };
  }
  const term = rawArgs.slice(0, colonIdx).trim();
  const bodyText = rawArgs.slice(colonIdx + 1).trim();
  if (!term || !bodyText) {
    return { text: t("wiki.add_usage", { lang, tone }) };
  }

  const fullText = `${term}: ${bodyText}`;
  let vector;
  try {
    vector = await embeddings.embed(fullText);
  } catch (err) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: err.message } }) };
  }

  // Duplicate check
  try {
    const existing = await db.findSimilar(vector, fullText, 0.92);
    if (existing && existing.length > 0) {
      const preview = existing[0].entry?.summary || existing[0].entry?.text || "";
      return { text: t("wiki.duplicate", { lang, tone, vars: { existing: preview.slice(0, 100) } }) };
    }
  } catch (_) {
    // findSimilar may fail if table is empty — proceed with store
  }

  const entry = applyDynamicsDefaults({
    id: randomUUID(),
    text: fullText,
    summary: `[Wiki] ${term}`,
    origin: "note",
    vector,
    importance: 0.9,
    category: "knowledge",
    memoryKind: "wiki",
    createdAt: Date.now(),
    mergedFrom: "[]",
    expiresAt: 0,
    storedBy: agentId,
    sourceTurnId: "",
    sourceMessageRole: "",
    sourceTimestamp: Date.now(),
    sourceUrl: "",
    evidenceQuote: "",
    scope: "workspace",
    emotionalValence: "neutral",
    emotionalIntensity: 0,
    emotionalDominant: "neutral",
    moodContextAtCapture: "",
  }, Date.now(), {});

  await db.store(entry);
  return { text: t("wiki.added", { lang, tone, vars: { term } }) };
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function wikiDelete(rawArgs, { db, embeddings, agentId, lang, tone }) {
  // By ID: /wiki delete id:<UUID>
  if (rawArgs.startsWith("id:")) {
    const rawId = rawArgs.slice(3).trim();
    const safeId = safeUuid(rawId);
    if (!safeId) return { text: t("wiki.delete_not_found", { lang, tone, vars: { query: rawId } }) };

    let card = null;
    try {
      card = await db.getById(safeId);
    } catch (_) {}
    if (!card) {
      try {
        const rows = await db.table.query().where(`id = "${safeId}"`).limit(1).toArray();
        if (rows.length > 0) card = rows[0];
      } catch (_) {}
    }
    if (!card) return { text: t("wiki.delete_not_found", { lang, tone, vars: { query: safeId } }) };

    try {
      archiveCard(card, agentId || "default");
    } catch (err) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: `Archive failed: ${err.message}` } }) };
    }
    await db.table.delete(`id = "${safeId}"`);
    return { text: t("wiki.deleted", { lang, tone }) };
  }

  // By query: search top-5, then decide
  const query = rawArgs.trim();
  if (!query) return { text: t("wiki.usage", { lang, tone }) };

  let vector;
  try {
    vector = await embeddings.embed(query);
  } catch (err) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: err.message } }) };
  }

  const results = await db.search(vector, 5, 0.25);
  if (!results || results.length === 0) {
    return { text: t("wiki.delete_not_found", { lang, tone, vars: { query } }) };
  }

  if (results.length === 1) {
    const card = results[0].entry;
    try {
      archiveCard(card, agentId || "default");
    } catch (err) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: `Archive failed: ${err.message}` } }) };
    }
    const safeId = safeUuid(card.id);
    if (safeId) await db.table.delete(`id = "${safeId}"`);
    return { text: t("wiki.deleted", { lang, tone }) };
  }

  // Multiple results — ask user to pick
  const list = results.map((r, i) => {
    const entry = r.entry;
    const preview = (entry.summary || entry.text || "").slice(0, 80);
    return `[${i + 1}] id:${entry.id}\n    ${preview}`;
  }).join("\n");
  return { text: t("wiki.delete_ambiguous", { lang, tone, vars: { query, list } }) };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * @param {object} commandCtx — OpenClaw command context
 * @param {object} deps — { pool, embeddings, reranker, callLlm, cfg, api, llmCfg }
 */
export async function runWikiCommand(commandCtx, { pool, embeddings, reranker, callLlm, cfg, api, llmCfg }) {
  const { lang, tone } = resolveLocaleFromCtx(commandCtx);
  const agentId = commandCtx.agentId || "default";
  const args = (commandCtx.args || "").trim();

  if (!args) {
    return { text: t("wiki.usage", { lang, tone }) };
  }

  const tokens = args.split(/\s+/);
  const subCmd = tokens[0]?.toLowerCase();

  if (subCmd === "add") {
    const denied = checkWikiAuth(commandCtx, cfg, { destructive: true });
    if (denied) return denied;
    const rest = args.slice(tokens[0].length).trim();
    if (!rest) return { text: t("wiki.add_usage", { lang, tone }) };
    const db = pool.getDb(agentId);
    await db.init();
    try {
      return await wikiAdd(rest, { db, embeddings, agentId, lang, tone });
    } catch (err) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: err.message } }) };
    }
  }

  if (subCmd === "delete" || subCmd === "löschen" || subCmd === "loeschen") {
    const denied = checkWikiAuth(commandCtx, cfg, { destructive: true });
    if (denied) return denied;
    const rest = args.slice(tokens[0].length).trim();
    if (!rest) return { text: t("wiki.usage", { lang, tone }) };
    const db = pool.getDb(agentId);
    await db.init();
    try {
      return await wikiDelete(rest, { db, embeddings, agentId, lang, tone });
    } catch (err) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: err.message } }) };
    }
  }

  // Default: search
  const db = pool.getDb(agentId);
  await db.init();
  try {
    return await wikiSearch(args, { db, embeddings, reranker, callLlm, llmCfg, lang, tone, logger: api.logger });
  } catch (err) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: err.message } }) };
  }
}
