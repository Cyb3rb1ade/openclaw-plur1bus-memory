import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveCommandVaultPath } from "../lib/obsidian-control-room.js";

/**
 * The registered command path decided vaultConfirmed *before* calling the
 * handler, from `cfg.vaultPath || cfg.vault || commandCtx.workspaceDir`. A
 * Telegram command carries no workspaceDir, so with the usual configuration
 * (no explicit vaultPath, one workspace per agent) that was "" -- and an empty
 * path means the receipt is never even looked up. The handler itself resolves
 * the vault through the configured workspaces; the caller must use the same
 * selector, or confirm writes a receipt that apply can never find.
 */
describe("command vault path resolution", () => {
  const bridge = {
    enabled: true,
    mode: "apply",
    workspaces: [{ workspace_id: "lab-alpha", agent_id: "lab-alpha", path: "/workspace/lab-alpha" }],
  };
  const telegramCtx = { agentId: "lab-alpha", channel: "telegram", accountId: "default" };

  it("resolves the agent's configured workspace when the command carries no workspaceDir", () => {
    assert.equal(resolveCommandVaultPath(bridge, { commandCtx: telegramCtx }), "/workspace/lab-alpha");
  });

  it("prefers an explicit vaultPath over the workspace list", () => {
    assert.equal(
      resolveCommandVaultPath({ ...bridge, vaultPath: "/vaults/explicit" }, { commandCtx: telegramCtx }),
      "/vaults/explicit",
    );
  });

  it("falls back to the only configured workspace for an unlabelled command", () => {
    assert.equal(resolveCommandVaultPath(bridge, { commandCtx: { channel: "telegram" } }), "/workspace/lab-alpha");
  });

  it("returns an empty string, not a guess, when nothing resolves", () => {
    assert.equal(resolveCommandVaultPath({ enabled: true, workspaces: [] }, { commandCtx: { channel: "telegram" } }), "");
    assert.equal(resolveCommandVaultPath({
      enabled: true,
      workspaces: [
        { workspace_id: "a", agent_id: "a", path: "/w/a" },
        { workspace_id: "b", agent_id: "b", path: "/w/b" },
      ],
    }, { commandCtx: { channel: "telegram" } }), "");
  });
});
