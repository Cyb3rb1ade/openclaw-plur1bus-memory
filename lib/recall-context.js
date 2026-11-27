/**
 * lib/recall-context.js — weighting recall hits by where they come from
 * (7.21.2, recall.contextWeighting).
 *
 * A memory from the chat the agent is answering in counts fully. Memories
 * from elsewhere (a direct chat shown in a group, group A in group B, group
 * knowledge in a direct chat, entries of unknown origin) are multiplied down,
 * not cut by a threshold: a very strong hit still makes it, weak ones do not.
 * At most `maxForeignPerBlock` foreign memories per block. Confidential
 * memories (lib/sensitivity.js) never leave their own chat; an unclassified
 * foreign memory counts as confidential. Only what is injected into a chat's
 * prompt (and the memory tools) is weighted; dreaming, skill mining,
 * consolidation and promotion still see everything.
 *
 * "The same chat" is the whole group or the whole direct chat (threads and
 * forum topics do not split it). Pure functions, never throw.
 */

import { normalizeSensitivity, normalizeSensitivitySource } from "./sensitivity.js";

/** Default multipliers per origin relation. */
export const CONTEXT_WEIGHT_DEFAULTS = Object.freeze({
  sameChat: 1,
  groupInDirect: 0.85,
  otherGroup: 0.5,
  unknown: 0.5,
  foreignDirect: 0.35,
});
export const CONTEXT_MAX_FOREIGN_DEFAULT = 5;

const PEER_KINDS = new Set(["direct", "dm", "group", "channel"]);

/**
 * The chat a session key belongs to, without thread or forum topic.
 *
 * @param {string} sessionKey e.g. agent:main:telegram:default:direct:55736530:thread:55736530:64934
 * @returns {{kind: "direct"|"group"|"channel"|"unknown", chatKey: string}}
 */
export function chatContextFromSessionKey(sessionKey) {
  const raw = typeof sessionKey === "string" ? sessionKey.trim().toLowerCase() : "";
  if (!raw) return { kind: "unknown", chatKey: "" };
  let rest = raw.replace(/^agent:[^:]+:/, "");
  const threadAt = rest.lastIndexOf(":thread:");
  if (threadAt >= 0) rest = rest.slice(0, threadAt);
  rest = rest.replace(/:topic:[^:]+$/, "");
  const parts = rest.split(":");
  const kindIndex = parts.findIndex((part, index) => index > 0 && PEER_KINDS.has(part));
  if (kindIndex < 1 || kindIndex >= parts.length - 1) return { kind: "unknown", chatKey: "" };
  const provider = parts[0];
  const account = kindIndex >= 2 ? parts[1] : "";
  const kindRaw = parts[kindIndex];
  const kind = kindRaw === "dm" ? "direct" : kindRaw;
  const peer = parts.slice(kindIndex + 1).join(":");
  if (!provider || !peer) return { kind: "unknown", chatKey: "" };
  // Direct chats are per bot account; a group is the same group for every account.
  const chatKey = kind === "direct" ? `${provider}:${account}:direct:${peer}` : `${provider}:${kind}:${peer}`;
  return { kind, chatKey };
}

/**
 * Resolve recall.contextWeighting.
 *
 * @param {object|boolean|undefined} raw
 * @returns {{enabled: boolean, weights: typeof CONTEXT_WEIGHT_DEFAULTS, maxForeignPerBlock: number}}
 */
export function resolveContextWeightingConfig(raw) {
  if (raw === false) return { enabled: false, weights: CONTEXT_WEIGHT_DEFAULTS, maxForeignPerBlock: CONTEXT_MAX_FOREIGN_DEFAULT };
  const cfg = raw && typeof raw === "object" ? raw : {};
  const weights = { ...CONTEXT_WEIGHT_DEFAULTS };
  for (const key of Object.keys(CONTEXT_WEIGHT_DEFAULTS)) {
    const value = Number(cfg.weights?.[key]);
    if (Number.isFinite(value) && value >= 0 && value <= 1) weights[key] = value;
  }
  const max = Number(cfg.maxForeignPerBlock);
  return {
    enabled: cfg.enabled !== false,
    weights: Object.freeze(weights),
    maxForeignPerBlock: Number.isInteger(max) && max >= 0 && max <= 100 ? max : CONTEXT_MAX_FOREIGN_DEFAULT,
  };
}

/**
 * Where a memory comes from, relative to the requesting chat.
 *
 * @param {{sessionKey?: string, origin?: string}} entry
 * @param {{kind: string, chatKey: string, ownerDirect?: boolean}} request
 *   `ownerDirect`: a direct chat with the agent's owner whose sender is
 *   proved; legacy rows (origin "dm", no sessionKey) count as this chat.
 * @returns {"sameChat"|"groupInDirect"|"otherGroup"|"foreignDirect"|"unknown"}
 */
export function originRelation(entry, request) {
  const own = chatContextFromSessionKey(entry?.sessionKey);
  const origin = String(entry?.origin || "").toLowerCase();
  if (own.chatKey) {
    if (request?.chatKey && own.chatKey === request.chatKey) return "sameChat";
    if (own.kind === "direct") return "foreignDirect";
    return request?.kind === "direct" ? "groupInDirect" : "otherGroup";
  }
  // Ohne sessionKey (Altbestand vor 7.20.10, Neo): nur die Herkunftsspalte.
  if (origin === "dm" && request?.kind === "direct" && request?.ownerDirect === true) return "sameChat";
  if (origin === "dm" && (request?.kind === "group" || request?.kind === "channel")) return "foreignDirect";
  if (origin === "group" && request?.kind === "direct") return "groupInDirect";
  return "unknown";
}

/**
 * The effective sensitivity of a memory: an LLM verdict (sidecar or column)
 * wins over the rules; nothing = "" (not classified).
 *
 * @param {object} entry
 * @param {(id: string) => ({sensitivity?: string, source?: string}|null)} [lookup] sidecar verdicts
 * @returns {{sensitivity: string, source: string}}
 */
export function effectiveSensitivity(entry, lookup = null) {
  const side = typeof lookup === "function" && entry?.id ? lookup(String(entry.id)) : null;
  const sideLevel = normalizeSensitivity(side?.sensitivity);
  if (sideLevel) return { sensitivity: sideLevel, source: normalizeSensitivitySource(side?.source) || "llm" };
  const level = normalizeSensitivity(entry?.sensitivity);
  return { sensitivity: level, source: level ? normalizeSensitivitySource(entry?.sensitivitySource) || "rules" : "" };
}

/**
 * Apply origin weighting, the confidentiality filter and the foreign cap to
 * a ranked list. Returns the new list (stable within equal scores) and the
 * counters for log and trace.
 *
 * @param {Array<{entry: object, score?: number, rerankScore?: number, weightedScore?: number}>} results
 * @param {object} args
 * @param {{kind: string, chatKey: string, ownerDirect?: boolean}} args.request
 * @param {ReturnType<typeof resolveContextWeightingConfig>} args.config
 * @param {(id: string) => object|null} [args.sensitivityLookup]
 * @param {(entry: object) => void} [args.enqueueClassification] called for a
 *   foreign candidate in a group that has no LLM verdict yet (not shown now)
 * @param {number} [args.limit] apply the foreign cap within the first `limit` places
 * @returns {{results: Array, counts: {same: number, foreignPassed: number, downweighted: number, filteredConfidential: number, queued: number, capped: number}}}
 */
export function applyContextWeighting(results, { request, config, sensitivityLookup = null, enqueueClassification = null, limit = Infinity } = {}) {
  const counts = { same: 0, foreignPassed: 0, downweighted: 0, filteredConfidential: 0, queued: 0, capped: 0 };
  if (!config?.enabled || !Array.isArray(results) || results.length === 0 || !request) return { results: results || [], counts };
  const inGroup = request.kind === "group" || request.kind === "channel";
  const weighed = [];
  for (const [position, r] of results.entries()) {
    const relation = originRelation(r?.entry, request);
    if (relation === "sameChat") {
      counts.same++;
      weighed.push({ r: { ...r, contextRelation: relation, contextWeight: 1 }, position, foreign: false });
      continue;
    }
    const { sensitivity, source } = effectiveSensitivity(r?.entry, sensitivityLookup);
    // Unklassifiziert und fremd zählt als vertraulich.
    if (!sensitivity || sensitivity === "confidential") {
      counts.filteredConfidential++;
      if (!sensitivity && inGroup && typeof enqueueClassification === "function") {
        try { enqueueClassification(r.entry); counts.queued++; } catch { /* best-effort */ }
      }
      continue;
    }
    // In Gruppen: fremd ohne LLM-Urteil beim ersten Mal nicht zeigen, sondern einstufen lassen.
    if (inGroup && source !== "llm") {
      counts.filteredConfidential++;
      if (typeof enqueueClassification === "function") {
        try { enqueueClassification(r.entry); counts.queued++; } catch { /* best-effort */ }
      }
      continue;
    }
    const weight = config.weights[relation] ?? config.weights.unknown;
    const base = Number.isFinite(r?.weightedScore) ? r.weightedScore : Number.isFinite(r?.rerankScore) ? r.rerankScore : r?.score;
    if (weight < 1) counts.downweighted++;
    weighed.push({
      r: { ...r, contextRelation: relation, contextWeight: weight, weightedScore: Number.isFinite(base) ? base * weight : base },
      position,
      foreign: true,
    });
  }
  const score = (item) => {
    const v = item.r.weightedScore ?? item.r.rerankScore ?? item.r.score;
    return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
  };
  weighed.sort((a, b) => (score(b) - score(a)) || (a.position - b.position));
  const out = [];
  let foreignTaken = 0;
  for (const item of weighed) {
    if (item.foreign && out.length < limit) {
      if (foreignTaken >= config.maxForeignPerBlock) { counts.capped++; continue; }
      foreignTaken++;
      counts.foreignPassed++;
    }
    out.push(item.r);
  }
  return { results: out, counts };
}

/**
 * Whether a direct chat is with the agent's owner, for the legacy rule
 * (origin "dm" without sessionKey counts as this chat). Needs a proved sender
 * (`userPrincipal`). The owner comes from `recall.contextWeighting.owners`
 * (`{ "<agentId>": ["telegram:55736530", ...] }`) or, without that, from the
 * host's channel account allowlist when it names exactly one person.
 * 7.21.3: a background turn without an inbound message (heartbeat, cron,
 * subagent completion) in the owner's direct chat counts too, without a
 * proved sender; its reply goes to that chat only (user decision 25.11.).
 *
 * @param {{sessionKey?: string, userPrincipal?: string, agentId?: string, owners?: object|null, hostConfig?: object|null, backgroundTurn?: boolean}} args
 * @returns {boolean}
 */
export function isOwnerDirectChat({ sessionKey, userPrincipal, agentId, owners = null, hostConfig = null, backgroundTurn = false } = {}) {
  const provedSender = typeof userPrincipal === "string" && userPrincipal !== "";
  if (!provedSender && backgroundTurn !== true) return false;
  const chat = chatContextFromSessionKey(sessionKey);
  if (chat.kind !== "direct") return false;
  const [provider, account, , ...peerParts] = chat.chatKey.split(":");
  const peer = peerParts.join(":");
  if (!provider || !peer) return false;
  const configured = owners && typeof owners === "object" ? owners[agentId] : null;
  if (Array.isArray(configured)) {
    return configured.some((value) => {
      const v = String(value ?? "").trim().toLowerCase();
      return v === peer || v === `${provider}:${peer}`;
    });
  }
  const channel = hostConfig?.channels?.[provider];
  const accountCfg = account && channel?.accounts?.[account] ? channel.accounts[account] : null;
  const allow = Array.isArray(accountCfg?.allowFrom) ? accountCfg.allowFrom
    : !account || account === "default" ? (Array.isArray(channel?.allowFrom) ? channel.allowFrom : null) : null;
  if (!Array.isArray(allow) || allow.length !== 1) return false;
  const only = String(allow[0] ?? "").trim().toLowerCase();
  return only === peer || only === `${provider}:${peer}`;
}

const SUBAGENT_COMPLETION_TOOLS = new Set(["subagent_announce", "subagent_settle"]);

/**
 * 7.21.3: Whether the host marks this turn as a subagent completion
 * (`inputProvenance.kind` "inter_session" from subagent_announce or
 * subagent_settle). sessions_send stays out: its replies can go to the
 * sending session.
 *
 * @param {object} [event]
 * @param {object} [hookCtx]
 * @returns {boolean}
 */
export function isSubagentCompletionTurn(event = {}, hookCtx = {}) {
  const provenance = hookCtx?.inputProvenance || event?.inputProvenance;
  if (!provenance || typeof provenance !== "object") return false;
  const kind = String(provenance.kind ?? "").trim().toLowerCase();
  const tool = String(provenance.sourceTool ?? "").trim().toLowerCase();
  return kind === "inter_session" && SUBAGENT_COMPLETION_TOOLS.has(tool);
}

/**
 * Weight and gate rows of the Neo lanes like the memory block: confidential
 * or unclassified foreign items drop out, foreign scores are multiplied,
 * at most `maxForeignPerBlock` foreign items stay.
 *
 * @param {Record<string, Array<{item: object, score?: number}>>} lanes
 * @param {object} args same as applyContextWeighting
 * @returns {{lanes: Record<string, Array>, counts: object}}
 */
export function applyContextWeightingToNeoLanes(lanes, args) {
  const flat = [];
  for (const [lane, rows] of Object.entries(lanes || {})) {
    for (const row of rows || []) {
      const item = row?.item || {};
      flat.push({
        lane,
        row,
        entry: {
          id: item.id,
          sessionKey: item.origin?.sessionKey || item.sessionKey || "",
          // Neo-Altbestand ohne sessionKey wird wie LanceDB-Altbestand mit
          // Herkunft "dm" behandelt: im DM mit dem Besitzer derselbe Chat, in
          // Gruppen fremde DM (stärkste Abwertung, LLM-Urteil nötig).
          origin: item.origin?.sessionKey || item.sessionKey ? "" : "dm",
          text: item.statement || item.content || "",
          sensitivity: item.sensitivity,
          sensitivitySource: item.sensitivitySource,
        },
        score: Number.isFinite(row?.score) ? row.score : 0,
      });
    }
  }
  const { results, counts } = applyContextWeighting(flat, { ...args, limit: Infinity });
  const out = {};
  for (const lane of Object.keys(lanes || {})) out[lane] = [];
  for (const r of results) {
    const weight = Number.isFinite(r.contextWeight) ? r.contextWeight : 1;
    out[r.lane].push(weight === 1 ? r.row : { ...r.row, score: (Number.isFinite(r.row?.score) ? r.row.score : 0) * weight });
  }
  return { lanes: out, counts };
}

/**
 * 7.21.2: The context policy of one recall, or null when weighting is off or
 * the requesting chat is not known (CLI, webchat, engine without session).
 *
 * @param {object} args `backgroundTurn` (7.21.3): turn without an inbound
 *   message, see isOwnerDirectChat.
 * @returns {{request: object, config: object, sensitivityLookup: Function, enqueueClassification: Function}|null}
 */
export function buildContextPolicy({ contextWeightingCfg, sensitivityStore, sessionKey, memoryCtx, agentId, owners, hostConfig, backgroundTurn = false }) {
  if (!contextWeightingCfg?.enabled) return null;
  const chat = chatContextFromSessionKey(sessionKey);
  if (chat.kind === "unknown") return null;
  return {
    request: {
      ...chat,
      ownerDirect: isOwnerDirectChat({ sessionKey, userPrincipal: memoryCtx?.userPrincipal, agentId, owners, hostConfig, backgroundTurn }),
      backgroundTurn: backgroundTurn === true,
    },
    config: contextWeightingCfg,
    sensitivityLookup: sensitivityStore ? (id) => sensitivityStore.lookup(id) : null,
    enqueueClassification: sensitivityStore ? (entry) => sensitivityStore.enqueue(entry, agentId) : null,
  };
}

/**
 * Whether a single memory may appear in this chat (CRR, Semantic Lens): same
 * chat, or foreign but classified as not confidential (in groups: by an LLM).
 *
 * @param {object} memory
 * @param {object} policy buildContextPolicy result
 * @returns {boolean}
 */
export function contextAllows(memory, policy) {
  const { results } = applyContextWeighting([{ entry: memory, score: 1 }], { ...policy, config: { ...policy.config, maxForeignPerBlock: Infinity } });
  return results.length === 1;
}
