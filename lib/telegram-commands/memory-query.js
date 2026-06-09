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
  const raw = (input || "").trim();
  if (!raw) return { mode: "help" };

  // Explicit help subcommand
  if (raw.toLowerCase() === "help") {
    return { mode: "help", helpReason: "explicit" };
  }

  const lower = raw.toLowerCase();

  // Time keywords (first, because they are unambiguous)
  if (TIME_KEYWORDS[lower]) {
    return { mode: "time", range: TIME_KEYWORDS[lower] };
  }
  // Month name (single word)
  const tokens = raw.split(/\s+/);
  if (tokens.length === 1 && MONTH_NAMES.has(lower)) {
    // Capitalize first letter for display key
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    return { mode: "time", range: `month:${cap}` };
  }

  // Extract filters from the end of the input
  const { topic: filteredTopic, filters, errors } = parseFilters(raw);

  // If there are parse errors, return help mode with errors
  if (errors && errors.length > 0) {
    return { mode: "help", helpReason: "filter_error", errors };
  }

  const topic = filteredTopic || raw;

  // Topic prefixes
  for (const re of TOPIC_PREFIXES) {
    const m = topic.match(re);
    if (m) {
      // Capture group is the last one
      const extracted = m[m.length - 1].trim();
      if (extracted) return { mode: "topic", topic: extracted, filters };
    }
  }

  // Default: remaining string as topic
  return { mode: "topic", topic, filters };
}

/**
 * Routes the parsed query to the DB adapter.
 *
 * @param {object} db    — { queryByTimeRange, searchByTopic }
 * @param {string} agent
 * @param {object} parsed — Output of parseQuery
 * @returns {Promise<Array>}
 */
export async function queryMemory(db, agent, parsed) {
  if (!parsed || parsed.mode === "help") return [];
  if (parsed.mode === "time") {
    return db.queryByTimeRange(agent, parsed.range);
  }
  if (parsed.mode === "topic") {
    return db.searchByTopic(agent, parsed.topic, { filters: parsed.filters });
  }
  return [];
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
  const { lang = "en", tone = "default" } = opts;
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
  }
  if (more > 0) {
    lines.push("");
    lines.push(t("memory.more_results", { lang, tone, vars: { count: more } }));
  }
  return lines.join("\n");
}
