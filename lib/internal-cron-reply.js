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
 * @param {object|null|undefined} result
 * @returns {{text: string, presentation?: object, presentationTextMode?: "fallback"}}
 */
export function formatClassifierCronReply(result) {
  if (result?.error) {
    throw new Error("PLUR1BUS classify-recent failed");
  }
  const messages = Array.isArray(result?.pushMessages)
    ? result.pushMessages
      .filter((message) => typeof message?.text === "string" && message.text.trim().length > 0)
    : [];
  if (messages.length > 0) {
    const errorCount = Number(result?.errors) > 0 ? Number(result.errors) : 0;
    const partialFailureWarning = errorCount > 0
      ? `⚠️ ${errorCount} weitere ${errorCount === 1 ? "Karte konnte" : "Karten konnten"} in diesem Lauf nicht verarbeitet werden.`
      : "";
    const text = [
      messages.map((message) => message.text).join("\n\n"),
      partialFailureWarning,
    ].filter(Boolean).join("\n\n");
    const blocks = [];
    let hasButtons = false;
    messages.forEach((message, messageIndex) => {
      if (messageIndex > 0) blocks.push({ type: "divider" });
      blocks.push({ type: "text", text: message.text });
      const rows = Array.isArray(message.inline_keyboard) ? message.inline_keyboard : [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const buttons = row
          .filter((button) => (
            typeof button?.text === "string"
            && button.text.trim().length > 0
            && typeof button?.callback_data === "string"
            && button.callback_data.trim().length > 0
          ))
          .map((button) => ({
            label: button.text,
            action: { type: "callback", value: button.callback_data },
          }));
        if (buttons.length === 0) continue;
        blocks.push({ type: "buttons", buttons });
        hasButtons = true;
      }
    });
    if (partialFailureWarning) {
      blocks.push({ type: "divider" });
      blocks.push({ type: "text", text: partialFailureWarning });
    }
    if (hasButtons) {
      return {
        text,
        presentation: { blocks },
        presentationTextMode: "fallback",
      };
    }
    return { text };
  }
  if (Number(result?.errors) > 0) {
    throw new Error("PLUR1BUS classify-recent failed");
  }
  return SILENT_REPLY;
}
