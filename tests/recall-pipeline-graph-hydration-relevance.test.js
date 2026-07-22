// tests/recall-pipeline-graph-hydration-relevance.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hydrateGraphResults } from "../lib/recall-pipeline.js";

/**
 * Extracts the IDs targeted by a LanceDB-style where clause.
 */
function extractWhereIds(whereClause) {
  if (typeof whereClause !== "string") return new Set();
  const normalized = whereClause.trim();
  const inMatch = normalized.match(/^id\s+IN\s*\((.+)\)$/i);
  if (inMatch) {
    return new Set(inMatch[1].match(/'([^']*)'/g)?.map(s => s.slice(1, -1)) ?? []);
  }
  const eqMatch = normalized.match(/^id\s*=\s*'([^']*)'$/i);
  if (eqMatch) return new Set([eqMatch[1]]);
  return new Set();
}

function mockTable(rows = []) {
  const authorizedRows = rows.map((row) => ({
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
    ...row,
  }));
  return {
    query() {
      return {
        where(whereClause) {
          const ids = extractWhereIds(whereClause);
          return {
            limit() {
              return {
                async toArray() {
                  return authorizedRows.filter(r => ids.size === 0 || ids.has(r.id));
                },
              };
            },
          };
        },
      };
    },
  };
}

function makeEmbeddings(vectorsByText) {
  return {
    dim: 4,
    embed: async (text) => vectorsByText[text] ?? [0, 0, 0, 0],
    embedQuery: async (text) => vectorsByText[text] ?? [0, 0, 0, 0],
  };
}

function makeLogger() {
  const warnings = [];
  return {
    warn(msg) { warnings.push(msg); },
    info() {},
    get warnings() { return warnings; },
  };
}

describe("hydrateGraphResults query-relevance revalidation", () => {
  const queryVector = [1, 0, 0, 0];
  const irrelevantVector = [0, 1, 0, 0];
  const ownerPrincipal = `user:v1:${"a".repeat(64)}`;
  const aclCtx = Object.freeze({
    agentId: "agent-a",
    workspaceId: "workspace:v1:ws-a",
    workspaceIdentity: "workspace:v1:ws-a",
    userPrincipal: ownerPrincipal,
    workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
  });
  const embeddingContext = Object.freeze({ agentId: "agent-a" });

  it("filters graph-only memory whose hydrated text is semantically irrelevant to the query", async () => {
    const rows = [
      { id: "m-far", text: "irrelevant weather memory", summary: "", status: "active" },
    ];
    const embeddings = makeEmbeddings({
      "irrelevant weather memory": irrelevantVector,
    });
    const results = [
      { entry: { id: "m-far" }, score: 0.5, source: "graph", depth: 1 },
    ];
    const out = await hydrateGraphResults(mockTable(rows), results, console, {
      queryVector,
      embeddings,
      graphConfig: { graphHydrationRelevanceThreshold: 0.25 },
      aclCtx,
      embeddingContext,
    });
    assert.strictEqual(out.length, 0, "irrelevant graph-only memory should be filtered");
  });

  it("preserves this for class embedding providers while filtering an irrelevant graph row", async () => {
    class ClassEmbeddingProvider {
      constructor() {
        this.irrelevantVector = irrelevantVector;
        this.calls = [];
      }

      async embed(text, context) {
        this.calls.push([text, context]);
        return this.irrelevantVector;
      }
    }

    const provider = new ClassEmbeddingProvider();
    const rows = [{
      id: "class-provider-row",
      text: "irrelevant class provider memory",
      summary: "",
      status: "active",
    }];
    const results = [{
      entry: { id: "class-provider-row" },
      score: 0.5,
      source: "graph",
      depth: 1,
    }];

    const out = await hydrateGraphResults(mockTable(rows), results, console, {
      queryVector,
      embeddings: provider,
      graphConfig: { graphHydrationRelevanceThreshold: 0.25 },
      aclCtx,
      embeddingContext,
    });

    assert.deepEqual(out, []);
    assert.deepEqual(provider.calls, [["irrelevant class provider memory", embeddingContext]]);
  });

  it("keeps graph-only memory whose hydrated text is semantically relevant to the query", async () => {
    const rows = [
      { id: "m-close", text: "relevant postgres memory", summary: "", status: "active" },
    ];
    const embeddings = makeEmbeddings({
      "relevant postgres memory": queryVector,
    });
    const results = [
      { entry: { id: "m-close" }, score: 0.5, source: "graph", depth: 1 },
    ];
    const out = await hydrateGraphResults(mockTable(rows), results, console, {
      queryVector,
      embeddings,
      graphConfig: { graphHydrationRelevanceThreshold: 0.25 },
      aclCtx,
      embeddingContext,
    });
    assert.strictEqual(out.length, 1, "relevant graph-only memory should stay");
    assert.strictEqual(out[0].entry.id, "m-close");
  });

  it("does not crash when embedding fails and keeps the candidate", async () => {
    const rows = [
      { id: "m-error", text: "some memory", summary: "", status: "active" },
    ];
    const embeddings = {
      dim: 4,
      embed: async () => { throw new Error("embedding service down"); },
      embedQuery: async () => { throw new Error("embedding service down"); },
    };
    const logger = makeLogger();
    const results = [
      { entry: { id: "m-error" }, score: 0.5, source: "graph", depth: 1 },
    ];
    const out = await hydrateGraphResults(mockTable(rows), results, logger, {
      queryVector,
      embeddings,
      graphConfig: { graphHydrationRelevanceThreshold: 0.25 },
      aclCtx,
      embeddingContext,
    });
    assert.strictEqual(out.length, 1, "candidate should be kept on embedding error");
    assert.strictEqual(logger.warnings.length, 1, "warning should be logged");
  });

  it("fails closed before graph relevance embedding when ACL context is absent", async () => {
    const embedded = [];
    const rows = [{
      id: "missing-context",
      text: "foreign graph secret",
      summary: "",
      status: "active",
      scope: "workspace",
      workspaceId: "workspace:v1:ws-b",
      workspaceKey: "workspace:v1:ws-b",
    }];
    const results = [{ entry: { id: "missing-context" }, score: 0.5, source: "graph", depth: 1 }];

    const out = await hydrateGraphResults(mockTable(rows), results, console, {
      queryVector,
      embeddings: {
        async embed(text, context) {
          embedded.push([text, context]);
          return queryVector;
        },
      },
      embeddingContext,
    });

    assert.deepEqual(out, []);
    assert.deepEqual(embedded, []);
  });

  it("drops a foreign graph row before relevance embedding", async () => {
    const embedded = [];
    const rows = [{
      id: "foreign",
      text: "workspace-b secret",
      summary: "",
      status: "active",
      scope: "workspace",
      workspaceId: "workspace:v1:ws-b",
      workspaceKey: "workspace:v1:ws-b",
    }];
    const results = [{ entry: { id: "foreign" }, score: 0.5, source: "graph", depth: 1 }];

    const out = await hydrateGraphResults(mockTable(rows), results, console, {
      queryVector,
      embeddings: {
        async embed(text, context) {
          embedded.push([text, context]);
          return queryVector;
        },
      },
      aclCtx,
      embeddingContext,
    });

    assert.deepEqual(out, []);
    assert.deepEqual(embedded, []);
  });

  it("hydrates an allowed neighbor and passes immutable agent context to relevance embedding", async () => {
    const embedded = [];
    const rows = [{
      id: "allowed",
      text: "allowed neighbor",
      summary: "",
      status: "active",
      scope: "user",
      ownerUserId: ownerPrincipal,
    }];
    const results = [{ entry: { id: "allowed" }, score: 0.5, source: "graph", depth: 1 }];

    const out = await hydrateGraphResults(mockTable(rows), results, console, {
      queryVector,
      embeddings: {
        async embed(text, context) {
          embedded.push([text, context]);
          return queryVector;
        },
      },
      aclCtx,
      embeddingContext,
    });

    assert.deepEqual(out.map((item) => item.entry.id), ["allowed"]);
    assert.deepEqual(embedded, [["allowed neighbor", { agentId: "agent-a" }]]);
    assert.ok(Object.isFrozen(embedded[0][1]), "graph embedding context must be immutable");
  });
});
