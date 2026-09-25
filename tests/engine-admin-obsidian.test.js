/**
 * tests/engine-admin-obsidian.test.js — E2 Task 7: AdminOps.obsidian
 * detect/prepare/confirm with explicit paths, no host runtime.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { expandVaultPath } from "../engine/admin/obsidian.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function freshBaseDbPath(prefix) {
  return join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
}

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
});

// prepare/confirm are destructive (a.origin === "user", a.background === false)
// and need a REAL, writable workspaceDir (opsContext.resolve refuses a
// destructive op without one) that also contains a `.obsidian/app.json`
// marker, so detect() reports it as a vault. Same pattern as
// tests/e1-memory-ops-write.test.js's stubHostForDestructiveOps.
function stubHostWithVaultWorkspace(stateDir, vaultDir) {
  return createStubHost({
    stateDir,
    workspaceDir: async () => vaultDir,
  });
}

function principalFor(agentId) {
  // No explicit `workspace` claim: the canonical workspace identity comes
  // from the host's real workspaceDir (same reasoning as e1's
  // principalForDestructive).
  return { agentId, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, user: `user:v1:${"a".repeat(64)}`, trust: "proved" };
}

const agent = { origin: "user", background: false };
const cronAgent = { origin: "cron", background: true };

function makeVaultDir(stateDir, name) {
  const dir = join(stateDir, name);
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  writeFileSync(join(dir, ".obsidian", "app.json"), "{}\n", "utf8");
  return dir;
}

describe("engine/admin/obsidian.js — expandVaultPath (unit)", () => {
  it("expands ~, ~/x, relative and absolute paths under a given home dir", () => {
    assert.equal(expandVaultPath("~/v", "/h"), join("/h", "v"));
    assert.equal(expandVaultPath("~", "/h"), join("/h"));
    assert.equal(expandVaultPath("v", "/h"), join("/h", "v"));
    assert.equal(expandVaultPath("/abs/v", "/h"), join("/abs", "v"));
  });

  it("throws invalid-input on empty/non-string input", () => {
    assert.throws(() => expandVaultPath("", "/h"), (err) => err.code === "invalid-input");
    assert.throws(() => expandVaultPath(undefined, "/h"), (err) => err.code === "invalid-input");
  });
});

describe("Engine.admin.obsidian", () => {
  it("detect() reports the workspace vault and expanded candidates", async () => {
    const stateDir = makeTempDir("e2t7-state-");
    const vaultDir = makeVaultDir(stateDir, "vault-a");
    const host = stubHostWithVaultWorkspace(stateDir, vaultDir);
    const engine = createEngine(host, config(freshBaseDbPath("e2t7-")));
    const p = principalFor("agent-a");

    const result = await engine.admin.obsidian.detect(p, agent);
    assert.equal(result.agentId, "agent-a");
    assert.ok(result.vaults.some((v) => v.path === vaultDir && v.isVault === true && v.confirmed === false && v.source === "workspace"));

    const withCandidates = await engine.admin.obsidian.detect(p, agent, { candidates: ["~/does-not-exist-e2"] });
    const expectedMissing = join(homedir(), "does-not-exist-e2");
    assert.ok(withCandidates.vaults.some((v) => v.path === expectedMissing && v.isVault === false && v.confirmed === false && v.source === "candidate"));

    await assert.rejects(
      engine.admin.obsidian.detect(p, agent, { candidates: "x" }),
      (err) => err.code === "invalid-input",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("prepare() issues a nonce bound to the vault, rejecting bad inputs", async () => {
    const stateDir = makeTempDir("e2t7-state-");
    const vaultDir = makeVaultDir(stateDir, "vault-b");
    const host = stubHostWithVaultWorkspace(stateDir, vaultDir);
    const engine = createEngine(host, config(freshBaseDbPath("e2t7-")));
    const p = principalFor("agent-b");

    const before = Date.now();
    const prepared = await engine.admin.obsidian.prepare(vaultDir, p, agent);
    assert.match(prepared.nonce, UUID_RE);
    assert.ok(prepared.expiresAt > before);
    assert.equal(prepared.vaultPath, vaultDir);
    assert.match(prepared.vaultDigest, DIGEST_RE);

    // Not a directory.
    const notADir = join(stateDir, "not-a-dir.txt");
    writeFileSync(notADir, "x", "utf8");
    await assert.rejects(engine.admin.obsidian.prepare(notADir, p, agent), (err) => err.code === "invalid-input");

    // Not a proved principal.
    await assert.rejects(
      engine.admin.obsidian.prepare(vaultDir, { ...p, trust: "inferred" }, agent),
      (err) => err.code === "denied",
    );

    // Not a user-originated call.
    await assert.rejects(engine.admin.obsidian.prepare(vaultDir, p, cronAgent), (err) => err.code === "denied");

    await engine.close({ budgetMs: 5_000 });
  });

  it("confirm() consumes the nonce exactly once, bound to the preparing identity and vault", async () => {
    const stateDir = makeTempDir("e2t7-state-");
    const vaultDir = makeVaultDir(stateDir, "vault-c");
    const baseDbPath = freshBaseDbPath("e2t7-");
    const host = stubHostWithVaultWorkspace(stateDir, vaultDir);
    const engine = createEngine(host, config(baseDbPath));
    const p = principalFor("agent-c");
    const otherUser = { ...p, user: `user:v1:${"b".repeat(64)}` };

    // Unknown nonce.
    await assert.rejects(engine.admin.obsidian.confirm(randomUUID(), p, agent), (err) => err.code === "not-found");

    const prepared = await engine.admin.obsidian.prepare(vaultDir, p, agent);

    // Wrong identity confirming a real nonce.
    await assert.rejects(engine.admin.obsidian.confirm(prepared.nonce, otherUser, agent), (err) => err.code === "denied");

    // Correct identity confirms. Note: confirmVaultConfirmation()
    // (lib/obsidian-vault-confirmation-flow.js) computes `alreadyConfirmed`
    // via isOwnedVaultConfirmed() AFTER the receipt is written, so it is
    // `true` on every successful confirm (first or repeat) once the receipt
    // exists on disk -- not a signal of "this was a no-op repeat". We forward
    // that field verbatim rather than reinterpreting it.
    const confirmed = await engine.admin.obsidian.confirm(prepared.nonce, p, agent);
    assert.deepEqual(confirmed, {
      confirmed: true,
      vaultPath: vaultDir,
      vaultDigest: prepared.vaultDigest,
      alreadyConfirmed: true,
    });

    // A receipt was written under baseDbPath/.plur1bus-authority/obsidian-vaults/<agent>/.
    const receiptDir = join(baseDbPath, ".plur1bus-authority", "obsidian-vaults", "agent-c");
    assert.ok(existsSync(receiptDir));
    assert.ok(readdirSync(receiptDir, { recursive: true }).some((name) => name.endsWith(".json")));

    // detect() now reports it confirmed.
    const afterConfirm = await engine.admin.obsidian.detect(p, agent);
    assert.ok(afterConfirm.vaults.some((v) => v.path === vaultDir && v.confirmed === true));

    // The nonce was consumed: confirming again fails.
    await assert.rejects(engine.admin.obsidian.confirm(prepared.nonce, p, agent), (err) => err.code === "not-found");

    // A second prepare + confirm reports alreadyConfirmed.
    const preparedAgain = await engine.admin.obsidian.prepare(vaultDir, p, agent);
    const confirmedAgain = await engine.admin.obsidian.confirm(preparedAgain.nonce, p, agent);
    assert.equal(confirmedAgain.alreadyConfirmed, true);

    await engine.close({ budgetMs: 5_000 });
  });
});
