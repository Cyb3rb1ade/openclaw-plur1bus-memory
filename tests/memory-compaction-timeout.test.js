import { describe, it } from "node:test";
import assert from "node:assert";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";

describe("memory-compaction timeout", () => {
  it("returns timeout reason when loadCompactionCandidates hangs", async () => {
    const db = {
      table: {
        query: () => ({
          limit: () => ({
            toArray: () => new Promise(() => {}), // never resolves
          }),
        }),
      },
    };

    const result = await runMemoryCompaction(db, {
      policy: { maxMemoryCount: 100 },
      timeoutMs: 50,
    });

    assert.strictEqual(result.note, "timeout");
    assert.strictEqual(result.timeoutMs, 50);
    assert.strictEqual(result.compacted, 0);
  });

  it("completes normally with fast empty table", async () => {
    const db = {
      table: {
        query: () => ({
          limit: () => ({
            toArray: async () => [],
          }),
        }),
      },
    };

    const result = await runMemoryCompaction(db, {
      timeoutMs: 1000,
    });

    assert.strictEqual(result.note, "too_few_candidates");
    assert.strictEqual(result.compacted, 0);
  });
});
