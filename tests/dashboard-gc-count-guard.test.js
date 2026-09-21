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

test("one unknown agent cannot be hidden by healthy agents or numeric coercion", () => {
  for (const cards of [null, undefined, "0", -1, 1.5]) {
    assert.equal(largestKnownAgentCount({ cards: { byAgent: [{ cards: 10 }, { cards }] } }), null);
  }
  assert.equal(largestKnownAgentCount({ cards: { byAgent: [] } }), null);
  assert.equal(largestKnownAgentCount({ cards: { byAgent: [{ cards: 0 }, { cards: 10 }] } }), 10);
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
