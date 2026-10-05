/**
 * lib/group-reasoning-filter.js — keeps agents from answering another bot's
 * visible reasoning in group chats.
 *
 * With `/reasoning stream` the host posts the model's thinking as a live
 * preview message ("🧠 …") and deletes it after the final answer. Other bots in
 * the group receive that preview as an ordinary new message. One bot then
 * started a turn on another bot's preview, and the model provider refused the
 * request ("reasoning_extraction": duplicating model outputs). The filter
 * claims such turns in `before_agent_reply` without a reply: no model call,
 * no message.
 */

export const DEFAULT_GROUP_REASONING_PREFIXES = Object.freeze([
  "🧠",
  "💭",
  "<think>",
  "<thinking>",
  "reasoning:",
  "thinking:",
]);

// "[Name]: " or "Name: " in front of the body, as some channels format group lines.
const SENDER_LABEL = /^\s*(?:\[[^\]\n]{1,80}\]|[^\s:\n][^:\n]{0,60}):\s+/;

/**
 * Does a group message look like another model's visible reasoning?
 *
 * @param {unknown} text inbound message body
 * @param {{prefixes?: string[]}} [opts]
 * @returns {boolean}
 */
export function isForeignReasoningMessage(text, opts = {}) {
  const prefixes = Array.isArray(opts.prefixes) && opts.prefixes.length > 0
    ? opts.prefixes.map((p) => String(p || "").trim().toLowerCase()).filter(Boolean)
    : DEFAULT_GROUP_REASONING_PREFIXES;
  const raw = String(text || "").trimStart();
  if (!raw) return false;
  const candidates = [raw];
  const withoutLabel = raw.replace(SENDER_LABEL, "");
  if (withoutLabel !== raw) candidates.push(withoutLabel);
  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    return prefixes.some((prefix) => lower.startsWith(prefix));
  });
}

/**
 * Is this hook context a group conversation?
 *
 * @param {object} ctx hook context
 * @returns {boolean}
 */
export function isGroupHookContext(ctx = {}) {
  const chatType = String(ctx?.chatType || ctx?.channelContext?.chatType || "").toLowerCase();
  if (["group", "supergroup", "channel"].includes(chatType)) return true;
  return /:(?:group|channel):/.test(String(ctx?.sessionKey || ""));
}

/**
 * Build the `before_agent_reply` / `before_dispatch` handler.
 *
 * @param {{enabled?: boolean, prefixes?: string[], logger?: object}} [opts]
 * @returns {(event: object, ctx: object) => ({handled: true} | undefined)}
 */
export function createGroupReasoningFilter(opts = {}) {
  const enabled = opts.enabled !== false;
  const prefixes = opts.prefixes;
  const logger = opts.logger;
  return (event, ctx) => {
    if (!enabled) return undefined;
    // before_dispatch carries isGroup on the event, before_agent_reply only the session key.
    if (event?.isGroup !== true && !isGroupHookContext({ ...ctx, sessionKey: ctx?.sessionKey || event?.sessionKey })) return undefined;
    // body is the bare message text; content/cleanedBody may carry an envelope.
    const bodies = [event?.body, event?.cleanedBody, event?.content, event?.text].filter((b) => typeof b === "string" && b);
    if (!bodies.some((body) => isForeignReasoningMessage(body, { prefixes }))) return undefined;
    logger?.info?.(`memory-lancedb-namespaced: ignored another model's visible reasoning in a group (agent=${ctx?.agentId || "?"}, session=${ctx?.sessionKey || "?"})`);
    return { handled: true };
  };
}
