/** Protected, owner-partitioned vault confirmation receipts. */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { workspacePoolKey } from "./memory-request-context.js";
import { resolveInside, safeAgentId } from "./sql-safety.js";

function vaultDigest(vaultPath) {
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
    `${vaultDigest(vaultPath)}.json`,
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
    vaultDigest: vaultDigest(vaultPath),
    confirmationNonce,
    confirmedAt: new Date().toISOString(),
  };
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
  return { confirmed: true, path, vaultDigest: receipt.vaultDigest };
}

/** Return true only for an exact owner/workspace/vault protected receipt. */
export function isOwnedVaultConfirmed({ baseDbPath, memoryCtx, vaultPath } = {}) {
  let path;
  try {
    path = receiptPath({ baseDbPath, memoryCtx, vaultPath });
  } catch {
    return false;
  }
  if (!existsSync(path)) return false;
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    return receipt?.version === 1
      && receipt.agentId === memoryCtx.agentId
      && receipt.workspaceIdentity === (memoryCtx.workspaceIdentity || memoryCtx.workspaceId)
      && receipt.vaultDigest === vaultDigest(vaultPath);
  } catch {
    return false;
  }
}
