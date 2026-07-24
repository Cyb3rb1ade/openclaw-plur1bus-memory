/**
 * critical-push-classifier — entscheidet, ob eine neue Memory-Card
 * proaktiv an den User gepusht werden soll (Telegram-Push mit Bestätigung).
 *
 * Trennt LLM-Klassifikation (classifyMemory) von Routing-Logik (shouldPush)
 * und Render (buildPushMessage). Production-Wiring (Cron-Job, Telegram-Bot)
 * passiert in Phase 5.
 */

export const CRITICAL_TYPES = [
  "person",
  "beziehung",
  "geburtstag",
  "geld_konto",
  "gesundheit",
  "zugang_passwort",
];

const CLASSIFY_PROMPT_TEMPLATE = (content) => `
Du klassifizierst eine NEUE Memory-Karte in genau EINEN Typ. Gib NUR den Typ
als Antwort, ohne Erklärung, ohne Code-Blocks. Wenn nichts passt: "fakt".

Mögliche Typen:
- person:           neue Person mit Identitätsinfo (Name, Rolle)
- beziehung:        zwischenmenschliche Verbindung (Familie, Partner, Freund)
- geburtstag:       Geburtstag oder Jahrestag einer Person
- geld_konto:       Bankkonto, Karte, IBAN, Zahlungsmittel
- gesundheit:       Diagnose, Medikament, Allergie, Termin
- zugang_passwort:  Passwort, API-Key, Login, Token
- fakt:             alles andere (Default)

Memory-Inhalt:
"""
${content}
"""

Antwort (nur ein Typ):`.trim();

/**
 * Klassifiziert eine Card via injected model.
 *
 * @param {string} content
 * @param {object} model — { complete: async ({prompt}) => {text} }
 * @returns {Promise<string>} — ein Typ aus CRITICAL_TYPES oder "fakt"
 * @throws {*} when model completion rejects
 */
export async function classifyMemory(content, model) {
  if (!content || !model || typeof model.complete !== "function") {
    return "fakt";
  }
  const prompt = CLASSIFY_PROMPT_TEMPLATE(content);
  const response = await model.complete({ prompt });
  const raw = String(response?.text || "").trim().toLowerCase();
  if (CRITICAL_TYPES.includes(raw)) return raw;
  if (raw === "fakt") return "fakt";
  return "fakt";
}

/**
 * Entscheidet, ob eine Card gepusht werden soll.
 *
 * @param {object} card — { type, date }
 * @param {object} dailyCounts — { 'YYYY-MM-DD': count }
 * @param {object} opts — { maxPerDay (default 3) }
 */
export function shouldPush(card, dailyCounts, opts = {}) {
  if (!card || !CRITICAL_TYPES.includes(card.type)) return false;
  const max = opts.maxPerDay ?? 3;
  const date = card.date || new Date().toISOString().slice(0, 10);
  const used = (dailyCounts && dailyCounts[date]) || 0;
  return used < max;
}

/**
 * Rendert eine Push-Karte mit 3 Inline-Buttons.
 *
 * Buttons:
 *   ✅ OK     → bestätigt, Card bleibt
 *   ❌ Falsch → Card wird verworfen
 *   ✏️ Edit   → User wird zu /korrigier geleitet
 */
export function buildPushMessage(card) {
  const id = card.id || "unknown";
  const typeLabel = {
    person: "Person",
    beziehung: "Beziehung",
    geburtstag: "Geburtstag",
    geld_konto: "Geld/Konto",
    gesundheit: "Gesundheit",
    zugang_passwort: "Zugang/Passwort",
  }[card.type] || card.type || "Karte";

  const title = card.title || "(ohne Titel)";
  const body = card.text || card.summary || "";
  const source = card.source || "?";
  const date = card.date || "?";

  const text = [
    `🔔 *Neue kritische Erinnerung* — ${typeLabel}`,
    "",
    `*${title}*`,
    body ? `\n${body}` : "",
    "",
    `_${source} · ${date}_`,
    "",
    "Stimmt das? Bitte kurz bestätigen.",
  ].join("\n");

  const inline_keyboard = [
    [
      { text: "✅ OK", callback_data: `crit:ok:${id}` },
      { text: "❌ Falsch", callback_data: `crit:no:${id}` },
      { text: "✏️ Korrigier", callback_data: `crit:edit:${id}` },
    ],
  ];
  return { text, inline_keyboard };
}
