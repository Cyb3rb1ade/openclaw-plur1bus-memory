import { createHash } from "node:crypto";

const FEATURE_DEFINITIONS = Object.freeze([
  { name: "autoCapture", path: ["autoCapture"], defaultValue: true, dependency: "conversationAccess" },
  { name: "autoRecall", path: ["autoRecall"], defaultValue: true },
  { name: "merging", path: ["merging", "enabled"], defaultValue: true },
  { name: "dailyConsolidation", path: ["dailyConsolidation", "enabled"], defaultValue: true },
  { name: "dreaming", path: ["dreaming", "enabled"], defaultValue: true },
  { name: "skillMiner", path: ["skillMiner", "enabled"], defaultValue: true, dependency: "skillWorkshop" },
  { name: "garbageCollection", path: ["gc", "enabled"], defaultValue: true },
  { name: "obsidianBridge", path: ["obsidianBridge", "enabled"], defaultValue: true },
  { name: "featureCronSetup", path: ["featureCronSetup", "auto"], defaultValue: true, dependency: "cronDispatch" },
  { name: "reranker", path: ["reranker", "enabled"], defaultValue: true, dependency: "rerankerRuntime" },
  { name: "emotionTier3", path: ["emotion", "t3", "enabled"], defaultValue: true },
  { name: "knowledgePromotion", path: ["schicht15", "enabled"], defaultValue: true },
  { name: "criticalPush", path: ["criticalPush", "enabled"], defaultValue: true },
  { name: "afterthought", path: ["afterthought", "enabled"], defaultValue: true },
  { name: "personaVoice", path: ["personaVoice", "enabled"], defaultValue: true },
  { name: "dreamEcho", path: ["dreamEcho", "enabled"], defaultValue: true },
  { name: "continuityEngine", path: ["continuityEngine", "enabled"], defaultValue: true },
  { name: "replyOutcomeTracking", path: ["replyOutcomeTracking", "enabled"], defaultValue: true },
  { name: "contradictionDisclosure", path: ["contradictionDisclosure", "enabled"], defaultValue: true },
  { name: "semanticLens", path: ["semanticLens", "enabled"], defaultValue: true },
  { name: "queryRefinement", path: ["recall", "queryRefinement", "enabled"], defaultValue: true },
  { name: "decisionTrace", path: ["trace", "enabled"], defaultValue: true },
  { name: "semanticCompression", path: ["semanticCompression", "enabled"], defaultValue: true },
  { name: "neo", path: ["neo", "enabled"], defaultValue: true },
  { name: "metaCognition", path: ["metaCognition", "enabled"], defaultValue: true },
  { name: "temporalContext", path: ["temporalContext", "enabled"], defaultValue: true },
]);

const FEATURE_CARD_DEFINITIONS = Object.freeze([
  { id: "capture", feature: "autoCapture", label: "Capture", dependencies: ["conversation_access"], purpose: "Stores each finished turn as memory." },
  { id: "recall", feature: "autoRecall", label: "Recall", dependencies: [], purpose: "Injects relevant memories into the prompt." },
  { id: "skill-miner", feature: "skillMiner", label: "Skill Miner", dependencies: ["skill_workshop"], purpose: "Derives reusable skills from past conversations." },
  { id: "feature-cron", feature: "featureCronSetup", label: "Feature Cron", dependencies: ["cron_dispatch"], purpose: "Registers the scheduled jobs the other features need." },
  { id: "rem", feature: "dreaming", label: "REM", dependencies: ["merging_route"], purpose: "Background consolidation of memories into patterns." },
  { id: "obsidian", feature: "obsidianBridge", label: "Obsidian Bridge", dependencies: [], purpose: "Mirrors memories into your Obsidian notes." },
  { id: "reranker", feature: "reranker", label: "Reranker", dependencies: ["reranker_runtime"], purpose: "Re-orders recall candidates for relevance." },
  { id: "merging", feature: "merging", label: "Merging", dependencies: [], purpose: "Decides whether two similar memories describe the same fact." },
  { id: "daily-consolidation", feature: "dailyConsolidation", label: "Daily Consolidation", dependencies: [], purpose: "Condenses each day's memories into a compact summary." },
  { id: "gc", feature: "garbageCollection", label: "Garbage Collection", dependencies: [], purpose: "Removes memories a retention policy no longer keeps. Inert without a policy." },
  { id: "emotion-t3", feature: "emotionTier3", label: "Emotion Engine (T3)", dependencies: [], purpose: "Deep affective analysis of a turn. Stays inert without a provider." },
  { id: "knowledge-promotion", feature: "knowledgePromotion", label: "Knowledge Promotion", dependencies: [], purpose: "Promotes recurring findings into long-term knowledge." },
  { id: "critical-push", feature: "criticalPush", label: "Critical Push", dependencies: [], purpose: "Sends urgent memory findings to the operator." },
  { id: "afterthought", feature: "afterthought", label: "Afterthought", dependencies: [], purpose: "Revisits a finished turn for what was missed. Needs skill miner or merging." },
  { id: "persona-voice", feature: "personaVoice", label: "Persona Voice", dependencies: [], purpose: "Evolves the agent's voice from observed conversations. Needs the skill miner." },
  { id: "dream-echo", feature: "dreamEcho", label: "Dream Echo", dependencies: [], purpose: "Surfaces material that dreaming consolidated." },
  { id: "continuity", feature: "continuityEngine", label: "Continuity Engine", dependencies: [], purpose: "Carries themes across sessions; also gates pattern surfacing and the taste gate." },
  { id: "reply-outcome", feature: "replyOutcomeTracking", label: "Reply Outcome Tracking", dependencies: [], purpose: "Records how replies landed, to learn from them." },
  { id: "contradiction", feature: "contradictionDisclosure", label: "Contradiction Disclosure", dependencies: [], purpose: "Points out when a recalled memory conflicts with the current turn." },
  { id: "semantic-lens", feature: "semanticLens", label: "Semantic Lens", dependencies: [], purpose: "Projects memories onto a semantic index for sharper recall." },
  { id: "query-refinement", feature: "queryRefinement", label: "Query Refinement", dependencies: [], purpose: "Rewrites a recall query before searching." },
  { id: "decision-trace", feature: "decisionTrace", label: "Decision Trace", dependencies: [], purpose: "Records why a memory was recalled. Injecting it into the prompt stays a separate opt-in." },
  { id: "semantic-compression", feature: "semanticCompression", label: "Semantic Compression", dependencies: [], purpose: "Condenses recalled material before it reaches the prompt." },
  { id: "neo", feature: "neo", label: "Neo Layer", dependencies: [], purpose: "Additive cognitive layer over the memory store." },
  { id: "meta-cognition", feature: "metaCognition", label: "Meta Cognition", dependencies: [], purpose: "Observes the agent's own recall quality." },
  { id: "temporal-context", feature: "temporalContext", label: "Temporal Context", dependencies: [], purpose: "Adds time-awareness to recall ranking." },
]);

const PAUSED_WORKSPACE_HOOKS = Object.freeze([
  "automatic_capture",
  "automatic_recall",
  "embedding",
  "reranking",
  "skill_miner",
  "workspace_cron",
  "workspace_obsidian",
  "workspace_maintenance",
]);

// Command templates, not rendered paths: the operator fills in their own.
const OBSIDIAN_SETUP_COMMANDS = Object.freeze([
  { id: "detect", command: "plur1bus-obsidian detect --session <key>", purpose: "List the Obsidian targets found on this machine." },
  { id: "use", command: "plur1bus-obsidian use --session <key> --path <target>", purpose: "Adopt an existing target and receive a one-time token." },
  { id: "create", command: "plur1bus-obsidian create --session <key> --path <target>", purpose: "Create a new target and receive a one-time token." },
  { id: "confirm", command: "plur1bus-obsidian confirm --session <key> --path <target> --token <token>", purpose: "Redeem the token; only this step writes the receipt." },
]);

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_PUBLIC_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE_RE = /^[a-z][a-z0-9_:-]{0,63}$/;
const SAFE_MIGRATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_FINGERPRINT_RE = /^embedding:v1:sha256:[a-f0-9]{64}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIMENSION_MODES = new Set(["fixed", "selectable", "probe_required"]);
const PUBLIC_MODEL_LICENSES = new Set(["CC-BY-NC-4.0"]);
const REEMBEDDING_STATES = new Set([
  "planned",
  "confirmed",
  "running",
  "validating",
  "ready_to_switch",
  "switching",
  "completed",
  "failed",
  "rollback_planned",
  "rolling_back",
  "rolled_back",
]);
const MODEL_PREPARATION_STATES = new Set([
  "blocked",
  "downloading",
  "validating",
  "ready",
  "failed",
  "interrupted",
]);
const MODEL_PREPARATION_SUGGESTION_STATES = new Set([
  "not_required",
  "recommended",
  "empty_source",
  "blocked_insufficient_disk",
]);
const MODEL_PREPARATION_NEXT_ACTIONS = new Set([
  "none",
  "plan_with_explicit_confirmation",
  "confirm_empty_generation_switch",
]);

const CREDENTIAL_DEFINITIONS = Object.freeze([
  ["embedding", ["embedding", "apiKey"]],
  ["embeddingFallback", ["embedding", "fallback", "apiKey"]],
  ["reranker", ["reranker", "apiKey"]],
  ["merging", ["merging", "apiKey"]],
  ["knowledgePromotion", ["schicht15", "apiKey"]],
  ["skillMiner", ["skillMiner", "apiKey"]],
  ["criticalPush", ["criticalPush", "apiKey"]],
  ["emotionTier3", ["emotion", "t3", "apiKey"]],
]);

function getPath(value, path) {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function configuredCredential(value) {
  if (value === undefined || value === null || value === "") return { status: "missing", source: null };
  if (typeof value === "string") return { status: "configured", source: "plaintext" };
  if (value && typeof value === "object" && ["env", "store", "file", "exec"].includes(value.source)) {
    return { status: "configured", source: value.source };
  }
  return { status: "invalid", source: null };
}

function featureReason(definition, config, hooks, policy, capabilities) {
  if (policy?.enabled === false) return "workspace_disabled";
  if (definition.dependency === "conversationAccess" && hooks?.allowConversationAccess !== true) {
    return "conversation_access_disabled";
  }
  if (definition.dependency === "skillWorkshop" && capabilities?.skillWorkshop !== true) {
    return "skill_workshop_unavailable";
  }
  if (definition.dependency === "cronDispatch" && capabilities?.cronDispatch !== true) {
    return "cron_dispatch_unavailable";
  }
  if (definition.dependency === "rerankerRuntime" && capabilities?.reranker !== true) {
    return "reranker_unavailable";
  }
  return null;
}

function projectProvider(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  for (const key of ["provider", "model", "revision", "dimensions", "fingerprint"]) {
    const item = value[key];
    if ((typeof item === "string" && item) || (key === "dimensions" && Number.isInteger(item) && item > 0)) {
      output[key] = item;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}

function projectEmbeddingDimensionProfile(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.id !== "string" || !SAFE_PUBLIC_ID_RE.test(value.id)) return null;
  if (typeof value.provider !== "string" || !SAFE_PUBLIC_ID_RE.test(value.provider)) return null;
  if (typeof value.model !== "string" || !SAFE_MODEL_RE.test(value.model)) return null;
  if (!DIMENSION_MODES.has(value.mode) || value.verification !== "runtime_vector") return null;
  const dimensions = [value.defaultDimensions, value.minDimensions, value.maxDimensions];
  if (value.mode === "probe_required") {
    if (dimensions.some((entry) => entry !== null) || !Array.isArray(value.presets) || value.presets.length !== 0) {
      return null;
    }
  } else if (dimensions.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
    return null;
  }
  if (!Array.isArray(value.presets) || value.presets.length > 32) return null;
  const presets = [...new Set(value.presets)];
  if (
    presets.length !== value.presets.length
    || presets.some((entry) => !Number.isSafeInteger(entry) || entry < 1)
    || presets.some((entry, index) => index > 0 && entry <= presets[index - 1])
  ) return null;
  const output = {
    id: value.id,
    provider: value.provider,
    model: value.model,
    mode: value.mode,
    defaultDimensions: value.defaultDimensions,
    minDimensions: value.minDimensions,
    maxDimensions: value.maxDimensions,
    presets,
    current: value.current === true,
    verification: "runtime_vector",
  };
  if (value.presetOnly === true) output.presetOnly = true;
  if (PUBLIC_MODEL_LICENSES.has(value.license)) output.license = value.license;
  if (value.commercialUse === false) output.commercialUse = false;
  if (Number.isSafeInteger(value.selectedDimensions) && value.selectedDimensions > 0) {
    output.selectedDimensions = value.selectedDimensions;
  }
  return output;
}

function projectNamespace(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  if (typeof value.id === "string" && SAFE_PUBLIC_ID_RE.test(value.id)) output.id = value.id;
  if (Number.isInteger(value.dimensions) && value.dimensions > 0) output.dimensions = value.dimensions;
  if (Number.isInteger(value.rows) && value.rows >= 0) output.rows = value.rows;
  return Object.hasOwn(output, "id") ? output : null;
}

function projectMigration(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  if (typeof value.id === "string" && SAFE_MIGRATION_ID_RE.test(value.id)) output.id = value.id;
  if (typeof value.state === "string" && REEMBEDDING_STATES.has(value.state)) output.state = value.state;
  if (value.failureCode === null || (typeof value.failureCode === "string" && SAFE_ERROR_CODE_RE.test(value.failureCode))) {
    output.failureCode = value.failureCode;
  }
  for (const key of ["processed", "total", "estimatedBytes", "targetDimensions", "checkpointBytes"]) {
    if (Number.isInteger(value[key]) && value[key] >= 0) output[key] = value[key];
  }
  if (typeof value.targetFingerprint === "string" && SAFE_FINGERPRINT_RE.test(value.targetFingerprint)) {
    output.targetFingerprint = value.targetFingerprint;
  }
  if (["passed", "probe_deferred_local_artifact"].includes(value.targetProbeStatus)) {
    output.targetProbeStatus = value.targetProbeStatus;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function projectModelPreparationSuggestion(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.required !== "boolean"
    || !MODEL_PREPARATION_SUGGESTION_STATES.has(value.status)
    || !MODEL_PREPARATION_NEXT_ACTIONS.has(value.nextAction)
  ) return null;
  for (const key of ["rows", "targetBytes", "requiredFreeBytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
  }
  if (value.freeBytes !== null && (!Number.isSafeInteger(value.freeBytes) || value.freeBytes < 0)) return null;
  return {
    required: value.required,
    status: value.status,
    rows: value.rows,
    targetBytes: value.targetBytes,
    requiredFreeBytes: value.requiredFreeBytes,
    freeBytes: value.freeBytes,
    nextAction: value.nextAction,
  };
}

function projectModelPreparation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!MODEL_PREPARATION_STATES.has(value.state)) return null;
  if (typeof value.profileId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.profileId)) return null;
  if (typeof value.model !== "string" || !SAFE_MODEL_RE.test(value.model)) return null;
  const revision = value.modelRevision ?? value.revision;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) return null;
  if (!Number.isSafeInteger(value.dimensions) || value.dimensions < 1) return null;
  for (const key of ["bytesCompleted", "bytesTotal", "artifactsCompleted", "artifactsTotal"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
  }
  if (value.bytesCompleted > value.bytesTotal || value.artifactsCompleted > value.artifactsTotal) return null;
  const targetFingerprintId = value.targetFingerprintId === null
    ? null
    : typeof value.targetFingerprintId === "string" && SAFE_FINGERPRINT_RE.test(value.targetFingerprintId)
      ? value.targetFingerprintId
      : undefined;
  if (targetFingerprintId === undefined) return null;
  const errorCode = value.errorCode === null
    ? null
    : typeof value.errorCode === "string" && SAFE_ERROR_CODE_RE.test(value.errorCode)
      ? value.errorCode
      : undefined;
  if (errorCode === undefined) return null;
  const license = PUBLIC_MODEL_LICENSES.has(value.license) ? value.license : null;
  return {
    state: value.state,
    profileId: value.profileId,
    model: value.model,
    revision,
    dimensions: value.dimensions,
    license,
    commercialUse: value.commercialUse !== false,
    bytesCompleted: value.bytesCompleted,
    bytesTotal: value.bytesTotal,
    artifactsCompleted: value.artifactsCompleted,
    artifactsTotal: value.artifactsTotal,
    targetFingerprintId,
    reembedding: projectModelPreparationSuggestion(value.reembedding),
    errorCode,
  };
}

function opaqueWorkspaceReference(value) {
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 62);
  return `workspace-ref:w-${digest}`;
}

function projectWorkspaceIdentity(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return null;
  return SAFE_PUBLIC_ID_RE.test(value) ? value : opaqueWorkspaceReference(value);
}

function projectWorkspaceOverride(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.agentId !== "string" || !SAFE_AGENT_ID_RE.test(value.agentId)) return null;
  const workspace = projectWorkspaceIdentity(value.workspaceIdentity);
  if (!workspace || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    return null;
  }
  return {
    agentId: value.agentId,
    workspace,
    enabled: value.enabled,
    revision: value.revision,
  };
}

function projectWorkspaceMatrix(values) {
  const overrides = Array.isArray(values)
    ? values.map(projectWorkspaceOverride).filter(Boolean)
    : [];
  overrides.sort((left, right) => (
    left.agentId.localeCompare(right.agentId) || left.workspace.localeCompare(right.workspace)
  ));
  return {
    defaultEnabled: true,
    overrides,
    disabledWorkspaceEffects: [...PAUSED_WORKSPACE_HOOKS],
  };
}

function projectFeatureCards(features) {
  return FEATURE_CARD_DEFINITIONS.map((definition) => {
    const feature = features[definition.feature] || { configured: false, effective: false, reason: "feature_unavailable" };
    return {
      id: definition.id,
      label: definition.label,
      configured: feature.configured === true,
      effective: feature.effective === true,
      reason: feature.reason ?? null,
      dependencies: [...definition.dependencies],
      purpose: definition.purpose ?? null,
      configurationSurface: "/config",
      credentialSurface: "/secrets",
      audit: "openclaw_config_audit",
    };
  });
}

function unavailableMemoryHealth() {
  return {
    status: "unavailable",
    namespaces: [],
    cards: { byAgent: [], byWorkspace: [], byUser: [] },
    storage: { bytes: null, complete: false },
    lastError: { component: "health", code: "health_unavailable" },
    observedAt: 0,
  };
}

function projectHealthCounts(value, name) {
  if (!Array.isArray(value)) throw new Error(`invalid ${name} health count group`);
  const seen = new Set();
  const counts = value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !SAFE_PUBLIC_ID_RE.test(entry.id)) {
      throw new Error(`invalid ${name} health count id`);
    }
    if (!Number.isSafeInteger(entry.cards) || entry.cards < 0 || seen.has(entry.id)) {
      throw new Error(`invalid ${name} health count`);
    }
    seen.add(entry.id);
    return { id: entry.id, cards: entry.cards };
  });
  return counts.toSorted((left, right) => left.id.localeCompare(right.id));
}

function projectMemoryHealth(value) {
  if (!value || typeof value !== "object" || !["ready", "degraded", "unavailable"].includes(value.status)) {
    return unavailableMemoryHealth();
  }
  try {
    if (!Array.isArray(value.namespaces) || !value.cards || typeof value.cards !== "object") {
      throw new Error("invalid health payload");
    }
    if (!value.storage || typeof value.storage !== "object" || typeof value.storage.complete !== "boolean") {
      throw new Error("invalid health storage");
    }
    const namespaces = value.namespaces.map(projectNamespace).filter(Boolean);
    if (namespaces.length !== value.namespaces.length) throw new Error("invalid health namespace");
    const bytes = value.storage.bytes;
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) throw new Error("invalid health storage bytes");
    let lastError = null;
    if (value.lastError !== null && value.lastError !== undefined) {
      if (
        !value.lastError || typeof value.lastError !== "object"
        || typeof value.lastError.component !== "string" || !SAFE_ERROR_CODE_RE.test(value.lastError.component)
        || typeof value.lastError.code !== "string" || !SAFE_ERROR_CODE_RE.test(value.lastError.code)
      ) throw new Error("invalid health error");
      lastError = { component: value.lastError.component, code: value.lastError.code };
    }
    return {
      status: value.status,
      namespaces,
      cards: {
        byAgent: projectHealthCounts(value.cards.byAgent, "agent"),
        byWorkspace: projectHealthCounts(value.cards.byWorkspace, "workspace"),
        byUser: projectHealthCounts(value.cards.byUser, "user"),
      },
      storage: { bytes, complete: value.storage.complete },
      lastError,
      observedAt: Number.isSafeInteger(value.observedAt) && value.observedAt >= 0 ? value.observedAt : 0,
    };
  } catch {
    return unavailableMemoryHealth();
  }
}

function stateForReembeddingStep(state, step) {
  if (!state) return step === "dry-run" ? "current" : "pending";
  if (["planned", "confirmed"].includes(state)) {
    return ["dry-run", "estimate", "target-fingerprint"].includes(step) ? "complete" : "pending";
  }
  if (state === "running") {
    if (["dry-run", "estimate", "target-fingerprint"].includes(step)) return "complete";
    return step === "checkpoint" ? "current" : "pending";
  }
  if (state === "validating") {
    if (["dry-run", "estimate", "target-fingerprint", "checkpoint"].includes(step)) return "complete";
    return step === "validation" ? "current" : "pending";
  }
  if (["ready_to_switch", "switching"].includes(state)) {
    if (["dry-run", "estimate", "target-fingerprint", "checkpoint", "validation"].includes(step)) return "complete";
    return step === "switch" ? "current" : "pending";
  }
  if (state === "completed") {
    if (step === "rollback") return "ready";
    return "complete";
  }
  if (["rollback_planned", "rolling_back"].includes(state)) {
    if (step === "rollback") return "current";
    return "complete";
  }
  if (state === "rolled_back") return "complete";
  return step === "checkpoint" ? "failed" : "pending";
}

/**
 * Obsidian target readiness. Deliberately path-free: this projection omits
 * filesystem paths everywhere else, and a screenshot of the tab should not
 * leak a home directory. The operator gets the exact commands instead, and
 * `plur1bus-obsidian detect` prints the candidate paths locally.
 */
function projectObsidianVault(value) {
  if (!value || typeof value !== "object") {
    return {
      configured: false,
      confirmed: false,
      candidates: 0,
      mutationSurface: "operator_cli",
      commands: OBSIDIAN_SETUP_COMMANDS,
    };
  }
  const candidates = Number.isSafeInteger(value.candidates) && value.candidates >= 0 ? value.candidates : 0;
  return {
    configured: value.configured === true,
    confirmed: value.confirmed === true,
    candidates,
    mutationSurface: "operator_cli",
    commands: OBSIDIAN_SETUP_COMMANDS,
  };
}

function projectReembeddingWorkflow(migration) {
  const steps = [
    ["dry-run", "Dry run"],
    ["estimate", "Size and cost estimate"],
    ["target-fingerprint", "Target fingerprint validation"],
    ["checkpoint", "Copy progress and checkpoint"],
    ["validation", "Readback and recall validation"],
    ["switch", "Controlled switch"],
    ["rollback", "Rollback plan"],
  ].map(([id, label]) => ({ id, label, state: stateForReembeddingStep(migration?.state, id) }));
  if (migration?.targetProbeStatus === "probe_deferred_local_artifact") {
    const targetStep = steps.find((step) => step.id === "target-fingerprint");
    targetStep.state = "attention";
  }
  return {
    mutationSurface: "operator_admin",
    noImplicitDimensionChange: true,
    migration,
    steps,
  };
}

/** Build the closed, recursively secret-free status view used by PLUR1BUS read surfaces. */
export function buildControlPlaneProjection({
  config = {},
  hooks,
  policy = null,
  capabilities = {},
  providers = {},
  namespaces = [],
  migration = null,
  workspacePolicies = [],
  health = null,
  embeddingDimensionProfiles = [],
  modelPreparation = null,
  obsidianVault = null,
} = {}) {
  const effectiveHooks = hooks ?? config?.hooks ?? {};
  const features = {};
  for (const definition of FEATURE_DEFINITIONS) {
    const raw = getPath(config, definition.path);
    // Opt-out, matching the runtime: only an explicit `false` turns a
    // feature off, so the tab never claims a state the plugin disagrees with.
    const configured = raw === undefined ? definition.defaultValue : raw !== false;
    const reason = configured ? featureReason(definition, config, effectiveHooks, policy, capabilities) : null;
    features[definition.name] = { configured, effective: configured && reason === null, reason };
  }

  const credentials = {};
  for (const [name, path] of CREDENTIAL_DEFINITIONS) {
    credentials[name] = configuredCredential(getPath(config, path));
  }

  const projectedMigration = projectMigration(migration);
  const projectedWorkspace = policy && typeof policy === "object"
    ? {
        agentId: typeof policy.agentId === "string" && SAFE_AGENT_ID_RE.test(policy.agentId)
          ? policy.agentId
          : null,
        identity: projectWorkspaceIdentity(policy.workspaceIdentity),
        enabled: policy.enabled !== false,
        revision: Number.isInteger(policy.revision) && policy.revision >= 0 ? policy.revision : 0,
      }
    : null;

  return {
    schemaVersion: 2,
    workspace: projectedWorkspace,
    features,
    featureCards: projectFeatureCards(features),
    credentials,
    providers: {
      embedding: projectProvider(providers.embedding),
      reranker: projectProvider(providers.reranker),
    },
    embeddingDimensionProfiles: Array.isArray(embeddingDimensionProfiles)
      ? embeddingDimensionProfiles.map(projectEmbeddingDimensionProfile).filter(Boolean)
      : [],
    modelPreparation: projectModelPreparation(modelPreparation),
    namespaces: Array.isArray(namespaces) ? namespaces.map(projectNamespace).filter(Boolean) : [],
    migration: projectedMigration,
    memoryHealth: projectMemoryHealth(health),
    obsidianVault: projectObsidianVault(obsidianVault),
    workspaceMatrix: projectWorkspaceMatrix(workspacePolicies),
    reembeddingWorkflow: projectReembeddingWorkflow(projectedMigration),
  };
}
