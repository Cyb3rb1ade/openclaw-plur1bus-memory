const FEATURE_DEFINITIONS = Object.freeze([
  { name: "autoCapture", path: ["autoCapture"], defaultValue: true, dependency: "conversationAccess" },
  { name: "autoRecall", path: ["autoRecall"], defaultValue: true },
  { name: "merging", path: ["merging", "enabled"], defaultValue: false },
  { name: "dailyConsolidation", path: ["dailyConsolidation", "enabled"], defaultValue: false },
  { name: "dreaming", path: ["dreaming", "enabled"], defaultValue: false },
  { name: "skillMiner", path: ["skillMiner", "enabled"], defaultValue: false, dependency: "skillWorkshop" },
  { name: "garbageCollection", path: ["gc", "enabled"], defaultValue: true },
  { name: "obsidianBridge", path: ["obsidianBridge", "enabled"], defaultValue: false },
  { name: "featureCronSetup", path: ["featureCronSetup", "auto"], defaultValue: true, dependency: "cronDispatch" },
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

function featureReason(definition, config, policy, capabilities) {
  if (policy?.enabled === false) return "workspace_disabled";
  if (definition.dependency === "conversationAccess" && config?.hooks?.allowConversationAccess !== true) {
    return "conversation_access_disabled";
  }
  if (definition.dependency === "skillWorkshop" && capabilities?.skillWorkshop !== true) {
    return "skill_workshop_unavailable";
  }
  if (definition.dependency === "cronDispatch" && capabilities?.cronDispatch !== true) {
    return "cron_dispatch_unavailable";
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

function projectNamespace(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  if (typeof value.id === "string" && value.id) output.id = value.id;
  if (Number.isInteger(value.dimensions) && value.dimensions > 0) output.dimensions = value.dimensions;
  if (Number.isInteger(value.rows) && value.rows >= 0) output.rows = value.rows;
  return Object.hasOwn(output, "id") ? output : null;
}

function projectMigration(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  for (const key of ["id", "state", "failureCode"]) {
    if (value[key] === null || typeof value[key] === "string") output[key] = value[key];
  }
  for (const key of ["processed", "total"]) {
    if (Number.isInteger(value[key]) && value[key] >= 0) output[key] = value[key];
  }
  return Object.keys(output).length > 0 ? output : null;
}

/** Build the closed, recursively secret-free status view used by PLUR1BUS read surfaces. */
export function buildControlPlaneProjection({
  config = {},
  policy = null,
  capabilities = {},
  providers = {},
  namespaces = [],
  migration = null,
} = {}) {
  const features = {};
  for (const definition of FEATURE_DEFINITIONS) {
    const raw = getPath(config, definition.path);
    const configured = raw === undefined ? definition.defaultValue : raw === true;
    const reason = configured ? featureReason(definition, config, policy, capabilities) : null;
    features[definition.name] = { configured, effective: configured && reason === null, reason };
  }

  const credentials = {};
  for (const [name, path] of CREDENTIAL_DEFINITIONS) {
    credentials[name] = configuredCredential(getPath(config, path));
  }

  return {
    schemaVersion: 1,
    workspace: policy
      ? {
          agentId: typeof policy.agentId === "string" ? policy.agentId : null,
          identity: typeof policy.workspaceIdentity === "string" ? policy.workspaceIdentity : null,
          enabled: policy.enabled !== false,
          revision: Number.isInteger(policy.revision) ? policy.revision : 0,
        }
      : null,
    features,
    credentials,
    providers: {
      embedding: projectProvider(providers.embedding),
      reranker: projectProvider(providers.reranker),
    },
    namespaces: Array.isArray(namespaces) ? namespaces.map(projectNamespace).filter(Boolean) : [],
    migration: projectMigration(migration),
  };
}
