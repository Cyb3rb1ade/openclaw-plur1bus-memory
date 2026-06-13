import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDoctor } from "../lib/memory-doctor.js";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

describe("MemoryDoctor", () => {
  function tmpDir() {
    return mkdtempSync(join(tmpdir(), "plur1bus-doctor-"));
  }

  it("summarize reports zero state for an empty workspace", async () => {
    const dir = tmpDir();
    try {
      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const summary = await doctor.summarize();
      assert.strictEqual(summary.totalOverlays, 0);
      assert.strictEqual(summary.active, 0);
      assert.strictEqual(summary.provisional, 0);
      assert.strictEqual(summary.superseded, 0);
      assert.strictEqual(summary.disabled, 0);
      assert.strictEqual(summary.contradictions, 0);
      assert.strictEqual(summary.memoriesWithContradictions, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diagnoseMemory returns active overlays and contradictions", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres.", triggerContext: "a", confidence: 0.8 });
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "MySQL.", triggerContext: "b", confidence: 0.7 });
      const overlays = await store.loadAllOverlays(["m1"], { includeSuperseded: false, includeProvisional: false });
      const [ovA, ovB] = overlays;

      const detector = new ContradictionDetector({ workspaceDir: dir });
      await detector.persistContradiction({ targetMemoryId: "m1", overlayA: ovA.id, overlayB: ovB.id, descriptionA: ovA.shiftDescription, descriptionB: ovB.shiftDescription });

      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const report = await doctor.diagnoseMemory("m1");
      assert.strictEqual(report.memoryId, "m1");
      assert.strictEqual(report.active.length, 2);
      assert.strictEqual(report.contradictions.length, 1);
      assert.strictEqual(report.suggestions.length, 1);
      assert.strictEqual(report.suggestions[0].action, "supersede");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diagnoseOverlay returns lineage and contradictions", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "First.", triggerContext: "a" });
      const all = await store.loadAllOverlays(["m1"]);
      const firstId = all[0].id;

      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const report = await doctor.diagnoseOverlay(firstId);
      assert.strictEqual(report.overlayId, firstId);
      assert.strictEqual(report.lineage.current.id, firstId);
      assert.deepStrictEqual(report.lineage.predecessors, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diagnoseOverlay returns not-found for unknown ids", async () => {
    const dir = tmpDir();
    try {
      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const report = await doctor.diagnoseOverlay("00000000-0000-0000-0000-000000000000");
      assert.strictEqual(report.found, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
