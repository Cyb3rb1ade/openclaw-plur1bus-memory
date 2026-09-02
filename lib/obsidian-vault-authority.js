/** Protected, owner-partitioned vault confirmation receipts. */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { workspacePoolKey } from "./memory-request-context.js";
import { resolveInside, safeAgentId } from "./sql-safety.js";

/**
 * Compute the canonical digest used to bind protected vault confirmations.
 *
 * @param {string} vaultPath Existing vault directory.
 * @returns {string} SHA-256 digest of the canonical vault path.
 */
export function ownedVaultDigest(vaultPath) {
  return createHash("sha256").update(realpathSync(vaultPath), "utf8").digest("hex");
}

function receiptPath({ baseDbPath, memoryCtx, vaultPath }) {
  const agentId = safeAgentId(memoryCtx?.agentId);
  const workspaceIdentity = String(memoryCtx?.workspaceIdentity || memoryCtx?.workspaceId || "");
  if (!workspaceIdentity) throw new Error("Vault confirmation requires workspace identity");
  const base = resolveInside(baseDbPath);
  return resolveInside(
    base,
    ".plur1bus-authority",
    "obsidian-vaults",
    agentId,
    workspacePoolKey(workspaceIdentity),
    `${ownedVaultDigest(vaultPath)}.json`,
  );
}

/**
 * Persist a protected vault confirmation only after an external one-time
 * confirmation primitive has validated the exact identity/scope/digest.
 */
export function recordOwnedVaultConfirmation({
  baseDbPath,
  memoryCtx,
  vaultPath,
  confirmationValidated,
  confirmationNonce,
} = {}) {
  if (confirmationValidated !== true
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(confirmationNonce || ""))) {
    throw new Error("Bound vault confirmation required");
  }
  const path = receiptPath({ baseDbPath, memoryCtx, vaultPath });
  mkdirSync(dirname(path), { recursive: true });
  const receipt = {
    version: 1,
    agentId: memoryCtx.agentId,
    workspaceIdentity: memoryCtx.workspaceIdentity || memoryCtx.workspaceId,
    vaultDigest: ownedVaultDigest(vaultPath),
    confirmationNonce,
    confirmedAt: new Date().toISOString(),
  };
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
  return { confirmed: true, path, vaultDigest: receipt.vaultDigest };
}

/** Return true only for an exact owner/workspace/vault protected receipt. */
/**
 * Explain a vault confirmation check without revealing its scope.
 *
 * A confirmation that is not honoured used to surface as a bare false. Three
 * independent bindings decide it -- agent, workspace identity, vault digest --
 * plus whether the receipt exists and parses at all, so an operator (or a test
 * harness) could not tell a missing receipt from one bound to another vault.
 *
 * Every value returned is a boolean or an irreversible fingerprint: no path,
 * identity or digest leaves this function.
 *
 * @returns {{
 *   confirmed: boolean,
 *   scopeFingerprint: string,
 *   scopeResolvable: boolean,
 *   receiptExists: boolean,
 *   receiptParsed: boolean,
 *   versionMatch: boolean,
 *   agentMatch: boolean,
 *   workspaceMatch: boolean,
 *   vaultDigestMatch: boolean,
 * }}
 */
export function describeOwnedVaultConfirmation({ baseDbPath, memoryCtx, vaultPath } = {}) {
  const result = {
    confirmed: false,
    scopeFingerprint: "",
    scopeResolvable: false,
    receiptExists: false,
    receiptParsed: false,
    versionMatch: false,
    agentMatch: false,
    workspaceMatch: false,
    vaultDigestMatch: false,
  };
  let path;
  let expectedDigest;
  try {
    path = receiptPath({ baseDbPath, memoryCtx, vaultPath });
    expectedDigest = ownedVaultDigest(vaultPath);
  } catch {
    return Object.freeze(result);
  }
  result.scopeResolvable = true;
  result.scopeFingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    baseDbRoot: String(resolveInside(baseDbPath)),
    agentId: safeAgentId(memoryCtx?.agentId),
    workspaceIdentity: String(memoryCtx?.workspaceIdentity || memoryCtx?.workspaceId || ""),
    vaultDigest: expectedDigest,
  }), "utf8").digest("hex")}`;
  result.receiptExists = existsSync(path);
  if (!result.receiptExists) return Object.freeze(result);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
    result.receiptParsed = true;
  } catch {
    return Object.freeze(result);
  }
  result.versionMatch = receipt?.version === 1;
  result.agentMatch = receipt?.agentId === memoryCtx.agentId;
  result.workspaceMatch = receipt?.workspaceIdentity === (memoryCtx.workspaceIdentity || memoryCtx.workspaceId);
  result.vaultDigestMatch = receipt?.vaultDigest === expectedDigest;
  result.confirmed = result.versionMatch && result.agentMatch && result.workspaceMatch && result.vaultDigestMatch;
  return Object.freeze(result);
}

export function isOwnedVaultConfirmed(scope = {}) {
  return describeOwnedVaultConfirmation(scope).confirmed;
}
