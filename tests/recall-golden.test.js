import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreNeoRecallItem } from "../lib/neo-arch.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/recall-golden.json", import.meta.url)));

describe("recall golden", () => {
  it("keeps committed rank order", () => {
    const scored = golden.items
      .map((item) => ({ id: item.id, score: scoreNeoRecallItem(item, golden.query) }))
      .sort((a, b) => b.score - a.score);
    assert.equal(scored.find((row) => row.id === "demoted").score, Number.NEGATIVE_INFINITY);
    assert.ok(Number.isFinite(scored.find((row) => row.id === "conflict").score));
    assert.deepEqual(scored.map((row) => row.id), golden.expectedOrder);
  });
});
