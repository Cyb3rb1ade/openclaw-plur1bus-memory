import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import {
  BGE_RERANKER_PROFILE,
  JINA_RERANKER_PROFILE,
  localEmbeddingPreparationTarget,
  pinnedLocalModelProfile,
} from "../providers/local-model-artifacts.js";
import { embeddingFingerprintId } from "../reembedding/fingerprint.js";
import { embeddingFingerprintFromNormalizedConfig } from "../reembedding/runtime-config.js";

/**
 * Write surface for the operator dashboard.
 *
 * The tab is read-only unless an operator opts in through
 * `controlUi.writeActions`, because a page that can change the running
 * configuration is a different security posture from one that cannot. The
 * modes are deliberately coarse:
 *
 * - `off` (default): no forms are rendered, the descriptor asks for read scope
 *   only, and the page behaves exactly as it did before this surface existed.
 * - `reranker`: the reranking choice becomes switchable. That is a pure runtime
 *   choice with no data migration and it is reversible in one click.
 * - `all`: additionally exposes the embedding target and the re-embedding
 *   migration steps. Those move data and are gated further below.
 *
 * Every mutating request must carry a single-use form token. The plugin-tab
 * cookie the host mints is `SameSite=None`, so a cross-site form post would
 * otherwise arrive with valid credentials.
 */
export const CONTROL_UI_WRITE_MODES = Object.freeze(["off", "reranker", "all"]);
export const CONTROL_UI_FORM_TOKEN_FIELD = "form_token";
export const CONTROL_UI_ACTION_FIELD = "action";
const MAX_FORM_BYTES = 4096;

/** The closed set of reranking choices the dashboard may write. */
export const RERANKER_CHOICES = Object.freeze([
  Object.freeze({
    id: "local-bge",
    label: "Local BGE",
    detail: "Multilingual, bundled, no API key. The free default.",
    provider: "local-transformers",
    model: BGE_RERANKER_PROFILE.model,
    revision: BGE_RERANKER_PROFILE.revision,
    needsKey: false,
  }),
  Object.freeze({
    id: "local-jina",
    label: "Local JinaAI",
    detail: "Multilingual Jina reranker v2, runs locally, no API key. Downloaded and hash-checked on first use.",
    provider: "local-transformers",
    model: JINA_RERANKER_PROFILE.model,
    revision: JINA_RERANKER_PROFILE.revision,
    needsKey: false,
  }),
  Object.freeze({
    id: "cohere",
    label: "Cohere",
    detail: "Hosted reranking. Needs a key in reranker.apiKey or reranker.apiKeyEnv.",
    provider: "cohere",
    model: null,
    revision: null,
    needsKey: true,
  }),
  Object.freeze({
    id: "disabled",
    label: "Off",
    detail: "No reranking. Recall returns candidates in raw similarity order.",
    provider: "disabled",
    model: null,
    revision: null,
    needsKey: false,
  }),
]);

const RERANKER_CHOICES_BY_ID = new Map(RERANKER_CHOICES.map((choice) => [choice.id, choice]));

/** Resolve one reranking choice by its closed id. */
export function rerankerChoice(id) {
  return RERANKER_CHOICES_BY_ID.get(id) || null;
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Name the choice the running config currently expresses, or null when it matches none. */
export function activeRerankerChoiceId(config = {}) {
  const reranker = plainRecord(config.reranker) ? config.reranker : {};
  if (reranker.provider === "disabled" || reranker.enabled === false) return "disabled";
  if (reranker.provider === "cohere") return "cohere";
  if (reranker.provider === "local-transformers") {
    const model = plainRecord(reranker.local) ? reranker.local.model : undefined;
    const match = RERANKER_CHOICES.find((choice) => choice.provider === "local-transformers" && choice.model === model);
    // An unset local model runs the bundled default, which is BGE.
    return match ? match.id : model === undefined ? "local-bge" : null;
  }
  return null;
}

/** Whether a key is configured for the hosted reranker; presence only, never the value. */
export function rerankerKeyConfigured(config = {}, env = {}) {
  const reranker = plainRecord(config.reranker) ? config.reranker : {};
  if (typeof reranker.apiKey === "string" && reranker.apiKey.trim()) return true;
  if (plainRecord(reranker.apiKey) && typeof reranker.apiKey.source === "string") return true;
  const envName = typeof reranker.apiKeyEnv === "string" ? reranker.apiKeyEnv.trim() : "";
  if (!envName) return false;
  return plainRecord(env) && typeof env[envName] === "string" && env[envName].trim() !== "";
}

/**
 * Build the next reranker config for one choice, preserving unrelated keys.
 * Pure, so the shape can be asserted without touching a config file.
 */
export function rerankerConfigPatch(choice, current = {}) {
  if (!choice) throw new Error("unknown reranker choice");
  const previous = plainRecord(current) ? current : {};
  const local = plainRecord(previous.local) ? previous.local : {};
  if (choice.provider === "disabled") {
    return { ...previous, provider: "disabled", enabled: false };
  }
  if (choice.provider === "cohere") {
    return { ...previous, provider: "cohere", enabled: true };
  }
  return {
    ...previous,
    provider: "local-transformers",
    enabled: true,
    local: { ...local, model: choice.model, revision: choice.revision },
  };
}

/** Create an OpenClaw config mutator for the reranking choice. */
export function createRerankerMutator({ api, pluginId = "memory-lancedb-namespaced" } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") {
    throw new Error("OpenClaw mutateConfigFile capability is required for the reranker switch");
  }
  return async (choice) => mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate(draft) {
      const entry = draft?.plugins?.entries?.[pluginId];
      if (!plainRecord(entry)) throw new Error("active PLUR1BUS config entry is unavailable");
      const config = plainRecord(entry.config) ? entry.config : {};
      entry.config = { ...config, reranker: rerankerConfigPatch(choice, config.reranker) };
      return Object.freeze({ provider: choice.provider, model: choice.model });
    },
  });
}

/** Create an OpenClaw config mutator for the local embedding preparation profile. */
export function createEmbeddingProfileMutator({ api, pluginId = "memory-lancedb-namespaced" } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") {
    throw new Error("OpenClaw mutateConfigFile capability is required for the embedding profile switch");
  }
  return async ({ profile, acceptNonCommercialLicense }) => mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate(draft) {
      const entry = draft?.plugins?.entries?.[pluginId];
      if (!plainRecord(entry)) throw new Error("active PLUR1BUS config entry is unavailable");
      const config = plainRecord(entry.config) ? entry.config : {};
      const preparation = plainRecord(config.modelPreparation) ? config.modelPreparation : {};
      entry.config = {
        ...config,
        modelPreparation: {
          ...preparation,
          profile,
          ...(acceptNonCommercialLicense === true ? { acceptNonCommercialLicense: true } : {}),
        },
      };
      return Object.freeze({ profile });
    },
  });
}

/**
 * Build the plan target for a prepared local embedding profile.
 *
 * The fingerprint is derived from the same pinned artifact profile that model
 * preparation used, and the caller must confirm it matches the fingerprint
 * preparation actually validated. A silent mismatch would plan a migration
 * into a generation nobody verified, so it is refused instead.
 */
export function embeddingPlanTarget(profileId, expectedFingerprintId) {
  const target = localEmbeddingPreparationTarget(profileId);
  if (!target) throw new Error("unknown embedding preparation profile");
  const profile = pinnedLocalModelProfile(target.model);
  if (!profile) throw new Error("embedding preparation profile is not pinned");
  const fingerprint = embeddingFingerprintFromNormalizedConfig({
    provider: "local-transformers",
    model: target.model,
    dimensions: target.dimensions,
    local: {
      revision: target.revision,
      ...(profile.queryPrefix ? { queryPrefix: profile.queryPrefix } : {}),
      ...(profile.passagePrefix ? { passagePrefix: profile.passagePrefix } : {}),
    },
  });
  const id = embeddingFingerprintId(fingerprint);
  if (typeof expectedFingerprintId === "string" && expectedFingerprintId && id !== expectedFingerprintId) {
    throw new Error("prepared target fingerprint does not match the planned target");
  }
  return { fingerprint };
}

/**
 * Single-use form tokens, bounded in count and lifetime.
 *
 * The plugin-tab cookie is SameSite=None, so possession of a token issued by a
 * page render is what separates an operator's click from a cross-site post.
 */
export function createFormTokenStore({
  now = Date.now,
  ttlMs = 900_000,
  maxTokens = 64,
  randomBytes = nodeRandomBytes,
} = {}) {
  if (typeof now !== "function") throw new Error("form token clock is required");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("invalid form token TTL");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("invalid form token capacity");
  const tokens = new Map();

  const prune = (at) => {
    for (const [token, expiresAt] of tokens) {
      if (expiresAt <= at) tokens.delete(token);
    }
    while (tokens.size >= maxTokens) {
      const oldest = tokens.keys().next().value;
      if (oldest === undefined) break;
      tokens.delete(oldest);
    }
  };

  return Object.freeze({
    issue() {
      const at = now();
      prune(at);
      const token = randomBytes(32).toString("base64url");
      tokens.set(token, at + ttlMs);
      return token;
    },
    consume(candidate) {
      if (typeof candidate !== "string" || candidate.length < 16 || candidate.length > 256) return false;
      const at = now();
      prune(at);
      // Constant-time comparison against each live token: the set is small and
      // bounded, and a length-only early exit already leaks nothing useful.
      const supplied = Buffer.from(candidate);
      for (const [token, expiresAt] of tokens) {
        const known = Buffer.from(token);
        if (known.length !== supplied.length) continue;
        if (!timingSafeEqual(known, supplied)) continue;
        tokens.delete(token);
        return expiresAt > at;
      }
      return false;
    },
    get size() {
      return tokens.size;
    },
  });
}

/**
 * Hold re-embedding confirmation tokens inside the gateway.
 *
 * `plan` mints a one-time confirmation that `apply` and `switch` must present.
 * Rendering it into the browser would turn a deliberate second factor into a
 * value on a web page, so the dashboard keeps it here and the operator's second
 * click is the confirmation.
 */
export function createConfirmationStore({ now = Date.now, ttlMs = 3_600_000, maxEntries = 8 } = {}) {
  const entries = new Map();
  const prune = (at) => {
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(id);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return Object.freeze({
    remember(id, token) {
      if (typeof id !== "string" || !id || typeof token !== "string" || !token) return;
      const at = now();
      prune(at);
      entries.set(id, { token, expiresAt: at + ttlMs });
    },
    take(id) {
      const at = now();
      prune(at);
      return entries.get(id)?.token ?? null;
    },
    forget(id) {
      entries.delete(id);
    },
    get size() {
      return entries.size;
    },
  });
}

/** Read one bounded urlencoded form body. */
export async function readFormBody(request, { maxBytes = MAX_FORM_BYTES } = {}) {
  const contentType = String(request?.headers?.["content-type"] || "");
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new Error("unsupported form content type");
  }
  const declared = Number(request?.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("form body is too large");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("form body is too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const RESULTS = Object.freeze({
  reranker_switched: "Reranking switched. The new provider is active for the next recall.",
  embedding_profile_switched: "Embedding target selected. Model preparation downloads and verifies it; the migration buttons appear once it is ready.",
  reembedding_planned: "Dry run complete. Review the estimate below, then start the copy.",
  reembedding_applied: "Copy finished into the isolated target generation. Nothing is switched yet.",
  reembedding_switched: "Active embedding generation switched. Recall now runs in the new vector space.",
  denied_mode: "This dashboard is read-only. Set controlUi.writeActions to enable changes.",
  denied_token: "That form was stale. Reload the page and try again.",
  denied_action: "Unknown action.",
  denied_choice: "Unknown choice.",
  denied_key: "That provider needs a key first. Configure it under OpenClaw Secrets.",
  denied_not_ready: "The prepared target is not ready yet.",
  failed: "The change did not go through. Nothing was altered.",
});

/** Human-readable text for one action result code. */
export function writeResultText(code) {
  return Object.hasOwn(RESULTS, code) ? RESULTS[code] : null;
}

function allows(mode, action) {
  if (mode === "all") return true;
  if (mode === "reranker") return action === "reranker.set";
  return false;
}

/**
 * Apply one dashboard write action.
 * @returns {Promise<{code: string, ok: boolean}>} Stable result code for the banner.
 */
export async function applyControlUiWriteAction({ action, form, mode = "off", deps = {} } = {}) {
  if (!allows(mode, action)) return { ok: false, code: "denied_mode" };
  const value = (name) => {
    const raw = form?.get?.(name);
    return typeof raw === "string" ? raw.slice(0, 256) : "";
  };
  try {
    if (action === "reranker.set") {
      const choice = rerankerChoice(value("choice"));
      if (!choice) return { ok: false, code: "denied_choice" };
      if (choice.needsKey && !deps.rerankerKeyConfigured?.()) return { ok: false, code: "denied_key" };
      await deps.setReranker(choice);
      return { ok: true, code: "reranker_switched" };
    }
    if (action === "embedding.profile") {
      const profile = value("profile");
      if (!localEmbeddingPreparationTarget(profile)) return { ok: false, code: "denied_choice" };
      await deps.setEmbeddingProfile({
        profile,
        acceptNonCommercialLicense: value("accept_license") === "yes",
      });
      return { ok: true, code: "embedding_profile_switched" };
    }
    if (action === "reembedding.plan") {
      const prepared = deps.preparedTarget?.();
      if (!prepared?.profileId || !prepared?.fingerprintId) return { ok: false, code: "denied_not_ready" };
      const target = embeddingPlanTarget(prepared.profileId, prepared.fingerprintId);
      const planned = await deps.planReembedding({ id: deps.nextMigrationId(), target });
      const id = planned?.record?.id || planned?.plan?.id;
      const token = planned?.confirmation?.token;
      if (id && token) deps.confirmations.remember(id, token);
      return { ok: true, code: "reembedding_planned" };
    }
    if (action === "reembedding.apply" || action === "reembedding.switch") {
      const id = value("migration");
      const token = deps.confirmations.take(id);
      if (!token) return { ok: false, code: "denied_token" };
      if (action === "reembedding.apply") {
        await deps.applyReembedding({ id, token });
        return { ok: true, code: "reembedding_applied" };
      }
      await deps.switchReembedding({ id, token });
      deps.confirmations.forget(id);
      return { ok: true, code: "reembedding_switched" };
    }
  } catch (error) {
    deps.logger?.warn?.(`memory-lancedb-namespaced: control write action failed: ${error?.message || error}`);
    return { ok: false, code: "failed" };
  }
  return { ok: false, code: "denied_action" };
}
