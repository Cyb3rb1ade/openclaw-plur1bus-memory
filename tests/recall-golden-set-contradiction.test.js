/**
 * tests/recall-golden-set-contradiction.test.js
 *
 * Behavioral regression golden-set for contradiction/version ranking and
 * overlay rendering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareMemoryVersions,
  resolveContradictionWinner,
  rankMemoryVersions,
} from "../lib/memory-text-contradiction.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("Golden-Set: memory-text contradiction version ranking", () => {
  it("higher versionNumber always wins", () => {
    const oldVersion = { id: "old", versionNumber: 1, status: "active", createdAt: 1000 };
    const newVersion = { id: "new", versionNumber: 2, status: "active", createdAt: 0 };
    const winner = resolveContradictionWinner(oldVersion, newVersion);
    assert.strictEqual(winner.id, "new");
  });

  it("active status wins when versions are equal", () => {
    const active = { id: "active", versionNumber: 1, status: "active", createdAt: 0 };
    const archived = { id: "archived", versionNumber: 1, status: "archived", createdAt: 1000 };
    const winner = resolveContradictionWinner(active, archived);
    assert.strictEqual(winner.id, "active");
  });

  it("authoritative updateSource wins when version and status are equal", () => {
    const userCorrection = {
      id: "corrected",
      versionNumber: 1,
      status: "active",
      updateSource: "user_correction",
      createdAt: 0,
    };
    const inferred = {
      id: "inferred",
      versionNumber: 1,
      status: "active",
      updateSource: "llm_inference",
      createdAt: 1000,
    };
    const winner = resolveContradictionWinner(userCorrection, inferred);
    assert.strictEqual(winner.id, "corrected");
  });

  it("more recent time wins when all other factors are equal", () => {
    const older = { id: "older", versionNumber: 1, status: "active", createdAt: 1000 };
    const newer = { id: "newer", versionNumber: 1, status: "active", createdAt: 2000 };
    const winner = resolveContradictionWinner(older, newer);
    assert.strictEqual(winner.id, "newer");
  });

  it("rankMemoryVersions produces a deterministic total order", () => {
    const memories = [
      { id: "a", versionNumber: 1, status: "active", createdAt: 3000 },
      { id: "b", versionNumber: 2, status: "archived", createdAt: 1000 },
      { id: "c", versionNumber: 1, status: "active", updateSource: "user_correction", createdAt: 2000 },
      { id: "d", versionNumber: 1, status: "active", createdAt: 1000 },
    ];
    const ranked = rankMemoryVersions(memories);
    assert.deepStrictEqual(
      ranked.map(m => m.id),
      ["b", "c", "a", "d"],
    );
  });
});

describe("Golden-Set: superseded memory rendering", () => {
  it("renders superseded-by attribute and prefix", () => {
    const out = formatRelevantMemoriesContext([
      {
        id: "m1",
        category: "fact",
        source: "dm",
        display: "Old fact",
        memoryStrength: 1.0,
        status: "superseded",
        supersededBy: "m2",
      },
    ]);
    assert.ok(out.includes('status="superseded"'), "missing status attribute");
    assert.ok(out.includes('superseded-by="m2"'), "missing superseded-by attribute");
    assert.ok(out.includes("[superseded] Old fact"), "missing superseded prefix");
  });

  it("renders version attribute only when versionNumber > 1", () => {
    const v1 = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "v1", memoryStrength: 1.0, versionNumber: 1 },
    ]);
    const v3 = formatRelevantMemoriesContext([
      { id: "m2", category: "fact", source: "dm", display: "v3", memoryStrength: 1.0, versionNumber: 3 },
    ]);
    assert.ok(!v1.includes('version="'), "v1 should not render version attribute");
    assert.ok(v3.includes('version="3"'), "v3 should render version attribute");
  });
});

describe("Golden-Set: overlay contradiction humility", () => {
  it("renders humility phrase for a flagged contradictory overlay", () => {
    const out = formatRelevantMemoriesContext(
      [
        { id: "m1", category: "fact", source: "dm", display: "Base memory", memoryStrength: 1.0 },
      ],
      {
        overlays: [
          {
            id: "ov1",
            targetMemoryId: "m1",
            shiftType: "meaning",
            shiftDescription: "Maybe this was about Beta, not Alpha.",
            confidence: 0.7,
            createdAt: new Date().toISOString(),
            provenance: { triggerMemoryIds: ["m2"] },
            contradiction: true,
          },
        ],
      },
    );
    assert.ok(out.includes("conflicts with another interpretation"), "missing humility phrase");
  });
});
