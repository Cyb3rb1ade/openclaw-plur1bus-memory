import test from "node:test";
import assert from "node:assert/strict";
import { compareRecallSnapshot } from "../lib/recall-comparison.js";

const rows = Array.from({ length: 110 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, text: `different fact ${i}`, summary: `fact ${i}`,
  storedBy: i === 1 ? "foreign" : "a", agentId: i === 1 ? "foreign" : "a", scope: "agent-private", status: "active", _distance: 0.1 + i * 0.001, memoryStrength: 1,
}));

test("native Arrow row wrappers are projected before freezing the comparison snapshot", async () => {
  const nativeRows = rows.slice(0, 3).map((row) => new Proxy(row, {}));
  const reranker = { async rerank(_q, docs) { return docs.map((_, index) => ({ index })); } };
  const results = await compareRecallSnapshot({ query: "q", rows: nativeRows, vector: [1, 0], agentId: "a", reranker });
  assert.ok(results[0].selectedIds.includes(rows[0].id));
  assert.ok(!results[0].selectedIds.includes(rows[1].id));
});

test("comparison uses identical immutable snapshots, bounds 40/50/100, filters ACL before both providers and caps output at 15", async () => {
  const seen = [];
  const reranker = { async rerank(_q, docs) { seen.push(docs); assert.ok(!docs.includes("fact 1")); return docs.map((_, index) => ({ index, relevance_score: 1 - index * 0.001 })); } };
  const jev = async (_q, docs) => { assert.ok(!docs.includes("fact 1")); return { indices: docs.map((_, i) => i) }; };
  const before = structuredClone(rows);
  const results = await compareRecallSnapshot({ query: "q", rows, vector: [1, 0], agentId: "a", reranker, jevFilter: jev, expectedIds: [rows[0].id] });
  assert.deepEqual(seen.map((d) => d.length), [39, 49, 99, 99]);
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.selectedIds.length <= 15 && r.expectedHits === 1));
  assert.deepEqual(rows, before);
});

test("all-irrelevant Jev shortlist stays empty instead of silently refilling from unfiltered candidates", async () => {
  const reranker = { async rerank(_q, docs) { return docs.map((_, index) => ({ index })); } };
  const results = await compareRecallSnapshot({ query: "q", rows: rows.slice(0, 4), vector: [1, 0], agentId: "a", reranker, jevFilter: async () => ({ indices: [] }), expectedIds: [] });
  assert.equal(results[3].selectedIds.length, 0);
});

test("outer pipeline timeouts and malformed provider results are reported as benchmark failures", async () => {
  for (const reranker of [
    { async rerank() { await new Promise((resolve) => setTimeout(resolve, 40)); return [{ index: 0 }]; } },
    { async rerank() { return [{ index: 99999 }]; } },
  ]) {
    const result = await compareRecallSnapshot({ query: "q", rows, vector: [1, 0], agentId: "a", reranker, rerankerTimeoutMs: 5 });
    for (const variant of result.slice(0, 3)) assert.ok(variant.providerError, variant.variant);
  }
});
