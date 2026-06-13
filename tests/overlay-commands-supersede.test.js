import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOverlayAuditCommand } from "../lib/overlay-commands.js";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";

describe("supersede-overlay command", () => {
  it("supersedes an overlay and returns ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-cmd-super-"));
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Old", triggerContext: "a" });
      const content = readFileSync(store.filePath, "utf8");
      const oldId = JSON.parse(content.split("\n").filter(Boolean)[0]).id;

      const result = await runOverlayAuditCommand({
        subCommand: "supersede-overlay",
        id: oldId,
        extraArgs: ["New", "interpretation"],
        workspaceDir: dir,
      });
      assert.strictEqual(result.ok, true);
      assert.ok(result.text.includes("superseded"));

      const active = await store.loadForTargets(["m1"]);
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].shiftDescription, "New interpretation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns ok:false for missing arguments", async () => {
    const result = await runOverlayAuditCommand({
      subCommand: "supersede-overlay",
      id: "00000000-0000-0000-0000-000000000000",
      workspaceDir: "/tmp",
    });
    assert.strictEqual(result.ok, false);
  });

  it("returns ok:false for invalid id", async () => {
    const result = await runOverlayAuditCommand({
      subCommand: "supersede-overlay",
      id: "not-a-uuid",
      extraArgs: ["New"],
      workspaceDir: "/tmp",
    });
    assert.strictEqual(result.ok, false);
  });
});
