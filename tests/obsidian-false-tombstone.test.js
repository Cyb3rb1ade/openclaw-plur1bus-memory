/**
 * tests/obsidian-false-tombstone.test.js
 *
 * Regression: scanWorkspace's mtime+size fast-path drops unchanged files from
 * scan.files, and syncWorkspace built `seen` only from scan.files. The
 * tombstone loop then treated every previously-synced-but-unchanged file as a
 * deletion, flooding approval_required_tombstone actions on every apply-mode
 * tick. A stable file must NOT be reported as deleted.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncWorkspace, confirmVaultPath } from "../lib/obsidian-bridge.js";

describe("obsidian false-tombstone guard", () => {
  function makeWorkspace(dir) {
    return {
      workspaceId: "tomb-ws",
      agentId: "tomb-agent",
      path: dir,
      includeGlobs: ["**/*.md"],
      ignoreGlobs: [".git/**", ".obsidian/**"],
    };
  }

  it("does not tombstone an unchanged file on the second apply-mode sync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-tomb-"));
    const ws = makeWorkspace(dir);
    confirmVaultPath(ws);

    const rel = "plur1bus/memories/keep.md";
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "# stable note\n\nunchanged content\n", "utf8");

    const opts = {
      dryRun: false,
      tombstoneOnDelete: true,
      backupBeforeApply: false,
      auditLog: false,
      requireVaultPathConfirmation: false,
    };

    // First sync persists state.files (writeBridgeState only runs when !dryRun).
    await syncWorkspace(ws, opts);
    // Second sync: file is unchanged → fast-path skip → must NOT be tombstoned.
    const second = await syncWorkspace(ws, opts);

    const tombActions = second.actions.filter(
      (a) => a.path === rel && /tombstone/.test(a.action),
    );
    assert.deepStrictEqual(
      tombActions,
      [],
      `unchanged file must not be tombstoned; got: ${JSON.stringify(tombActions)}`,
    );
  });
});
