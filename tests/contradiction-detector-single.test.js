import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

describe("ContradictionDetector single-overlay helpers", () => {
  it("detectContradiction returns true when LLM says yes", async () => {
    let promptSeen = "";
    const detector = new ContradictionDetector({
      llm: async (messages) => {
        promptSeen = messages[messages.length - 1].content;
        return "yes";
      },
    });
    const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use Postgres." };
    const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use MySQL." };
    const result = await detector.detectContradiction(a, b);
    assert.strictEqual(result, true);
    assert.ok(promptSeen.includes("Postgres"));
    assert.ok(promptSeen.includes("MySQL"));
  });

  it("detectContradiction returns false when LLM says no", async () => {
    const detector = new ContradictionDetector({ llm: async () => "no" });
    const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use Postgres." };
    const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We still use Postgres." };
    const result = await detector.detectContradiction(a, b);
    assert.strictEqual(result, false);
  });

  it("findContradictionsForNewOverlay only checks meaning overlays for the same target memory", async () => {
    const detector = new ContradictionDetector({
      llm: async (messages) => {
        const content = messages[messages.length - 1].content;
        // Only claim contradiction when both descriptions are about the database stack.
        return content.includes("Postgres") && content.includes("MySQL") ? "yes" : "no";
      },
    });
    const newOverlay = { id: "ov-new", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use MySQL." };
    const existing = [
      { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use Postgres." },
      { id: "ov-b", targetMemoryId: "m1", shiftType: "confidence", shiftDescription: "High confidence." },
      { id: "ov-c", targetMemoryId: "m2", shiftType: "meaning", shiftDescription: "We use SQLite." },
    ];
    const result = await detector.findContradictionsForNewOverlay(newOverlay, existing);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].overlayA, "ov-new");
    assert.strictEqual(result[0].overlayB, "ov-a");
    assert.strictEqual(result[0].targetMemoryId, "m1");
  });

  it("persistContradiction writes a correctly shaped record to contradictions.jsonl", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-single-"));
    const detector = new ContradictionDetector({ workspaceDir: tmpDir });
    try {
      await detector.persistContradiction({
        targetMemoryId: "m1",
        overlayA: "ov-a",
        overlayB: "ov-b",
      });
      const content = readFileSync(join(tmpDir, "contradictions.jsonl"), "utf8");
      const lines = content.split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.strictEqual(record.recordType, "contradiction");
      assert.strictEqual(record.targetMemoryId, "m1");
      assert.strictEqual(record.overlayA, "ov-a");
      assert.strictEqual(record.overlayB, "ov-b");
      assert.ok(record.id);
      assert.ok(record.detectedAt);
      assert.match(record.detectedAt, /^\d{4}-/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persistContradiction is a no-op when required fields are missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-missing-"));
    const detector = new ContradictionDetector({ workspaceDir: tmpDir });
    try {
      await detector.persistContradiction({});
      assert.strictEqual(existsSync(join(tmpDir, "contradictions.jsonl")), false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
