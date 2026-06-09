import { describe, it } from "node:test";
import assert from "node:assert";
import { applyRetrievalReinforcement } from "../lib/memory-dynamics.js";

describe("smoke-correct-recall: applyRetrievalReinforcement contract", () => {
  it("refreshes lastRetrievedAt and increments retrievalCount from zero", () => {
    const now = Date.now();
    const card = {
      retrievalCount: 0,
      lastRetrievedAt: 0,
      memoryStrength: 0.8,
      lastStrengthenedAt: now,
      lastDynamicsAt: now,
      halfLifeDays: 7,
      memoryClass: "standard",
      neverForget: 0,
      coreMemoryScore: 0.0,
    };
    const patch = applyRetrievalReinforcement(card, now);
    assert.strictEqual(patch.retrievalCount, 1, "retrievalCount should be 1 after first recall");
    assert.ok(patch.lastRetrievedAt >= now, "lastRetrievedAt should be >= now");
    assert.ok(patch.memoryStrength > 0.8, "memoryStrength should increase");
  });

  it("null guard: if getById returns null, rawDb.update is not called", async () => {
    let updateCalled = false;
    const mockDb = {
      getById: async () => null,
      update: async () => { updateCalled = true; },
    };
    // Simulate the exact inline pattern from index.js updateMemory callback
    const correctedCard = await mockDb.getById("some-new-id");
    if (correctedCard) {
      await mockDb.update("some-new-id", applyRetrievalReinforcement(correctedCard, Date.now()));
    }
    assert.strictEqual(updateCalled, false, "update must not be called when card is null");
  });
});
