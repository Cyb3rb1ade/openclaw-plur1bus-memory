/**
 * Parse Obsidian commands once and carry one immutable, fail-closed write policy
 * from the authorization boundary to every mutation sink.
 */

import { normalizeWorkspaceTarget } from "./memory-request-context.js";
import { safeAgentId } from "./sql-safety.js";

const POLICY_KIND = "plur1bus.obsidian-mutation-policy.v1";

const FLAG_DEFINITIONS = Object.freeze({
  "--allow-delete": Object.freeze({ name: "allowDelete", takesValue: false, mutation: true }),
  "--agent": Object.freeze({ name: "agent", takesValue: true, mutation: false }),
  "--agent-id": Object.freeze({ name: "agentId", takesValue: true, mutation: false }),
  "--announce": Object.freeze({ name: "announce", takesValue: false, mutation: false }),
  "--apply": Object.freeze({ name: "apply", takesValue: false, mutation: true }),
  "--backup": Object.freeze({ name: "backup", takesValue: true, mutation: false }),
  "--backup-dir": Object.freeze({ name: "backupDir", takesValue: true, mutation: false }),
  "--channel": Object.freeze({ name: "channel", takesValue: true, mutation: false }),
  "--deep": Object.freeze({ name: "deep", takesValue: false, mutation: false }),
  "--delete": Object.freeze({ name: "delete", takesValue: false, mutation: true }),
  "--dry-run": Object.freeze({ name: "dryRun", takesValue: false, mutation: false }),
  "--evening-only": Object.freeze({ name: "eveningOnly", takesValue: false, mutation: false }),
  "--exact": Object.freeze({ name: "exact", takesValue: false, mutation: false }),
  "--force": Object.freeze({ name: "force", takesValue: false, mutation: true }),
  "--force-soul": Object.freeze({ name: "forceSoul", takesValue: false, mutation: true }),
  "--items": Object.freeze({ name: "items", takesValue: true, mutation: false }),
  "--max-age-days": Object.freeze({ name: "maxAgeDays", takesValue: true, mutation: false }),
  "--max-size-mb": Object.freeze({ name: "maxSizeMb", takesValue: true, mutation: false }),
  "--migrate-soul-memory-rules": Object.freeze({ name: "migrateSoulMemoryRules", takesValue: false, mutation: true }),
  "--morning-only": Object.freeze({ name: "morningOnly", takesValue: false, mutation: false }),
  "--refresh": Object.freeze({ name: "refresh", takesValue: false, mutation: false }),
  "--to": Object.freeze({ name: "to", takesValue: true, mutation: false }),
  "--until": Object.freeze({ name: "until", takesValue: true, mutation: false }),
  "--verbose": Object.freeze({ name: "verbose", takesValue: false, mutation: false }),
  "--write": Object.freeze({ name: "write", takesValue: false, mutation: true }),
  "--workspace": Object.freeze({ name: "workspace", takesValue: true, mutation: false }),
  "--workspace-id": Object.freeze({ name: "workspaceId", takesValue: true, mutation: false }),
});

const MUTATING_COMMANDS = Object.freeze({
  init: Object.freeze({ workspaces: Object.freeze(["vault_write"]) }),
  discover: Object.freeze({ workspaces: Object.freeze(["config_write"]) }),
  "morning-review": Object.freeze({ "*": Object.freeze(["review_write", "vault_write"]) }),
  "evening-review": Object.freeze({ "*": Object.freeze(["review_write", "vault_write"]) }),
  "evening-deep-review": Object.freeze({ "*": Object.freeze(["review_write", "vault_write"]) }),
  records: Object.freeze({ rebuild: Object.freeze(["vault_write"]) }),
  dashboards: Object.freeze({ build: Object.freeze(["vault_write"]) }),
  bases: Object.freeze({ build: Object.freeze(["vault_write"]) }),
  dataview: Object.freeze({ build: Object.freeze(["vault_write"]) }),
  tasks: Object.freeze({ build: Object.freeze(["vault_write"]) }),
  weekly: Object.freeze({ "*": Object.freeze(["review_write", "vault_write"]), build: Object.freeze(["vault_write"]) }),
  conflicts: Object.freeze({ "*": Object.freeze(["vault_write"]), build: Object.freeze(["vault_write"]) }),
  "project-hub": Object.freeze({ "*": Object.freeze(["vault_write"]) }),
  memory: Object.freeze({ explain: Object.freeze(["vault_write"]) }),
  maintenance: Object.freeze({ deep: Object.freeze(["vault_write"]) }),
  "semantic-conflicts": Object.freeze({ build: Object.freeze(["vault_write"]) }),
  duplicates: Object.freeze({ scan: Object.freeze(["vault_write"]) }),
  provenance: Object.freeze({ build: Object.freeze(["vault_write"]) }),
  impact: Object.freeze({ analyze: Object.freeze(["vault_write"]) }),
  links: Object.freeze({ suggest: Object.freeze(["vault_write"]) }),
  soul: Object.freeze({ patch: Object.freeze(["soul_write"]) }),
  rotate: Object.freeze({ "*": Object.freeze(["archive_move"]) }),
  cron: Object.freeze({
    "install-workspace-reviews": Object.freeze(["cron_write"]),
    "install-morning-review": Object.freeze(["cron_write"]),
  }),
  review: Object.freeze({
    prepare: Object.freeze(["review_write", "vault_write"]),
    approve: Object.freeze(["review_write"]),
    reject: Object.freeze(["review_write"]),
    snooze: Object.freeze(["review_write"]),
    apply: Object.freeze(["review_write", "vault_write", "memory_write", "knowledge_write"]),
    quickapply: Object.freeze(["review_write", "vault_write", "memory_write", "knowledge_write"]),
  }),
  "semantic-discovery": Object.freeze({
    confirm: Object.freeze(["semantic_index_write", "vault_write"]),
  }),
  "vault-confirm": Object.freeze({
    confirm: Object.freeze(["vault_confirmation_write"]),
  }),
});

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizeCommandWord(value) {
  const compact = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "-");
  const aliases = {
    morning: "morning-review",
    morgen: "morning-review",
    evening: "evening-review",
    abend: "evening-review",
    details: "show",
    detail: "show",
    anzeigen: "show",
    zeigen: "show",
    zeige: "show",
    approved: "approve",
    freigabe: "approve",
    freigeben: "approve",
    zustimmen: "approve",
    zustimmung: "approve",
    akzeptieren: "approve",
    rejected: "reject",
    ablehnen: "reject",
    verwerfen: "reject",
    verschieben: "snooze",
    anwenden: "apply",
    ausfuehren: "apply",
    ausfuhren: "apply",
    explanation: "explain",
    summary: "explain",
    summarize: "explain",
    erklaeren: "explain",
    aufdroeseln: "explain",
    was: "explain",
    vorbereiten: "prepare",
  };
  return aliases[compact] || compact;
}

function capabilitiesFor(command, subcommand, options) {
  const commandMap = MUTATING_COMMANDS[command];
  let capabilities = commandMap?.[subcommand] || commandMap?.["*"] || [];
  if (command === "discover" && subcommand === "workspaces" && options.write !== true) capabilities = [];
  if (command === "rotate") {
    if (options.apply !== true) capabilities = [];
    else if (options.delete === true) capabilities = ["archive_delete"];
  }
  if (command === "project-hub" && options.refresh !== true) capabilities = ["vault_write"];
  return [...new Set(capabilities)].sort();
}

function makeMutationPolicy({
  capabilities,
  mode,
  dryRun,
  allowWrite,
  vaultConfirmed,
  actionConfirmed,
  baseDbPath,
  agentId,
  workspaceIdentity,
}) {
  const applyMode = mode === "apply";
  const gatesOpen = applyMode
    && dryRun === false
    && allowWrite === true
    && vaultConfirmed === true
    && actionConfirmed === true;
  const permitted = gatesOpen ? [...capabilities] : [];
  const policy = {
    kind: POLICY_KIND,
    mode,
    applyMode,
    dryRun,
    allowWrite,
    vaultConfirmed,
    actionConfirmed,
    baseDbPath: String(baseDbPath || ""),
    agentId,
    workspaceIdentity,
    capabilities: [...capabilities],
    permitted,
    allows(capability) {
      return permitted.includes(String(capability || ""));
    },
  };
  return deepFreeze(policy);
}

function canonicalSelectors(options, agentId, workspaceIdentity) {
  if (options.agent !== undefined && options.agentId !== undefined) {
    throw new Error("Duplicate agent selector");
  }
  if (options.workspace !== undefined && options.workspaceId !== undefined) {
    throw new Error("Duplicate workspace selector");
  }
  const rawAgent = options.agent ?? options.agentId;
  const rawWorkspace = options.workspace ?? options.workspaceId;
  const selectedAgent = rawAgent === undefined ? agentId : safeAgentId(rawAgent);
  const selectedWorkspace = rawWorkspace === undefined
    ? workspaceIdentity
    : normalizeWorkspaceTarget(rawWorkspace, "Obsidian workspace selector");
  if (selectedAgent !== agentId || selectedWorkspace !== workspaceIdentity) {
    throw new Error("Obsidian selector scope must exactly match canonical request identity");
  }
  if (rawAgent !== undefined) {
    if (options.agent !== undefined) options.agent = selectedAgent;
    else options.agentId = selectedAgent;
  }
  if (rawWorkspace !== undefined) {
    if (options.workspace !== undefined) options.workspace = selectedWorkspace;
    else options.workspaceId = selectedWorkspace;
  }
  return { agentId: selectedAgent, workspaceIdentity: selectedWorkspace };
}

/**
 * Parse raw tokens into one deeply frozen command plan and mutation policy.
 *
 * @param {string[]} rawTokens Raw command tokens after the leading `obsidian`.
 * @param {object} context Canonical memory identity plus effective write gates.
 * @returns {object} Deeply frozen command plan.
 */
export function parseObsidianCommandPlan(rawTokens = [], context = {}) {
  if (!Array.isArray(rawTokens)) throw new TypeError("Obsidian command tokens must be an array");
  const options = {};
  const operands = [];
  const seenFlags = new Set();
  const mutationFlags = [];

  for (let index = 0; index < rawTokens.length; index++) {
    const token = String(rawTokens[index] ?? "").trim();
    if (!token.startsWith("--")) {
      operands.push(token);
      continue;
    }
    const flag = token.toLowerCase();
    const definition = FLAG_DEFINITIONS[flag];
    if (!definition) throw new Error(`Unknown flag ${flag}`);
    if (seenFlags.has(flag)) throw new Error(`Duplicate flag ${flag}`);
    seenFlags.add(flag);
    if (definition.mutation) mutationFlags.push(flag);
    if (definition.takesValue) {
      const next = rawTokens[index + 1];
      if (next === undefined || String(next).startsWith("--")) {
        throw new Error(`Flag ${flag} requires a value`);
      }
      options[definition.name] = String(next);
      index++;
    } else {
      options[definition.name] = true;
    }
  }

  if (options.dryRun === true && mutationFlags.length > 0) {
    throw new Error(`Contradictory flags: --dry-run cannot be combined with ${mutationFlags.join(", ")}`);
  }

  const command = normalizeCommandWord(operands[0] || "doctor");
  const subcommand = normalizeCommandWord(operands[1] || "");
  if (command === "rotate" && options.delete === true && !(options.apply === true && options.allowDelete === true)) {
    throw new Error("rotate --delete requires --apply and --allow-delete");
  }

  const memoryCtx = context.memoryCtx || {};
  const agentId = String(memoryCtx.agentId || context.agentId || "");
  const workspaceIdentity = String(
    memoryCtx.workspaceIdentity
      || memoryCtx.workspaceId
      || context.workspaceIdentity
      || "",
  );
  if (!agentId) throw new Error("Obsidian command plan requires canonical agent identity");
  if (!workspaceIdentity) throw new Error("Obsidian command plan requires canonical workspace identity");
  const selectors = canonicalSelectors(options, agentId, workspaceIdentity);

  const capabilities = capabilitiesFor(command, subcommand, options);
  const requiresActionConfirmation = ["semantic-discovery", "vault-confirm"].includes(command)
    && subcommand === "confirm";
  const mode = String(context.mode || "augment").toLowerCase();
  const dryRun = options.dryRun === true || context.dryRun === true;
  const actionConfirmed = requiresActionConfirmation
    ? context.actionConfirmed === true
    : context.actionConfirmed !== false;
  const mutationPolicy = makeMutationPolicy({
    capabilities,
    mode,
    dryRun,
    allowWrite: context.allowWrite === true,
    vaultConfirmed: context.vaultConfirmed === true,
    actionConfirmed,
    baseDbPath: context.baseDbPath,
    agentId,
    workspaceIdentity,
  });
  return deepFreeze({
    version: 1,
    command,
    subcommand,
    operands: operands.slice(2),
    options,
    selectors,
    mutationFlags,
    capabilities,
    dataBearing: command !== "help",
    identity: {
      agentId,
      workspaceIdentity,
      userPrincipal: String(memoryCtx.userPrincipal || ""),
      conversationPrincipal: String(memoryCtx.conversationPrincipal || memoryCtx.chatId || ""),
    },
    mutationPolicy,
  });
}

/**
 * Derive an exact target-bound policy from an immutable parsed command plan.
 *
 * @param {object} commandPlan Frozen plan returned by parseObsidianCommandPlan.
 * @param {{agentId: string, workspaceIdentity: string, vaultConfirmed: boolean}} target Exact target binding.
 * @returns {object} A frozen policy with the original capabilities and gates.
 */
export function deriveTargetMutationPolicy(commandPlan, target = {}) {
  if (!commandPlan || Object.isFrozen(commandPlan) !== true || commandPlan.mutationPolicy?.kind !== POLICY_KIND) {
    throw new Error("Immutable Obsidian command plan required");
  }
  const agentId = safeAgentId(target.agentId);
  const workspaceIdentity = normalizeWorkspaceTarget(
    target.workspaceIdentity,
    "Obsidian target workspace identity",
  );
  if (agentId !== commandPlan.identity.agentId
    || workspaceIdentity !== commandPlan.identity.workspaceIdentity) {
    throw new Error("Obsidian target scope must exactly match canonical command identity");
  }
  const source = commandPlan.mutationPolicy;
  return makeMutationPolicy({
    capabilities: commandPlan.capabilities,
    mode: source.mode,
    dryRun: source.dryRun,
    allowWrite: source.allowWrite,
    vaultConfirmed: target.vaultConfirmed === true,
    actionConfirmed: source.actionConfirmed,
    baseDbPath: source.baseDbPath,
    agentId,
    workspaceIdentity,
  });
}

/**
 * Assert that a sink received the canonical policy and it permits a capability.
 *
 * @param {object} policy Mutation policy from `parseObsidianCommandPlan`.
 * @param {string} capability Required mutation capability.
 * @returns {true}
 */
export function assertMutationAllowed(policy, capability) {
  if (!policy || policy.kind !== POLICY_KIND || Object.isFrozen(policy) !== true) {
    throw new Error("Obsidian mutation policy required");
  }
  if (!policy.allows(capability)) {
    throw new Error(`Obsidian mutation denied: ${capability}`);
  }
  return true;
}

/** Return whether a canonical policy permits a capability without throwing. */
export function mutationAllowed(policy, capability) {
  try {
    return assertMutationAllowed(policy, capability);
  } catch {
    return false;
  }
}

export const OBSIDIAN_MUTATION_POLICY_KIND = POLICY_KIND;
