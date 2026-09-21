import assert from "node:assert/strict";
import test from "node:test";
import { createSettingMutator, largestKnownAgentCount } from "../lib/dashboard-settings.js";

for (const count of [null, undefined, NaN, Infinity, -1, 0.5]) {
  test(`GC cap cannot be saved when the authoritative count is unavailable: ${String(count)}`, async () => {
    let writes = 0;
    const mutate = createSettingMutator({
      api: { runtime: { config: { mutateConfigFile: async () => { writes += 1; } } } },
      validate: () => {}, maxAgentCards: async () => count,
    });
    await assert.rejects(mutate({ id: "gc.maxMemoryCount", value: "1" }));
    assert.equal(writes, 0);
  });
}

// Der Waechter liest die Zahl, die der Scan nennt, und leitet sie nicht aus
// byAgent ab: Diese Liste folgt dem oeffentlichen Kennungsvertrag und deckt
// sich in beide Richtungen nicht mit dem, was der GC-Job bereinigt.
test("the guard reads the scan's own number, never the published list", () => {
  const byAgent = [{ cards: 10 }, { cards: 99 }];
  assert.equal(largestKnownAgentCount({ cards: { largestAgentCards: 10, byAgent } }), 10);
  assert.equal(largestKnownAgentCount({ cards: { largestAgentCards: 0, byAgent: [] } }), 0, "leerer Bestand ist bekannt, nicht unbekannt");
});

test("an inventory nobody vouches for is unknown, however healthy the rows look", () => {
  const byAgent = [{ cards: 0 }, { cards: 10 }];
  for (const largest of [undefined, null, -1, 1.5, NaN, Infinity, "10"]) {
    assert.equal(largestKnownAgentCount({ cards: { largestAgentCards: largest, byAgent } }), null);
  }
  assert.equal(largestKnownAgentCount({ cards: { byAgent } }), null, "fehlende Zahl verweigert");
  assert.equal(largestKnownAgentCount(null), null);
});

test("a known empty store still permits a positive cap", async () => {
  let writes = 0;
  const mutate = createSettingMutator({
    api: { runtime: { config: { mutateConfigFile: async () => { writes += 1; } } } },
    validate: () => {}, maxAgentCards: async () => 0,
  });
  await mutate({ id: "gc.maxMemoryCount", value: "1" });
  assert.equal(writes, 1);
});
