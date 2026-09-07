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

describe("critical-classifier tombstone guard", () => {
  // Live 05.09.2026: zwei per memory_forget getombstonte Karten (status
  // "deleted") blieben unklassifiziert, wurden klassifiziert und als Critical
  // gepusht; der Review-Pfad (status = 'active') kannte die Referenzen nicht.
  it("neither classifies nor pushes a card with status deleted", async () => {
    let sent = 0;
    let typed = 0;
    const statePath = mkdtempSync(join(tmpdir(), "crit-state-"));
    const db = makeDb({
      findRecentUnclassified: async () => [
        { ...card, id: "dead1", status: "deleted" },
        { ...card, id: "arch1", status: "archived" },
        { ...card, id: "live1", status: "active" },
        { ...card, id: "bare1" },
      ],
      updateCardType: async () => { typed++; },
    });
    const res = await runClassifier(db, "agentC", {
      model, telegramSend: async () => { sent++; }, statePath,
    });
    assert.strictEqual(typed, 2, "only the active and the status-less card may be reclassified");
    assert.strictEqual(res.processed, 2, "tombstones do not count as processed");
    assert.strictEqual(res.skippedInactive, 2, "both inactive cards are reported as skipped");
    assert.strictEqual(sent, 2, "only living cards are pushed");
    assert.deepStrictEqual(
      (res.pushMessages || []).map((m) => m.id).sort(),
      ["bare1", "live1"],
      "the push carries no tombstone reference",
    );
  });
});

describe("critical-classifier hideTypes", () => {
  const healthModel = { complete: async () => ({ text: "gesundheit" }) };
  // A user statement: the provenance gate keeps assistant-only hits out of the push.
  const healthCard = { id: "h1", content: "Die OP ist zwei Wochen her, Liegen ist noch blöd", title: "x", sourceMessageRole: "user" };

  it("shows the health preview by default and hides it when hideTypes says so", async () => {
    for (const [hideTypes, expectPreview] of [[undefined, true], [["gesundheit"], false]]) {
      const statePath = mkdtempSync(join(tmpdir(), "crit-state-"));
      const db = makeDb({ findRecentUnclassified: async () => [healthCard] });
      const res = await runClassifier(db, "agentH", { model: healthModel, statePath, hideTypes });
      assert.strictEqual(res.pushed, 1);
      const text = res.pushMessages[0].text;
      if (expectPreview) assert.match(text, /zwei Wochen her/);
      else { assert.doesNotMatch(text, /zwei Wochen/); assert.match(text, /ausgeblendet/); }
    }
  });
});
