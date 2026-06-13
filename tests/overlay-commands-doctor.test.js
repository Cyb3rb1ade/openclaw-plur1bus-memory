import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOverlayAuditCommand } from "../lib/overlay-commands.js";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";

describe("overlay-commands doctor", () => {
  function tmpDir() {
    return mkdtempSync(join(tmpdir(), "plur1bus-doctor-cmd-"));
  }

  it("doctor returns a summary when no id is given", async () => {
    const dir = tmpDir();
    try {
      const result = await runOverlayAuditCommand({
        subCommand: "doctor",
        workspaceDir: dir,
        doctorCfg: { enabled: true, maxAgeDays: 90 },
      });
      const parsed = JSON.parse(result.text);
      assert.strictEqual(parsed.type, "summary");
      assert.strictEqual(parsed.totalOverlays, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor memory <id> works with a non-UUID memory id", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "custom-mem-123", shiftType: "meaning", shiftDescription: "Custom memory.", triggerContext: "a" });
      const result = await runOverlayAuditCommand({
        subCommand: "doctor",
        id: "memory",
        extraArgs: ["custom-mem-123"],
        workspaceDir: dir,
        doctorCfg: { enabled: true, maxAgeDays: 90 },
      });
      const parsed = JSON.parse(result.text);
      assert.strictEqual(parsed.type, "memory");
      assert.strictEqual(parsed.memoryId, "custom-mem-123");
      assert.strictEqual(parsed.active.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor memory <id> diagnoses a memory", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres.", triggerContext: "a" });
      const result = await runOverlayAuditCommand({
        subCommand: "doctor",
        id: "memory",
        extraArgs: ["m1"],
        workspaceDir: dir,
        doctorCfg: { enabled: true, maxAgeDays: 90 },
      });
      const parsed = JSON.parse(result.text);
      assert.strictEqual(parsed.type, "memory");
      assert.strictEqual(parsed.memoryId, "m1");
      assert.strictEqual(parsed.active.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor overlay <id> diagnoses an overlay", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres.", triggerContext: "a" });
      const all = await store.loadAllOverlays(["m1"]);
      const id = all[0].id;
      const result = await runOverlayAuditCommand({
        subCommand: "doctor",
        id: "overlay",
        extraArgs: [id],
        workspaceDir: dir,
        doctorCfg: { enabled: true, maxAgeDays: 90 },
      });
      const parsed = JSON.parse(result.text);
      assert.strictEqual(parsed.type, "overlay");
      assert.strictEqual(parsed.overlayId, id);
      assert.strictEqual(parsed.found, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor is gated by continuityEngine.doctor.enabled", async () => {
    const result = await runOverlayAuditCommand({
      subCommand: "doctor",
      workspaceDir: "/tmp/plur1bus-test-unused",
      doctorCfg: { enabled: false },
    });
    assert.ok(result.text.includes("disabled"));
  });

  it("doctor memory without id returns usage", async () => {
    const result = await runOverlayAuditCommand({
      subCommand: "doctor",
      id: "memory",
      workspaceDir: "/tmp/plur1bus-test-unused",
      doctorCfg: { enabled: true },
    });
    assert.strictEqual(result.text, "Usage: /plur1bus memory doctor memory <memoryId>");
  });

  it("doctor overlay without id returns usage", async () => {
    const result = await runOverlayAuditCommand({
      subCommand: "doctor",
      id: "overlay",
      workspaceDir: "/tmp/plur1bus-test-unused",
      doctorCfg: { enabled: true },
    });
    assert.strictEqual(result.text, "Usage: /plur1bus memory doctor overlay <overlayId>");
  });

  it("doctor overlay with malformed id returns invalid message", async () => {
    const result = await runOverlayAuditCommand({
      subCommand: "doctor",
      id: "overlay",
      extraArgs: ["not-a-uuid"],
      workspaceDir: "/tmp/plur1bus-test-unused",
      doctorCfg: { enabled: true },
    });
    assert.strictEqual(result.text, "Invalid overlay id: not-a-uuid");
  });
});
