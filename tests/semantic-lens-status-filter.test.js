/**
 * tests/semantic-lens-status-filter.test.js
 *
 * Regression: the semantic-lens recall path (selectLensMemories/tryPick) hydrated
 * candidate memories and injected them into recall WITHOUT a status filter. A
 * memory archived/superseded/deleted after the lens index was built could
 * resurface in recall — the same lifecycle-status gap just fixed in
 * Conversation-Reactivation-Recall. Parity: inactive memories must be dropped.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySemanticLensToRecall } from "../lib/semantic-lens-index.js";

describe("semantic lens status filter", () => {
  it("does not surface a superseded memory from the lens index", async () => {
    const baseMemories = [
      { id: "base1", text: "Projekt Alpha nutzt den Auth-Service intern" },
    ];

    const index = {
      version: 1,
      memoryToCommunity: { base1: "c1" },
      communities: {
        c1: {
          id: "c1",
          size: 3,
          representativeMemoryIds: ["mem-superseded", "mem-active"],
          bridgeMemoryIds: [],
          fadedCandidateMemoryIds: [],
        },
      },
    };

    const memoryById = new Map([
      ["mem-superseded", { id: "mem-superseded", text: "Projekt Alpha nutzt den Auth-Service extern", status: "superseded" }],
      ["mem-active", { id: "mem-active", text: "Projekt Alpha nutzt den Auth-Service zentral", status: "active" }],
    ]);

    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true },
      index,
      memoryById,
    });

    const ids = result.lensMemories.map((m) => m.entry.id);
    assert.ok(!ids.includes("mem-superseded"), "superseded memory must not be surfaced by the lens");
    assert.ok(ids.includes("mem-active"), "active memory should still be surfaced");
  });
});
