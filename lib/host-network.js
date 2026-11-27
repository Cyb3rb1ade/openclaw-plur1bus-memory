/**
 * lib/host-network.js — the engine's outbound-HTTP and secret ports
 * (HostServices.fetch / HostServices.secrets, contract 1.15.0).
 *
 * Every outbound HTTP request the engine makes — embedding clients, rerankers,
 * the engine's own LLM calls, webhooks, model downloads — goes through
 * `hostFetch()`. When the host injected `HostServices.fetch`, that function
 * carries the request (so a host can enforce its egress policy); when it did
 * not, `hostFetch()` calls the global `fetch` at call time, which is exactly
 * the behaviour before 1.15.0.
 *
 * `resolveHostSecret()` asks the host's secret store for a provider key named
 * by `apiKeyRef`. The value is never logged and never cached here; callers
 * keep it at most `SECRET_REF_TTL_MS` (see createSecretRefCache) so a rotated
 * key is picked up without a restart.
 *
 * One binding per process, like lib/host-paths.js: the engine is the only
 * memory owner in a process (host-contract), so the last bind wins.
 */

/** How long a key resolved through `apiKeyRef` may be reused before it is resolved again. */
export const SECRET_REF_TTL_MS = 60_000;

/** Purposes the engine passes to `HostServices.secrets.resolve(ref, purpose)`. */
export const SECRET_PURPOSES = Object.freeze({
  EMBEDDING: "embedding",
  RERANKER: "reranker",
  LLM: "llm",
});

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;

let boundFetch = null;
let boundSecrets = null;

/**
 * Bind the host's network ports. Absent members unbind (global fetch, no secret store).
 * @param {{fetch?: Function|null, secrets?: {resolve?: Function, lease?: Function}|null}} [ports]
 * @returns {void}
 */
export function bindHostNetwork({ fetch, secrets } = {}) {
  if (fetch !== undefined && fetch !== null && typeof fetch !== "function") {
    throw new TypeError("HostServices.fetch must be a function when provided");
  }
  if (secrets !== undefined && secrets !== null) {
    if (typeof secrets !== "object"
      || (typeof secrets.resolve !== "function" && typeof secrets.lease !== "function")) {
      throw new TypeError("HostServices.secrets must provide resolve(ref, purpose) when provided");
    }
  }
  boundFetch = fetch ?? null;
  boundSecrets = secrets ?? null;
}

/** Drop both bindings (tests). */
export function resetHostNetwork() {
  boundFetch = null;
  boundSecrets = null;
}

/** @returns {boolean} True when the host injected its own fetch. */
export function isHostFetchBound() {
  return boundFetch !== null;
}

/** @returns {boolean} True when the host offers a secret store. */
export function isHostSecretStoreBound() {
  return boundSecrets !== null;
}

/**
 * WHATWG-fetch-compatible entry point for every outbound engine request.
 * Resolves the implementation per call, so a later bind (or a test that
 * swaps global fetch) is honoured.
 * @param {string|URL|Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function hostFetch(input, init) {
  if (boundFetch) return boundFetch(input, init);
  if (typeof globalThis.fetch !== "function") {
    return Promise.reject(new Error("no fetch implementation available"));
  }
  return globalThis.fetch(input, init);
}

/**
 * Client options that route an SDK (OpenAI and compatible) through the port.
 * Empty when no host fetch is bound, so the SDK keeps its own default.
 * @returns {{fetch?: Function}}
 */
export function sdkFetchOptions() {
  return boundFetch ? { fetch: hostFetch } : {};
}

/**
 * Route a loaded `@huggingface/transformers` module's downloads through the port.
 * @param {object} mod Transformers module namespace.
 * @returns {object} The same module.
 */
export function applyHostFetchToTransformers(mod) {
  if (boundFetch && mod?.env && typeof mod.env === "object") {
    try {
      mod.env.fetch = hostFetch;
    } catch (error) {
      throw new Error("transformers env.fetch cannot be routed through HostServices.fetch", { cause: error });
    }
  }
  return mod;
}

function secretError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  // The cause stays attached for diagnostics; the message never carries a value.
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Validate an `apiKeyRef` config value.
 * @param {unknown} ref
 * @returns {string|undefined} The trimmed reference, or undefined when unset.
 */
export function normalizeApiKeyRef(ref) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  if (typeof ref !== "string" || !REF_RE.test(ref.trim())) {
    throw new Error("apiKeyRef must be a secret name of 1-256 characters ([A-Za-z0-9._:/@-])");
  }
  return ref.trim();
}

/**
 * Resolve one secret through the host's store.
 * @param {string} ref Secret name in the host's store (`apiKeyRef`).
 * @param {string} purpose What the key is for ("embedding" | "reranker" | "llm").
 * @returns {Promise<string>} The trimmed secret.
 */
export async function resolveHostSecret(ref, purpose) {
  const name = normalizeApiKeyRef(ref);
  if (!name) throw secretError("apiKeyRef is empty", "PLUR1BUS_SECRET_REF_INVALID");
  const store = boundSecrets;
  if (!store) {
    throw secretError(
      `apiKeyRef "${name}" is configured but the host offers no secret store (HostServices.secrets)`,
      "PLUR1BUS_SECRET_STORE_UNAVAILABLE",
    );
  }
  let value;
  try {
    value = typeof store.resolve === "function"
      ? await store.resolve(name, String(purpose || ""))
      : await store.lease(name);
  } catch (cause) {
    throw secretError(`apiKeyRef "${name}" could not be resolved by the host secret store`, "PLUR1BUS_SECRET_REF_UNRESOLVED", cause);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw secretError(`apiKeyRef "${name}" resolved to an empty value`, "PLUR1BUS_SECRET_REF_UNRESOLVED");
  }
  return value.trim();
}

/**
 * A short-lived cache for one `apiKeyRef`: concurrent callers share one
 * resolution, a value lives at most `ttlMs`, and `invalidate()` (on 401/403)
 * forces the next call to ask the host again. Nothing is persisted.
 * @param {{ref: string, purpose: string, ttlMs?: number, clock?: () => number}} options
 * @returns {{get: () => Promise<string>, invalidate: () => void}}
 */
export function createSecretRefCache({ ref, purpose, ttlMs = SECRET_REF_TTL_MS, clock = Date.now }) {
  const name = normalizeApiKeyRef(ref);
  if (!name) throw new Error("createSecretRefCache needs an apiKeyRef");
  let value = null;
  let expiresAt = 0;
  let inflight = null;
  let generation = 0;
  return {
    async get() {
      if (value !== null && clock() < expiresAt) return value;
      if (!inflight) {
        const started = generation;
        inflight = resolveHostSecret(name, purpose).then((resolved) => {
          if (started === generation) {
            value = resolved;
            expiresAt = clock() + Math.max(0, ttlMs);
          }
          return resolved;
        }).finally(() => { inflight = null; });
      }
      return inflight;
    },
    invalidate() {
      generation += 1;
      value = null;
      expiresAt = 0;
    },
  };
}

/** True for an HTTP status that means "the credential was refused". */
export function isCredentialRejection(status) {
  return status === 401 || status === 403;
}
