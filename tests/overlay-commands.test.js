import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOverlayAuditCommand } from "../lib/overlay-commands.js";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "plur1bus-cmd-"));
}

describe("overlay audit commands", () => {
  it("overlays lists all overlays", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres", triggerContext: "ctx" });
      const result = await runOverlayAuditCommand({
        subCommand: "overlays",
        workspaceDir: dir,
        callLlm: async () => "no",
        mergingLlmCfg: {},
      });
      const parsed = JSON.parse(result.text);
      assert.strictEqual(parsed.count, 1);
      assert.strictEqual(parsed.overlays[0].targetMemoryId, "m1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overlay returns lineage for an id", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "First", triggerContext: "a" });
      const content1 = readFileSync(store.filePath, "utf8");
      const firstId = JSON.parse(content1.split("\n").filter(Boolean)[0]).id;
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Second", triggerContext: "b", supersedes: firstId });
      const content2 = readFileSync(store.filePath, "utf8");
      const secondId = JSON.parse(content2.split("\n").filter(Boolean)[1]).id;

      const result = await runOverlayAuditCommand({ subCommand: "overlay", id: secondId, workspaceDir: dir });
      const parsed = JSON.parse(result.text);
      assert.strictEqual(parsed.current.id, secondId);
      assert.strictEqual(parsed.predecessors.length, 1);
      assert.strictEqual(parsed.predecessors[0].id, firstId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disable-overlay hides the overlay from recall", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Live", triggerContext: "a" });
      const content = readFileSync(store.filePath, "utf8");
      const id = JSON.parse(content.split("\n").filter(Boolean)[0]).id;

      const result = await runOverlayAuditCommand({ subCommand: "disable-overlay", id, workspaceDir: dir });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.text, `Overlay ${id} disabled.`);

      const rendered = await store.loadForTargets(["m1"]);
      assert.strictEqual(rendered.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disable-overlay with non-existent id returns ok false", async () => {
    const dir = tmpDir();
    try {
      const id = "00000000-0000-0000-0000-000000000000";
      const result = await runOverlayAuditCommand({ subCommand: "disable-overlay", id, workspaceDir: dir });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.text, `Could not disable ${id}.`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disable-overlay returns invalid id error for malformed ids", async () => {
    const dir = tmpDir();
    try {
      const result = await runOverlayAuditCommand({ subCommand: "disable-overlay", id: "not-a-uuid", workspaceDir: dir });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.text, "Invalid overlay id: not-a-uuid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("contradictions scans active meaning overlays", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres", triggerContext: "a" });
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "MySQL", triggerContext: "b" });

      const result = await runOverlayAuditCommand({
        subCommand: "contradictions",
        workspaceDir: dir,
        callLlm: async () => "yes",
        mergingLlmCfg: {},
      });
      const parsed = JSON.parse(result.text);
      assert.strictEqual(parsed.scanned, 2);
      assert.strictEqual(parsed.contradictions.length, 1);
      assert.strictEqual(parsed.contradictions[0].targetMemoryId, "m1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("contradictions returns not configured when LLM merging is disabled", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres", triggerContext: "a" });
      const result = await runOverlayAuditCommand({
        subCommand: "contradictions",
        workspaceDir: dir,
        callLlm: null,
        mergingLlmCfg: null,
      });
      assert.strictEqual(result.text, "LLM merging is not configured; cannot scan for contradictions.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("contradictions returns invalid id error for malformed ids", async () => {
    const dir = tmpDir();
    try {
      const result = await runOverlayAuditCommand({ subCommand: "contradictions", id: "not-a-uuid", workspaceDir: dir });
      assert.strictEqual(result.text, "Invalid overlay id: not-a-uuid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no workspace message when workspaceDir is missing", async () => {
    const result = await runOverlayAuditCommand({ subCommand: "overlays" });
    assert.strictEqual(result.text, "No workspace directory available.");
  });

  it("disable-overlay returns ok false when workspaceDir is missing", async () => {
    const result = await runOverlayAuditCommand({ subCommand: "disable-overlay" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.text, "No workspace directory available.");
  });

  it("returns usage text when id is missing for overlay", async () => {
    const result = await runOverlayAuditCommand({ subCommand: "overlay", workspaceDir: "/tmp/plur1bus-test-unused" });
    assert.strictEqual(result.text, "Usage: /plur1bus memory overlay <id>");
  });

  it("returns usage text when id is missing for disable-overlay", async () => {
    const result = await runOverlayAuditCommand({ subCommand: "disable-overlay", workspaceDir: "/tmp/plur1bus-test-unused" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.text, "Usage: /plur1bus memory disable-overlay <id>");
  });

  it("returns invalid id error for malformed ids", async () => {
    const dir = tmpDir();
    try {
      const result = await runOverlayAuditCommand({ subCommand: "overlay", id: "not-a-uuid", workspaceDir: dir });
      assert.strictEqual(result.text, "Invalid overlay id: not-a-uuid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns unknown subcommand text for unsupported subcommand", async () => {
    const dir = tmpDir();
    try {
      const result = await runOverlayAuditCommand({ subCommand: "nope", workspaceDir: dir });
      assert.strictEqual(result.text, "Unknown overlay subcommand: nope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
