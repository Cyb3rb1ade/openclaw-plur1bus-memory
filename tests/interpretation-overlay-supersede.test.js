/**
 * tests/interpretation-overlay-supersede.test.js
 *
 * Tests for InterpretationOverlayStore.supersedeOverlay.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";

describe("InterpretationOverlayStore — supersedeOverlay", () => {
  it("supersedeOverlay appends a new overlay linking to the old one", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "mem-123",
        shiftType: "meaning",
        shiftDescription: "Original interpretation",
        triggerContext: "original context",
      });

      const content = readFileSync(store.filePath, "utf8");
      const oldId = JSON.parse(content.split("\n").filter(Boolean)[0]).id;

      const result = await store.supersedeOverlay(
        oldId,
        "New interpretation",
        "operator resolution",
      );
      assert.strictEqual(result, true, "supersedeOverlay should return true");

      const lineage = await store.getLineage(oldId, 365 * 100);
      assert.strictEqual(lineage.successors.length, 1, "old overlay should have one successor");
      assert.strictEqual(lineage.successors[0].supersedes, oldId);
      assert.strictEqual(lineage.successors[0].shiftDescription, "New interpretation");

      const active = await store.loadForTargets(["mem-123"]);
      assert.strictEqual(active.length, 1, "only the new overlay should be active");
      assert.strictEqual(active[0].shiftDescription, "New interpretation");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supersedeOverlay returns false for unknown id", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const result = await store.supersedeOverlay(
        "00000000-0000-0000-0000-000000000000",
        "New interpretation",
        "operator resolution",
      );
      assert.strictEqual(result, false, "supersedeOverlay should return false for unknown id");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supersedeOverlay throws for missing id", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await assert.rejects(
        async () => store.supersedeOverlay(undefined, "New interpretation"),
        { name: "TypeError", message: "oldId is required" },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supersedeOverlay throws for empty newDescription", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "mem-123",
        shiftType: "meaning",
        shiftDescription: "Original interpretation",
        triggerContext: "original context",
      });

      const content = readFileSync(store.filePath, "utf8");
      const oldId = JSON.parse(content.split("\n").filter(Boolean)[0]).id;

      await assert.rejects(
        async () => store.supersedeOverlay(oldId, "   "),
        { name: "TypeError", message: /newDescription is required/ },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
