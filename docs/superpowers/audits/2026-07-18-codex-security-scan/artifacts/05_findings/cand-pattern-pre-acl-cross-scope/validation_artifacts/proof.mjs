import assert from "node:assert/strict";

const targetRoot = process.argv[2];
if (!targetRoot) throw new Error("usage: node proof.mjs <repository-root>");
const { runRecallPipeline } = await import(`${targetRoot}/lib/recall-pipeline.js`);

const foreign = {
  id: "33333333-3333-3333-3333-333333333333",
  text: "workspace-b secret",
  summary: "cross-scope confidential summary",
  scope: "workspace",
  storedBy: "shared-agent",
  workspaceKey: "workspace-b",
  importance: 0.5,
  status: "active",
  _distance: 0,
};
const local = {
  id: "44444444-4444-4444-4444-444444444444",
  text: "workspace-a ordinary memory",
  summary: "workspace-a ordinary memory",
  scope: "workspace",
  storedBy: "shared-agent",
  workspaceKey: "workspace-a",
  importance: 0.5,
  status: "active",
  _distance: 0.01,
};
const table = {
  vectorSearch() {
    return { limit() { return { async toArray() { return [foreign, local]; } }; } };
  },
  query() {
    return { where() { return this; }, limit() { return this; }, async toArray() { return []; } };
  },
};
const sent = [];
const result = await runRecallPipeline({
  query: "secret",
  dbTable: table,
  embeddings: { async embed() { return [1, 0]; } },
  topN: 2,
  budget: 2,
  canonicalEnabled: false,
  dedupEnabled: false,
  associativeEnabled: false,
  agentId: "shared-agent",
  workspaceId: "workspace-a",
  reranker: {
    async rerank(_query, docs) {
      sent.push(...docs);
      return [{ index: 0, relevanceScore: 1 }, { index: 1, relevanceScore: 0.9 }];
    },
  },
  logger: { info() {}, warn() {} },
});
assert.ok(sent.includes(foreign.summary), "reranker receives protected summary before ACL");
assert.deepEqual(result.memories.map((item) => item.entry.id), [local.id], "late ACL removes only the foreign row after reranking");
console.log(JSON.stringify({ reproduced: true, sent, finalMemoryIds: result.memories.map((item) => item.entry.id) }, null, 2));
