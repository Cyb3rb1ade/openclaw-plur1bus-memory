/**
 * critical-push-classifier — entscheidet, ob eine neue Memory-Card
 * proaktiv an den User gepusht werden soll (Telegram-Push mit Bestätigung).
 *
 * Trennt LLM-Klassifikation (classifyMemory) von Routing-Logik (shouldPush)
 * und Render (buildPushMessage). Production-Wiring (Cron-Job, Telegram-Bot)
 * passiert in Phase 5.
 */

import { buildCriticalMessage } from "./critical-review.js";

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
- zugang_passwort:  enthaelt einen TATSAECHLICH vorhandenen Geheimniswert:
                    Passwort, API-Key, Token, Zugangscode, Wiederherstellungs-
                    schluessel. NICHT bei blosser Erwaehnung von Login, Zugriff,
                    Konten, Profil-, Werkzeug- oder Dienstnamen ohne konkretes
                    Geheimnis — auch nicht bei der Aufforderung, Zugangsdaten
                    NICHT zu nennen.
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
 * Rendert eine Critical-Review-Karte gemäß dem gemeinsamen UX-Vertrag.
 *
 * Aktionen als Textbefehle (OpenClaw liefert keine Callback-Ereignisse):
 *   „Bestätigen“        → /plur1bus critical accept <ref>
 *   „Nicht hervorheben“ → /plur1bus critical reject <ref> (verwirft nur die
 *                         Kennzeichnung, löscht NICHT)
 *   „Korrigieren“       → /plur1bus critical edit <ref> (sicherer Korrekturablauf)
 *
 * @param {object} card — { id, type, title, text, summary, source, date, sourceMessageRole, shortRef, reason }
 * @param {object} [opts] — { lang, tone }
 * @returns {{text: string}}
 */
export function buildPushMessage(card, opts = {}) {
  return buildCriticalMessage(card, opts);
}
