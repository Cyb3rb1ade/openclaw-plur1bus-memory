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

  it("diagnoseMemory emits a disable suggestion when a provisional overlay contradicts an active overlay", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres.", triggerContext: "a", confidence: 0.8 });
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "MySQL.", triggerContext: "b", confidence: 0.6, status: "provisional" });
      const overlays = await store.loadAllOverlays(["m1"], { includeProvisional: true });
      const active = overlays.find((o) => o.status !== "provisional");
      const provisional = overlays.find((o) => o.status === "provisional");

      const detector = new ContradictionDetector({ workspaceDir: dir });
      await detector.persistContradiction({ targetMemoryId: "m1", overlayA: active.id, overlayB: provisional.id, descriptionA: active.shiftDescription, descriptionB: provisional.shiftDescription });

      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const report = await doctor.diagnoseMemory("m1");
      const disableSuggestion = report.suggestions.find((s) => s.action === "disable");
      assert.ok(disableSuggestion, "expected a disable suggestion");
      assert.strictEqual(disableSuggestion.targetOverlayId, provisional.id);
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

  it("_pickWinner chooses higher-confidence overlay and falls back to recency on tie", async () => {
    const dir = tmpDir();
    try {
      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const older = { id: "older", confidence: 0.5, createdAt: "2026-01-01T00:00:00.000Z" };
      const newer = { id: "newer", confidence: 0.5, createdAt: "2026-01-02T00:00:00.000Z" };
      const stronger = { id: "stronger", confidence: 0.9, createdAt: "2026-01-01T00:00:00.000Z" };

      assert.strictEqual(doctor._pickWinner(older, newer).id, "newer");
      assert.strictEqual(doctor._pickWinner(newer, older).id, "newer");
      assert.strictEqual(doctor._pickWinner(older, stronger).id, "stronger");
      assert.strictEqual(doctor._pickWinner(stronger, older).id, "stronger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies a disabled overlay as disabled", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Original.", triggerContext: "a" });
      const overlays = await store.loadAllOverlays(["m1"]);
      await store.disableOverlay(overlays[0].id);

      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const report = await doctor.diagnoseMemory("m1");
      assert.strictEqual(report.disabled.length, 1);
      assert.strictEqual(report.active.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a note suggestion when a superseded overlay has no active successor", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "First.", triggerContext: "a" });
      const overlays = await store.loadAllOverlays(["m1"]);
      const firstId = overlays[0].id;
      await store.supersedeOverlay(firstId, "Second.");
      const updated = await store.loadAllOverlays(["m1"], { includeSuperseded: true });
      const second = updated.find((o) => o.supersedes === firstId);
      await store.disableOverlay(second.id);

      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const report = await doctor.diagnoseMemory("m1");
      assert.strictEqual(report.active.length, 0);
      assert.strictEqual(report.superseded.length, 1);
      const note = report.suggestions.find((s) => s.action === "note");
      assert.ok(note, "expected a note suggestion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summarize returns correct counts for overlays and current-state contradictions", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Active one.", triggerContext: "a" });
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Provisional one.", triggerContext: "b", status: "provisional" });
      const overlays = await store.loadAllOverlays(["m1"], { includeProvisional: true });
      const active = overlays.find((o) => o.status !== "provisional");
      const provisional = overlays.find((o) => o.status === "provisional");

      await store.disableOverlay(active.id);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Replacement active.", triggerContext: "c" });
      const afterDisable = await store.loadAllOverlays(["m1"], { includeSuperseded: true, includeProvisional: true });
      const replacement = afterDisable.find((o) => o.shiftDescription === "Replacement active.");
      await store.supersedeOverlay(replacement.id, "Latest active.");

      const detector = new ContradictionDetector({ workspaceDir: dir });
      const finalOverlays = await store.loadAllOverlays(["m1"], { includeSuperseded: true, includeProvisional: true, includeDisabled: true });
      const latestActive = finalOverlays.find((o) => o.shiftDescription === "Latest active.");
      await detector.persistContradiction({ targetMemoryId: "m1", overlayA: provisional.id, overlayB: latestActive.id, descriptionA: provisional.shiftDescription, descriptionB: latestActive.shiftDescription });
      // Stale contradiction involving the disabled overlay should not be counted.
      await detector.persistContradiction({ targetMemoryId: "m1", overlayA: active.id, overlayB: provisional.id, descriptionA: active.shiftDescription, descriptionB: provisional.shiftDescription });

      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const summary = await doctor.summarize();
      assert.strictEqual(summary.active, 1);
      assert.strictEqual(summary.provisional, 1);
      assert.strictEqual(summary.superseded, 1);
      assert.strictEqual(summary.disabled, 1);
      assert.strictEqual(summary.contradictions, 1);
      assert.strictEqual(summary.memoriesWithContradictions, 1);
      assert.ok(summary.totalOverlays >= summary.active + summary.provisional + summary.superseded + summary.disabled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diagnoseOverlay produces a supersede suggestion when the target overlay is the weaker interpretation", async () => {
    const dir = tmpDir();
    try {
      const store = new InterpretationOverlayStore(dir);
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Weak.", triggerContext: "a", confidence: 0.4 });
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Strong.", triggerContext: "b", confidence: 0.9 });
      const overlays = await store.loadAllOverlays(["m1"]);
      const weak = overlays.find((o) => o.confidence === 0.4);
      const strong = overlays.find((o) => o.confidence === 0.9);

      const detector = new ContradictionDetector({ workspaceDir: dir });
      await detector.persistContradiction({ targetMemoryId: "m1", overlayA: weak.id, overlayB: strong.id, descriptionA: weak.shiftDescription, descriptionB: strong.shiftDescription });

      const doctor = new MemoryDoctor({ workspaceDir: dir });
      const report = await doctor.diagnoseOverlay(weak.id);
      const supersede = report.suggestions.find((s) => s.action === "supersede");
      assert.ok(supersede, "expected a supersede suggestion");
      assert.strictEqual(supersede.targetOverlayId, weak.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
