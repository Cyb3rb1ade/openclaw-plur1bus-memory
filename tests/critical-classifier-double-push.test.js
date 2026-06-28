/**
 * tests/critical-classifier-double-push.test.js
 *
 * Regression: runClassifier pushes a card AFTER updateCardType, relying on the
 * card then dropping out of findRecentUnclassified. But if updateCardType throws
 * (caught, no continue) or is unwired, the card stays unclassified yet still
 * gets pushed — and re-pushed on every subsequent run (capped only by maxPerDay).
 * A card that wasn't actually reclassified must NOT be pushed.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClassifier } from "../lib/jobs/critical-classifier.js";

const model = { complete: async () => ({ text: "person" }) }; // → critical type
const card = { id: "c1", content: "Christians Geburtstag ist am 1. Mai", title: "x" };

function makeDb(overrides = {}) {
  return {
    findRecentUnclassified: async () => [card],
    updateCardType: async () => {},
    ...overrides,
  };
}

describe("critical-classifier double-push guard", () => {
  it("does not push when updateCardType throws (card stays unclassified)", async () => {
    let sent = 0;
    const statePath = mkdtempSync(join(tmpdir(), "crit-state-"));
    const db = makeDb({ updateCardType: async () => { throw new Error("not wired"); } });
    const res = await runClassifier(db, "agentA", {
      model, telegramSend: async () => { sent++; }, statePath,
    });
    assert.strictEqual(sent, 0, "must not send a push for an unclassified card");
    assert.strictEqual(res.pushed, 0, "pushed count must be 0");
    assert.strictEqual((res.pushMessages || []).length, 0, "no carrier push messages either");
  });

  it("does not push when updateCardType is unwired", async () => {
    let sent = 0;
    const statePath = mkdtempSync(join(tmpdir(), "crit-state-"));
    const db = makeDb({ updateCardType: undefined });
    const res = await runClassifier(db, "agentB", {
      model, telegramSend: async () => { sent++; }, statePath,
    });
    assert.strictEqual(sent, 0, "must not push when reclassification can't happen");
    assert.strictEqual(res.pushed, 0, "pushed count must be 0");
  });
});
