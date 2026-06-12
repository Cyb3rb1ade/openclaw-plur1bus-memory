/**
 * tests/interpretation-overlay.test.js
 *
 * Comprehensive tests for InterpretationOverlayStore.
 * Uses temp directories for isolation, never writes to production paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";

describe("InterpretationOverlayStore — append", () => {
  it("writes a JSONL line to file (file didn't exist before)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const overlay = {
        targetMemoryId: "mem-123",
        shiftType: "meaning",
        shiftDescription: "New interpretation",
        triggerContext: "conversation",
      };

      const result = await store.append(overlay);
      assert.strictEqual(result, true, "append should return true");

      // Verify file exists and contains one line
      const content = readFileSync(store.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 1, "should have exactly 1 line");

      const record = JSON.parse(lines[0]);
      assert.strictEqual(record.targetMemoryId, "mem-123");
      assert.strictEqual(record.shiftType, "meaning");
      assert.strictEqual(typeof record.id, "string", "id should be auto-generated as string");
      assert(record.id.length > 0, "id should not be empty");
      assert.strictEqual(typeof record.createdAt, "string", "createdAt should be auto-generated");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("calling twice with same dedupeKey returns false on second call, file has exactly 1 line", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const overlay = {
        targetMemoryId: "mem-456",
        shiftType: "meaning",
        shiftDescription: "Same shift",
        triggerContext: "same context",
      };

      const result1 = await store.append(overlay);
      assert.strictEqual(result1, true, "first append should return true");

      const result2 = await store.append(overlay);
      assert.strictEqual(result2, false, "second append with same overlay should return false");

      // Verify file has exactly 1 line
      const content = readFileSync(store.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 1, "should still have exactly 1 line");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("same dedupeKey after cooldown window has passed returns true (writes second overlay)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      // First overlay with old timestamp (older than cooldown = 7 days)
      const oldTime = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
      const overlay1 = {
        targetMemoryId: "mem-789",
        shiftType: "confidence",
        shiftDescription: "First confidence shift (old)",
        triggerContext: "context A",
        createdAt: oldTime,
      };

      const result1 = await store.append(overlay1);
      assert.strictEqual(result1, true);

      // Second overlay with current timestamp (within cooldown, but first one is outside cooldown window)
      const now = new Date().toISOString();
      const overlay2 = {
        targetMemoryId: "mem-789",
        shiftType: "confidence",
        shiftDescription: "Second confidence shift (recent, after cooldown period)",
        triggerContext: "context A", // same trigger → same dedupeKey
        createdAt: now,
      };

      // Pass cooldown=7 to loadFor, meaning only overlays from last 7 days are checked for dupes
      // Since overlay1 is 8 days old, it won't be found, so overlay2 should be allowed
      const result2 = await store.append(overlay2, 7);
      assert.strictEqual(result2, true, "should allow second append after cooldown window");

      // Verify file has exactly 2 lines
      const content = readFileSync(store.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 2, "should have exactly 2 lines");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-generates id and createdAt if not provided", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const overlay = {
        targetMemoryId: "mem-auto",
        shiftType: "context",
        shiftDescription: "Auto-generated fields",
        triggerContext: "test",
      };

      const result = await store.append(overlay);
      assert.strictEqual(result, true);

      const content = readFileSync(store.filePath, "utf8");
      const record = JSON.parse(content.split("\n")[0]);

      assert.strictEqual(typeof record.id, "string", "id should be auto-generated UUID");
      assert.strictEqual(record.id.length > 0, true, "id should not be empty");
      assert.strictEqual(typeof record.createdAt, "string", "createdAt should be auto-generated ISO timestamp");
      assert(record.createdAt.match(/^\d{4}-\d{2}-\d{2}T/), "createdAt should be valid ISO format");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves manually-provided id and createdAt", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const manualId = "custom-uuid-12345";
      const manualTime = "2026-06-11T10:00:00.000Z";

      const overlay = {
        id: manualId,
        targetMemoryId: "mem-manual",
        shiftType: "meaning",
        shiftDescription: "Manual fields",
        triggerContext: "test",
        createdAt: manualTime,
      };

      const result = await store.append(overlay);
      assert.strictEqual(result, true);

      const content = readFileSync(store.filePath, "utf8");
      const record = JSON.parse(content.split("\n")[0]);

      assert.strictEqual(record.id, manualId, "id should be preserved");
      assert.strictEqual(record.createdAt, manualTime, "createdAt should be preserved");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws TypeError when required fields are missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      assert.throws(
        () => store.append({ shiftType: "meaning", triggerContext: "test" }),
        TypeError,
      );
      assert.throws(
        () => store.append({ targetMemoryId: "mem-123", triggerContext: "test" }),
        TypeError,
      );
      assert.throws(
        () => store.append({ targetMemoryId: "mem-123", shiftType: "meaning" }),
        TypeError,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("InterpretationOverlayStore — loadFor", () => {
  it("returns only overlays for specified memoryIds", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      // Append overlays for different memories
      await store.append({
        targetMemoryId: "mem-A",
        shiftType: "meaning",
        shiftDescription: "Shift A",
        triggerContext: "context A",
      });

      await store.append({
        targetMemoryId: "mem-B",
        shiftType: "meaning",
        shiftDescription: "Shift B",
        triggerContext: "context B",
      });

      await store.append({
        targetMemoryId: "mem-C",
        shiftType: "meaning",
        shiftDescription: "Shift C",
        triggerContext: "context C",
      });

      // Load only A and C
      const results = await store.loadFor(["mem-A", "mem-C"]);
      assert.strictEqual(results.length, 2, "should return 2 overlays");
      assert.strictEqual(results.every((r) => ["mem-A", "mem-C"].includes(r.targetMemoryId)), true);
      assert(results.some((r) => r.targetMemoryId === "mem-A"));
      assert(results.some((r) => r.targetMemoryId === "mem-C"));
      assert(!results.some((r) => r.targetMemoryId === "mem-B"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters out overlays older than maxAgeDays", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const now = new Date();
      const recent = new Date(now.getTime() - 5 * 24 * 3600 * 1000).toISOString();
      const old = new Date(now.getTime() - 40 * 24 * 3600 * 1000).toISOString();

      await store.append({
        targetMemoryId: "mem-recent",
        shiftType: "meaning",
        shiftDescription: "Recent",
        triggerContext: "recent",
        createdAt: recent,
      });

      await store.append({
        targetMemoryId: "mem-old",
        shiftType: "meaning",
        shiftDescription: "Old",
        triggerContext: "old",
        createdAt: old,
      });

      // Load with maxAgeDays=30 (should exclude old)
      const results = await store.loadFor(["mem-recent", "mem-old"], 30);
      assert.strictEqual(results.length, 1, "should filter out overlays older than 30 days");
      assert.strictEqual(results[0].targetMemoryId, "mem-recent");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns [] if file doesn't exist", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const results = await store.loadFor(["mem-any"]);
      assert.deepStrictEqual(results, [], "should return empty array if file doesn't exist");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips malformed JSON lines without throwing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      // Manually write some lines, including a malformed one
      const lines = [
        JSON.stringify({
          targetMemoryId: "mem-good-1",
          shiftType: "meaning",
          shiftDescription: "Good",
          triggerContext: "context",
          createdAt: new Date().toISOString(),
        }),
        "{ broken json line",
        JSON.stringify({
          targetMemoryId: "mem-good-2",
          shiftType: "meaning",
          shiftDescription: "Also good",
          triggerContext: "context",
          createdAt: new Date().toISOString(),
        }),
      ];

      const { appendFileSync } = await import("node:fs");
      appendFileSync(store.filePath, lines.join("\n") + "\n");

      // Should skip the malformed line
      const results = await store.loadFor(["mem-good-1", "mem-good-2"]);
      assert.strictEqual(results.length, 2, "should skip malformed lines and return 2 valid records");
      assert(results.every((r) => r.shiftType === "meaning"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("InterpretationOverlayStore — loadForTargets", () => {
  it("returns overlays for specified targets", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "mem-target",
        shiftType: "meaning",
        shiftDescription: "Target shift",
        triggerContext: "context",
      });

      const results = await store.loadForTargets(["mem-target"]);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].targetMemoryId, "mem-target");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects maxAgeDays parameter", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const oldTime = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
      await store.append({
        targetMemoryId: "mem-aged",
        shiftType: "meaning",
        shiftDescription: "Old shift",
        triggerContext: "context",
        createdAt: oldTime,
      });

      const results = await store.loadForTargets(["mem-aged"], 30);
      assert.deepStrictEqual(results, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when no overlays match", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "mem-a",
        shiftType: "meaning",
        shiftDescription: "Shift A",
        triggerContext: "context",
      });

      const results = await store.loadForTargets(["mem-b"]);
      assert.deepStrictEqual(results, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("InterpretationOverlayStore — computeDedupeKey", () => {
  it("same inputs produce same hash", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const key1 = store.computeDedupeKey("mem-123", "meaning", "trigger context");
      const key2 = store.computeDedupeKey("mem-123", "meaning", "trigger context");

      assert.strictEqual(key1, key2, "same inputs should produce same hash");
      assert.strictEqual(key1.length, 16, "hash should be 16 chars");
      assert(/^[a-f0-9]{16}$/.test(key1), "hash should be valid hex");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("different targetMemoryId produces different hash", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const key1 = store.computeDedupeKey("mem-111", "meaning", "trigger");
      const key2 = store.computeDedupeKey("mem-222", "meaning", "trigger");

      assert.notStrictEqual(key1, key2, "different targetMemoryId should produce different hash");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("different shiftType produces different hash", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const key1 = store.computeDedupeKey("mem-123", "meaning", "trigger");
      const key2 = store.computeDedupeKey("mem-123", "confidence", "trigger");

      assert.notStrictEqual(key1, key2, "different shiftType should produce different hash");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("different triggerContext produces different hash", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const key1 = store.computeDedupeKey("mem-123", "meaning", "context A");
      const key2 = store.computeDedupeKey("mem-123", "meaning", "context B");

      assert.notStrictEqual(key1, key2, "different triggerContext should produce different hash");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles null/undefined triggerContext gracefully", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const key1 = store.computeDedupeKey("mem-123", "meaning", null);
      const key2 = store.computeDedupeKey("mem-123", "meaning", undefined);
      const key3 = store.computeDedupeKey("mem-123", "meaning", "");

      assert.strictEqual(key1, key2, "null and undefined should produce same hash");
      assert.strictEqual(key1, key3, "null and empty string should produce same hash");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("truncates long triggerContext to first 200 chars for deduping", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const short = "a".repeat(100);
      const long = "a".repeat(300);
      const truncated = "a".repeat(200);

      const keyShort = store.computeDedupeKey("mem-123", "meaning", short);
      const keyLong = store.computeDedupeKey("mem-123", "meaning", long);
      const keyTruncated = store.computeDedupeKey("mem-123", "meaning", truncated);

      assert.strictEqual(keyLong, keyTruncated, "300 chars and 200 chars should produce same hash (truncated)");
      assert.notStrictEqual(keyShort, keyLong, "100 chars and 300 chars should produce different hashes");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("InterpretationOverlayStore — integration", () => {
  it("completes full workflow: append, load, check dedupes", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      // Create and append 3 unique overlays for mem-core
      const overlays = [
        {
          targetMemoryId: "mem-core",
          shiftType: "meaning",
          shiftDescription: "First interpretation",
          triggerContext: "context 1",
        },
        {
          targetMemoryId: "mem-core",
          shiftType: "confidence",
          shiftDescription: "Changed confidence",
          triggerContext: "context 2",
        },
        {
          targetMemoryId: "mem-related",
          shiftType: "meaning",
          shiftDescription: "Related memory shift",
          triggerContext: "context 3",
        },
      ];

      for (const ov of overlays) {
        const result = await store.append(ov);
        assert.strictEqual(result, true, `should append ${ov.shiftType} successfully`);
      }

      // Try to append duplicate of first overlay
      const dupResult = await store.append(overlays[0]);
      assert.strictEqual(dupResult, false, "duplicate should return false");

      // Load for mem-core
      const memCoreOverlays = await store.loadFor(["mem-core"]);
      assert.strictEqual(memCoreOverlays.length, 2, "mem-core should have 2 overlays");

      // Load for mem-related
      const memRelatedOverlays = await store.loadFor(["mem-related"]);
      assert.strictEqual(memRelatedOverlays.length, 1, "mem-related should have 1 overlay");

      // Load for both
      const bothOverlays = await store.loadFor(["mem-core", "mem-related"]);
      assert.strictEqual(bothOverlays.length, 3, "both memories should have 3 overlays total");

      // Load for nonexistent
      const noneOverlays = await store.loadFor(["mem-nonexistent"]);
      assert.strictEqual(noneOverlays.length, 0, "nonexistent memory should have 0 overlays");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("InterpretationOverlayStore — shouldSkipLlmResponse static helper", () => {
  it("returns true for null/undefined response", () => {
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse(null), true);
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse(undefined), true);
  });

  it("returns true for 'no shift' response (case-insensitive)", () => {
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse("no shift"), true);
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse("NO SHIFT"), true);
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse("No Shift"), true);
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse("  no shift  "), true);
  });

  it("returns false for meaningful responses", () => {
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse("meaning changed"), false);
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse("confidence increased"), false);
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse("new context"), false);
  });

  it("returns true for empty string (handled as falsy)", () => {
    assert.strictEqual(InterpretationOverlayStore.shouldSkipLlmResponse(""), true);
  });
});

describe("InterpretationOverlayStore — loadForTargets render path", () => {
  it("returns only the latest overlay per target", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const now = Date.now();
      await store.append({
        targetMemoryId: "mem-core",
        shiftType: "meaning",
        shiftDescription: "First interpretation",
        triggerContext: "context 1",
        createdAt: new Date(now - 1000).toISOString(),
      });
      await store.append({
        targetMemoryId: "mem-core",
        shiftType: "meaning",
        shiftDescription: "Latest interpretation",
        triggerContext: "context 2",
        createdAt: new Date(now).toISOString(),
      });

      const loaded = await store.loadForTargets(["mem-core"]);
      assert.strictEqual(loaded.length, 1, "only one overlay per target");
      assert.strictEqual(loaded[0].shiftDescription, "Latest interpretation", "latest overlay wins");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters out superseded overlays", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "mem-core",
        shiftType: "meaning",
        shiftDescription: "Superseded interpretation",
        triggerContext: "context 1",
        supersededBy: "ov-2",
      });
      await store.append({
        targetMemoryId: "mem-core",
        shiftType: "meaning",
        shiftDescription: "Current interpretation",
        triggerContext: "context 2",
      });

      const loaded = await store.loadForTargets(["mem-core"]);
      assert.strictEqual(loaded.length, 1, "superseded overlay excluded");
      assert.strictEqual(loaded[0].shiftDescription, "Current interpretation", "current overlay returned");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
