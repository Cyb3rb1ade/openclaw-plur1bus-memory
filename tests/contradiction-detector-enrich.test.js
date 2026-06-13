/**
 * tests/contradiction-detector-enrich.test.js
 *
 * Tests for ContradictionDetector.flagContradictoryOverlays.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

describe("ContradictionDetector — flagContradictoryOverlays", () => {
  it("flags overlays that appear in persisted contradiction records", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contradiction-test-"));
    try {
      const contradictionPath = join(tmpDir, "contradictions.jsonl");
      writeFileSync(
        contradictionPath,
        JSON.stringify({
          recordType: "contradiction",
          targetMemoryId: "m1",
          overlayA: "ov-a",
          overlayB: "ov-b",
          detectedAt: new Date().toISOString(),
        }) + "\n",
      );

      const detector = new ContradictionDetector({ workspaceDir: tmpDir });
      const overlays = [
        { id: "ov-a", targetMemoryId: "m1" },
        { id: "ov-b", targetMemoryId: "m1" },
        { id: "ov-c", targetMemoryId: "m1" },
      ];

      await detector.flagContradictoryOverlays(overlays);

      assert.strictEqual(overlays[0].contradiction, true, "ov-a should be flagged");
      assert.strictEqual(overlays[1].contradiction, true, "ov-b should be flagged");
      assert.strictEqual(overlays[2].contradiction, undefined, "ov-c should not be flagged");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does nothing when contradictions file is missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contradiction-test-"));
    try {
      const detector = new ContradictionDetector({ workspaceDir: tmpDir });
      const overlays = [{ id: "ov-only", targetMemoryId: "m1" }];

      await detector.flagContradictoryOverlays(overlays);

      assert.strictEqual(overlays[0].contradiction, undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns early for empty overlay input", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contradiction-test-"));
    try {
      const detector = new ContradictionDetector({ workspaceDir: tmpDir });
      const result = await detector.flagContradictoryOverlays([]);
      assert.strictEqual(result, undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not flag a contradiction when the other side is no longer active", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contradiction-test-"));
    try {
      writeFileSync(
        join(tmpDir, "contradictions.jsonl"),
        JSON.stringify({
          recordType: "contradiction",
          targetMemoryId: "m1",
          overlayA: "ov-a",
          overlayB: "ov-b",
          detectedAt: new Date().toISOString(),
        }) + "\n",
      );

      const detector = new ContradictionDetector({ workspaceDir: tmpDir });

      // Both partners active → both flagged.
      const both = [
        { id: "ov-a", targetMemoryId: "m1" },
        { id: "ov-b", targetMemoryId: "m1" },
      ];
      await detector.flagContradictoryOverlays(both);
      assert.strictEqual(both[0].contradiction, true, "ov-a flagged while partner is active");
      assert.strictEqual(both[1].contradiction, true, "ov-b flagged while partner is active");

      // Partner gone → ov-a is no longer flagged.
      const onlyA = [{ id: "ov-a", targetMemoryId: "m1" }];
      await detector.flagContradictoryOverlays(onlyA);
      assert.strictEqual(onlyA[0].contradiction, undefined, "ov-a not flagged after partner is gone");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
