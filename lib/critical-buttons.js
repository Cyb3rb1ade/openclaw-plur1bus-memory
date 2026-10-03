/**
 * lib/critical-buttons.js — Critical Push mit Telegram-Knöpfen (7.16.10).
 *
 * Jede Karte kommt als eigene Nachricht mit „✅ Annehmen“ und „❌ Ablehnen“.
 * Alle auf einmal bleibt über den Textbefehl `/plur1bus critical accept all`
 * oder eine zitierte Antwort möglich.
 *
 * Die Callback-Daten tragen Agent und Kurzreferenz, die Nachricht selbst
 * braucht keinen eigenen Speicher und übersteht einen Gateway-Neustart.
 *
 * Reine Funktionen, keine I/O — Versand und Handler verdrahtet index.js.
 */

import { t } from "./i18n.js";
import {
  buildPreview,
  resolveSourceRole,
  translateReason,
  translateSourceRole,
} from "./critical-review.js";

/** Namespace der Telegram-Callback-Daten (`<namespace>:<payload>`). */
export const CRITICAL_BUTTON_NAMESPACE = "plurc";

/** Telegram erlaubt höchstens 64 Byte callback_data. */
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const ACTION_CODES = Object.freeze({ a: "accept", r: "reject" });
const AGENT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const REF_TOKEN_RE = /^[0-9a-f]{3,32}$/;

function callbackData(code, agentId, ref) {
  return `${CRITICAL_BUTTON_NAMESPACE}:${code}:${agentId}:${ref}`;
}

function fitsTelegram(data) {
  return Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

/**
 * Text einer Karte für die Knopf-Nachricht: Überschrift, Vorschau, Grund,
 * Quelle und Kurzreferenz, ohne die Befehlszeilen der Textvariante.
 *
 * @param {object} card - Karte mit shortRef, type, reason und Quellrolle
 * @param {{lang?: string, hideTypes?: string[]}} [opts]
 * @returns {string}
 */
export function buildCriticalButtonCardText(card = {}, { lang = "de", hideTypes } = {}) {
  const preview = buildPreview(card, { lang, hideTypes });
  const quoted = preview.suppressed ? preview.reason : preview.text;
  const reason = translateReason(card?.reason || "", card?.type || "", lang);
  const source = translateSourceRole(resolveSourceRole(card), lang);
  const refLabel = lang === "de" ? "Referenz" : "Reference";
  return [
    t("critical.headline", { lang }),
    "",
    `„${quoted || "…"}“`,
    t("critical.reason", { lang, vars: { reason } }),
    t("critical.source", { lang, vars: { source } }),
    `${refLabel}: ${card?.shortRef || ""}`,
  ].join("\n");
}

/**
 * Baut die Nachrichten für einen Push, eine je Karte. Liefert `null`, wenn
 * eine Karte keine Kurzreferenz oder keinen Text hat oder die Callback-Daten
 * nicht in 64 Byte passen — dann bleibt es bei der Textnachricht.
 *
 * @param {string} agentId
 * @param {Array<{shortRef: string, buttonText: string}>} messages - pushMessages
 * @param {{lang?: string, warning?: string}} [opts]
 * @returns {Array<{text: string, buttons: Array<Array<object>>}>|null}
 */
export function buildCriticalButtonMessages(agentId, messages, { lang = "de", warning = "" } = {}) {
  if (!AGENT_RE.test(String(agentId || ""))) return null;
  const cards = Array.isArray(messages) ? messages : [];
  if (cards.length === 0) return null;
  if (cards.some((card) => !REF_TOKEN_RE.test(card?.shortRef || "") || !card?.buttonText)) return null;

  const out = [];
  for (const card of cards) {
    const accept = callbackData("a", agentId, card.shortRef);
    const reject = callbackData("r", agentId, card.shortRef);
    if (!fitsTelegram(accept) || !fitsTelegram(reject)) return null;
    out.push({
      text: [card.buttonText, t("critical.buttons_hint", { lang })].join("\n\n"),
      buttons: [[
        { text: t("critical.button_accept", { lang }), callback_data: accept, style: "success" },
        { text: t("critical.button_reject", { lang }), callback_data: reject, style: "danger" },
      ]],
    });
  }
  if (warning) out[out.length - 1].text += `\n\n${warning}`;
  return out;
}

/**
 * Zerlegt die Callback-Nutzlast (`a:<agent>:<ref>` oder `r:<agent>:<ref>`).
 *
 * @param {string} payload - Teil nach dem Namespace
 * @returns {{action: "accept"|"reject", agentId: string, ref: string}|null}
 */
export function parseCriticalButtonPayload(payload) {
  const parts = String(payload || "").split(":");
  const action = ACTION_CODES[parts[0]];
  if (!action || parts.length !== 3 || !AGENT_RE.test(parts[1]) || !REF_TOKEN_RE.test(parts[2])) return null;
  return { action, agentId: parts[1], ref: parts[2] };
}

/**
 * Zeile, die nach einer Entscheidung an die Nachricht angehängt wird.
 *
 * @param {string} ref
 * @param {"accepted"|"rejected"|"failed"} outcome
 * @param {{lang?: string}} [opts]
 * @returns {string}
 */
export function criticalDecisionLine(ref, outcome, { lang = "de" } = {}) {
  if (outcome === "accepted") return `✅ ${ref} ${t("critical.button_accepted", { lang })}`;
  if (outcome === "rejected") return `❌ ${ref} ${t("critical.button_rejected", { lang })}`;
  return `⚠️ ${ref} ${t("critical.button_failed", { lang })}`;
}
