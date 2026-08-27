import { loadOpenClawPluginSdkRuntime } from "../setup/feature-cron-plugin-runtime.js";

const LEGACY_ENV_NAMES = new Set([
  "COHERE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_FALLBACK",
  "OPENAI_COMPATIBLE_API_KEY",
  "PLUR1BUS_COHERE_API_KEY",
  "PLUR1BUS_OPENAI_API_KEY",
  "PLUR1BUS_OPENAI_COMPATIBLE_API_KEY",
]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function unresolvedError(path) {
  const error = new Error(`${path}: configured SecretInput could not be resolved`);
  error.code = "PLUR1BUS_SECRET_INPUT_UNRESOLVED";
  return error;
}

function normalizeResolved(value, path) {
  if (typeof value !== "string" || !value.trim()) throw unresolvedError(path);
  return value.trim();
}

function resolveEnvName(env, envName, path) {
  if (!ENV_NAME_RE.test(envName)) throw unresolvedError(path);
  return normalizeResolved(env?.[envName], path);
}

function resolveLegacyString(value, env, path) {
  const match = /^\$\{([^}]+)\}$/.exec(value);
  if (!match) return normalizeResolved(value, path);
  const envName = match[1];
  if (!LEGACY_ENV_NAMES.has(envName)) throw unresolvedError(path);
  return resolveEnvName(env, envName, path);
}

/** Return a redacted credential-source classification suitable for status UIs. */
export function secretInputSourceKind(value) {
  if (value === undefined || value === null || value === "") return "unset";
  if (typeof value === "string") return "configured";
  if (value && typeof value === "object" && ["env", "store", "file", "exec"].includes(value.source)) {
    return value.source;
  }
  return "invalid";
}

/** Load the public SecretInput resolver from the exact active OpenClaw host package. */
export async function loadOpenClawSecretInputRuntime(options = {}) {
  return loadOpenClawPluginSdkRuntime("secret-input-runtime", options);
}

/**
 * Create a lazy credential resolver that keeps legacy strings compatible and
 * delegates structured SecretRefs exclusively to OpenClaw's public runtime.
 */
export function createConfiguredSecretInputResolver({
  getConfig,
  env = process.env,
  loadSecretRuntime = loadOpenClawSecretInputRuntime,
} = {}) {
  let runtimePromise;
  return async function resolveConfiguredCredential({ value, apiKeyEnv, defaultEnv, path } = {}) {
    if (typeof path !== "string" || !path) throw unresolvedError("plugin credential");
    if (apiKeyEnv !== undefined && apiKeyEnv !== null && apiKeyEnv !== "") {
      if (typeof apiKeyEnv !== "string") throw unresolvedError(path);
      return resolveEnvName(env, apiKeyEnv, path);
    }
    if (typeof value === "string") return resolveLegacyString(value, env, path);
    if (value === undefined || value === null || value === "") {
      if (typeof defaultEnv === "string" && defaultEnv) return resolveEnvName(env, defaultEnv, path);
      throw unresolvedError(path);
    }
    if (typeof value !== "object" || Array.isArray(value)) throw unresolvedError(path);

    try {
      runtimePromise ??= Promise.resolve().then(() => loadSecretRuntime());
      const runtime = await runtimePromise;
      if (typeof runtime?.resolveConfiguredSecretInputString !== "function") throw unresolvedError(path);
      const config = typeof getConfig === "function" ? getConfig() : null;
      if (!config || typeof config !== "object") throw unresolvedError(path);
      const resolved = await runtime.resolveConfiguredSecretInputString({
        config,
        env,
        value,
        path,
        unresolvedReasonStyle: "generic",
      });
      if (resolved?.unresolvedRefReason) throw unresolvedError(path);
      return normalizeResolved(resolved?.value, path);
    } catch {
      throw unresolvedError(path);
    }
  };
}
