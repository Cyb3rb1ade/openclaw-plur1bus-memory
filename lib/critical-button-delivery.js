/**
 * lib/critical-button-delivery.js — sendet den Critical Push als eigene
 * Telegram-Nachricht je Karte mit „Annehmen“/„Ablehnen“ (7.16.10).
 *
 * Die Cron-Ausgabe kann nur Text tragen, deshalb sendet das Plugin selbst über
 * den Telegram-Outbound-Adapter des Hosts an das Ziel, an das der
 * classify-recent-Cron seinen Text bisher zustellt. Scheitert etwas, bekommt
 * der Aufrufer die noch nicht gesendeten Karten als Text zurück und liefert
 * sie wie bisher über die Cron-Zustellung aus.
 */

import { buildCriticalButtonMessages } from "./critical-buttons.js";

/**
 * @param {object} params
 * @param {string} params.agentId
 * @param {object} params.result - Ergebnis von runClassifier (pushMessages, errors)
 * @param {object} params.config - effektive OpenClaw-Konfiguration
 * @param {{channel: string, to: string, accountId?: string}|null} params.delivery - Zustellziel des Crons mit Bot-Konto
 * @param {(channel: string) => Promise<object|undefined>} params.loadAdapter
 * @param {string} [params.warning] - Hinweis auf Teilfehler für die letzte Nachricht
 * @param {object} [params.logger]
 * @returns {Promise<{sent: number, unsentTexts: string[], reason?: string}>}
 */
export async function deliverCriticalButtonPush({ agentId, result, config, delivery, loadAdapter, warning = "", logger }) {
  const pushMessages = Array.isArray(result?.pushMessages) ? result.pushMessages : [];
  const allTexts = pushMessages.map((message) => message?.text).filter((text) => typeof text === "string" && text.trim());
  const fallback = (reason, sent = 0) => ({ sent, unsentTexts: allTexts.slice(sent), reason });

  const messages = buildCriticalButtonMessages(agentId, pushMessages, { warning });
  if (!messages) return fallback("not_buttonable");
  if (!delivery || delivery.channel !== "telegram" || !delivery.to || !delivery.accountId) {
    return fallback("no_telegram_target");
  }

  let adapter;
  try {
    adapter = await loadAdapter("telegram");
  } catch (error) {
    logger?.warn?.(`critical-buttons[${agentId}]: telegram adapter unavailable: ${error?.message || error}`);
  }
  if (typeof adapter?.sendPayload !== "function") return fallback("adapter_unavailable");

  let sent = 0;
  for (const message of messages) {
    try {
      await adapter.sendPayload({
        cfg: config,
        to: delivery.to,
        accountId: delivery.accountId,
        text: message.text,
        payload: {
          text: message.text,
          channelData: { telegram: { buttons: message.buttons } },
        },
      });
      sent += 1;
    } catch (error) {
      logger?.warn?.(`critical-buttons[${agentId}]: send failed after ${sent} message(s): ${error?.message || error}`);
      return fallback("send_failed", sent);
    }
  }
  return { sent, unsentTexts: [] };
}
