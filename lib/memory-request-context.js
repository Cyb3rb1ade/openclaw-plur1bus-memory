/**
 * Canonical, immutable identity context for every memory data boundary.
 * Host routing support is loaded lazily so this package remains directly testable.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
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
const SUPPORTED_ROUTE_PROVIDERS = new Set(["telegram", "discord", "slack", "mattermost"]);
const COMMAND_BODY_LIMIT = INPUT_LIMITS.COMMAND_ARGS;
const WORKSPACE_KEY_PREFIX = "workspace:v1:";
const WORKSPACE_DIR_PREFIX = "workspace-dir:v1:";
const WORKSPACE_TARGET_LIMIT = WORKSPACE_DIR_PREFIX.length + INPUT_LIMITS.SESSION_KEY;

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
export function validatedIdentity(value, maxLength, name, { required = false, allowNumber = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} is required`);
    return "";
  }
  let canonical;
  if (typeof value === "string") canonical = value.trim();
  else if (allowNumber && typeof value === "number" && Number.isSafeInteger(value) && Number.isFinite(value)) canonical = String(value);
  else throw new Error(allowNumber ? `${name} must be a string or finite safe integer` : `${name} must be a string`);
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

/**
 * Canonicalize one workspace identity using the shared prefix and suffix grammar.
 * @param {unknown} value Raw legacy or canonical workspace identity.
 * @param {string} name Validation label used in errors.
 * @returns {string} A canonical workspace principal.
 */
export function normalizeWorkspaceTarget(value, name = "workspace alias target") {
  const target = validatedIdentity(value, WORKSPACE_TARGET_LIMIT, name, { required: true });
  for (const [prefix, limit] of [
    [WORKSPACE_KEY_PREFIX, INPUT_LIMITS.AGENT_ID],
    [WORKSPACE_DIR_PREFIX, INPUT_LIMITS.SESSION_KEY],
  ]) {
    if (!target.startsWith(prefix)) continue;
    const suffix = validatedIdentity(target.slice(prefix.length), limit, name, { required: true });
    if (suffix.startsWith(WORKSPACE_KEY_PREFIX) || suffix.startsWith(WORKSPACE_DIR_PREFIX)) {
      throw new Error(`invalid ${name}`);
    }
    return `${prefix}${suffix}`;
  }
  if (target.startsWith("workspace:") || target.startsWith("workspace-dir:")) {
    throw new Error(`invalid ${name}`);
  }
  return `${WORKSPACE_KEY_PREFIX}${validatedIdentity(target, INPUT_LIMITS.AGENT_ID, name, { required: true })}`;
}

function neoWorkspaceAliasLookupKeys(value) {
  const raw = String(value);
  const sanitized = (raw.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "default").slice(0, 120);
  return [...new Set([raw, sanitized.toLowerCase(), raw.toLowerCase()])];
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
    for (const lookupKey of neoWorkspaceAliasLookupKeys(alias)) {
      if (aliases.has(lookupKey) && aliases.get(lookupKey) !== target) {
        throw new Error("conflicting workspace alias declaration");
      }
      aliases.set(lookupKey, target);
    }
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

function lookupWorkspaceAlias(aliases, value) {
  for (const lookupKey of neoWorkspaceAliasLookupKeys(value)) {
    const target = aliases.get(lookupKey);
    if (target) return target;
  }
  return "";
}

/** Canonicalize all present workspace facts and reject disagreement. */
export function resolveCanonicalWorkspacePrincipal(bindings, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const snapshot = normalizeAndFreezeWorkspaceAliases(workspaceAliases);
  const maps = workspaceMaps(snapshot);
  const principals = [];
  for (const raw of [bindings?.explicitId, bindings?.explicitKey]) {
    if (raw === undefined || raw === null || raw === "") continue;
    const validated = validatedIdentity(raw, WORKSPACE_TARGET_LIMIT, "workspace identity", { required: true });
    const canonical = validated.startsWith(WORKSPACE_KEY_PREFIX) || validated.startsWith(WORKSPACE_DIR_PREFIX);
    principals.push(canonical
      ? normalizeWorkspaceTarget(validated, "workspace identity")
      : lookupWorkspaceAlias(maps.aliases, validated) || normalizeWorkspaceTarget(validated, "workspace identity"));
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
  const explicitId = validatedIdentity(commandCtx?.workspaceId, WORKSPACE_TARGET_LIMIT, "workspaceId");
  const explicitKey = validatedIdentity(commandCtx?.workspaceKey, WORKSPACE_TARGET_LIMIT, "workspaceKey");
  const canonicalDir = commandCtx?.workspaceDir ? normalizeWorkspacePath(commandCtx.workspaceDir) : "";
  const workspaceIdentity = resolveCanonicalWorkspacePrincipal(
    { explicitId, explicitKey, canonicalDir },
    normalizedWorkspaceAliases,
  );
  const userId = validatedIdentity(extractRawIdentity(commandCtx, "user"), INPUT_LIMITS.USER_ID, "userId", { allowNumber: true });
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
    chatId: validatedIdentity(extractRawIdentity(commandCtx, "chat"), INPUT_LIMITS.CHAT_ID, "chatId", { allowNumber: true }),
    conversationPrincipal: validatedIdentity(commandCtx?.conversationPrincipal, INPUT_LIMITS.PRINCIPAL, "conversationPrincipal"),
    chatKind: normalizeChatKind(commandCtx?.chatKind),
    sessionKey: validatedIdentity(commandCtx?.sessionKey, INPUT_LIMITS.SESSION_KEY, "sessionKey"),
    sessionId: validatedIdentity(commandCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId"),
    workspaceDir: canonicalDir,
    workspaceAliases: normalizedWorkspaceAliases,
  });
}

function resolveRoutingCapability(module) {
  return module?.default && typeof module.default === "object" ? { ...module.default, ...module } : module;
}

function validateRoutingCapability(module) {
  const capability = resolveRoutingCapability(module);
  if (!capability || ROUTING_EXPORTS.some((name) => typeof capability[name] !== "function")) {
    throw new Error("OpenClaw routing capability is missing required public exports");
  }
  return Object.freeze(Object.fromEntries(ROUTING_EXPORTS.map((name) => [name, capability[name]])));
}

function validateIncognitoSessionClassifier(module) {
  const capability = resolveRoutingCapability(module);
  if (!capability || typeof capability.isIncognitoSessionKey !== "function") {
    throw new Error("OpenClaw routing capability is missing the public incognito session classifier");
  }
  return capability.isIncognitoSessionKey;
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

/**
 * Create a memoized classifier backed by OpenClaw's public routing SDK.
 * @param {{importRouting?: () => Promise<object>, logger?: object|null}} [options] Host import and logger dependencies.
 * @returns {(sessionKey: string) => Promise<boolean>} Incognito session classifier.
 */
export function createHostIncognitoSessionClassifier({
  importRouting = () => import("openclaw/plugin-sdk/routing"),
  logger = null,
} = {}) {
  let loadPromise = null;
  return async function classifyHostIncognitoSession(sessionKey) {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(importRouting)
        .then(validateIncognitoSessionClassifier)
        .catch((error) => {
          safeWarn(logger, "memory-request-context.incognito-routing", error);
          throw error;
        });
    }
    const classify = await loadPromise;
    const result = classify(sessionKey);
    if (typeof result !== "boolean") {
      throw new Error("OpenClaw incognito session classifier returned a non-boolean result");
    }
    return result;
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
      ].filter(Boolean)) {
        entries.push({ type: "path", value: path, key });
        const pathAlias = typeof path === "string" && path.trim() ? basename(path.trim()) : "";
        if (pathAlias) entries.push({ type: "alias", value: pathAlias, key });
      }
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
  const raw = validatedIdentity(value, INPUT_LIMITS.CHANNEL_ID, "channel");
  if (!raw) return "";
  const provider = routingCapability.normalizeMessageChannel(raw);
  if (!provider) return "";
  const normalized = validatedIdentity(provider, INPUT_LIMITS.CHANNEL_ID, "channel", { required: true });
  if (!SUPPORTED_ROUTE_PROVIDERS.has(normalized)) throw new Error("unsupported conversation provider");
  return normalized;
}

function normalizeAccount(value, routingCapability) {
  const raw = validatedIdentity(value, INPUT_LIMITS.ACCOUNT_ID, "accountId");
  if (!raw) return "";
  const account = routingCapability.normalizeOptionalAccountId(raw);
  return account ? validatedIdentity(account, INPUT_LIMITS.ACCOUNT_ID, "accountId", { required: true }) : "";
}

function parseSupportedTarget(value, expectedProvider, routingCapability) {
  if (!value) return null;
  const target = validatedIdentity(value, INPUT_LIMITS.SESSION_KEY, "conversation target", { required: true });
  const parts = target.split(":");
  if (parts.some((part) => !part)) throw new Error("malformed conversation target");
  if (expectedProvider === "discord" && parts.length === 2 && ["channel", "user"].includes(parts[0])) {
    return {
      provider: expectedProvider,
      peerKind: parts[0] === "user" ? "direct" : "channel",
      peerId: validatedIdentity(parts[1], INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true }),
      threadId: "",
    };
  }
  const provider = normalizeProvider(parts[0], routingCapability);
  if (!provider || (expectedProvider && provider !== expectedProvider)) throw new Error("conflicting conversation provider");
  if (parts.length === 2) {
    return { provider, peerKind: "direct", peerId: validatedIdentity(parts[1], INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true }), threadId: "" };
  }
  if (parts.length === 3 && SUPPORTED_PEER_KINDS.has(parts[1])) {
    return {
      provider,
      peerKind: parts[1] === "dm" ? "direct" : parts[1],
      peerId: validatedIdentity(parts[2], INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true }),
      threadId: "",
    };
  }
  if (provider === "telegram" && parts.length === 4 && parts[2] === "topic") {
    return {
      provider,
      peerKind: "group",
      peerId: validatedIdentity(parts[1], INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true }),
      threadId: validatedIdentity(parts[3], INPUT_LIMITS.THREAD_ID, "threadId", { required: true, allowNumber: true }),
    };
  }
  if (provider === "telegram" && parts.length === 5 && ["group", "channel"].includes(parts[1]) && parts[3] === "topic") {
    return {
      provider,
      peerKind: parts[1],
      peerId: validatedIdentity(parts[2], INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true }),
      threadId: validatedIdentity(parts[4], INPUT_LIMITS.THREAD_ID, "threadId", { required: true, allowNumber: true }),
    };
  }
  throw new Error("unsupported conversation target grammar");
}

function parseDeliveryTarget(value, expectedProvider, routingCapability) {
  if (!value) return null;
  const raw = validatedIdentity(value, INPUT_LIMITS.SESSION_KEY, "delivery target", { required: true });
  if (!raw.includes(":")) {
    return { provider: expectedProvider, peerKind: "", peerId: validatedIdentity(raw, INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true }), threadId: "" };
  }
  return parseSupportedTarget(raw, expectedProvider, routingCapability);
}

function splitTelegramTopicPeer(provider, peerKind, rawPeer) {
  if (provider !== "telegram") return { peerId: rawPeer, threadId: "" };
  const parts = rawPeer.split(":");
  if (parts.length === 1) return { peerId: rawPeer, threadId: "" };
  if (parts.length === 3 && parts[1] === "topic" && ["direct", "group", "channel"].includes(peerKind)) {
    return { peerId: parts[0], threadId: parts[2] };
  }
  throw new Error("unsupported telegram session topic grammar");
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
  let route = null;
  let accountId = "";
  if (parts.length === 1 && rest !== "main") throw new Error("unsupported one-part session route");
  if (parts.length > 1) {
    let provider = "";
    let peerKind = "";
    let rawPeer = "";
    if (["direct", "dm"].includes(parts[0])) {
      if (parts.length !== 2) throw new Error("unsupported canonical session route grammar");
      peerKind = "direct";
      rawPeer = parts[1];
    } else {
      provider = normalizeProvider(parts[0], routingCapability);
      if (SUPPORTED_PEER_KINDS.has(parts[1])) {
        peerKind = parts[1] === "dm" ? "direct" : parts[1];
        if (parts.length === 3) rawPeer = parts[2];
        else if (provider === "telegram" && ["group", "channel"].includes(peerKind)
          && parts.length === 5 && parts[3] === "topic") rawPeer = `${parts[2]}:topic:${parts[4]}`;
        else throw new Error("unsupported canonical session route grammar");
      } else if (["direct", "dm"].includes(parts[2])) {
        if (parts.length !== 4) throw new Error("unsupported canonical session route grammar");
        accountId = normalizeAccount(parts[1], routingCapability);
        if (!accountId) throw new Error("missing canonical session account");
        peerKind = "direct";
        rawPeer = parts[3];
      } else {
        throw new Error("unsupported canonical session route");
      }
    }
    if (!rawPeer) throw new Error("missing canonical session peer");
    const topic = splitTelegramTopicPeer(provider, peerKind, rawPeer);
    const peerId = validatedIdentity(topic.peerId, INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true });
    const routeThread = validatedIdentity(topic.threadId, INPUT_LIMITS.THREAD_ID, "threadId", { allowNumber: true });
    const canonicalThread = assertSame("session thread", [threadId, routeThread]);
    route = { provider, peerKind, peerId, threadId: canonicalThread };
  }
  return {
    agentId,
    rest: parsed.rest,
    sessionKey: `agent:${agentId}:${parsed.rest}`,
    route,
    accountId,
    threadId: route?.threadId || threadId,
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
  const to = rawTo ? parseSupportedTarget(rawTo, channel, capability) : null;
  if (!from) throw new Error("unsupported or missing inbound conversation route");
  const provider = assertSame("conversation provider", [channel, from.provider, to?.provider, session.route?.provider]);
  const peerKind = assertSame("conversation peer kind", [from.peerKind, to?.peerKind, session.route?.peerKind]);
  const parentPeerId = validatedIdentity(commandCtx?.threadParentId, INPUT_LIMITS.CHAT_ID, "threadParentId", { allowNumber: true });
  const routePeerId = assertSame("conversation peer", [from.peerId, to?.peerId, session.route?.peerId, parentPeerId]);
  const explicitThreadId = validatedIdentity(commandCtx?.messageThreadId, INPUT_LIMITS.THREAD_ID, "threadId", { allowNumber: true });
  const threadId = assertSame("conversation thread", [explicitThreadId, from.threadId, to?.threadId, session.threadId]);
  const accountId = assertSame("conversation account", [
    normalizeAccount(commandCtx?.accountId, capability),
    session.accountId,
  ]);
  return Object.freeze({
    agentId,
    sessionKey: session.sessionKey,
    channel: provider,
    accountId,
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
    const bindingChannel = normalizeProvider(binding.channel, routingCapability);
    const bindingAccount = normalizeAccount(binding.accountId, routingCapability);
    const bindingConversation = validatedIdentity(binding.conversationId, INPUT_LIMITS.CHAT_ID, "binding conversationId", { required: true, allowNumber: true });
    const bindingParent = validatedIdentity(binding.parentConversationId, INPUT_LIMITS.CHAT_ID, "binding parentConversationId", { allowNumber: true });
    const bindingThread = validatedIdentity(binding.threadId, INPUT_LIMITS.THREAD_ID, "binding threadId", { allowNumber: true });
    if (!bindingChannel || !bindingAccount) throw new Error("incomplete conversation binding");
    assertSame("binding channel", [facts.channel, bindingChannel]);
    assertSame("binding account", [facts.accountId, bindingAccount]);
    assertSame("binding conversation", [facts.conversationId, bindingConversation]);
    assertSame("binding parent conversation", [facts.parentPeerId, bindingParent]);
    assertSame("binding thread", [facts.threadId, bindingThread]);
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
    if (value !== undefined && value !== null && value !== "") {
      values.push(validatedIdentity(value, limit, label, { allowNumber: ["senderId", "chatId", "threadId"].includes(label) }));
    }
  }
  return assertSame(label, values);
}

function strictPresentAliases(entries, normalize, label) {
  const values = [];
  for (const [container, key] of entries) {
    if (!container || !Object.prototype.hasOwnProperty.call(container, key)) continue;
    if (container[key] === undefined || container[key] === null) continue;
    const value = normalize(container[key]);
    if (!value) throw new Error(`empty ${label}`);
    values.push(value);
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
  for (const [name, value] of Object.entries({ maxPending, maxClaimed, maxTainted, ttlMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  }
  if (typeof now !== "function") throw new Error("now must be a function");
  const capability = validateRoutingCapability(routingCapability);
  const pending = [];
  const runIndex = new Map();
  const claimed = new Map();
  const retiredRuns = new Map();
  const tainted = new Map();
  let sequence = 0;
  let globalTaintUntil = 0;

  const removeSessionState = (sessionKey, { removeClaims = true } = {}) => {
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].sessionKey !== sessionKey) continue;
      const [removed] = pending.splice(index, 1);
      if (removed.runId) runIndex.delete(removed.runId);
    }
    for (const [runId, ticket] of runIndex) if (ticket.sessionKey === sessionKey) runIndex.delete(runId);
    if (removeClaims) {
      for (const [runId, ticket] of claimed) if (ticket.sessionKey === sessionKey) claimed.delete(runId);
      for (const [runId, ticket] of retiredRuns) if (ticket.sessionKey === sessionKey) retiredRuns.delete(runId);
    }
  };
  const taintAndClearSession = (sessionKey) => {
    if (!sessionKey) return;
    removeSessionState(sessionKey);
    const expiry = now() + ttlMs;
    if (!tainted.has(sessionKey) && tainted.size >= maxTainted) {
      globalTaintUntil = Math.max(globalTaintUntil, expiry);
      pending.splice(0);
      runIndex.clear();
      claimed.clear();
      return;
    }
    tainted.set(sessionKey, expiry);
  };
  const ticketIdentity = (ticket) => JSON.stringify({
    runId: ticket.runId,
    agentId: ticket.agentId,
    sessionKey: ticket.sessionKey,
    provider: ticket.provider,
    accountId: ticket.accountId,
    chatId: ticket.chatId,
    peerKind: ticket.peerKind,
    threadId: ticket.threadId,
    senderProof: ticket.senderProof,
  });
  const retireClaimedRun = (runId, ticket) => {
    claimed.delete(runId);
    const tombstone = Object.freeze({ sessionKey: ticket.sessionKey, expiresAt: now() + ttlMs });
    if (!retiredRuns.has(runId) && retiredRuns.size >= maxClaimed) {
      globalTaintUntil = Math.max(
        globalTaintUntil,
        tombstone.expiresAt,
        ...[...retiredRuns.values()].map((record) => record.expiresAt),
      );
      pending.splice(0);
      runIndex.clear();
      claimed.clear();
      retiredRuns.clear();
      return false;
    }
    retiredRuns.set(runId, tombstone);
    return true;
  };
  const prune = () => {
    const current = now();
    if (!(globalTaintUntil > current)) globalTaintUntil = 0;
    for (const [key, expiry] of tainted) if (!(expiry > current)) tainted.delete(key);
    for (const [runId, ticket] of retiredRuns) if (!(ticket.expiresAt > current)) retiredRuns.delete(runId);
    const expiredSessions = new Set(pending.filter((ticket) => !(ticket.expiresAt > current)).map((ticket) => ticket.sessionKey));
    for (const sessionKey of expiredSessions) taintAndClearSession(sessionKey);
    for (const [runId, ticket] of [...claimed]) {
      if (!(ticket.expiresAt > current) && !retireClaimedRun(runId, ticket)) return;
    }
  };
  const evictPending = () => {
    while (pending.length > maxPending) {
      taintAndClearSession(pending[0].sessionKey);
    }
  };
  const evictClaimed = () => {
    while (claimed.size > maxClaimed) {
      const [runId, ticket] = claimed.entries().next().value;
      if (!retireClaimedRun(runId, ticket)) return false;
    }
    return true;
  };

  function observeReplyDispatch(event = {}) {
    prune();
    const raw = event?.ctx && typeof event.ctx === "object" ? event.ctx : event;
    if (event.isTailDispatch === true || raw.isTailDispatch === true || event.isTail === true || raw.tail === true) return undefined;
    if (raw.CommandTurn !== undefined) {
      if (!raw.CommandTurn || typeof raw.CommandTurn !== "object") return undefined;
      if (raw.CommandTurn.kind !== "normal" || raw.CommandTurn.source !== "message") return undefined;
      if (raw.CommandTurn.body !== undefined && raw.CommandTurn.body !== raw.CommandBody) return undefined;
      if (raw.CommandSource !== undefined) return undefined;
    } else if (raw.CommandSource === "native" || raw.CommandSource === "text") {
      return undefined;
    }
    if (event.isCommand === true || raw.isCommand === true || event.nativeCommand === true) return undefined;
    let body;
    try {
      body = validatedIdentity(raw.CommandBody, COMMAND_BODY_LIMIT, "CommandBody", { required: true });
    } catch (error) {
      safeWarn(logger, "memory-turn-routes.command-body", "invalid_command_body", { reason: error?.name || "invalid" });
      return undefined;
    }
    if (body.trimStart().startsWith("/")) return undefined;
    const sessionCandidates = [event?.sessionKey, raw?.SessionKey, raw?.sessionKey]
      .filter((value) => typeof value === "string" && value.trim());
    try {
      const eventSession = rawString(event, ["sessionKey"], INPUT_LIMITS.SESSION_KEY, "sessionKey");
      const rawSession = rawString(raw, ["SessionKey", "sessionKey"], INPUT_LIMITS.SESSION_KEY, "sessionKey");
      if (!eventSession || !rawSession) throw new Error("incomplete dispatch session");
      const sessionKey = assertSame("sessionKey", [eventSession, rawSession]);
      const session = parseSessionFacts(sessionKey, capability);
      const agentId = rawString(raw, ["agentId", "AgentId"], INPUT_LIMITS.AGENT_ID, "agentId");
      if (!agentId) throw new Error("incomplete dispatch agent");
      if (safeAgentId(agentId) !== session.agentId) throw new Error("conflicting dispatch agent");
      const runId = assertSame("runId", [
        rawString(event, ["runId", "RunId"], INPUT_LIMITS.SESSION_ID, "runId"),
        rawString(raw, ["runId", "RunId"], INPUT_LIMITS.SESSION_ID, "runId"),
      ]);
      const rawProvider = rawString(raw, ["Provider", "Surface", "OriginatingChannel"], INPUT_LIMITS.CHANNEL_ID, "provider");
      const eventProvider = rawString(event, ["originatingChannel"], INPUT_LIMITS.CHANNEL_ID, "provider");
      if (!rawProvider || !eventProvider) throw new Error("incomplete dispatch provider");
      const provider = normalizeProvider(assertSame("provider", [
        rawProvider,
        eventProvider,
        session.route?.provider,
      ]), capability);
      const rawAccount = rawString(raw, ["AccountId", "OriginatingAccountId"], INPUT_LIMITS.ACCOUNT_ID, "accountId");
      const eventAccount = rawString(event, ["originatingAccountId"], INPUT_LIMITS.ACCOUNT_ID, "accountId");
      if (!rawAccount || !eventAccount) throw new Error("incomplete dispatch account");
      const accountId = normalizeAccount(assertSame("accountId", [
        rawAccount,
        eventAccount,
        session.accountId,
      ]), capability);
      const rawSender = rawString(raw, ["SenderId"], INPUT_LIMITS.USER_ID, "senderId");
      if (!rawSender) throw new Error("incomplete dispatch sender");
      const sender = assertSame("senderId", [
        rawSender,
        rawString(raw?.ChannelContext?.sender, ["id"], INPUT_LIMITS.USER_ID, "senderId"),
      ]);
      const rawChat = assertSame("chatId", [
        rawString(raw, ["ChatId"], INPUT_LIMITS.CHAT_ID, "chatId"),
        rawString(raw?.ChannelContext?.chat, ["id"], INPUT_LIMITS.CHAT_ID, "chatId"),
      ]);
      const eventTargetValue = rawString(event, ["originatingTo"], INPUT_LIMITS.SESSION_KEY, "originatingTo");
      const rawTargetValue = rawString(raw, ["OriginatingTo"], INPUT_LIMITS.SESSION_KEY, "originatingTo");
      if (!eventTargetValue || !rawTargetValue) throw new Error("incomplete dispatch target");
      const eventTarget = parseDeliveryTarget(eventTargetValue, provider, capability);
      const rawTarget = parseDeliveryTarget(rawTargetValue, provider, capability);
      const chatId = assertSame("chatId", [rawChat, eventTarget?.peerId, rawTarget?.peerId, session.route?.peerId]);
      const peerKind = assertSame("peerKind", [eventTarget?.peerKind, rawTarget?.peerKind, session.route?.peerKind]);
      const threadId = assertSame("threadId", [
        rawString(event, ["originatingThreadId"], INPUT_LIMITS.THREAD_ID, "threadId"),
        rawString(raw, ["MessageThreadId", "OriginatingThreadId", "TransportThreadId"], INPUT_LIMITS.THREAD_ID, "threadId"),
        eventTarget?.threadId,
        rawTarget?.threadId,
        session.threadId,
      ]);
      if (!provider || !accountId || !sender || !chatId) return undefined;
      const ticket = Object.freeze({
        id: ++sequence,
        runId,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        provider,
        accountId,
        chatId,
        peerKind,
        threadId,
        senderProof: stableIdentityHash(sender),
        expiresAt: now() + ttlMs,
      });
      if (runId && runIndex.has(runId)) {
        const prior = runIndex.get(runId);
        if (ticketIdentity(prior) !== ticketIdentity(ticket)) {
          taintAndClearSession(prior.sessionKey);
          taintAndClearSession(ticket.sessionKey);
        }
        return undefined;
      }
      if (runId && claimed.has(runId)) {
        const prior = claimed.get(runId);
        if (ticketIdentity(prior) !== ticketIdentity(ticket)) {
          taintAndClearSession(prior.sessionKey);
          taintAndClearSession(ticket.sessionKey);
        }
        return undefined;
      }
      if (runId && retiredRuns.has(runId)) return undefined;
      if (globalTaintUntil > now() || tainted.has(ticket.sessionKey)) return undefined;
      pending.push(ticket);
      if (runId) runIndex.set(runId, ticket);
      evictPending();
    } catch (error) {
      for (const rawSessionKey of sessionCandidates) {
        try {
          taintAndClearSession(parseSessionFacts(rawSessionKey, capability).sessionKey);
        } catch (parseError) {
          safeWarn(logger, "memory-turn-routes.session", "invalid_dispatch_session", { reason: parseError?.name || "invalid" });
        }
      }
      safeWarn(logger, "memory-turn-routes.dispatch", "invalid_dispatch_identity", { reason: error?.name || "invalid" });
      return undefined;
    }
    return undefined;
  }

  function claimForPrompt(hookCtx, proofMode, verifyTicket) {
    prune();
    const runId = validatedIdentity(hookCtx?.runId, INPUT_LIMITS.SESSION_ID, "runId", { required: true });
    const session = parseSessionFacts(hookCtx?.sessionKey, capability);
    if (globalTaintUntil > now()) return null;
    if (tainted.has(session.sessionKey)) return null;
    if (retiredRuns.has(runId)) return null;
    if (claimed.has(runId)) {
      const prior = claimed.get(runId);
      if (prior.sessionKey !== session.sessionKey || typeof verifyTicket !== "function" || verifyTicket(prior) !== true) {
        taintAndClearSession(prior.sessionKey);
        if (prior.sessionKey !== session.sessionKey) taintAndClearSession(session.sessionKey);
        return null;
      }
      return prior;
    }
    const head = pending.find((item) => item.sessionKey === session.sessionKey);
    let ticket = proofMode === "turn-run" ? runIndex.get(runId) : head;
    if (!ticket || !(ticket.expiresAt > now())) return null;
    if (ticket.sessionKey !== session.sessionKey || ticket !== head) {
      taintAndClearSession(session.sessionKey);
      if (ticket.sessionKey !== session.sessionKey) taintAndClearSession(ticket.sessionKey);
      return null;
    }
    if (typeof verifyTicket !== "function" || verifyTicket(ticket) !== true) {
      taintAndClearSession(session.sessionKey);
      return null;
    }
    const index = pending.indexOf(ticket);
    if (index < 0) {
      taintAndClearSession(session.sessionKey);
      return null;
    }
    pending.splice(index, 1);
    if (ticket.runId) runIndex.delete(ticket.runId);
    const claimedSessionId = validatedIdentity(hookCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId", { required: true });
    const record = Object.freeze({ ...ticket, claimedRunId: runId, claimedSessionId });
    claimed.set(runId, record);
    if (!evictClaimed()) return null;
    return record;
  }

  return Object.freeze({
    observeReplyDispatch,
    claimForPrompt,
    clearRun(runId) {
      const key = String(runId);
      const pendingTicket = runIndex.get(key);
      if (pendingTicket) {
        const index = pending.indexOf(pendingTicket);
        if (index >= 0) pending.splice(index, 1);
        runIndex.delete(key);
      }
      const claimedTicket = claimed.get(key);
      if (claimedTicket) retireClaimedRun(key, claimedTicket);
    },
    clearSession(sessionKey) {
      removeSessionState(sessionKey);
      tainted.delete(sessionKey);
    },
    clear() { pending.length = 0; runIndex.clear(); claimed.clear(); retiredRuns.clear(); tainted.clear(); globalTaintUntil = 0; },
    pendingCount() { prune(); return pending.length; },
    stateCounts() { prune(); return Object.freeze({ pending: pending.length, runIndex: runIndex.size, claimed: claimed.size, retired: retiredRuns.size, tainted: tainted.size, globalTaint: globalTaintUntil > now() }); },
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
    if (["cron", "heartbeat", "background", "manual"].includes(String(hookCtx?.trigger || "").toLowerCase())) {
      throw new Error("non_user_trigger");
    }
    const parsedAgentSession = capability.parseAgentSessionKey(base.sessionKey);
    const boundTransportIdentityPresent = [
      hookCtx?.accountId,
      hookCtx?.senderId,
      hookCtx?.channelContext?.sender?.id,
      hookCtx?.channelContext?.accountId,
      hookCtx?.channelContext?.chat?.id,
    ].some((value) => value !== undefined && value !== null && value !== "");
    const channelRouteIds = [hookCtx?.messageProvider, hookCtx?.channel]
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map((value) => validatedIdentity(value, INPUT_LIMITS.CHANNEL_ID, "channel", { required: true }));
    const derivedHeadlessRouteIds = [hookCtx?.channelId, hookCtx?.chatId]
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map((value) => validatedIdentity(value, INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true }));
    const internalWebchatRoute = channelRouteIds.length > 0
      && channelRouteIds.every((value) => value.toLowerCase() === "webchat")
      && derivedHeadlessRouteIds.every((value) => value.toLowerCase() === "webchat");
    const transportFreeRoute = channelRouteIds.length === 0
      && derivedHeadlessRouteIds.every((value) => value === parsedAgentSession?.rest);
    const officialHeadlessRoute = !boundTransportIdentityPresent
      && parsedAgentSession?.agentId
      && parsedAgentSession?.rest
      && (internalWebchatRoute || transportFreeRoute);
    const hasTransportIdentity = boundTransportIdentityPresent
      || (!officialHeadlessRoute && (channelRouteIds.length > 0 || derivedHeadlessRouteIds.length > 0));
    if (!hasTransportIdentity) {
      validatedIdentity(hookCtx?.runId, INPUT_LIMITS.SESSION_ID, "runId", { required: true });
      validatedIdentity(hookCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId", { required: true });
      if (!parsedAgentSession?.agentId || !parsedAgentSession?.rest
        || safeAgentId(parsedAgentSession.agentId) !== base.agentId) {
        throw new Error("invalid headless agent session key");
      }
      return resolveMemoryRequestContext({
        agentId: base.agentId,
        workspaceDir: base.workspaceDir,
        sessionKey: base.sessionKey,
        sessionId: base.sessionId,
      }, { workspaceAliases });
    }
    const runId = validatedIdentity(hookCtx?.runId, INPUT_LIMITS.SESSION_ID, "runId", { required: true });
    const sessionId = validatedIdentity(hookCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId", { required: true });
    const session = parseSessionFacts(base.sessionKey, capability);
    if (session.agentId !== base.agentId) throw new Error("hook_agent");
    const senderId = validatedIdentity(hookCtx?.senderId, INPUT_LIMITS.USER_ID, "senderId", { required: true, allowNumber: true });
    const nestedSender = validatedIdentity(hookCtx?.channelContext?.sender?.id, INPUT_LIMITS.USER_ID, "senderId", { allowNumber: true });
    if (nestedSender) assertSame("hook sender", [senderId, nestedSender]);
    const chatId = validatedIdentity(hookCtx?.chatId, INPUT_LIMITS.CHAT_ID, "chatId", { required: true, allowNumber: true });
    const nestedChat = validatedIdentity(hookCtx?.channelContext?.chat?.id, INPUT_LIMITS.CHAT_ID, "chatId", { allowNumber: true });
    if (nestedChat) assertSame("hook chat", [chatId, nestedChat]);
    const explicitHookThread = validatedIdentity(hookCtx?.messageThreadId, INPUT_LIMITS.THREAD_ID, "threadId", { allowNumber: true });
    if (session.threadId && !explicitHookThread) throw new Error("thread_missing");
    const hookThread = assertSame("hook session thread", [explicitHookThread, session.threadId]);
    if (typeof getSessionEntry !== "function") throw new Error("session_reader");
    const entry = await getSessionEntry({ agentId: session.agentId, sessionKey: session.sessionKey, readConsistency: "latest" });
    if (!entry || validatedIdentity(entry.sessionId, INPUT_LIMITS.SESSION_ID, "entry sessionId", { required: true }) !== sessionId) throw new Error("session_id");
    const provider = normalizeProvider(base.channel, capability);
    const entryProvider = strictPresentAliases([
      [entry.deliveryContext, "channel"],
      [entry.origin, "provider"],
      [entry, "lastChannel"],
    ], (value) => normalizeProvider(value, capability), "entry provider");
    if (!provider || provider !== entryProvider) throw new Error("provider");
    const entryAccount = strictPresentAliases([
      [entry.deliveryContext, "accountId"],
      [entry.origin, "accountId"],
      [entry, "lastAccountId"],
    ], (value) => normalizeAccount(value, capability), "entry account");
    if (!entryAccount) throw new Error("account");
    const entryTargets = [entry.deliveryContext?.to, entry.origin?.to, entry.lastTo]
      .filter((target) => target !== undefined && target !== null)
      .map((target) => parseDeliveryTarget(target, provider, capability));
    if (!entryTargets.length || assertSame("entry target", entryTargets.map((target) => target.peerId)) !== chatId) throw new Error("target");
    const entryPeerKind = assertSame("entry peer kind", entryTargets.map((target) => target.peerKind));
    const targetThread = assertSame("entry target thread", entryTargets.map((target) => target.threadId));
    const entryThread = assertSame("entry thread", [
      validatedIdentity(entry.deliveryContext?.threadId, INPUT_LIMITS.THREAD_ID, "threadId", { allowNumber: true }),
      validatedIdentity(entry.origin?.threadId, INPUT_LIMITS.THREAD_ID, "threadId", { allowNumber: true }),
      validatedIdentity(entry.lastThreadId, INPUT_LIMITS.THREAD_ID, "threadId", { allowNumber: true }),
      targetThread,
    ]);
    if (assertSame("current thread", [hookThread, entryThread]) !== hookThread) throw new Error("thread");
    if ((hookThread && !entryThread) || (entryThread && !hookThread)) throw new Error("thread_missing");
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
      && (!entryPeerKind || !ticket.peerKind || ticket.peerKind === entryPeerKind)
      && ticket.threadId === hookThread
      && ticket.senderProof === stableIdentityHash(senderId)
      && (!ticket.claimedSessionId || ticket.claimedSessionId === sessionId)
      && (!ticket.runId || ticket.runId === runId)
      && (proofMode !== "turn-run" || Boolean(ticket.runId))
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
      channel: claimed.provider,
      accountId: claimed.accountId,
    }, { workspaceAliases });
  } catch (error) {
    safeWarn(logger, "memory-request-context.hook", error, { reason: String(error?.message || "invalid").slice(0, 64) });
    return base;
  }
}
