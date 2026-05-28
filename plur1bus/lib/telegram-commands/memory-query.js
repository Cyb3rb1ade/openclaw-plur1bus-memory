/**
 * /memory — Inspektions-Command.
 *
 * Parsing- und Render-Logik (pur). Der Command-Handler in index.js injiziert
 * den DB-Adapter (siehe lib/db-adapter.js).
 *
 * Zwei Modi:
 *   - time:  z.B. "heute", "gestern", "diese Woche", "Mai"
 *   - topic: alles andere, z.B. "über Eva", "PinchTab Bug"
 */

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
 * Parsed eine User-Anfrage in {mode, range|topic}.
 *
 * @param {string} input
 * @returns {{mode: 'time'|'topic'|'help', range?: string, topic?: string}}
 */
export function parseQuery(input) {
  const raw = (input || "").trim();
  if (!raw) return { mode: "help" };

  const lower = raw.toLowerCase();

  // Zeit-Keywords (zuerst, weil sie eindeutiger sind)
  if (TIME_KEYWORDS[lower]) {
    return { mode: "time", range: TIME_KEYWORDS[lower] };
  }
  // Monatsname (einzelnes Wort)
  const tokens = raw.split(/\s+/);
  if (tokens.length === 1 && MONTH_NAMES.has(lower)) {
    // Capitalize first letter for display key
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    return { mode: "time", range: `month:${cap}` };
  }

  // Topic-Präfixe
  for (const re of TOPIC_PREFIXES) {
    const m = raw.match(re);
    if (m) {
      // Capture-Group ist die letzte
      const topic = m[m.length - 1].trim();
      if (topic) return { mode: "topic", topic };
    }
  }

  // Default: ganzer String als Topic
  return { mode: "topic", topic: raw };
}

/**
 * Routet den geparsten Query an den DB-Adapter.
 *
 * @param {object} db    — { queryByTimeRange, searchByTopic }
 * @param {string} agent
 * @param {object} parsed — Output von parseQuery
 * @returns {Promise<Array>}
 */
export async function queryMemory(db, agent, parsed) {
  if (!parsed || parsed.mode === "help") return [];
  if (parsed.mode === "time") {
    return db.queryByTimeRange(agent, parsed.range);
  }
  if (parsed.mode === "topic") {
    return db.searchByTopic(agent, parsed.topic);
  }
  return [];
}

function formatRangeLabel(range) {
  if (range === "today") return "von heute";
  if (range === "yesterday") return "von gestern";
  if (range === "this_week") return "aus dieser Woche";
  if (range === "this_month") return "aus diesem Monat";
  if (range && range.startsWith("month:")) return `aus ${range.slice("month:".length)}`;
  return range || "";
}

function formatHelp() {
  return [
    "🧠 /memory — Erinnerungen einsehen",
    "",
    "Beispiele:",
    "• /memory heute",
    "• /memory diese Woche",
    "• /memory Mai",
    "• /memory über Eva",
    "• /memory was weißt du über Riva",
  ].join("\n");
}

/**
 * Rendert eine Trefferliste als Telegram-Markdown.
 *
 * @param {Array} items   — [{title, source, date, id}]
 * @param {object} parsed — parseQuery-Output, beeinflusst Header
 * @returns {string}
 */
export function formatResults(items, parsed) {
  if (parsed?.mode === "help") return formatHelp();

  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length === 0) {
    if (parsed?.mode === "time") {
      return `🧠 Keine Erinnerungen ${formatRangeLabel(parsed.range)}.`;
    }
    if (parsed?.mode === "topic") {
      return `🧠 Nichts gefunden zu "${parsed.topic}".`;
    }
    return "🧠 Keine Erinnerungen gefunden.";
  }

  const MAX_SHOW = 5;
  const shown = safeItems.slice(0, MAX_SHOW);
  const more = safeItems.length - MAX_SHOW;

  const header = parsed?.mode === "time"
    ? `🧠 Erinnerungen ${formatRangeLabel(parsed.range)} (${safeItems.length}):`
    : parsed?.mode === "topic"
      ? `🧠 Treffer für "${parsed.topic}" (${safeItems.length}):`
      : `🧠 Erinnerungen (${safeItems.length}):`;

  const lines = [header, ""];
  for (const item of shown) {
    const title = item.title || "(ohne Titel)";
    const source = item.source || "?";
    const date = item.date || "?";
    lines.push(`• ${title}`);
    lines.push(`  _${source} · ${date}_`);
  }
  if (more > 0) {
    lines.push("");
    lines.push(`(Mehr: ${more} weitere — /memory mit engerer Frage)`);
  }
  return lines.join("\n");
}
