/**
 * 7.20.8 on main: the time-filter safety net decides over all namespaces,
 * also when runMergedNamespaceRecall pre-merges per embedding identity
 * (main-only multi-identity recall).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runMergedNamespaceRecall } from "../engine/recall/namespace-recall.js";
import { identityId } from "../lib/providers/embedding-identity.js";
import { mergeNamespaceRecallResults, namespaceTemporalFilterHit } from "../lib/recall-pipeline.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const QUERY = "Was hab ich dir gestern über das Auto erzählt?";

const identityA = { provider: "fake", model: "a", revision: "r1", dimension: 2, normalization: "l2", prefixScheme: "query/passage", instruction: "", dtype: "float32" };
const identityB = { ...identityA, model: "b", dimension: 3 };

const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const words = { 1: "auto werkstatt reifen wechsel", 2: "garten blumen erde beet", 3: "urlaub strand sonne meer" };
const row = (n, distance, createdAt) => ({
  id: uuid(n), text: words[n], _distance: distance, createdAt,
  scope: "agent-private", agentId: "agent-a", storedBy: "agent-a",
});
const table = (rows) => ({ vectorSearch: () => ({ where() { return this; }, limit: () => ({ toArray: async () => rows }) }) });

function capturingLogger() {
  const lines = [];
  const push = (msg) => lines.push(String(msg));
  return { lines, logger: { info: push, warn: push, debug: push } };
}

describe("7.20.8 (main): Zeitfilter-Netz über Embedding-Identitäten", () => {
  it("runMergedNamespaceRecall: ein ungefilterter Namensraum einer anderen Identität liefert keine alten Treffer", async () => {
    // runMergedNamespaceRecall nimmt die Systemzeit als now.
    const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const providers = new Map([
      [identityId(identityA), { embedQuery: async () => [1, 0] }],
      [identityId(identityB), { embedQuery: async () => [1, 0, 0] }],
    ]);
    const readDbs = [
      { namespace: "private", sourceKind: "private", db: { identity: identityA, table: table([row(1, 0.2, today - DAY + 10 * HOUR), row(2, 0.1, Date.parse("2026-03-01T10:00:00Z"))]) } },
      { namespace: "shared-user", sourceKind: "user", optional: true, db: { identity: identityB, table: table([row(3, 0.05, Date.parse("2026-02-01T10:00:00Z"))]) } },
    ];
    const run = async (extra = {}) => {
      const { lines, logger } = capturingLogger();
      const merged = await runMergedNamespaceRecall(readDbs, {
        query: QUERY, agentId: "agent-a", embeddings: providers.get(identityId(identityA)), identityProviders: providers,
        topN: 10, budget: 10, canonicalEnabled: false, associativeEnabled: false, dedupEnabled: false,
        logger, adaptiveBudget: { enabled: false }, ...extra,
      }, null, null);
      return { ids: merged.memories.map((m) => m.entry.id), lines };
    };
    const intent = await run();
    assert.deepEqual(intent.ids, [uuid(1)]);
    assert.ok(
      intent.lines.includes("recall-pipeline: temporal filter across namespaces removed 1 results kept unfiltered by their namespace"),
      intent.lines.join("\n"),
    );
    // legacy bleibt 7.20.7: das Netz entscheidet je Namensraum.
    const legacy = await run({ temporalFilterMode: "legacy" });
    assert.deepEqual([...legacy.ids].sort(), [uuid(1), uuid(3)].sort());
  });

  it("mergeNamespaceRecallResults: temporalInWindow ersetzt die Entscheidung aus den übergebenen Namensräumen", () => {
    const window = { kind: "yesterday", from: Date.UTC(2026, 10, 23), to: Date.UTC(2026, 10, 24) };
    const old = { namespace: "shared-user", sourceKind: "user", canonical: [], temporalFilter: { ...window, keptUnfiltered: true },
      memories: [{ entry: { id: uuid(3), text: words[3], createdAt: Date.UTC(2026, 1, 1) }, score: 0.9 }] };
    const filtered = { namespace: "private", sourceKind: "private", canonical: [], temporalFilter: { ...window, keptUnfiltered: false },
      memories: [{ entry: { id: uuid(1), text: words[1], createdAt: window.from + 10 * HOUR }, score: 0.5 }] };
    assert.equal(namespaceTemporalFilterHit([old]), false);
    assert.equal(namespaceTemporalFilterHit([old, filtered]), true);
    // Allein (Vormischung einer Identität) bliebe der alte Treffer stehen.
    assert.deepEqual(mergeNamespaceRecallResults([old], { maxOut: 10 }).memories.map((m) => m.entry.id), [uuid(3)]);
    assert.deepEqual(mergeNamespaceRecallResults([old], { maxOut: 10, temporalInWindow: true }).memories, []);
    // Ohne Treffer im Fenster nirgends bleibt alles stehen, auch mit beiden.
    assert.deepEqual(
      mergeNamespaceRecallResults([old, filtered], { maxOut: 10, temporalInWindow: false }).memories.map((m) => m.entry.id).sort(),
      [uuid(1), uuid(3)].sort(),
    );
  });
});
