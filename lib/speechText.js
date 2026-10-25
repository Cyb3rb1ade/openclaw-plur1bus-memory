import { validateInput } from "./input-limits.js";

function removePrivateBlocks(text) {
  const stack = [];
  let visible = "";
  let cursor = 0;
  for (const match of text.matchAll(/<(\/?)(think|thinking|analysis|reasoning)\b[^>]*>/gi)) {
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (!closing) {
      if (!stack.length) visible += text.slice(cursor, match.index);
      stack.push(name);
    } else if (stack.at(-1) === name) {
      stack.pop();
      if (!stack.length) cursor = match.index + match[0].length;
    }
  }
  return visible + (stack.length ? "" : text.slice(cursor));
}

/**
 * Prepare canonical spoken words once, stripping private/transport markup and blocking raw directions.
 * @param {string} text Source text.
 * @param {{maxChars?:number}} [options] Unicode code point cap including an ellipsis.
 * @returns {{text:string,blocked:boolean,reason?:string}} Canonical speech or a text-only failure.
 */
export function prepareSpeechText(text, { maxChars = 2000 } = {}) {
  if (text == null || text === "") return { text: "", blocked: false };
  if (typeof text !== "string" || !validateInput(text, { maxLength: 100000, name: "speech text" }).ok) return { text: "", blocked: true, reason: "invalid_input" };
  let clean = removePrivateBlocks(text)
    .replace(/\[\[(?:reply_to_current|reply_to:[^\]\r\n]*|audio_as_voice)\]\]/gi, "")
    .replace(/^[ \t]*MEDIA:[^\r\n]*$/gm, "")
    .replace(/^\s*(?:NO_REPLY|HEARTBEAT_OK)\s*$/, "")
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "")
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]*|[-*+][ \t]+)/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(?<!\w)[*_]([^\n]*?)[*_](?!\w)/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Never pass arbitrary provider instructions through the canonical text.
  if (/[\[\]]/.test(clean.replace(/\[\d+\]/g, ""))) return { text: clean, blocked: true, reason: "raw_direction" };
  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.min(2000, Math.floor(maxChars))) : 2000;
  const points = [...clean];
  if (points.length > cap) {
    if (cap === 0) clean = "";
    else {
      const prefix = points.slice(0, cap - 1).join("");
      // If the next code point continues a word, remove that partial word.
      const complete = /\s/u.test(points[cap - 1] || "") ? prefix : prefix.replace(/\S+$/u, "");
      clean = complete.trimEnd() + "…";
    }
  }
  return { text: clean, blocked: false };
}
