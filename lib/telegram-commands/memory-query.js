/**
 * /memory — Inspection command.
 *
 * Parsing and render logic (pure). The command handler in index.js injects
 * the DB adapter (see lib/db-adapter.js).
 *
 * Two modes:
 *   - time:  e.g. "heute", "gestern", "diese Woche", "Mai"
 *   - topic: everything else, e.g. "über Eva", "PinchTab Bug"
 */

import { t } from "../i18n.js";
import { parseFilters } from "../filter-parser.js";
import { filterMemoriesByAcl } from "../acl-middleware.js";
import { safeUuid } from "../sql-safety.js";
import { buildWhereClause } from "../filter-parser.js";
import { computeCutoff } from "../db-adapter.js";
import { distanceToScore } from "../score.js";
import {
  canonicalMemoryOriginKey,
  isRecallEntryLive,
  projectRecallEntry,
} from "../recall-pipeline.js";
import { withAccessReadDbs } from "../shared-memory.js";
import { trySafeWarn } from "../safe-logging.js";

const MONTH_NAMES = new Set([
  "januar", "februar", "märz", "maerz", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "dezember",
]);

const TIME_KEYWORDS = {
  heute: "today",
  today: "today",
  gestern: "yesterday",
  yesterday: "yesterday",
  "diese woche": "this_week",
  "die woche": "this_week",
  "this week": "this_week",
  "dieser monat": "this_month",
  "diesen monat": "this_month",
};

const TOPIC_PREFIXES = [
  /^was\s+weißt\s+du\s+(über|von)\s+(.+)$/i,
  /^was\s+weisst\s+du\s+(über|ueber|von)\s+(.+)$/i,
  /^erinnerst\s+du\s+dich\s+an\s+(.+)$/i,
  /^über\s+(.+)$/i,
  /^ueber\s+(.+)$/i,
  /^zu\s+(.+)$/i,
];

/**
 * Parses a user query into {mode, range|topic, filters}.
 *
 * Filter syntax (topic mode only):
 *   /memory <topic> [category:<cat>] [source:<src>] [origin:<origin>]
 *                    [minImportance:<0-1>] [from:YYYY-MM-DD] [to:YYYY-MM-DD]
 *                    [emotion:<emotion>]
 *
 * @param {string} input
 * @returns {{mode: 'time'|'topic'|'help', range?: string, topic?: string, filters?: object}}
 */
export function parseQuery(input) {
  let raw = (input || "").trim();
  if (!raw) return { mode: "help" };

  // Explicit help subcommand
  if (raw.toLowerCase() === "help") {
    return { mode: "help", helpReason: "explicit" };
  }

  // Detect --explain flag anywhere in the input
  const explain = /\s--explain\b/i.test(raw);
  if (explain) {
    raw = raw.replace(/\s--explain\b/gi, "").trim();
  }

  const lower = raw.toLowerCase();

  // Time keywords (first, because they are unambiguous)
  if (TIME_KEYWORDS[lower]) {
    return { mode: "time", range: TIME_KEYWORDS[lower], explain };
  }
  // Month name (single word)
  const tokens = raw.split(/\s+/);
  if (tokens.length === 1 && MONTH_NAMES.has(lower)) {
    // Capitalize first letter for display key
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    return { mode: "time", range: `month:${cap}`, explain };
  }

  // Extract filters from the end of the input
  const { topic: filteredTopic, filters, errors } = parseFilters(raw);

  // If there are parse errors, return help mode with errors
  if (errors && errors.length > 0) {
    return { mode: "help", helpReason: "filter_error", errors, explain };
  }

  const topic = filteredTopic || raw;

  // Topic prefixes
  for (const re of TOPIC_PREFIXES) {
    const m = topic.match(re);
    if (m) {
      // Capture group is the last one
      const extracted = m[m.length - 1].trim();
      if (extracted) return { mode: "topic", topic: extracted, filters, explain };
    }
  }

  // Default: remaining string as topic
  return { mode: "topic", topic, filters, explain };
}

/**
 * Routes the parsed query to the DB adapter.
 *
 * @param {object} db    — { queryByTimeRange, searchByTopic }
 * @param {string} agent
 * @param {object} parsed — Output of parseQuery
 * @returns {Promise<Array>}
 */
export async function queryMemory(db, agent, parsed, ctx = null) {
  if (!parsed || parsed.mode === "help") return [];
  let results = [];
  if (parsed.mode === "time") {
    results = await db.queryByTimeRange(agent, parsed.range, { ctx });
  } else if (parsed.mode === "topic") {
    results = await db.searchByTopic(agent, parsed.topic, { filters: parsed.filters, ctx });
  }
  if (ctx && results.length > 0) {
    results = filterMemoriesByAcl(ctx, results);
  }
  return results;
}

/**
 * Projects a persisted memory into the existing Telegram formatter shape.
 * @param {object} row Persisted memory row.
 * @returns {object} ACL-safe formatter card retaining provenance/lifecycle fields.
 */
export function projectMemoryQueryCard(row) {
  const entry = projectRecallEntry(row);
  const summary = entry.summary || entry.text || "";
  const sourceMap = {
    dm: "konversation",
    group: "gruppe",
    voice: "sprachnotiz",
    note: "notiz",
  };
  return {
    ...entry,
    title: summary.split("\n")[0].slice(0, 80) || "(ohne Titel)",
    source: sourceMap[entry.origin] || entry.origin || "notiz",
    date: entry.createdAt ? new Date(Number(entry.createdAt)).toISOString().slice(0, 10) : "",
    score: typeof row?._distance === "number" ? distanceToScore(row._distance) : row?.score,
    explanation: row?.explanation,
  };
}

/**
 * Queries one already-authorized physical MemoryDB with a hard acquisition bound.
 * @param {object} db Read-only MemoryDB.
 * @param {object} parsed Parsed /memory request.
 * @param {object} requestEmbeddings Request-bound embedding adapter.
 * @param {object} ctx Canonical memory request context.
 * @param {{hardLimit?: number, now?: number}} options Query limits.
 * @returns {Promise<object[]>} Projected live candidates.
 */
export async function queryMemoryDbCandidates(
  db,
  parsed,
  requestEmbeddings,
  ctx,
  { hardLimit = 100, now = Date.now() } = {},
) {
  if (!db || !parsed || parsed.mode === "help") return [];
  const initialized = await db.init();
  if (initialized === false || !db.table) return [];
  // Read-only LanceDB table handles can retain the version observed when the
  // lease was first opened. Rejoin the live head before every command query so
  // a completed /forget or /correct cannot remain visible through a stale
  // reader snapshot.
  if (typeof db.table.checkoutLatest === "function") {
    await db.table.checkoutLatest();
  }
  const limit = Math.min(MAX_CANDIDATES_PER_SOURCE, Math.max(1, Math.floor(hardLimit)));
  const lifecycleSql = `(status = 'active' OR status IS NULL) AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > ${now})`;
  let rows;
  if (parsed.mode === "topic") {
    const vector = await requestEmbeddings.embedQuery(parsed.topic);
    const filterClause = buildWhereClause(parsed.filters);
    const whereClause = filterClause ? `(${lifecycleSql}) AND (${filterClause})` : lifecycleSql;
    let query = db.table.vectorSearch(vector);
    if (typeof query.where === "function") query = query.where(whereClause);
    rows = await query.limit(limit).toArray();
  } else if (parsed.mode === "time") {
    const { from, to } = computeCutoff(parsed.range, now);
    // An invalidated row is dropped by isRecallEntryLive below; filtering it
    // in SQL as well keeps it from taking one of the `limit` newest slots.
    const epistemicSql = db.schemaFieldNames?.has("epistemicStatus")
      ? " AND (epistemicStatus IS NULL OR epistemicStatus != 'invalidated')"
      : "";
    const whereClause = `(${lifecycleSql})${epistemicSql} AND createdAt >= ${Math.floor(from)} AND createdAt <= ${Math.floor(to)}`;
    // Newest first (E1 final review I4). LanceDB's query has no ORDER BY and
    // returns rows in storage order (oldest first in practice), so a plain
    // .limit() picked the oldest rows of the window. Read a two-column
    // projection of the whole window, find the createdAt of the limit-th
    // newest row, and load only the rows at or after it; ties at that
    // boundary can return a few extra rows, which the sort and slice drop.
    const keys = await db.table.query().where(whereClause).select(["id", "createdAt"]).toArray();
    if (keys.length === 0) {
      rows = [];
    } else {
      const times = keys.map((key) => Number(key.createdAt)).sort((left, right) => right - left);
      const boundary = times[Math.min(limit, times.length) - 1];
      const windowRows = keys.length <= limit
        ? await db.table.query().where(whereClause).toArray()
        : await db.table.query().where(`${whereClause} AND createdAt >= ${Math.floor(boundary)}`).toArray();
      rows = windowRows
        .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
        .slice(0, limit);
    }
  } else {
    return [];
  }
  return rows
    .map(projectMemoryQueryCard)
    .filter((card) => isRecallEntryLive(card, now));
}

/** One more than the MemoryOps list maximum (100), so a caller can tell "more matched". */
const MAX_CANDIDATES_PER_SOURCE = 101;

function accessSourcePriority(kind) {
  return kind === "private" ? 0 : kind === "workspace" ? 1 : 2;
}

/**
 * Queries all authorized private/workspace/user pools and applies one global merge.
 * Each pool contributes at most `hardLimit` candidates (its best `hardLimit`
 * by score, or its newest in time mode), so the merged list's first
 * `hardLimit` entries are the global best/newest.
 * @param {object} options Query dependencies; `hardLimit` (default 100, at most 101) caps each pool.
 * @returns {Promise<object[]>} Globally ordered and origin-deduplicated cards.
 */
export async function queryMemoryAcrossAccessPools({
  privatePool,
  sharedPool,
  embeddings,
  agent,
  parsed,
  ctx,
  now = Date.now(),
  hardLimit = 100,
}) {
  if (!parsed || parsed.mode === "help") return [];
  let queryEmbedding;
  const requestEmbeddings = Object.freeze({
    embedQuery: (text) => {
      if (!queryEmbedding) {
        queryEmbedding = Promise.resolve(
          typeof embeddings.embedQuery === "function"
            ? embeddings.embedQuery(text, { agentId: agent })
            : embeddings.embed(text, { agentId: agent }),
        );
      }
      return queryEmbedding;
    },
    embed: (text) => embeddings.embed(text, { agentId: agent }),
  });
  const leaseCtx = { ...ctx, logger: ctx?.logger };
  return withAccessReadDbs(privatePool, sharedPool, agent, leaseCtx, async (sources) => {
    const settled = await Promise.allSettled(sources.map(async (source) => ({
      source,
      cards: await queryMemoryDbCandidates(
        source.db,
        parsed,
        requestEmbeddings,
        ctx,
        { hardLimit, now },
      ),
    })));
    const candidates = [];
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      const source = sources[index];
      if (result.status === "rejected") {
        if (!source.optional) throw result.reason;
        trySafeWarn(ctx?.logger, `memory-query.${source.namespace}`, result.reason);
        continue;
      }
      for (const card of result.value.cards) {
        candidates.push({ card, sourceKind: source.sourceKind, ordinal: candidates.length });
      }
    }
    const authorized = filterMemoriesByAcl(ctx, candidates.map(({ card }) => card));
    const authorizedSet = new Set(authorized);
    const winners = new Map();
    const unique = [];
    for (const candidate of candidates) {
      if (!authorizedSet.has(candidate.card)) continue;
      const key = canonicalMemoryOriginKey(candidate.card);
      if (!key) {
        unique.push(candidate);
        continue;
      }
      const existing = winners.get(key);
      if (!existing
        || accessSourcePriority(candidate.sourceKind) < accessSourcePriority(existing.sourceKind)) {
        winners.set(key, candidate);
      }
    }
    unique.push(...winners.values());
    unique.sort((left, right) => parsed.mode === "time"
      ? (Number(right.card.createdAt) - Number(left.card.createdAt)) || left.ordinal - right.ordinal
      : (Number(right.card.score ?? Number.NEGATIVE_INFINITY)
        - Number(left.card.score ?? Number.NEGATIVE_INFINITY)) || left.ordinal - right.ordinal);
    return unique.map(({ card }) => card);
  });
}

/**
 * Looks one memory id up across every pool the principal can reach — the same
 * private/workspace/user fan-out and ACL `queryMemoryAcrossAccessPools` applies
 * for a list — and returns the live, ACL-visible copy with the highest source
 * priority (private before workspace before user), or null.
 * @param {object} options Lookup dependencies.
 * @param {object} options.privatePool Private MemoryDB pool.
 * @param {object} options.sharedPool Shared workspace/user pool.
 * @param {string} options.agent Agent identifier.
 * @param {string} options.id Memory id (validated with safeUuid).
 * @param {object} options.ctx Canonical memory request context.
 * @param {number} [options.now] Liveness reference time.
 * @param {string[]|null} [options.sourceKinds] Restrict to these source kinds ("private", "workspace", "user").
 * @returns {Promise<{card: object, sourceKind: string}|null>} The visible copy, or null.
 */
export async function findMemoryAcrossAccessPools({
  privatePool,
  sharedPool,
  agent,
  id,
  ctx,
  now = Date.now(),
  sourceKinds = null,
}) {
  const safe = safeUuid(id);
  const leaseCtx = { ...ctx, logger: ctx?.logger };
  return withAccessReadDbs(privatePool, sharedPool, agent, leaseCtx, async (sources) => {
    const eligible = sources.filter((source) => source.db
      && (!sourceKinds || sourceKinds.includes(source.sourceKind)));
    const settled = await Promise.allSettled(eligible.map(async (source) => {
      const initialized = await source.db.init();
      if (initialized === false || !source.db.table) return null;
      // Same stale-reader guard as queryMemoryDbCandidates.
      if (typeof source.db.table.checkoutLatest === "function") {
        await source.db.table.checkoutLatest();
      }
      const rows = await source.db.table.query().where(`id = "${safe}"`).limit(1).toArray();
      return rows.length > 0 ? projectMemoryQueryCard(rows[0]) : null;
    }));
    const candidates = [];
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      const source = eligible[index];
      if (result.status === "rejected") {
        if (!source.optional) throw result.reason;
        trySafeWarn(ctx?.logger, `memory-query.find.${source.namespace}`, result.reason);
        continue;
      }
      if (result.value && isRecallEntryLive(result.value, now)) {
        candidates.push({ card: result.value, sourceKind: source.sourceKind });
      }
    }
    const authorized = new Set(filterMemoriesByAcl(ctx, candidates.map(({ card }) => card)));
    const visible = candidates.filter(({ card }) => authorized.has(card));
    visible.sort((left, right) => accessSourcePriority(left.sourceKind) - accessSourcePriority(right.sourceKind));
    return visible[0] ?? null;
  });
}

function formatRangeLabel(range, lang = "en", tone = "default") {
  if (range === "today") return t("range.today", { lang, tone });
  if (range === "yesterday") return t("range.yesterday", { lang, tone });
  if (range === "this_week") return t("range.this_week", { lang, tone });
  if (range === "this_month") return t("range.this_month", { lang, tone });
  if (range && range.startsWith("month:")) return t("range.month", { lang, tone, vars: { month: range.slice("month:".length) } });
  return range || "";
}

function formatHelp(lang = "en", tone = "default") {
  return [
    t("memory.help_header", { lang, tone }),
    "",
    t("memory.help_examples", { lang, tone }),
    "",
    t("memory.help_filters", { lang, tone }),
  ].join("\n");
}

function formatHelpWithErrors(errors, lang = "en", tone = "default") {
  const lines = [
    t("memory.help_filter_error_header", { lang, tone }),
    "",
  ];
  for (const err of errors) {
    lines.push(`• ${err}`);
  }
  lines.push("");
  lines.push(t("memory.help_filters", { lang, tone }));
  return lines.join("\n");
}

/**
 * Renders a result list as Telegram-Markdown.
 *
 * @param {Array} items   — [{title, source, date, id}]
 * @param {object} parsed — parseQuery output, influences header
 * @param {object} opts   — { lang, tone }
 * @returns {string}
 */
export function formatResults(items, parsed, opts = {}) {
  const { lang = "en", tone = "default", showIds = false } = opts;
  if (parsed?.mode === "help") {
    if (parsed.helpReason === "filter_error" && parsed.errors?.length > 0) {
      return formatHelpWithErrors(parsed.errors, lang, tone);
    }
    return formatHelp(lang, tone);
  }

  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length === 0) {
    if (parsed?.mode === "time") {
      return t("memory.no_results_time", { lang, tone, vars: { range: formatRangeLabel(parsed.range, lang, tone) } });
    }
    if (parsed?.mode === "topic") {
      return t("memory.no_results_topic", { lang, tone, vars: { topic: parsed.topic } });
    }
    return t("memory.no_results", { lang, tone });
  }

  const MAX_SHOW = 5;
  const shown = safeItems.slice(0, MAX_SHOW);
  const more = safeItems.length - MAX_SHOW;

  let header;
  if (parsed?.mode === "time") {
    header = t("memory.header_time", { lang, tone, vars: { range: formatRangeLabel(parsed.range, lang, tone), count: safeItems.length } });
  } else if (parsed?.mode === "topic") {
    header = t("memory.header_topic", { lang, tone, vars: { topic: parsed.topic, count: safeItems.length } });
  } else {
    header = t("memory.header_default", { lang, tone, vars: { count: safeItems.length } });
  }

  const lines = [header, ""];
  for (const item of shown) {
    const title = item.title || "(untitled)";
    const source = item.source || "?";
    const date = item.date || "?";
    lines.push(t("memory.item", { lang, tone, vars: { title, source, date } }));
    if (showIds && item.id) {
      lines.push(`  \`ID: ${item.id}\``);
    }
    if (parsed?.explain && item.explanation) {
      lines.push(`  _${item.explanation}_`);
    }
  }
  if (more > 0) {
    lines.push("");
    lines.push(t("memory.more_results", { lang, tone, vars: { count: more } }));
  }
  if (showIds) {
    lines.push("");
    lines.push(t("memory.feedback_hint", { lang, tone }));
  }
  return lines.join("\n");
}

const FEEDBACK_ALIASES = {
  "+": "positive",
  "👍": "positive",
  "positive": "positive",
  "-": "negative",
  "👎": "negative",
  "negative": "negative",
  "~": "neutral",
  "neutral": "neutral",
};

/**
 * Parses a memory-feedback command.
 * Syntax: /memory-feedback <memoryId> <feedback>
 *         /mf <memoryId> <feedback>
 *
 * @param {string} input
 * @returns {{memoryId: string, feedback: string}|null}
 */
export function parseMemoryFeedback(input) {
  const raw = (input || "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return null;
  let memoryId;
  try {
    memoryId = safeUuid(parts[0]);
  } catch {
    return null;
  }
  const feedbackRaw = parts[1].toLowerCase();
  const feedback = FEEDBACK_ALIASES[feedbackRaw];
  if (!feedback) return null;
  return { memoryId, feedback };
}
