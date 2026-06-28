/**
 * tests/crr-status-filter.test.js
 *
 * Regression: Conversation-Reactivation-Recall had no status filter, so a
 * superseded/tombstoned memory reachable via the semantic-lens index could
 * resurface in the <memory-reactivation> block as current evidence. The main
 * recall pipeline filters status==="active"; reactivation must not resurface
 * explicitly-inactive memories.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { selectReactivationMemories } from "../lib/conversation-reactivation-recall.js";

describe("CRR status filter", () => {
  it("does not reactivate a superseded memory from the semantic lens", async () => {
    const semanticLens = {
      communities: [
        { id: "c1", representativeMemoryIds: ["mem-superseded", "mem-active"] },
      ],
      memories: [
        { id: "mem-superseded", text: "Projekt Alpha nutzt den Auth-Service", status: "superseded" },
        { id: "mem-active", text: "Projekt Alpha nutzt den Auth-Service", status: "active" },
      ],
    };

    const { memories } = await selectReactivationMemories({
      prompt: "Projekt Alpha Auth-Service Status",
      baseRecallIds: new Set(),
      semanticLens,
      graphEdges: [],
      cfg: { maxReactivationMemories: 10, maxCommunities: 5 },
      getMemoryById: async () => null,
      decisionTrace: null,
    });

    const ids = memories.map((m) => m.id);
    assert.ok(!ids.includes("mem-superseded"), "superseded memory must not be reactivated");
    assert.ok(ids.includes("mem-active"), "active memory should still be reactivated");
  });
});
