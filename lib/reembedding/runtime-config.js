import { normalizeEmbeddingFingerprint } from "./fingerprint.js";
import { pinnedLocalModelProfile } from "../providers/local-model-artifacts.js";

const ENV_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validatedSecretRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid embedding SecretRef");
  if (Object.keys(value).sort().join(",") !== "id,provider,source") throw new Error("invalid embedding SecretRef fields");
  if (!["env", "store", "file", "exec"].includes(value.source)) throw new Error("invalid embedding SecretRef source");
  if (typeof value.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.provider)) {
    throw new Error("invalid embedding SecretRef provider");
  }
  if (typeof value.id !== "string" || !value.id || value.id.length > 256) throw new Error("invalid embedding SecretRef id");
  return Object.freeze(structuredClone(value));
}

/** Return a persistable credential reference without ever projecting literal key material. */
export function redactedEmbeddingSecretRef(config = {}) {
  if (config.provider === "local-transformers") return null;
  if (config.apiKey && typeof config.apiKey === "object") return validatedSecretRef(config.apiKey);
  if (typeof config.apiKeyEnv === "string" && ENV_ID_RE.test(config.apiKeyEnv)) {
    return Object.freeze({ source: "env", provider: "default", id: config.apiKeyEnv });
  }
  if (typeof config.apiKey === "string") {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(config.apiKey.trim());
    return match
      ? Object.freeze({ source: "env", provider: "default", id: match[1] })
      : null;
  }
  if (config.apiKey === undefined || config.apiKey === null) {
    return Object.freeze({ source: "env", provider: "default", id: "OPENAI_API_KEY" });
  }
  return null;
}

/** Convert an effective provider config into the immutable active vector-space fingerprint. */
export function embeddingFingerprintFromNormalizedConfig(config = {}) {
  if (config.provider === "local-transformers") {
    const profile = pinnedLocalModelProfile(config.model);
    if (!profile) throw new Error(`local embedding model is not pinned: ${String(config.model)}`);
    if (config.local?.revision !== profile.revision) {
      throw new Error(`local embedding revision is not pinned for ${profile.model}`);
    }
    return normalizeEmbeddingFingerprint({
      provider: config.provider,
      model: config.model,
      revision: profile.revision,
      dimensions: config.dimensions,
      queryPrefix: config.local.queryPrefix,
      passagePrefix: config.local.passagePrefix,
      pooling: "mean",
      normalize: true,
    }, profile.artifacts.map(({ path, sha256 }) => ({ path, sha256 })));
  }
  return normalizeEmbeddingFingerprint({
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    ...(config.baseUrl ? { endpoint: config.baseUrl } : {}),
  }, []);
}

/** Project one validated migration selection into PLUR1BUS' closed embedding config. */
export function embeddingConfigFromSelection(selection = {}, current = {}) {
  const fingerprint = selection.fingerprint;
  if (!fingerprint || typeof fingerprint !== "object" || Array.isArray(fingerprint)) {
    throw new Error("embedding selection fingerprint is required");
  }
  const shared = {
    provider: fingerprint.provider,
    dimensions: fingerprint.dimensions,
    ...(selection.secretRef ? { apiKey: structuredClone(selection.secretRef) } : {}),
    ...(current.fallback ? { fallback: structuredClone(current.fallback) } : {}),
  };
  if (fingerprint.provider === "local-transformers") {
    return {
      ...shared,
      local: {
        model: fingerprint.model,
        dimensions: fingerprint.dimensions,
        revision: fingerprint.revision,
        ...(fingerprint.queryPrefix ? { queryPrefix: fingerprint.queryPrefix } : {}),
        ...(fingerprint.passagePrefix ? { passagePrefix: fingerprint.passagePrefix } : {}),
        ...(current.local?.cacheDir ? { cacheDir: current.local.cacheDir } : {}),
      },
    };
  }
  return {
    ...shared,
    model: fingerprint.model,
    ...(fingerprint.endpoint ? { baseUrl: fingerprint.endpoint } : {}),
  };
}

/** Build an official OpenClaw config mutator for an atomic embedding-generation selection. */
export function createOpenClawEmbeddingSelectionMutator({
  api,
  pluginId = "memory-lancedb-namespaced",
} = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") {
    throw new Error("OpenClaw mutateConfigFile capability is required for reembedding");
  }
  return async (selection = {}) => mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate(draft) {
      const entry = draft?.plugins?.entries?.[pluginId];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("active PLUR1BUS config entry is unavailable");
      }
      const current = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
        ? entry.config
        : {};
      const next = {
        ...current,
        embedding: embeddingConfigFromSelection(selection, current.embedding || {}),
      };
      if (selection.generation === null) {
        delete next.reembedding;
      } else {
        if (typeof selection.generation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(selection.generation)) {
          throw new Error("invalid embedding selection generation");
        }
        if (typeof selection.fingerprintId !== "string" || !/^embedding:v1:sha256:[a-f0-9]{64}$/.test(selection.fingerprintId)) {
          throw new Error("invalid embedding selection fingerprint id");
        }
        next.reembedding = {
          activeGeneration: selection.generation,
          fingerprintId: selection.fingerprintId,
          dimensions: selection.fingerprint.dimensions,
        };
      }
      entry.config = next;
      return Object.freeze({ generation: selection.generation, fingerprintId: selection.fingerprintId });
    },
  });
}
