const SILENT_REPLY = Object.freeze({ text: "NO_REPLY" });

/**
 * Convert an Afterthought job result into a direct OpenClaw cron reply.
 *
 * @param {object|null|undefined} result
 * @returns {{text: string}}
 */
export function formatAfterthoughtCronReply(result) {
  if (result?.reason === "error" || result?.error) {
    throw new Error("PLUR1BUS afterthought failed");
  }
  if (typeof result?.text === "string" && result.text.trim().length > 0) {
    return { text: result.text };
  }
  return SILENT_REPLY;
}

/**
 * Convert a Critical Push classifier result into a direct OpenClaw cron reply.
 *
 * OpenClaw liefert keine Callback-Ereignisse an Plugins — deshalb wird keine
 * Presentation-/Button-Ausgabe erzeugt. Die Zustellung erfolgt als reiner Text
 * mit Kurzreferenz-Befehlen.
 *
 * @param {object|null|undefined} result
 * @returns {{text: string}}
 */
export function formatClassifierCronReply(result) {
  if (result?.error) {
    throw new Error("PLUR1BUS classify-recent failed");
  }
  const messages = Array.isArray(result?.pushMessages)
    ? result.pushMessages
      .filter((message) => typeof message?.text === "string" && message.text.trim().length > 0)
    : [];
  const errorCount = Number(result?.errors) > 0 ? Number(result.errors) : 0;
  const succeeded = Number(result?.processed) > 0 ? Number(result.processed) : 0;
  const partialFailureWarning = errorCount > 0
    ? `⚠️ ${errorCount} ${messages.length > 0 ? "weitere " : ""}${errorCount === 1 ? "Karte konnte" : "Karten konnten"} in diesem Lauf nicht verarbeitet werden.`
    : "";

  if (messages.length > 0) {
    const text = [
      messages.map((message) => message.text).join("\n\n"),
      partialFailureWarning,
    ].filter(Boolean).join("\n\n");
    return { text };
  }
  if (errorCount > 0) {
    // Hart scheitern nur beim Totalausfall. Vorher warf jeder Teilfehler, sobald
    // zufaellig keine Push-Karte anfiel — derselbe Teilfehler war mit Push-Karte
    // bloss eine Warnung. Ein Lauf mit 2 von 3 Fehlern galt damit als
    // Katastrophe, einer mit 1 von 16 als Warnung.
    if (succeeded === 0) {
      throw new Error("PLUR1BUS classify-recent failed");
    }
    return { text: partialFailureWarning };
  }
  return SILENT_REPLY;
}
