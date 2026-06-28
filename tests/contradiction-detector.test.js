import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

describe("ContradictionDetector", () => {
  it("returns empty array when no meaning overlays exist", async () => {
    const detector = new ContradictionDetector({ llm: async () => "no" });
    const result = await detector.findContradictions([]);
    assert.deepStrictEqual(result, []);
  });

  it("detects contradiction when LLM says yes", async () => {
    let promptSeen = "";
    const detector = new ContradictionDetector({
      llm: async (messages) => {
        promptSeen = messages[messages.length - 1].content;
        return "yes";
      },
    });
    const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use Postgres." };
    const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use MySQL." };
    const result = await detector.findContradictions([a, b]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].overlayA, "ov-a");
    assert.strictEqual(result[0].overlayB, "ov-b");
    assert.ok(promptSeen.includes("Postgres"));
    assert.ok(promptSeen.includes("MySQL"));
  });

  it("returns no contradiction when LLM says no", async () => {
    const detector = new ContradictionDetector({ llm: async () => "no" });
    const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We use Postgres." };
    const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "We still use Postgres." };
    const result = await detector.findContradictions([a, b]);
    assert.deepStrictEqual(result, []);
  });

  it("limits meaning-overlay pairwise LLM checks to maxPairs", async () => {
    let calls = 0;
    const detector = new ContradictionDetector({
      llm: async () => {
        calls++;
        return "yes";
      },
    });
    const overlays = Array.from({ length: 5 }, (_, index) => ({
      id: `ov-${index}`,
      targetMemoryId: "m1",
      shiftType: "meaning",
      shiftDescription: `Meaning ${index}`,
    }));

    const result = await detector.findContradictions(overlays, { maxPairs: 3 });

    assert.strictEqual(calls, 3);
    assert.strictEqual(result.length, 3);
  });

  it("ignores non-meaning overlays", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "confidence", shiftDescription: "High confidence." };
    const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "confidence", shiftDescription: "Low confidence." };
    const result = await detector.findContradictions([a, b]);
    assert.deepStrictEqual(result, []);
  });

  it("persists contradiction records to JSONL", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-"));
    const detector = new ContradictionDetector({
      llm: async () => "yes",
      workspaceDir: tmpDir,
    });
    try {
      const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres." };
      const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "MySQL." };
      await detector.findAndPersistContradictions([a, b]);
      const content = readFileSync(join(tmpDir, "contradictions.jsonl"), "utf8");
      const record = JSON.parse(content.split("\n").filter(Boolean)[0]);
      assert.strictEqual(record.recordType, "contradiction");
      assert.strictEqual(record.overlayA, "ov-a");
      assert.strictEqual(record.overlayB, "ov-b");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty when LLM throws", async () => {
    const detector = new ContradictionDetector({
      llm: async () => {
        throw new Error("llm unavailable");
      },
    });
    const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres." };
    const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "MySQL." };
    const result = await detector.findContradictions([a, b]);
    assert.deepStrictEqual(result, []);
  });

  it("loadFor filters records by memory ids", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-"));
    const detector = new ContradictionDetector({
      llm: async () => "yes",
      workspaceDir: tmpDir,
    });
    try {
      const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres." };
      const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "MySQL." };
      const c = { id: "ov-c", targetMemoryId: "m2", shiftType: "meaning", shiftDescription: "SQLite." };
      const d = { id: "ov-d", targetMemoryId: "m2", shiftType: "meaning", shiftDescription: "Oracle." };
      await detector.findAndPersistContradictions([a, b, c, d]);
      const loaded = await detector.loadFor(["m2"]);
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].targetMemoryId, "m2");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadFor returns empty when file is missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-"));
    const detector = new ContradictionDetector({
      llm: async () => "yes",
      workspaceDir: tmpDir,
    });
    try {
      const loaded = await detector.loadFor(["m1"]);
      assert.deepStrictEqual(loaded, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadFor skips malformed JSON lines", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-"));
    const detector = new ContradictionDetector({
      llm: async () => "yes",
      workspaceDir: tmpDir,
    });
    try {
      writeFileSync(join(tmpDir, "contradictions.jsonl"), "not-json\n");
      const loaded = await detector.loadFor(["m1"]);
      assert.deepStrictEqual(loaded, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty when overlays is not an array", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const result = await detector.findContradictions("not-an-array");
    assert.deepStrictEqual(result, []);
  });

  it("loadFor returns empty when memoryIds is not an array", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-"));
    const detector = new ContradictionDetector({
      llm: async () => "yes",
      workspaceDir: tmpDir,
    });
    try {
      const loaded = await detector.loadFor("m1");
      assert.deepStrictEqual(loaded, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gracefully disables persistence when workspaceDir is invalid", () => {
    const detector = new ContradictionDetector({
      llm: async () => "yes",
      workspaceDir: "/nonexistent/path/that/does/not/exist",
    });
    assert.strictEqual(detector.filePath, null);
  });

  it("serializes concurrent JSONL appends", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-contra-"));
    const detector = new ContradictionDetector({
      llm: async () => "yes",
      workspaceDir: tmpDir,
    });
    try {
      const a = { id: "ov-a", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "Postgres." };
      const b = { id: "ov-b", targetMemoryId: "m1", shiftType: "meaning", shiftDescription: "MySQL." };
      const c = { id: "ov-c", targetMemoryId: "m2", shiftType: "meaning", shiftDescription: "SQLite." };
      const d = { id: "ov-d", targetMemoryId: "m2", shiftType: "meaning", shiftDescription: "Oracle." };
      await Promise.all([
        detector.findAndPersistContradictions([a, b]),
        detector.findAndPersistContradictions([c, d]),
      ]);
      const content = readFileSync(join(tmpDir, "contradictions.jsonl"), "utf8");
      const lines = content.split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 2);
      for (const line of lines) {
        const rec = JSON.parse(line);
        assert.strictEqual(rec.recordType, "contradiction");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
