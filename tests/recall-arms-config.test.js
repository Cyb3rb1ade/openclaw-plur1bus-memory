/**
 * tests/recall-arms-config.test.js
 *
 * Config contract and production wiring of the retrieval-arm switches:
 * the manifest accepts recall.collectionWidth / candidateHardLimitMax /
 * retrievalArms / eventDateRender, rejects bad values, materialises no
 * defaults, and autoRecallParams passes the switches only when configured.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ConfigContractError, manifestConfigDefaults, validatePluginConfig } from "../lib/setup/config-contract.js";
import { autoRecallParams } from "../engine/recall/recall-params.js";

const FULL = {
  recall: {
    candidateHardLimitMax: 200,
    collectionWidth: { enabled: true, topN: 45, candidateTopK: 200 },
    retrievalArms: { mode: "shadow", entity: true, eventTime: true, fusion: "slots", timeoutMs: 150, armTopK: 30, slots: 30, rrfK: 60, seedExpansion: true },
    eventDateRender: { enabled: true },
  },
};

describe("config contract", () => {
  it("accepts every new key", () => {
    const normalized = validatePluginConfig(structuredClone(FULL));
    assert.deepEqual(normalized.recall, FULL.recall);
  });

  for (const [label, recall] of [
    ["an unknown mode", { retrievalArms: { mode: "maybe" } }],
    ["an unknown fusion", { retrievalArms: { fusion: "max" } }],
    ["an unknown arm key", { retrievalArms: { graph: true } }],
    ["topN 0", { collectionWidth: { topN: 0 } }],
    ["topN above 100", { collectionWidth: { topN: 101 } }],
    ["candidateHardLimitMax 0", { candidateHardLimitMax: 0 }],
    ["a non-boolean eventDateRender.enabled", { eventDateRender: { enabled: "yes" } }],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => validatePluginConfig({ recall }), ConfigContractError);
    });
  }

  it("materialises none of the keys as a default", () => {
    const defaults = manifestConfigDefaults();
    for (const key of ["candidateHardLimitMax", "collectionWidth", "retrievalArms", "eventDateRender"]) {
      assert.equal(Object.hasOwn(defaults.recall ?? {}, key), false, key);
    }
  });
});

function ctx(cfg, extra = {}) {
  return {
    cfg,
    embeddingCleanTextCfg: { enabled: false },
    resolveRuntimeRecallBudget: () => 30,
    rerankerCfg: {},
    host: { logger: {} },
    ...extra,
  };
}

describe("autoRecallParams", () => {
  it("passes no switch without config", () => {
    const params = autoRecallParams(ctx({}), { query: "What activities does Melanie do?", agentId: "main" });
    assert.equal(params.collectionWidth, null);
    assert.equal(params.retrievalArms, null);
    assert.equal(params.enrichmentIndexFor, null);
    assert.equal(params.candidateHardLimitMax, 100);
  });

  it("passes the configured switches, binds the agent and the plugin time zone", () => {
    const calls = [];
    const params = autoRecallParams(ctx({ ...FULL, timezone: "Europe/Berlin" }, { enrichmentIndexFor: (args) => { calls.push(args); return null; } }), { query: "q", agentId: "main" });
    assert.deepEqual(params.collectionWidth, FULL.recall.collectionWidth);
    assert.equal(params.candidateHardLimitMax, 200);
    assert.equal(params.retrievalArms.mode, "shadow");
    assert.equal(params.retrievalArms.timeZone, "Europe/Berlin");
    params.enrichmentIndexFor({ namespace: null, sourceKind: "private" });
    assert.deepEqual(calls, [{ agentId: "main", namespace: null, sourceKind: "private" }]);
  });

  it("mode off passes no arms even with arms switched on", () => {
    const params = autoRecallParams(ctx({ recall: { retrievalArms: { mode: "off", entity: true } } }, { enrichmentIndexFor: () => null }), { query: "q", agentId: "main" });
    assert.equal(params.retrievalArms, null);
    assert.equal(params.enrichmentIndexFor, null);
  });
});
