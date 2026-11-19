/**
 * lib/group-reasoning-filter.js — keeps agents from answering another bot's
 * visible reasoning in group chats.
 *
 * With `/reasoning stream` OpenClaw posts the model's thinking as a live
 * preview message ("🧠 …") and deletes it after the final answer. Other bots in
 * the group receive that preview as an ordinary new message. On 04.10.2026
 * Bernd got Bernhardine's preview one second after it was posted, started a
 * turn on it, and Anthropic refused the request ("reasoning_extraction":
 * duplicating model outputs). The filter claims such turns in
 * `before_agent_reply` without a reply: no model call, no message.
 *
 * 7.20.2: messages from known human senders (channel allowFrom lists) are
 * never claimed. On 19.11.2026 the filter swallowed Christian's explicit
 * mentions of Bernd and Bernhardine in the group; the filter is meant for
 * other bots only.
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
 * Collect the sender ids of the humans allowed on any channel (`allowFrom`,
 * `groupAllowFrom`, per account). Wildcards are skipped.
 *
 * @param {object} [hostConfig] OpenClaw config
 * @returns {Set<string>}
 */
export function collectHumanSenderIds(hostConfig) {
  const ids = new Set();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const id = String(entry ?? "").trim();
      if (id && id !== "*") ids.add(id);
    }
  };
  const addScope = (scope) => {
    if (!scope || typeof scope !== "object") return;
    add(scope.allowFrom);
    add(scope.groupAllowFrom);
  };
  const channels = hostConfig?.channels;
  if (!channels || typeof channels !== "object") return ids;
  for (const channel of Object.values(channels)) {
    addScope(channel);
    const accounts = channel?.accounts;
    if (accounts && typeof accounts === "object") Object.values(accounts).forEach(addScope);
  }
  return ids;
}

// Sender ids may arrive as "telegram:123" or "123".
function bareSenderId(value) {
  const raw = String(value ?? "").trim();
  return raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
}

function matchedPrefix(text, prefixes) {
  const list = Array.isArray(prefixes) && prefixes.length > 0
    ? prefixes.map((p) => String(p || "").trim().toLowerCase()).filter(Boolean)
    : DEFAULT_GROUP_REASONING_PREFIXES;
  const raw = String(text || "").trimStart();
  const candidates = [raw, raw.replace(SENDER_LABEL, "")].map((c) => c.toLowerCase());
  return list.find((prefix) => candidates.some((c) => c.startsWith(prefix))) || "?";
}

/**
 * Build the `before_agent_reply` / `before_dispatch` handler.
 *
 * @param {{enabled?: boolean, prefixes?: string[], logger?: object, humanSenderIds?: () => Iterable<string|number>}} [opts]
 * @returns {(event: object, ctx: object) => ({handled: true} | undefined)}
 */
export function createGroupReasoningFilter(opts = {}) {
  const enabled = opts.enabled !== false;
  const prefixes = opts.prefixes;
  const logger = opts.logger;
  const humanSenderIds = typeof opts.humanSenderIds === "function" ? opts.humanSenderIds : null;
  const isHumanSender = (senderId) => {
    if (!humanSenderIds || !senderId) return false;
    try {
      const wanted = bareSenderId(senderId);
      for (const id of humanSenderIds() || []) {
        if (bareSenderId(id) === wanted) return true;
      }
    } catch (error) {
      logger?.debug?.(`memory-lancedb-namespaced: group reasoning filter could not read human sender ids: ${error?.message || error}`);
    }
    return false;
  };
  return (event, ctx) => {
    if (!enabled) return undefined;
    // before_dispatch carries isGroup on the event, before_agent_reply only the session key.
    if (event?.isGroup !== true && !isGroupHookContext({ ...ctx, sessionKey: ctx?.sessionKey || event?.sessionKey })) return undefined;
    // body is the bare message text; content/cleanedBody may carry an envelope.
    const bodies = [event?.body, event?.cleanedBody, event?.content, event?.text].filter((b) => typeof b === "string" && b);
    const hit = bodies.find((body) => isForeignReasoningMessage(body, { prefixes }));
    if (!hit) return undefined;
    const senderId = event?.senderId ?? ctx?.senderId ?? ctx?.requesterSenderId;
    if (isHumanSender(senderId)) return undefined;
    logger?.info?.(`memory-lancedb-namespaced: ignored another model's visible reasoning in a group (agent=${ctx?.agentId || "?"}, session=${ctx?.sessionKey || "?"}, sender=${senderId ?? "?"}, prefix=${matchedPrefix(hit, prefixes)})`);
    return { handled: true };
  };
}
