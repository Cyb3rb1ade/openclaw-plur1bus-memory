/**
 * engine/admin/obsidian.js — E2 Task 7: AdminOps.obsidian, explicit paths, no host runtime.
 *
 * `detect` is a read-only lookup over configured/workspace/candidate vault paths.
 * `prepare`/`confirm` are the two halves of one one-time, identity- and vault-bound
 * confirmation (lib/obsidian-vault-confirmation-flow.js, itself built on
 * lib/security.js's createConfirmation/validateConfirmation) — no separate
 * confirmation mechanism is introduced here (global-constraints: "no third
 * confirmation mechanism").
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { discoverObsidianWorkspaces } from "../../lib/obsidian-bridge.js";
import { isOwnedVaultConfirmed } from "../../lib/obsidian-vault-authority.js";
import {
  confirmVaultConfirmation,
  prepareVaultConfirmation,
  vaultConfirmationCallbackForNonce,
} from "../../lib/obsidian-vault-confirmation-flow.js";
import { safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "../memory-ops/errors.js";

const MAX_CANDIDATES = 20;
const MAX_PENDING = 64;
const EXPIRY_MINUTES = 10;

// Every reason confirmVaultConfirmation()/validateConfirmation() (lib/security.js)
// can return, mapped onto the fixed MemoryOpError vocabulary. Read from
// lib/obsidian-vault-confirmation-flow.js's confirmVaultConfirmation (its own
// "invalid_format"/"not_found_or_expired"/"binding_mismatch"/"vault_digest_mismatch"/
// "missing_confirmation_store", plus lib/security.js's validateConfirmation
// "security.*" reasons it forwards verbatim) before adding to either set.
const CONFIRM_NOT_FOUND_REASONS = new Set([
  "not_found_or_expired",
  "security.not_found_or_expired",
  "security.expired",
]);
const CONFIRM_DENIED_REASONS = new Set([
  "binding_mismatch",
  "vault_digest_mismatch",
  "security.wrong_user",
  "security.wrong_chat",
]);

/**
 * "~" | "~/x" -> under homeDir; relative -> join(homeDir, raw); absolute -> as is; then normalize.
 *
 * @param {unknown} raw
 * @param {string} homeDir
 * @returns {string}
 */
export function expandVaultPath(raw, homeDir) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw memoryOpError("invalid-input", "vault path must be a non-empty string");
  }
  let expanded;
  if (raw === "~") {
    expanded = homeDir;
  } else if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    expanded = join(homeDir, raw.slice(2));
  } else if (isAbsolute(raw)) {
    expanded = raw;
  } else {
    expanded = join(homeDir, raw);
  }
  return normalize(expanded);
}

function isVaultDirectory(path) {
  return existsSync(join(path, ".obsidian", "workspace.json")) || existsSync(join(path, ".obsidian", "app.json"));
}

function isExistingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// prepareVaultConfirmation/confirmVaultConfirmation/isOwnedVaultConfirmed bind
// identity through memoryCtx.userId (identityBinding() in
// lib/obsidian-vault-confirmation-flow.js). memoryContextFromPrincipal
// (engine/identity/principal.js) never populates userId for a Principal-derived
// memoryCtx -- only userPrincipal, which is the engine's actual proof of a real
// end user for a proved principal. Controller ruling (Task 7): map
// userPrincipal onto userId here, locally, rather than changing the shared
// identity or confirmation-flow libs (both used by other, already-working
// callers). Applied identically at prepare and confirm time so the binding
// recorded when the nonce was issued is compared against the same shape later.
function boundMemoryCtx(memoryCtx) {
  return { ...memoryCtx, userId: memoryCtx.userPrincipal };
}

function dedupeByNormalizedPath(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    if (!seen.has(candidate.path)) seen.set(candidate.path, candidate);
  }
  return [...seen.values()];
}

/**
 * @param {object} options
 * @param {object} options.opsContext createMemoryOpsContext() instance (engine/memory-ops/context.js).
 * @param {string} options.baseDbPath
 * @param {Map<string, object>} options.confirmationStore The engine's existing pending-confirmation Map.
 * @param {() => object} options.getObsidianBridgeConfig Returns the engine config's obsidianBridge section.
 * @param {object} options.host
 * @param {object} [options.logger]
 * @param {() => number} [options.clock]
 * @returns {{detect: Function, prepare: Function, confirm: Function}}
 */
export function createObsidianOps({ opsContext, baseDbPath, confirmationStore, getObsidianBridgeConfig, host, logger, clock = Date.now }) {
  const home = homedir();
  // nonce -> { vaultPath, expiresAt }. Separate from confirmationStore: this
  // Map only remembers which vault path a nonce prepared, so confirm() can
  // call confirmVaultConfirmation() with the same vaultPath without asking
  // the caller to repeat it. Swept of expired entries and capped at
  // MAX_PENDING (oldest evicted) on every prepare()/confirm() call.
  const pending = new Map();

  function sweepPending() {
    const now = clock();
    for (const [nonce, record] of pending) {
      if (record.expiresAt <= now) pending.delete(nonce);
    }
    while (pending.size > MAX_PENDING) {
      const oldestNonce = pending.keys().next().value;
      pending.delete(oldestNonce);
    }
  }

  async function detect(p, a, opts = {}) {
    const { agentId, memoryCtx, workspaceDir } = await opsContext.resolve(p, a);

    let candidateInputs = [];
    if (opts.candidates !== undefined) {
      if (!Array.isArray(opts.candidates) || opts.candidates.length > MAX_CANDIDATES) {
        throw memoryOpError("invalid-input", "candidates must be an array of at most 20 strings");
      }
      candidateInputs = opts.candidates.map((raw) => {
        if (typeof raw !== "string") throw memoryOpError("invalid-input", "each candidate must be a string");
        return expandVaultPath(raw, home);
      });
    }

    const ordered = [];
    for (const workspace of discoverObsidianWorkspaces(getObsidianBridgeConfig(), { agentId })) {
      if (workspace?.path) ordered.push({ path: normalize(workspace.path), source: "config" });
    }
    if (workspaceDir) ordered.push({ path: normalize(workspaceDir), source: "workspace" });
    for (const candidatePath of candidateInputs) ordered.push({ path: candidatePath, source: "candidate" });

    const vaults = dedupeByNormalizedPath(ordered).map(({ path, source }) => {
      const directoryExists = isExistingDirectory(path);
      const isVault = directoryExists && isVaultDirectory(path);
      const confirmed = directoryExists
        && isOwnedVaultConfirmed({ baseDbPath, memoryCtx: boundMemoryCtx(memoryCtx), vaultPath: path });
      return { path, isVault, confirmed, source };
    });

    return { agentId, vaults };
  }

  async function prepare(vaultPath, p, a) {
    const { memoryCtx } = await opsContext.resolve(p, a, { destructive: true });
    const expanded = expandVaultPath(vaultPath, home);
    if (!isExistingDirectory(expanded)) {
      throw memoryOpError("invalid-input", "vault path is not a directory");
    }
    if (memoryCtx.trust !== "proved" || !memoryCtx.userPrincipal) {
      throw memoryOpError("denied", "vault confirmation requires a proved principal with a user");
    }

    sweepPending();
    const result = prepareVaultConfirmation({
      baseDbPath,
      memoryCtx: boundMemoryCtx(memoryCtx),
      vaultPath: expanded,
      confirmationStore,
      expiryMinutes: EXPIRY_MINUTES,
    });
    if (!result.ok) {
      // Only reason prepareVaultConfirmation() returns ok:false today is
      // identity_binding_required (missing agentId/workspaceIdentity/conversation
      // binding even after the userId mapping above) -- always a denial, never a
      // storage fault.
      throw memoryOpError("denied", "vault confirmation requires a proved principal with a full identity binding");
    }

    pending.set(result.nonce, { vaultPath: expanded, expiresAt: result.expiresAt });
    sweepPending();

    return { nonce: result.nonce, expiresAt: result.expiresAt, vaultPath: expanded, vaultDigest: result.vaultDigest };
  }

  async function confirm(nonce, p, a) {
    sweepPending();
    const { memoryCtx } = await opsContext.resolve(p, a, { destructive: true });

    let validNonce;
    try {
      validNonce = safeUuid(nonce);
    } catch {
      throw memoryOpError("invalid-input", "nonce must be a valid UUID");
    }

    const record = pending.get(validNonce);
    if (!record || record.expiresAt <= clock()) {
      pending.delete(validNonce);
      throw memoryOpError("not-found", "confirmation not found or expired");
    }

    const callbackData = vaultConfirmationCallbackForNonce(confirmationStore, validNonce);
    if (!callbackData) {
      pending.delete(validNonce);
      throw memoryOpError("not-found", "confirmation not found or expired");
    }

    const result = confirmVaultConfirmation({
      callbackData,
      confirmationStore,
      baseDbPath,
      memoryCtx: boundMemoryCtx(memoryCtx),
      vaultPath: record.vaultPath,
    });

    if (!result.ok) {
      if (CONFIRM_NOT_FOUND_REASONS.has(result.reason)) {
        pending.delete(validNonce);
        throw memoryOpError("not-found", "confirmation not found or expired");
      }
      if (CONFIRM_DENIED_REASONS.has(result.reason)) {
        throw memoryOpError("denied", "vault confirmation identity or vault mismatch");
      }
      logger?.warn?.(`admin.obsidian.confirm: vault confirmation failed (${result.reason})`);
      throw memoryOpError("storage", "vault confirmation failed");
    }

    pending.delete(validNonce);
    return {
      confirmed: true,
      vaultPath: record.vaultPath,
      vaultDigest: result.receipt?.vaultDigest,
      alreadyConfirmed: result.alreadyConfirmed === true,
    };
  }

  return { detect, prepare, confirm };
}
