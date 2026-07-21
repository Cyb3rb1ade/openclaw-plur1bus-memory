/**
 * Canonical, immutable identity context for every memory data boundary.
 * Host routing support is loaded lazily so this package remains directly testable.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { INPUT_LIMITS, validateInput } from "./input-limits.js";
import { safeAgentId } from "./sql-safety.js";
import { safeWarn } from "./safe-logging.js";

const EMPTY_WORKSPACE_ALIASES = Object.freeze({
  paths: Object.freeze([]),
  aliases: Object.freeze([]),
});
const ROUTING_EXPORTS = Object.freeze([
  "parseAgentSessionKey",
  "parseThreadSessionSuffix",
  "normalizeOptionalAccountId",
  "normalizeMessageChannel",
]);
const SUPPORTED_PEER_KINDS = new Set(["direct", "dm", "group", "channel"]);
const COMMAND_BODY_LIMIT = INPUT_LIMITS.COMMAND_ARGS;

/** Hash an identity deterministically without exposing it in path names. */
export function stableIdentityHash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** Return the safe, fixed-size physical key for a workspace pool. */
export function workspacePoolKey(workspaceIdentity) {
  return `w-${stableIdentityHash(workspaceIdentity).slice(0, 62)}`;
}

/** Return the safe, fixed-size physical key for a user pool. */
export function userPoolKey(userPrincipal) {
  return `u-${stableIdentityHash(userPrincipal).slice(0, 62)}`;
}

/** Strictly validate an identity without coercing objects or booleans. */
export function validatedIdentity(value, maxLength, name, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} is required`);
    return "";
  }
  let canonical;
  if (typeof value === "string") canonical = value.trim();
  else if (typeof value === "number" && Number.isSafeInteger(value) && Number.isFinite(value)) canonical = String(value);
  else throw new Error(`${name} must be a string or finite safe integer`);
  if (required && !canonical) throw new Error(`${name} is required`);
  const result = validateInput(canonical, { maxLength, name, required });
  if (!result.ok) throw new Error(result.error);
  return result.value ?? canonical;
}

function normalizeChatKind(value) {
  if (value === "private") return "private";
  if (value === "group") return "group";
  return "unknown";
}

function extractRawIdentity(ctx, kind) {
  if (kind === "user") return ctx?.userId ?? ctx?.senderId;
  if (kind === "chat") return ctx?.chatId;
  return undefined;
}

function normalizeWorkspaceTarget(value, name = "workspace alias target") {
  const target = validatedIdentity(value, INPUT_LIMITS.AGENT_ID, name, { required: true });
  return target.startsWith("workspace:v1:") || target.startsWith("workspace-dir:v1:")
    ? target
    : `workspace:v1:${target}`;
}

function normalizeWorkspacePath(value) {
  const path = validatedIdentity(value, INPUT_LIMITS.SESSION_KEY, "workspace path", { required: true });
  return realpathSync(path);
}

/** Normalize and deeply freeze a trusted workspace alias snapshot. */
export function normalizeAndFreezeWorkspaceAliases(source = EMPTY_WORKSPACE_ALIASES) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("invalid workspace alias snapshot");
  }
  if (!Array.isArray(source.paths) || !Array.isArray(source.aliases)) {
    throw new Error("invalid workspace alias snapshot");
  }
  const paths = new Map();
  const aliases = new Map();
  for (const entry of source.paths) {
    if (!entry || typeof entry !== "object") throw new Error("invalid workspace alias snapshot");
    const path = normalizeWorkspacePath(entry.path);
    const target = normalizeWorkspaceTarget(entry.workspaceKey);
    if (paths.has(path) && paths.get(path) !== target) throw new Error("conflicting workspace path declaration");
    paths.set(path, target);
  }
  for (const entry of source.aliases) {
    if (!entry || typeof entry !== "object") throw new Error("invalid workspace alias snapshot");
    const alias = validatedIdentity(entry.alias, INPUT_LIMITS.AGENT_ID, "workspace alias", { required: true });
    const target = normalizeWorkspaceTarget(entry.workspaceKey);
    if (aliases.has(alias) && aliases.get(alias) !== target) throw new Error("conflicting workspace alias declaration");
    aliases.set(alias, target);
  }
  return Object.freeze({
    paths: Object.freeze([...paths].map(([path, workspaceKey]) => Object.freeze({ path, workspaceKey }))),
    aliases: Object.freeze([...aliases].map(([alias, workspaceKey]) => Object.freeze({ alias, workspaceKey }))),
  });
}

function workspaceMaps(snapshot) {
  return {
    paths: new Map(snapshot.paths.map((entry) => [entry.path, entry.workspaceKey])),
    aliases: new Map(snapshot.aliases.map((entry) => [entry.alias, entry.workspaceKey])),
  };
}

/** Canonicalize all present workspace facts and reject disagreement. */
export function resolveCanonicalWorkspacePrincipal(bindings, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const snapshot = normalizeAndFreezeWorkspaceAliases(workspaceAliases);
  const maps = workspaceMaps(snapshot);
  const principals = [];
  for (const raw of [bindings?.explicitId, bindings?.explicitKey]) {
    if (!raw) continue;
    if (raw.startsWith("workspace:v1:") || raw.startsWith("workspace-dir:v1:")) principals.push(raw);
    else principals.push(maps.aliases.get(raw) || `workspace:v1:${raw}`);
  }
  if (bindings?.canonicalDir) {
    principals.push(maps.paths.get(bindings.canonicalDir) || `workspace-dir:v1:${bindings.canonicalDir}`);
  }
  const unique = [...new Set(principals)];
  if (unique.length > 1) throw new Error("conflicting workspace identity");
  return unique[0] || "";
}

/** Build the immutable memory request context used by ACL and storage. */
export function resolveMemoryRequestContext(commandCtx, {
  requireWorkspace = false,
  requireUser = false,
  workspaceAliases = EMPTY_WORKSPACE_ALIASES,
} = {}) {
  const normalizedWorkspaceAliases = normalizeAndFreezeWorkspaceAliases(workspaceAliases);
  const rawAgentId = validatedIdentity(commandCtx?.agentId, INPUT_LIMITS.AGENT_ID, "agentId", { required: true });
  const agentId = safeAgentId(rawAgentId);
  const explicitId = validatedIdentity(commandCtx?.workspaceId, INPUT_LIMITS.AGENT_ID, "workspaceId");
  const explicitKey = validatedIdentity(commandCtx?.workspaceKey, INPUT_LIMITS.AGENT_ID, "workspaceKey");
  const canonicalDir = commandCtx?.workspaceDir ? normalizeWorkspacePath(commandCtx.workspaceDir) : "";
  const workspaceIdentity = resolveCanonicalWorkspacePrincipal(
    { explicitId, explicitKey, canonicalDir },
    normalizedWorkspaceAliases,
  );
  const userId = validatedIdentity(extractRawIdentity(commandCtx, "user"), INPUT_LIMITS.USER_ID, "userId");
  const channel = validatedIdentity(commandCtx?.channel ?? commandCtx?.provider, INPUT_LIMITS.CHANNEL_ID, "channel");
  const accountId = validatedIdentity(commandCtx?.accountId ?? commandCtx?.account_id, INPUT_LIMITS.ACCOUNT_ID, "accountId");
  const userPrincipal = userId && channel && accountId
    ? `user:v1:${stableIdentityHash(JSON.stringify([channel, accountId, userId]))}`
    : "";
  if (requireWorkspace && !workspaceIdentity) throw new Error("memory context requires a bound workspace");
  if (requireUser && !userPrincipal) throw new Error("memory context requires a channel/account-bound authenticated user");
  return Object.freeze({
    agentId,
    workspaceId: workspaceIdentity,
    workspaceIdentity,
    userId,
    userPrincipal,
    channel,
    accountId,
    chatId: validatedIdentity(extractRawIdentity(commandCtx, "chat"), INPUT_LIMITS.CHAT_ID, "chatId"),
    conversationPrincipal: validatedIdentity(commandCtx?.conversationPrincipal, INPUT_LIMITS.PRINCIPAL, "conversationPrincipal"),
    chatKind: normalizeChatKind(commandCtx?.chatKind),
    sessionKey: validatedIdentity(commandCtx?.sessionKey, INPUT_LIMITS.SESSION_KEY, "sessionKey"),
    sessionId: validatedIdentity(commandCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId"),
    workspaceDir: canonicalDir,
    workspaceAliases: normalizedWorkspaceAliases,
  });
}

function validateRoutingCapability(module) {
  const capability = module?.default && typeof module.default === "object" ? { ...module.default, ...module } : module;
  if (!capability || ROUTING_EXPORTS.some((name) => typeof capability[name] !== "function")) {
    throw new Error("OpenClaw routing capability is missing required public exports");
  }
  return Object.freeze(Object.fromEntries(ROUTING_EXPORTS.map((name) => [name, capability[name]])));
}

/** Create a memoized lazy loader for the public OpenClaw routing SDK. */
export function createHostRoutingLoader({ importRouting = () => import("openclaw/plugin-sdk/routing"), logger = null } = {}) {
  let loadPromise = null;
  return async function loadHostRouting() {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(importRouting)
        .then(validateRoutingCapability)
        .catch((error) => {
          safeWarn(logger, "memory-request-context.routing", error);
          throw error;
        });
    }
    return loadPromise;
  };
}

function collectRawWorkspaceEntries(cfg) {
  const entries = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const key = value.workspaceKey ?? value.workspace_id ?? value.workspaceId ?? value.id ?? value.key ?? value.name;
    if (key) {
      for (const path of [
        value.path, value.workspacePath, value.workspaceDir, value.vaultPath, value.dir, value.workspace,
        ...(Array.isArray(value.paths) ? value.paths : []),
      ].filter(Boolean)) entries.push({ type: "path", value: path, key });
      for (const alias of [
        value.alias, value.label, value.agent_id, value.agentId, value.agent,
        value.workspace_id, value.workspaceId, value.id, value.name,
        ...(Array.isArray(value.aliases) ? value.aliases : []),
        ...(Array.isArray(value.legacyKeys) ? value.legacyKeys : []),
      ].filter(Boolean)) {
        entries.push({ type: "alias", value: alias, key });
      }
    }
  };
  visit(cfg?.obsidianBridge?.workspaces);
  visit(cfg?.neo?.workspaces);
  const addAliasSource = (source) => {
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (!entry || typeof entry !== "object") continue;
        const key = entry.workspaceKey ?? entry.workspace_id ?? entry.workspaceId ?? entry.target ?? entry.id;
        for (const alias of [entry.alias, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].filter(Boolean)) {
          entries.push({ type: "alias", value: alias, key });
        }
      }
      return;
    }
    for (const [alias, key] of Object.entries(source || {})) entries.push({ type: "alias", value: alias, key });
  };
  addAliasSource(cfg?.workspaceAliases);
  addAliasSource(cfg?.neo?.workspaceAliases);
  return entries;
}

/** Build a conflict-checked trusted workspace snapshot once at registration. */
export function buildMemoryWorkspaceAliases(cfg = {}, precomputedNeoAliases = EMPTY_WORKSPACE_ALIASES) {
  const paths = [];
  const aliases = [];
  for (const entry of collectRawWorkspaceEntries(cfg)) {
    if (entry.type === "path") paths.push({ path: entry.value, workspaceKey: entry.key });
    else aliases.push({ alias: entry.value, workspaceKey: entry.key });
  }
  for (const entry of precomputedNeoAliases?.paths || []) paths.push(entry);
  for (const entry of precomputedNeoAliases?.aliases || []) aliases.push(entry);
  return normalizeAndFreezeWorkspaceAliases({ paths, aliases });
}

function normalizeProvider(value, routingCapability) {
  const provider = routingCapability.normalizeMessageChannel(value);
  return provider ? validatedIdentity(provider, INPUT_LIMITS.CHANNEL_ID, "channel", { required: true }) : "";
}

function normalizeAccount(value, routingCapability) {
  const account = routingCapability.normalizeOptionalAccountId(value);
  return account ? validatedIdentity(account, INPUT_LIMITS.ACCOUNT_ID, "accountId", { required: true }) : "";
}

function parseSupportedTarget(value, expectedProvider, routingCapability) {
  if (!value) return null;
  const target = validatedIdentity(value, INPUT_LIMITS.SESSION_KEY, "conversation target", { required: true });
  const parts = target.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const provider = normalizeProvider(parts.shift(), routingCapability);
  if (!provider || (expectedProvider && provider !== expectedProvider)) return null;
  let peerKind = "direct";
  if (parts.length === 2) peerKind = parts.shift();
  if (!SUPPORTED_PEER_KINDS.has(peerKind) || !parts[0]) return null;
  const peerId = validatedIdentity(parts[0], INPUT_LIMITS.CHAT_ID, "chatId", { required: true });
  return { provider, peerKind: peerKind === "dm" ? "direct" : peerKind, peerId };
}

function parseDeliveryPeer(value, expectedProvider, routingCapability) {
  if (!value) return "";
  const raw = validatedIdentity(value, INPUT_LIMITS.SESSION_KEY, "delivery target", { required: true });
  if (!raw.includes(":")) return validatedIdentity(raw, INPUT_LIMITS.CHAT_ID, "chatId", { required: true });
  return parseSupportedTarget(raw, expectedProvider, routingCapability)?.peerId || "";
}

function parseSessionFacts(sessionKey, routingCapability) {
  const raw = validatedIdentity(sessionKey, INPUT_LIMITS.SESSION_KEY, "sessionKey", { required: true });
  const parsed = routingCapability.parseAgentSessionKey(raw);
  if (!parsed || !parsed.agentId || !parsed.rest) throw new Error("invalid canonical agent session key");
  const agentId = safeAgentId(validatedIdentity(parsed.agentId, INPUT_LIMITS.AGENT_ID, "session agentId", { required: true }));
  const thread = routingCapability.parseThreadSessionSuffix(parsed.rest);
  const rest = validatedIdentity(thread?.baseSessionKey ?? parsed.rest, INPUT_LIMITS.SESSION_KEY, "session route", { required: true });
  const threadId = validatedIdentity(thread?.threadId, INPUT_LIMITS.THREAD_ID, "threadId");
  const parts = rest.split(":");
  const peerIndex = parts.findIndex((part) => SUPPORTED_PEER_KINDS.has(part));
  let route = null;
  let accountId = "";
  if (peerIndex >= 1 && peerIndex === parts.length - 2) {
    const provider = normalizeProvider(parts[0], routingCapability);
    const peerKind = parts[peerIndex] === "dm" ? "direct" : parts[peerIndex];
    const peerId = validatedIdentity(parts[peerIndex + 1], INPUT_LIMITS.CHAT_ID, "chatId", { required: true });
    if (peerIndex === 2) accountId = normalizeAccount(parts[1], routingCapability);
    else if (peerIndex !== 1) throw new Error("unsupported canonical session route");
    route = { provider, peerKind, peerId };
  }
  return {
    agentId,
    rest: parsed.rest,
    sessionKey: `agent:${agentId}:${parsed.rest}`,
    route,
    accountId,
    threadId,
  };
}

function assertSame(label, values) {
  const present = [...new Set(values.filter(Boolean))];
  if (present.length > 1) throw new Error(`conflicting ${label}`);
  return present[0] || "";
}

/** Decode and cross-check a host command route using only public SDK functions. */
export function resolveHostCommandRouteFacts(commandCtx, routingCapability) {
  const capability = validateRoutingCapability(routingCapability);
  const agentId = safeAgentId(validatedIdentity(commandCtx?.agentId, INPUT_LIMITS.AGENT_ID, "agentId", { required: true }));
  const session = parseSessionFacts(commandCtx?.sessionKey, capability);
  if (session.agentId !== agentId) throw new Error("conflicting command and session agentId");
  const channel = normalizeProvider(commandCtx?.channel, capability);
  const from = parseSupportedTarget(commandCtx?.from, channel, capability);
  const rawTo = typeof commandCtx?.to === "string" && /^slash:/i.test(commandCtx.to) ? null : commandCtx?.to;
  const to = parseSupportedTarget(rawTo, channel, capability);
  if (!from) throw new Error("unsupported or missing inbound conversation route");
  const provider = assertSame("conversation provider", [channel, from.provider, to?.provider, session.route?.provider]);
  const peerKind = assertSame("conversation peer kind", [from.peerKind, to?.peerKind, session.route?.peerKind]);
  const parentPeerId = validatedIdentity(commandCtx?.threadParentId, INPUT_LIMITS.CHAT_ID, "threadParentId");
  const routePeerId = assertSame("conversation peer", [from.peerId, to?.peerId, session.route?.peerId, parentPeerId]);
  const explicitThreadId = validatedIdentity(commandCtx?.messageThreadId, INPUT_LIMITS.THREAD_ID, "threadId");
  const threadId = assertSame("conversation thread", [explicitThreadId, session.threadId]);
  return Object.freeze({
    agentId,
    sessionKey: session.sessionKey,
    channel: provider,
    accountId: normalizeAccount(commandCtx?.accountId, capability),
    peerKind,
    parentPeerId: parentPeerId || routePeerId,
    conversationId: threadId || routePeerId,
    threadId,
    chatKind: peerKind === "direct" ? "private" : "group",
  });
}

function conversationPrincipalFor(facts, sessionId) {
  const present = Boolean(sessionId);
  const payload = [
    "plur1bus-confirmation", 1, facts.agentId, facts.sessionKey,
    ["sessionId", present, sessionId || ""], facts.channel, facts.accountId,
    facts.peerKind, facts.parentPeerId, facts.conversationId,
    ["threadId", Boolean(facts.threadId), facts.threadId || ""],
  ];
  return `conversation:v1:${stableIdentityHash(JSON.stringify(payload))}`;
}

/** Resolve an official PluginCommandContext into a canonical memory context. */
export async function resolveHostCommandMemoryContext(commandCtx, {
  resolveAgentWorkspaceDir,
  workspaceAliases = EMPTY_WORKSPACE_ALIASES,
  routingLoader = createHostRoutingLoader(),
  requireWorkspace = false,
  requireUser = false,
  requireConversation = false,
} = {}) {
  const routingCapability = await routingLoader();
  const facts = resolveHostCommandRouteFacts(commandCtx, routingCapability);
  let binding = null;
  if (typeof commandCtx?.getCurrentConversationBinding === "function") binding = await commandCtx.getCurrentConversationBinding();
  if (binding) {
    assertSame("binding agent", [facts.agentId, binding.agentId]);
    assertSame("binding channel", [facts.channel, binding.channel]);
    assertSame("binding account", [facts.accountId, binding.accountId]);
  }
  if (requireConversation && (!facts.channel || !facts.accountId || !facts.parentPeerId || !facts.conversationId)) {
    throw new Error("memory context requires a verified conversation");
  }
  if (typeof resolveAgentWorkspaceDir !== "function") throw new Error("resolveAgentWorkspaceDir capability is required");
  const workspaceDir = await resolveAgentWorkspaceDir(commandCtx?.config, facts.agentId);
  const sessionId = validatedIdentity(commandCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId");
  return resolveMemoryRequestContext({
    agentId: facts.agentId,
    workspaceDir,
    senderId: commandCtx?.senderId,
    channel: facts.channel,
    accountId: facts.accountId,
    chatId: facts.parentPeerId,
    chatKind: facts.chatKind,
    sessionKey: facts.sessionKey,
    sessionId,
    conversationPrincipal: facts.channel && facts.accountId
      ? conversationPrincipalFor(facts, sessionId)
      : "",
  }, { workspaceAliases, requireWorkspace, requireUser });
}

/** Resolve trusted agent-tool identity fields into the same frozen contract. */
export function resolveToolMemoryRequestContext(toolCtx, options = {}) {
  const delivery = toolCtx?.deliveryContext && typeof toolCtx.deliveryContext === "object" ? toolCtx.deliveryContext : {};
  return resolveMemoryRequestContext({
    agentId: toolCtx?.agentId,
    workspaceDir: toolCtx?.workspaceDir,
    sessionKey: toolCtx?.sessionKey,
    userId: toolCtx?.requesterSenderId,
    channel: toolCtx?.messageChannel,
    accountId: toolCtx?.agentAccountId,
    chatId: toolCtx?.chatId ?? delivery.chatId ?? delivery.to?.split?.(":")?.at?.(-1),
    chatKind: toolCtx?.chatKind,
  }, options);
}

function deepFreezeTopology(providers) {
  const frozenProviders = {};
  for (const [provider, data] of Object.entries(providers)) {
    frozenProviders[provider] = Object.freeze({ accounts: Object.freeze([...data.accounts].sort()), ambiguous: data.ambiguous });
  }
  return Object.freeze({ providers: Object.freeze(frozenProviders) });
}

/** Build a conservative account snapshot; implicit default always exists. */
export function buildMemoryAccountTopology(cfg = {}) {
  const providers = {};
  for (const [provider, channelCfg] of Object.entries(cfg?.channels || {})) {
    if (!channelCfg || typeof channelCfg !== "object") continue;
    const accounts = new Set(["default"]);
    let ambiguous = false;
    for (const account of Object.keys(channelCfg.accounts || {})) accounts.add(account);
    if (channelCfg.defaultAccount) accounts.add(String(channelCfg.defaultAccount));
    for (const binding of cfg?.bindings || []) {
      if (binding?.match?.channel !== provider) continue;
      const account = binding?.match?.accountId;
      if (!account || account === "*") ambiguous = true;
      else accounts.add(String(account));
    }
    if (accounts.size !== 1) ambiguous = true;
    providers[provider] = { accounts, ambiguous };
  }
  return deepFreezeTopology(providers);
}

function rawString(event, names, limit, label) {
  const values = [];
  for (const name of names) {
    const value = event?.[name];
    if (value !== undefined && value !== null && value !== "") values.push(validatedIdentity(value, limit, label));
  }
  return assertSame(label, values);
}

/** Create a bounded, TTL-protected join registry for reply dispatch and prompt hooks. */
export function createMemoryTurnRouteRegistry({
  routingCapability,
  maxPending = 1000,
  maxClaimed = 1000,
  maxTainted = 1000,
  ttlMs = 60_000,
  now = Date.now,
  logger = null,
} = {}) {
  const capability = validateRoutingCapability(routingCapability);
  const pending = [];
  const runIndex = new Map();
  const claimed = new Map();
  const tainted = new Map();
  let sequence = 0;
  let globalTaint = false;

  const taint = (sessionKey) => {
    if (tainted.size >= maxTainted && !tainted.has(sessionKey)) globalTaint = true;
    else tainted.set(sessionKey, now() + ttlMs);
  };
  const prune = () => {
    const current = now();
    for (let index = pending.length - 1; index >= 0; index--) {
      if (!(pending[index].expiresAt > current)) {
        const [lost] = pending.splice(index, 1);
        if (lost.runId) runIndex.delete(lost.runId);
        taint(lost.sessionKey);
      }
    }
    for (const [key, value] of claimed) if (!(value.expiresAt > current)) claimed.delete(key);
    for (const [key, expiry] of tainted) if (!(expiry > current)) tainted.delete(key);
  };
  const evictPending = () => {
    while (pending.length > maxPending) {
      const lost = pending.shift();
      if (lost.runId) runIndex.delete(lost.runId);
      taint(lost.sessionKey);
    }
  };
  const evictClaimed = () => {
    while (claimed.size > maxClaimed) claimed.delete(claimed.keys().next().value);
  };

  function observeReplyDispatch(event = {}) {
    prune();
    const raw = event?.ctx && typeof event.ctx === "object" ? event.ctx : event;
    if (event.isTailDispatch === true || raw.isTailDispatch === true || event.isTail === true || raw.tail === true) return undefined;
    if (raw.CommandTurn !== undefined) {
      if (!raw.CommandTurn || typeof raw.CommandTurn !== "object") return undefined;
      if (raw.CommandTurn.kind !== "user" || raw.CommandTurn.source === "native") return undefined;
    }
    if (raw.CommandSource === "native" || raw.CommandSource === "text") return undefined;
    if (event.isCommand === true || raw.isCommand === true || event.nativeCommand === true) return undefined;
    let body;
    try {
      body = validatedIdentity(raw.CommandBody, COMMAND_BODY_LIMIT, "CommandBody", { required: true });
    } catch (error) {
      safeWarn(logger, "memory-turn-routes.command-body", "invalid_command_body", { reason: error?.name || "invalid" });
      return undefined;
    }
    if (body.trimStart().startsWith("/")) return undefined;
    try {
      const eventSession = rawString(event, ["sessionKey"], INPUT_LIMITS.SESSION_KEY, "sessionKey");
      const rawSession = rawString(raw, ["SessionKey", "sessionKey"], INPUT_LIMITS.SESSION_KEY, "sessionKey");
      const sessionKey = assertSame("sessionKey", [eventSession, rawSession]);
      if (!sessionKey) return undefined;
      const session = parseSessionFacts(sessionKey, capability);
      const agentId = rawString(raw, ["agentId", "AgentId"], INPUT_LIMITS.AGENT_ID, "agentId") || session.agentId;
      if (safeAgentId(agentId) !== session.agentId) throw new Error("conflicting dispatch agent");
      const runId = rawString(event, ["runId", "RunId"], INPUT_LIMITS.SESSION_ID, "runId");
      const provider = normalizeProvider(assertSame("provider", [
        rawString(raw, ["Provider", "OriginatingChannel"], INPUT_LIMITS.CHANNEL_ID, "provider"),
        rawString(event, ["originatingChannel"], INPUT_LIMITS.CHANNEL_ID, "provider"),
        session.route?.provider,
      ]), capability);
      const accountId = normalizeAccount(assertSame("accountId", [
        rawString(raw, ["AccountId"], INPUT_LIMITS.ACCOUNT_ID, "accountId"),
        rawString(event, ["originatingAccountId"], INPUT_LIMITS.ACCOUNT_ID, "accountId"),
      ]), capability);
      const sender = rawString(raw, ["SenderId"], INPUT_LIMITS.USER_ID, "senderId");
      const rawChat = rawString(raw, ["ChatId"], INPUT_LIMITS.CHAT_ID, "chatId");
      const target = rawString(event, ["originatingTo"], INPUT_LIMITS.SESSION_KEY, "originatingTo")
        || rawString(raw, ["OriginatingTo"], INPUT_LIMITS.SESSION_KEY, "originatingTo");
      const targetPeer = parseDeliveryPeer(target, provider, capability);
      const chatId = assertSame("chatId", [rawChat, targetPeer, session.route?.peerId]);
      if (!provider || !accountId || !sender || !chatId) return undefined;
      const ticket = Object.freeze({
        id: ++sequence,
        runId,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        provider,
        accountId,
        chatId,
        threadId: session.threadId,
        senderProof: stableIdentityHash(sender),
        expiresAt: now() + ttlMs,
      });
      if (runId && runIndex.has(runId)) {
        const prior = runIndex.get(runId);
        if (JSON.stringify({ ...prior, id: 0, expiresAt: 0 }) !== JSON.stringify({ ...ticket, id: 0, expiresAt: 0 })) taint(ticket.sessionKey);
        return undefined;
      }
      pending.push(ticket);
      if (runId) runIndex.set(runId, ticket);
      evictPending();
    } catch (error) {
      safeWarn(logger, "memory-turn-routes.dispatch", "invalid_dispatch_identity", { reason: error?.name || "invalid" });
      return undefined;
    }
    return undefined;
  }

  function claimForPrompt(hookCtx, proofMode, verifyTicket) {
    prune();
    const runId = validatedIdentity(hookCtx?.runId, INPUT_LIMITS.SESSION_ID, "runId", { required: true });
    if (claimed.has(runId)) return claimed.get(runId);
    if (globalTaint) return null;
    const session = parseSessionFacts(hookCtx?.sessionKey, capability);
    if (tainted.has(session.sessionKey)) return null;
    let ticket = proofMode === "turn-run" ? runIndex.get(runId) : pending.find((item) => item.sessionKey === session.sessionKey);
    if (!ticket || !(ticket.expiresAt > now())) return null;
    if (typeof verifyTicket !== "function" || verifyTicket(ticket) !== true) {
      taint(session.sessionKey);
      return null;
    }
    const index = pending.indexOf(ticket);
    if (index < 0) {
      taint(session.sessionKey);
      return null;
    }
    pending.splice(index, 1);
    if (ticket.runId) runIndex.delete(ticket.runId);
    const record = Object.freeze({ ...ticket, claimedRunId: runId });
    claimed.set(runId, record);
    evictClaimed();
    return record;
  }

  return Object.freeze({
    observeReplyDispatch,
    claimForPrompt,
    clearRun(runId) { claimed.delete(String(runId)); },
    clearSession(sessionKey) {
      for (let index = pending.length - 1; index >= 0; index--) if (pending[index].sessionKey === sessionKey) pending.splice(index, 1);
      tainted.delete(sessionKey);
    },
    clear() { pending.length = 0; runIndex.clear(); claimed.clear(); tainted.clear(); globalTaint = false; },
    pendingCount() { prune(); return pending.length; },
  });
}

function safeHookBase(hookCtx, workspaceAliases) {
  return resolveMemoryRequestContext({
    agentId: hookCtx?.agentId,
    workspaceDir: hookCtx?.workspaceDir,
    channel: hookCtx?.messageProvider,
    chatId: hookCtx?.chatId,
    sessionKey: hookCtx?.sessionKey,
    sessionId: hookCtx?.sessionId,
  }, { workspaceAliases });
}

/** Resolve authenticated prompt-hook identity through a verified dispatch ticket. */
export async function resolveHostHookMemoryContext(hookCtx, {
  getSessionEntry,
  workspaceAliases = EMPTY_WORKSPACE_ALIASES,
  accountTopology = Object.freeze({ providers: Object.freeze({}) }),
  turnRoutes,
  routingCapability,
  logger = null,
} = {}) {
  const capability = validateRoutingCapability(routingCapability);
  const base = safeHookBase(hookCtx, workspaceAliases);
  try {
    const runId = validatedIdentity(hookCtx?.runId, INPUT_LIMITS.SESSION_ID, "runId", { required: true });
    const sessionId = validatedIdentity(hookCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId", { required: true });
    const session = parseSessionFacts(base.sessionKey, capability);
    if (session.agentId !== base.agentId) throw new Error("hook_agent");
    const senderId = validatedIdentity(hookCtx?.senderId, INPUT_LIMITS.USER_ID, "senderId", { required: true });
    const nestedSender = validatedIdentity(hookCtx?.channelContext?.senderId ?? hookCtx?.channelContext?.sender?.id, INPUT_LIMITS.USER_ID, "senderId");
    assertSame("hook sender", [senderId, nestedSender]);
    const chatId = validatedIdentity(hookCtx?.chatId, INPUT_LIMITS.CHAT_ID, "chatId", { required: true });
    const nestedChat = validatedIdentity(hookCtx?.channelContext?.chatId ?? hookCtx?.channelContext?.chat?.id, INPUT_LIMITS.CHAT_ID, "chatId");
    assertSame("hook chat", [chatId, nestedChat]);
    if (typeof getSessionEntry !== "function") throw new Error("session_reader");
    const entry = await getSessionEntry({ agentId: session.agentId, sessionKey: session.sessionKey, readConsistency: "latest" });
    if (!entry || String(entry.sessionId || "") !== sessionId) throw new Error("session_id");
    const provider = normalizeProvider(base.channel, capability);
    const entryProvider = assertSame("entry provider", [
      normalizeProvider(entry.deliveryContext?.channel, capability),
      normalizeProvider(entry.origin?.provider, capability),
      normalizeProvider(entry.lastChannel, capability),
    ]);
    if (!provider || provider !== entryProvider) throw new Error("provider");
    const entryAccount = assertSame("entry account", [
      normalizeAccount(entry.deliveryContext?.accountId, capability),
      normalizeAccount(entry.origin?.accountId, capability),
      normalizeAccount(entry.lastAccountId, capability),
    ]);
    if (!entryAccount) throw new Error("account");
    const entryTargets = [entry.deliveryContext?.to, entry.origin?.to, entry.lastTo]
      .filter(Boolean)
      .map((target) => parseDeliveryPeer(target, provider, capability));
    if (assertSame("entry target", entryTargets) !== chatId) throw new Error("target");
    const entryThread = assertSame("entry thread", [
      validatedIdentity(entry.deliveryContext?.threadId, INPUT_LIMITS.THREAD_ID, "threadId"),
      validatedIdentity(entry.origin?.threadId, INPUT_LIMITS.THREAD_ID, "threadId"),
      validatedIdentity(entry.lastThreadId, INPUT_LIMITS.THREAD_ID, "threadId"),
    ]);
    const hookThread = validatedIdentity(hookCtx?.messageThreadId ?? hookCtx?.channelContext?.threadId, INPUT_LIMITS.THREAD_ID, "threadId");
    if (entryThread && hookThread && entryThread !== hookThread) throw new Error("thread");
    const topology = accountTopology?.providers?.[provider];
    const proofMode = session.accountId && session.accountId === entryAccount
      ? "account-session"
      : topology && topology.ambiguous === false && topology.accounts?.length === 1 && topology.accounts[0] === entryAccount
        ? "single-account"
        : "turn-run";
    const claimed = turnRoutes?.claimForPrompt(hookCtx, proofMode, (ticket) => (
      ticket.agentId === base.agentId
      && ticket.sessionKey === base.sessionKey
      && ticket.provider === provider
      && ticket.accountId === entryAccount
      && ticket.chatId === chatId
      && ticket.senderProof === stableIdentityHash(senderId)
      && (proofMode !== "turn-run" || ticket.runId === runId)
    ));
    if (!claimed) throw new Error("ticket");
    return resolveMemoryRequestContext({
      agentId: base.agentId,
      workspaceDir: base.workspaceDir,
      sessionKey: base.sessionKey,
      sessionId: base.sessionId,
      chatId: base.chatId,
      chatKind: base.chatKind,
      userId: senderId,
      channel: provider,
      accountId: entryAccount,
    }, { workspaceAliases });
  } catch (error) {
    safeWarn(logger, "memory-request-context.hook", error, { reason: String(error?.message || "invalid").slice(0, 64) });
    return base;
  }
}
