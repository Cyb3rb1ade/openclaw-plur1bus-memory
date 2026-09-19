import { describe, it } from "node:test";
import assert from "node:assert";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

const makeDbTable = (rows) => ({
  vectorSearch: () => ({ limit: () => ({ toArray: async () => rows.map((r) => ({ scope: "agent-private", agentId: "a", storedBy: "a", ...r })) }) }),
});
const embeddings = { dim: 3, embed: async () => [0.1, 0.2, 0.3], embedQuery: async () => [0.1, 0.2, 0.3] };
const logger = { info: () => {}, warn: () => {} };

describe("recall ignores importance", () => {
  it("ranks two equally similar rows the same regardless of importance", async () => {
    const rows = [
      { id: "low", text: "Kaffee kochen mit der neuen Maschine", _distance: 0.2, importance: 0.1, memoryStrength: 1 },
      { id: "high", text: "Kaffee kochen mit der alten Maschine", _distance: 0.2, importance: 0.94, memoryStrength: 1 },
    ];
    const { memories } = await runRecallPipeline({
      query: "Kaffee", dbTable: makeDbTable(rows), embeddings, agentId: "a",
      topN: 5, canonicalEnabled: false, dedupEnabled: false, importanceBoost: 0.3, logger,
    });
    const scores = Object.fromEntries(memories.map((m) => [m.entry.id, m.score]));
    assert.ok(Math.abs(scores.low - scores.high) < 1e-9, `importance still moves the score: ${JSON.stringify(scores)}`);
  });

  it("still lets strength decide", async () => {
    const rows = [
      { id: "faded", text: "Kaffee kochen mit der neuen Maschine", _distance: 0.2, importance: 0.5, memoryStrength: 0.2 },
      { id: "fresh", text: "Kaffee kochen mit der alten Maschine", _distance: 0.2, importance: 0.5, memoryStrength: 1.0 },
    ];
    const { memories } = await runRecallPipeline({
      query: "Kaffee", dbTable: makeDbTable(rows), embeddings, agentId: "a",
      topN: 5, canonicalEnabled: false, dedupEnabled: false, logger,
    });
    assert.strictEqual(memories[0].entry.id, "fresh");
  });
});
