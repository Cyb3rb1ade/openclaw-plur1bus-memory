// tests/recall-pipeline-associative-toggle.test.js
// K1-02: Assoziativer Recall ist Opt-in (continuityEngine.enabled && assocCfg.enabled).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecallPipeline, computeUseAssociative } from "../lib/recall-pipeline.js";

const VECTOR_DIM = 4;

function makeVector() {
  return Array(VECTOR_DIM).fill(0.1);
}

function mockTable(vectorRows = [], queryRows = null) {
  const lookupRows = queryRows ?? vectorRows;
  function matchRows(whereClause) {
    if (typeof whereClause !== "string") return lookupRows;
    const eqMatch = whereClause.match(/^id\s*=\s*['"]([^'"]+)['"]$/i);
    if (eqMatch) return lookupRows.filter(r => r.id === eqMatch[1]);
    const inMatch = whereClause.match(/^id\s+IN\s*\((.+)\)$/i);
    if (inMatch) {
      const ids = new Set(inMatch[1].match(/'([^']*)'/g)?.map(s => s.slice(1, -1)) ?? []);
      return lookupRows.filter(r => ids.has(r.id));
    }
    return lookupRows;
  }
  return {
    vectorSearch() {
      return {
        limit() {
          return { async toArray() { return vectorRows; } };
        },
      };
    },
    query() {
      return {
        where(whereClause) {
          return {
            limit() {
              return { async toArray() { return matchRows(whereClause); } };
            },
          };
        },
      };
    },
  };
}

const embeddings = {
  dim: VECTOR_DIM,
  async embed() { return makeVector(); },
  async embedQuery() { return makeVector(); },
};

describe("recall-pipeline associative toggle (K1-02)", () => {
  const seedRow = {
    id: "seed-1",
    text: "Seed memory about project alpha",
    summary: "seed",
    category: "fact",
    origin: "dm",
    status: "active",
    importance: 0.5,
    memoryStrength: 1.0,
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
  };
  const assocRow = {
    id: "assoc-1",
    text: "Associated memory about project beta",
    summary: "assoc",
    category: "fact",
    origin: "dm",
    status: "active",
    importance: 0.5,
    memoryStrength: 1.0,
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
  };
  const graphEdges = [{
    source: "seed-1",
    target: "assoc-1",
    type: "semantic",
    strength: 0.9,
    directed: false,
  }];
  const baseOpts = {
    query: "project alpha",
    dbTable: mockTable([seedRow], [seedRow, assocRow]),
    embeddings,
    workspaceDir: null,
    topN: 5,
    recallMinScore: 0.1,
    importanceBoost: 0,
    canonicalEnabled: false,
    graphEdges,
    agentId: "agent-a",
  };

  it("continuity off -> no graph traversal", async () => {
    const associativeEnabled = computeUseAssociative(false, { enabled: true });
    const { memories } = await runRecallPipeline({ ...baseOpts, associativeEnabled });
    assert.ok(
      !memories.some(r => r.entry.id === "assoc-1"),
      "graph must not be traversed when continuity engine is disabled"
    );
  });

  it("continuity on + assoc off -> no graph traversal", async () => {
    const associativeEnabled = computeUseAssociative(true, { enabled: false });
    const { memories } = await runRecallPipeline({ ...baseOpts, associativeEnabled });
    assert.ok(
      !memories.some(r => r.entry.id === "assoc-1"),
      "graph must not be traversed when associative recall is disabled"
    );
  });

  it("continuity on + assoc on -> graph traversal allowed", async () => {
    const associativeEnabled = computeUseAssociative(true, { enabled: true });
    const { memories } = await runRecallPipeline({ ...baseOpts, associativeEnabled });
    assert.ok(
      memories.some(r => r.entry.id === "assoc-1"),
      "graph must be traversed when both continuity and associative recall are enabled"
    );
  });
});
