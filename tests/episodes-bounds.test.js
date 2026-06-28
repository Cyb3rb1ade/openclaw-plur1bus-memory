import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupTurnsIntoEpisodes } from "../lib/episodes.js";

function makeTurns(count) {
  const base = new Date("2026-06-28T12:00:00.000Z").getTime();
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    createdAt: new Date(base + index * 60_000).toISOString(),
    content: `turn content ${index}`,
  }));
}

describe("episodes bounds", () => {
  it("splits long contiguous conversations at the max episode turn limit", () => {
    const groups = groupTurnsIntoEpisodes(makeTurns(55), { maxGapMinutes: 30 });

    assert.deepStrictEqual(groups.map((group) => group.length), [50, 5]);
  });
});
