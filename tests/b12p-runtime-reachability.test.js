import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { manifestConfigDefaults, validatePluginConfig } from "../lib/setup/config-contract.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

function privateRow(id, score = 0.1) {
  return {
    id,
    _distance: score,
    text: `memory ${id}`,
    summary: `memory ${id}`,
    category: "fact",
    status: "active",
    scope: "agent-private",
    agentId: "b12p-agent",
    storedBy: "b12p-agent",
  };
}

function tableWithObservedLimits(rows) {
  const limits = [];
  return {
    limits,
    vectorSearch() {
      return {
        limit(value) {
          limits.push(value);
          return { async toArray() { return rows; } };
        },
      };
    },
    query() {
      return { where() { return { limit() { return { async toArray() { return rows; } }; } }; } };
    },
  };
}

const embeddings = {
  async embed() { return [0.1, 0.2]; },
  async embedQuery() { return [0.1, 0.2]; },
};

describe("B12-P advertised recall runtime contract", () => {
  it("materializes and strictly validates each advertised recall switch", () => {
    const cfg = manifestConfigDefaults();
    assert.equal(cfg.recall.queryRefinement.enabled, false);
    assert.equal(cfg.recall.adaptiveBudget.enabled, false);
    assert.equal(cfg.recall.adaptiveBudget.tokenBudgetPct, 0.3);
    assert.equal(cfg.recall.semanticCompression.enabled, false);
    assert.equal(cfg.continuityEngine.associativeRecall.graphIndex.enabled, true);
    assert.throws(
      () => validatePluginConfig({ recall: { candidateTopK: 101 } }),
      /at most 100/,
    );
  });

  it("uses candidateTopK for the initial ANN fetch without a reranker", async () => {
    const table = tableWithObservedLimits([privateRow("11111111-1111-4111-8111-111111111111")]);
    await runRecallPipeline({
      query: "candidate limit",
      dbTable: table,
      embeddings,
      topN: 2,
      candidateTopK: 17,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      agentId: "b12p-agent",
    });
    assert.deepEqual(table.limits, [17]);
  });
});
