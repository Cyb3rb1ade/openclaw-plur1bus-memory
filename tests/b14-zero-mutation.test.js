import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createObsidianBridgeService,
  initWorkspace,
  syncWorkspace,
} from "../lib/obsidian-bridge.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";

function snapshot(root) {
  const output = {};
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      const stat = statSync(path);
      output[rel] = {
        type: entry.isDirectory() ? "dir" : "file",
        mtimeMs: stat.mtimeMs,
        content: entry.isFile() ? readFileSync(path, "utf8") : null,
      };
      if (entry.isDirectory()) walk(path, rel);
    }
  };
  walk(root);
  return output;
}

function workspace(path) {
  return {
    workspaceId: "workspace-a",
    agentId: "agent-a",
    path,
    includeGlobs: ["**/*.md"],
    ignoreGlobs: [".git/**"],
  };
}

function vaultPolicy(baseDbPath, mode = "apply", allowWrite = true, vaultConfirmed = true) {
  return parseObsidianCommandPlan(["dashboards", "build"], {
    memoryCtx: {
      agentId: "agent-a",
      workspaceIdentity: "workspace:v1:workspace-a",
    },
    baseDbPath,
    mode,
    allowWrite,
    vaultConfirmed,
    actionConfirmed: true,
  }).mutationPolicy;
}

describe("B14 zero-mutation service and sink paths", () => {
  it("preserves the complete tree and mtimes for missing, augment, allowWrite false, and unconfirmed policies", async () => {
    for (const policy of [
      null,
      vaultPolicy(mkdtempSync(join(tmpdir(), "b14-db-augment-")), "augment", true, true),
      vaultPolicy(mkdtempSync(join(tmpdir(), "b14-db-nowrite-")), "apply", false, true),
      vaultPolicy(mkdtempSync(join(tmpdir(), "b14-db-unconfirmed-")), "apply", true, false),
    ]) {
      const vault = mkdtempSync(join(tmpdir(), "b14-zero-vault-"));
      mkdirSync(join(vault, "notes"));
      writeFileSync(join(vault, "notes", "source.md"), "# source\n");
      const before = snapshot(vault);
      const ws = workspace(vault);

      initWorkspace(ws, { dryRun: false, mutationPolicy: policy });
      await syncWorkspace(ws, {
        dryRun: false,
        requireVaultPathConfirmation: false,
        mutationPolicy: policy,
        memoryStore: async () => {
          throw new Error("must not be called");
        },
      });
      const service = createObsidianBridgeService({
        enabled: true,
        mode: "apply",
        allowWrite: true,
        vaultPath: vault,
        workspaces: [{ workspaceId: ws.workspaceId, agentId: ws.agentId, path: vault }],
      }, { mutationPolicy: policy });
      await service.syncOnce();
      await service.rebuildDashboards();
      await service.start();

      assert.deepEqual(snapshot(vault), before);
    }
  });

  it("retains confirmed positive vault writes", () => {
    const vault = mkdtempSync(join(tmpdir(), "b14-positive-vault-"));
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-positive-db-"));
    const result = initWorkspace(workspace(vault), {
      dryRun: false,
      mutationPolicy: vaultPolicy(baseDbPath),
    });
    assert.equal(result.actions.some((action) => action.action === "create_dir"), true);
    assert.equal(existsSync(join(vault, "memory", "cards")), true);
  });
});
