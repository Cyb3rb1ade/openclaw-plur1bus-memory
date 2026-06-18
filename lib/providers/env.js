const CONTROL_CHARS_RE = /[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g;

const ENV_GETTERS = {
  COHERE_API_KEY: () => process.env.COHERE_API_KEY,
  OPENAI_API_KEY: () => process.env.OPENAI_API_KEY,
  OPENAI_API_KEY_FALLBACK: () => process.env.OPENAI_API_KEY_FALLBACK,
  OPENAI_BASE_URL: () => process.env.OPENAI_BASE_URL,
  OPENAI_COMPATIBLE_API_KEY: () => process.env.OPENAI_COMPATIBLE_API_KEY,
  OPENAI_COMPATIBLE_BASE_URL: () => process.env.OPENAI_COMPATIBLE_BASE_URL,
  OPENCLAW_HOME: () => process.env.OPENCLAW_HOME || `${process.env.HOME || "."}/.openclaw`,
  PLUR1BUS_COHERE_API_KEY: () => process.env.PLUR1BUS_COHERE_API_KEY,
  PLUR1BUS_MODEL_CACHE: () => process.env.PLUR1BUS_MODEL_CACHE,
  PLUR1BUS_OPENAI_API_KEY: () => process.env.PLUR1BUS_OPENAI_API_KEY,
  PLUR1BUS_OPENAI_BASE_URL: () => process.env.PLUR1BUS_OPENAI_BASE_URL,
  PLUR1BUS_OPENAI_COMPATIBLE_API_KEY: () => process.env.PLUR1BUS_OPENAI_COMPATIBLE_API_KEY,
  PLUR1BUS_OPENAI_COMPATIBLE_BASE_URL: () => process.env.PLUR1BUS_OPENAI_COMPATIBLE_BASE_URL,
};

const ALLOWED_GROUPS = {
  cohere: new Set([
    "COHERE_API_KEY",
    "PLUR1BUS_COHERE_API_KEY",
  ]),
  localPath: new Set([
    "OPENCLAW_HOME",
    "PLUR1BUS_MODEL_CACHE",
  ]),
  openai: new Set([
    "OPENAI_API_KEY",
    "OPENAI_API_KEY_FALLBACK",
    "OPENAI_BASE_URL",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
    "PLUR1BUS_OPENAI_API_KEY",
    "PLUR1BUS_OPENAI_BASE_URL",
    "PLUR1BUS_OPENAI_COMPATIBLE_API_KEY",
    "PLUR1BUS_OPENAI_COMPATIBLE_BASE_URL",
  ]),
};

function sanitizeEnvValue(value) {
  return String(value).replace(CONTROL_CHARS_RE, "").trim();
}

function allowedEnvNames(groups) {
  const out = new Set();
  for (const group of groups) {
    for (const envVar of ALLOWED_GROUPS[group] || []) out.add(envVar);
  }
  return out;
}

export function resolveEnvVars(value, { groups = ["openai"], label = "value" } = {}) {
  if (!value) return value;
  const allowed = allowedEnvNames(groups);
  return String(value).replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    if (!allowed.has(envVar) || !ENV_GETTERS[envVar]) {
      throw new Error(
        `Environment variable ${envVar} is not allowed for PLUR1BUS ${label}. ` +
        "Use an explicit PLUR1BUS/OpenAI/Cohere provider variable or pass a literal configured value."
      );
    }
    const v = ENV_GETTERS[envVar]();
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    return sanitizeEnvValue(v);
  });
}

export function resolveOptionalEnvVars(value, options = {}) {
  try {
    return resolveEnvVars(value, options);
  } catch (_) {
    return undefined;
  }
}

/**
 * Löst einen API-Key aus Config auf.
 *
 * Priorität: cfg.apiKeyEnv → cfg.apiKey → opts.defaultEnv
 * KEIN globaler OPENAI-Fallback — jeder Aufrufer muss defaultEnv explizit setzen.
 * Cohere: defaultEnv: "COHERE_API_KEY"
 * OpenAI Embedding: defaultEnv: "OPENAI_API_KEY"
 *
 * @param {object} cfg — { apiKeyEnv?, apiKey? }
 * @param {object} opts — { defaultEnv?, optional?, label? }
 */
export function resolveApiKey(cfg = {}, { defaultEnv, optional = false, label = "API key" } = {}) {
  // 1. cfg.apiKeyEnv hat höchste Priorität
  if (cfg.apiKeyEnv) {
    const val = process.env[cfg.apiKeyEnv];
    if (!val) {
      if (optional) return undefined;
      throw new Error(`Env var ${cfg.apiKeyEnv} not set — required for ${label}`);
    }
    return val;
  }
  // 2. cfg.apiKey als Literal (${VAR}-Syntax wird aufgelöst)
  if (cfg.apiKey) {
    return resolveOptionalEnvVars(cfg.apiKey) || cfg.apiKey;
  }
  // 3. defaultEnv — nur wenn vom Aufrufer explizit gesetzt
  if (defaultEnv) {
    const val = process.env[defaultEnv];
    if (!val) {
      if (optional) return undefined;
      throw new Error(`Env var ${defaultEnv} not set — required for ${label}`);
    }
    return val;
  }
  // 4. Kein Key gefunden — kein globaler Fallback
  if (optional) return undefined;
  throw new Error(`no API key configured for ${label} (set apiKeyEnv, apiKey, or pass defaultEnv)`);
}
