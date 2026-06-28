/**
 * tests/gc-neverforget-guard.test.js
 *
 * Regression: GC must never archive neverForget / core-class memories.
 * Two compounding defects guarded here:
 *  1. The active-scan projection (normalizeActiveScanRow) stripped neverForget
 *     and memoryClass, so the protected fields never reached selection.
 *  2. selectCandidatesForGc had no neverForget/core guard.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { MemoryDB } from "../index.js";
import { selectCandidatesForGc } from "../lib/garbage-collector.js";

describe("GC neverForget/core protection", () => {
  it("normalizeActiveScanRow carries neverForget and memoryClass through the projection", () => {
    const db = new MemoryDB("/tmp/gc-neverforget-test", 3);
    const row = db.normalizeActiveScanRow({
      id: "a", text: "t", neverForget: true, memoryClass: "core", status: "active",
    });
    assert.strictEqual(row.neverForget, true, "neverForget must survive the active-scan projection");
    assert.strictEqual(row.memoryClass, "core", "memoryClass must survive the active-scan projection");
  });

  it("selectCandidatesForGc never selects neverForget or core memories under count pressure", () => {
    const memories = [
      { id: "keep-nf", memoryStrength: 0.01, createdAt: 1, neverForget: true, status: "active" },
      { id: "keep-nf1", memoryStrength: 0.01, createdAt: 2, neverForget: 1, status: "active" },
      { id: "keep-core", memoryStrength: 0.01, createdAt: 3, memoryClass: "core", status: "active" },
      { id: "evict-1", memoryStrength: 0.02, createdAt: 4, status: "active" },
      { id: "evict-2", memoryStrength: 0.03, createdAt: 5, status: "active" },
    ];
    // Pressure: keep at most 1 → must remove the weakest, but protected ones are off-limits.
    const ids = selectCandidatesForGc(memories, { maxMemoryCount: 1 });
    assert.ok(!ids.includes("keep-nf"), "neverForget:true must not be archived");
    assert.ok(!ids.includes("keep-nf1"), "neverForget:1 must not be archived");
    assert.ok(!ids.includes("keep-core"), "memoryClass:core must not be archived");
  });

  it("selectCandidatesForGc never selects protected memories under minMemoryStrength", () => {
    const memories = [
      { id: "keep-nf", memoryStrength: 0.01, createdAt: 1, neverForget: true, status: "active" },
      { id: "evict-1", memoryStrength: 0.01, createdAt: 2, status: "active" },
    ];
    const ids = selectCandidatesForGc(memories, { minMemoryStrength: 0.5 });
    assert.ok(!ids.includes("keep-nf"), "neverForget must survive minMemoryStrength sweep");
    assert.ok(ids.includes("evict-1"), "unprotected weak memory is still eligible");
  });
});
