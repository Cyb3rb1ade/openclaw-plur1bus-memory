import assert from "node:assert/strict";

const targetRoot = process.argv[2];
if (!targetRoot) throw new Error("usage: node proof.mjs <repository-root>");
const { buildEdgesForSession } = await import(`${targetRoot}/lib/memory-graph.js`);
const { hydrateGraphResults } = await import(`${targetRoot}/lib/recall-pipeline.js`);
const { checkAccess } = await import(`${targetRoot}/lib/acl-middleware.js`);

const localId = "11111111-1111-1111-1111-111111111111";
const foreignId = "22222222-2222-2222-2222-222222222222";
const foreignRow = {
  id: foreignId,
  text: "workspace-b secret",
  summary: "workspace-b secret",
  scope: "workspace",
  storedBy: "shared-agent",
  workspaceKey: "workspace-b",
  status: "active",
  importance: 0.5,
};

const graphTable = {
  vectorSearch() {
    return { limit() { return { async toArray() { return [{ id: foreignId, _distance: 0 }]; } }; } };
  },
};
const edges = await buildEdgesForSession([
  { id: localId, vector: [1, 0], createdAt: new Date().toISOString(), sessionId: "a" },
], [], graphTable, null);
assert.ok(edges.some((edge) => edge.source === localId && edge.target === foreignId && edge.type === "semantic"), "unscoped graph search should create foreign edge");

const hydrationTable = {
  query() {
    return {
      where() { return this; },
      limit() { return this; },
      async toArray() { return [foreignRow]; },
    };
  },
};
const hydrated = await hydrateGraphResults(hydrationTable, [{
  source: "graph",
  score: 0.9,
  entry: { id: foreignId },
}], null);
assert.equal(hydrated.length, 1);
assert.equal(hydrated[0].entry.agentId, "", "hydration loses storedBy");
assert.equal(hydrated[0].entry.workspaceId, "", "hydration loses workspaceKey");
assert.equal(checkAccess({ agentId: "shared-agent", workspaceId: "workspace-a" }, hydrated[0].entry).allowed, true, "legacy ACL branch allows the stripped workspace record");
console.log(JSON.stringify({ reproduced: true, edge: edges[0], hydratedEntry: hydrated[0].entry, acl: "allowed-for-workspace-a" }, null, 2));
