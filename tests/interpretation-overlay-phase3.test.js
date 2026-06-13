import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";

describe("InterpretationOverlayStore — Phase 3", () => {
  it("getLineage returns predecessors and successors", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "First", triggerContext: "a" });
      const content1 = readFileSync(store.filePath, "utf8");
      const firstId = JSON.parse(content1.split("\n").filter(Boolean)[0]).id;

      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "Second",
        triggerContext: "b",
        supersedes: firstId,
      });
      const content2 = readFileSync(store.filePath, "utf8");
      const secondId = JSON.parse(content2.split("\n").filter(Boolean)[1]).id;

      const lineage = await store.getLineage(secondId);
      assert.strictEqual(lineage.current.id, secondId);
      assert.strictEqual(lineage.predecessors.length, 1);
      assert.strictEqual(lineage.predecessors[0].id, firstId);
      assert.strictEqual(lineage.successors.length, 0);

      const firstLineage = await store.getLineage(firstId);
      assert.strictEqual(firstLineage.successors.length, 1);
      assert.strictEqual(firstLineage.successors[0].id, secondId);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disableOverlay appends a tombstone and hides the overlay", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Live", triggerContext: "a" });
      const content = readFileSync(store.filePath, "utf8");
      const id = JSON.parse(content.split("\n").filter(Boolean)[0]).id;

      await store.disableOverlay(id, "operator rollback");
      const rendered = await store.loadForTargets(["m1"]);
      assert.strictEqual(rendered.length, 0);

      const all = await store.loadAllOverlays(["m1"], { includeDisabled: true });
      const disabled = all.find((r) => r.disabledOverlayId === id);
      assert.ok(disabled);
      assert.strictEqual(disabled.status, "forgotten");
      assert.strictEqual(disabled.reason, "operator rollback");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadAllOverlays([]) loads the entire file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "A", triggerContext: "a" });
      await store.append({ targetMemoryId: "m2", shiftType: "meaning", shiftDescription: "B", triggerContext: "b" });
      const all = await store.loadAllOverlays([], { includeProvisional: true });
      assert.strictEqual(all.length, 2);
      const ids = all.map((r) => r.targetMemoryId).sort();
      assert.deepStrictEqual(ids, ["m1", "m2"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadForTargets excludes disabled overlays unless includeDisabled is true", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Live", triggerContext: "a" });
      const content = readFileSync(store.filePath, "utf8");
      const id = JSON.parse(content.split("\n").filter(Boolean)[0]).id;
      await store.disableOverlay(id, "test");

      const hidden = await store.loadForTargets(["m1"]);
      assert.strictEqual(hidden.length, 0);

      const shown = await store.loadForTargets(["m1"], 30, { includeDisabled: true });
      assert.strictEqual(shown.length, 1);
      assert.strictEqual(shown[0].id, id);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getLineage skips malformed JSON lines and still returns correct lineage", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "First", triggerContext: "a" });
      const content1 = readFileSync(store.filePath, "utf8");
      const firstId = JSON.parse(content1.split("\n").filter(Boolean)[0]).id;

      appendFileSync(store.filePath, "{ malformed json line\n");

      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "Second",
        triggerContext: "b",
        supersedes: firstId,
      });
      const content2 = readFileSync(store.filePath, "utf8");
      const secondId = JSON.parse(content2.split("\n").filter(Boolean)[2]).id;

      const lineage = await store.getLineage(secondId);
      assert.strictEqual(lineage.current.id, secondId);
      assert.strictEqual(lineage.predecessors.length, 1);
      assert.strictEqual(lineage.predecessors[0].id, firstId);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disableOverlay(undefined) throws TypeError", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await assert.rejects(store.disableOverlay(undefined), TypeError);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disableOverlay(non-existent-id) returns false", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      const result = await store.disableOverlay("non-existent-id", "test");
      assert.strictEqual(result, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadAllOverlays excludes records superseded via supersedes unless includeSuperseded is true", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Old", triggerContext: "a" });
      const content = readFileSync(store.filePath, "utf8");
      const oldId = JSON.parse(content.split("\n").filter(Boolean)[0]).id;

      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "New",
        triggerContext: "b",
        supersedes: oldId,
      });

      const withoutSuperseded = await store.loadAllOverlays(["m1"]);
      assert.strictEqual(withoutSuperseded.length, 1);
      assert.strictEqual(withoutSuperseded[0].shiftDescription, "New");

      const withSuperseded = await store.loadAllOverlays(["m1"], { includeSuperseded: true });
      assert.strictEqual(withSuperseded.length, 2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadForTargets returns an empty array for a target whose only overlay is superseded", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Old", triggerContext: "a" });
      const content = readFileSync(store.filePath, "utf8");
      const oldId = JSON.parse(content.split("\n").filter(Boolean)[0]).id;

      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "New provisional",
        triggerContext: "b",
        supersedes: oldId,
        status: "provisional",
      });

      const rendered = await store.loadForTargets(["m1"]);
      assert.deepStrictEqual(rendered, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disableOverlay can disable two different overlays for the same target with the same reason", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "First", triggerContext: "a" });
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Second", triggerContext: "b" });
      const content = readFileSync(store.filePath, "utf8");
      const ids = content.split("\n").filter(Boolean).map((line) => JSON.parse(line).id);

      const firstDisable = await store.disableOverlay(ids[0], "operator rollback");
      assert.strictEqual(firstDisable, true, "first disable should succeed");
      const secondDisable = await store.disableOverlay(ids[1], "operator rollback");
      assert.strictEqual(secondDisable, true, "second disable with same reason should also succeed");

      const rendered = await store.loadForTargets(["m1"]);
      assert.deepStrictEqual(rendered, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getLineage stops at a circular supersedes chain without hanging", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      const now = new Date().toISOString();
      const records = [
        { id: "ov-1", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "First", triggerContext: "a", createdAt: now, supersedes: "ov-2" },
        { id: "ov-2", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Second", triggerContext: "b", createdAt: now, supersedes: "ov-1" },
      ];
      writeFileSync(store.filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

      const lineage = await store.getLineage("ov-1");
      assert.strictEqual(lineage.current.id, "ov-1");
      // Predecessor walk should stop after visiting ov-2 once, avoiding the loop back to ov-1.
      assert.strictEqual(lineage.predecessors.length, 1);
      assert.strictEqual(lineage.predecessors[0].id, "ov-2");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadAllOverlays skips malformed JSON lines and returns valid records", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      await store.append({ targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Good", triggerContext: "a" });
      appendFileSync(store.filePath, "{ broken json\n");
      await store.append({ targetMemoryId: "m2", shiftType: "meaning", shiftDescription: "Also good", triggerContext: "b" });

      const all = await store.loadAllOverlays([], { includeProvisional: true });
      assert.strictEqual(all.length, 2);
      const targetIds = all.map((r) => r.targetMemoryId).sort();
      assert.deepStrictEqual(targetIds, ["m1", "m2"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadForTargets returns the latest overlay when multiple non-superseded overlays exist for one target", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-phase3-"));
    const store = new InterpretationOverlayStore(tmpDir);
    try {
      const now = Date.now();
      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "Older",
        triggerContext: "a",
        createdAt: new Date(now - 1000).toISOString(),
      });
      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "Latest",
        triggerContext: "b",
        createdAt: new Date(now).toISOString(),
      });

      const rendered = await store.loadForTargets(["m1"]);
      assert.strictEqual(rendered.length, 1);
      assert.strictEqual(rendered[0].shiftDescription, "Latest");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
