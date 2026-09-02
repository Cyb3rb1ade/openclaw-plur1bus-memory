import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  describeOwnedVaultConfirmation,
  isOwnedVaultConfirmed,
  recordOwnedVaultConfirmation,
} from "../lib/obsidian-vault-authority.js";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-vault-diag-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ctx = { agentId: "lab-alpha", workspaceIdentity: "workspace:v1:lab-alpha" };

describe("vault confirmation diagnosis", () => {
  it("names a missing receipt without inventing a match", (t) => {
    const base = scratch(t);
    const vault = join(base, "vault"); mkdirSync(vault);
    const d = describeOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault });
    assert.equal(d.confirmed, false);
    assert.equal(d.scopeResolvable, true);
    assert.equal(d.receiptExists, false);
    assert.match(d.scopeFingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(isOwnedVaultConfirmed({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault }), false);
  });

  it("confirms a receipt written for exactly this scope", (t) => {
    const base = scratch(t);
    const vault = join(base, "vault"); mkdirSync(vault);
    recordOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault, confirmationValidated: true, confirmationNonce: randomUUID() });
    const d = describeOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault });
    assert.equal(d.confirmed, true);
    assert.deepEqual(
      [d.receiptExists, d.receiptParsed, d.versionMatch, d.agentMatch, d.workspaceMatch, d.vaultDigestMatch],
      [true, true, true, true, true, true],
    );
  });

  it("names the one binding that differs", (t) => {
    const base = scratch(t);
    const vault = join(base, "vault"); mkdirSync(vault);
    const other = join(base, "other"); mkdirSync(other);
    recordOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault, confirmationValidated: true, confirmationNonce: randomUUID() });

    // Another vault: the receipt lives under a different digest, so it is
    // simply not found for this scope.
    const otherVault = describeOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: other });
    assert.equal(otherVault.receiptExists, false);

    // Same vault, another workspace identity: stored under another pool key.
    const otherWorkspace = describeOwnedVaultConfirmation({
      baseDbPath: base,
      memoryCtx: { ...ctx, workspaceIdentity: "workspace:v1:lab-beta" },
      vaultPath: vault,
    });
    assert.equal(otherWorkspace.receiptExists, false);
    assert.notEqual(otherWorkspace.scopeFingerprint, otherVault.scopeFingerprint);
  });

  it("distinguishes an unreadable receipt from an absent one", async (t) => {
    const base = scratch(t);
    const vault = join(base, "vault"); mkdirSync(vault);
    recordOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault, confirmationValidated: true, confirmationNonce: randomUUID() });
    const good = describeOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault });
    assert.equal(good.confirmed, true);
    // Corrupt the receipt in place: same path, no longer JSON.
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir) => readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const receipt = walk(join(base, ".plur1bus-authority")).find((p) => p.endsWith(".json"));
    writeFileSync(receipt, "not json");
    const bad = describeOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault });
    assert.equal(bad.receiptExists, true);
    assert.equal(bad.receiptParsed, false);
    assert.equal(bad.confirmed, false);
  });

  it("exposes only booleans and a fingerprint", (t) => {
    const base = scratch(t);
    const vault = join(base, "vault"); mkdirSync(vault);
    const d = describeOwnedVaultConfirmation({ baseDbPath: base, memoryCtx: ctx, vaultPath: vault });
    const text = JSON.stringify(d);
    assert.doesNotMatch(text, /lab-alpha|workspace:v1|plur1bus-vault-diag/u, "leaks scope");
    for (const [key, value] of Object.entries(d)) {
      if (key === "scopeFingerprint") continue;
      assert.equal(typeof value, "boolean", `${key} must be boolean`);
    }
  });
});
