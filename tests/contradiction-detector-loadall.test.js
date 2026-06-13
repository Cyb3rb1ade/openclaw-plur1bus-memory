import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

describe("ContradictionDetector.loadAll", () => {
  it("returns all persisted contradiction records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-contra-all-"));
    try {
      writeFileSync(
        join(dir, "contradictions.jsonl"),
        JSON.stringify({ recordType: "contradiction", targetMemoryId: "m1", overlayA: "a", overlayB: "b" }) + "\n" +
        JSON.stringify({ recordType: "contradiction", targetMemoryId: "m2", overlayA: "c", overlayB: "d" }) + "\n",
      );
      const detector = new ContradictionDetector({ workspaceDir: dir });
      const all = await detector.loadAll();
      assert.strictEqual(all.length, 2);
      assert.ok(all.some((r) => r.targetMemoryId === "m1"));
      assert.ok(all.some((r) => r.targetMemoryId === "m2"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty array when the contradictions file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-contra-empty-"));
    try {
      const detector = new ContradictionDetector({ workspaceDir: dir });
      const all = await detector.loadAll();
      assert.deepStrictEqual(all, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
