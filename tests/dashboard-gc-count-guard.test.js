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
  const complete = (byAgent) => ({ cards: { agentCountsComplete: true, byAgent } });
  for (const cards of [null, undefined, "0", -1, 1.5]) {
    assert.equal(largestKnownAgentCount(complete([{ cards: 10 }, { cards }])), null);
  }
  assert.equal(largestKnownAgentCount(complete([])), null);
  assert.equal(largestKnownAgentCount(complete([{ cards: 0 }, { cards: 10 }])), 10);
});

// Ein Agent, dessen Zaehlung scheiterte, faellt ganz aus byAgent heraus: die
// Liste sieht dann vollstaendig aus. Nur der Scan weiss es besser, also muss er
// buergen — und alles ausser einem ausdruecklichen true gilt als unbekannt,
// damit eine Schicht, die das Merkmal verliert, verweigert statt zu erlauben.
test("an inventory nobody vouches for is unknown, however healthy the rows look", () => {
  const rows = [{ cards: 0 }, { cards: 10 }];
  for (const flag of [undefined, false, null, "true", 1]) {
    assert.equal(largestKnownAgentCount({ cards: { agentCountsComplete: flag, byAgent: rows } }), null);
  }
  assert.equal(largestKnownAgentCount({ cards: { byAgent: rows } }), null, "fehlendes Merkmal verweigert");
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
