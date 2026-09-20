/**
 * Wartezustaende der Importance-Klaerung.
 *
 * Zwei getrennte Wartezustaende, weil sie von verschiedenen Laeufern bedient
 * werden: `pending` nimmt der stuendliche emotion-refine-Cron (frische Zeilen,
 * rund 131 am Tag), `pending_backfill` ausschliesslich das Backfill-Skript in
 * Stapeln. Ohne die Trennung wuerde der Cron den gesamten Bestand Zeile fuer
 * Zeile abarbeiten und dabei je Zeile eine LanceDB-Version erzeugen — genau die
 * Fragmentierung, die am 13.09.2026 zu Gateway-Blockaden gefuehrt hat.
 */
export const IMPORTANCE_STATUS = Object.freeze({
  PENDING: "pending",
  PENDING_BACKFILL: "pending_backfill",
  FINAL: "final",
});

const KNOWN = new Set(Object.values(IMPORTANCE_STATUS));

/** Unbekanntes und Fehlendes gilt als geklaert — Bestandszeilen sind nicht "offen". */
export function normalizeImportanceStatus(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return KNOWN.has(text) ? text : IMPORTANCE_STATUS.FINAL;
}
