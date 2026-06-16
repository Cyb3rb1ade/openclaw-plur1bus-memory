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
  return {
    query() {
      return {
        where(whereClause) {
          const ids = extractWhereIds(whereClause);
          return {
            limit() {
              return {
                async toArray() {
                  return rows.filter(r => ids.size === 0 || ids.has(r.id));
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
    });
    assert.strictEqual(out.length, 0, "irrelevant graph-only memory should be filtered");
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
    });
    assert.strictEqual(out.length, 1, "candidate should be kept on embedding error");
    assert.strictEqual(logger.warnings.length, 1, "warning should be logged");
  });
});
