/**
 * tests/recall-arms-golden.test.js
 *
 * With every retrieval-arm switch absent or off, runRecallPipeline and
 * formatRelevantMemoriesContext produce exactly what they produced before
 * the switches existed. The fixture was recorded from a copy of the tree at
 * v7.21.6 (tests/helpers/arms-golden-scenarios.js documents how); shadow mode
 * keeps the memories of the off path and only adds the `arms` report.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import { createEnrichmentIndex } from "../lib/enrichment/sidecar.js";
import { enrichmentContentHash } from "../lib/enrichment/enrich-llm.js";
import {
  GOLDEN_NOW,
  goldenEmbeddings,
  goldenRows,
  goldenTable,
  pipelineScenarios,
  runArmsGoldenScenarios,
  unitVector,
} from "./helpers/arms-golden-scenarios.js";

const expected = JSON.parse(readFileSync(new URL("./fixtures/arms-golden/expected.json", import.meta.url), "utf8"));

function throwingIndex() {
  throw new Error("the sidecar must not be read while the arms are off");
}

/** Index over the golden rows: every row about its speaker, hobby/art facets, events on the support-group rows. */
function goldenIndex() {
  const index = createEnrichmentIndex();
  for (const row of goldenRows()) {
    const speaker = /\] (\w+):/.exec(row.text)[1].toLowerCase();
    const n = Number(row.id.slice(1));
    const axis = n % 4;
    index.offer({
      id: row.id,
      contentHash: enrichmentContentHash(row.text),
      enrichedAt: 1,
      enrichVersion: 1,
      entities: axis === 2 ? ["oscar"] : axis === 3 ? ["support group"] : [],
      about: [speaker],
      facets: axis === 0 ? ["sport", "family"] : axis === 1 ? ["art"] : axis === 2 ? ["pets"] : ["identity"],
      event: axis === 3 ? { from: "2026-11-06", until: "2026-11-06", fromMs: Date.UTC(2026, 10, 6), untilMs: Date.UTC(2026, 10, 7), precision: "day", kind: "past", phrase: "on Friday", source: "relative" } : null,
      dateCheck: axis === 3 ? "agree" : "none",
    });
  }
  return index;
}

describe("retrieval-arm switches off: byte-identical to v7.21.6", () => {
  it("switches absent reproduce the recorded pipeline and render output", async () => {
    const actual = await runArmsGoldenScenarios({ runRecallPipeline, formatRelevantMemoriesContext });
    assert.equal(JSON.stringify(actual, null, 2), JSON.stringify(expected, null, 2));
  });

  it("switches explicitly off reproduce it too (and never read the sidecar)", async () => {
    const extra = {
      collectionWidth: { enabled: false, topN: 45, candidateTopK: 200 },
      candidateHardLimitMax: 100,
      retrievalArms: { mode: "off", entity: true, eventTime: true, fusion: "slots" },
      enrichmentIndex: throwingIndex,
    };
    const actual = await runArmsGoldenScenarios({
      runRecallPipeline,
      formatRelevantMemoriesContext,
      extra,
      renderOptions: { eventDateRender: { enabled: false, timeZone: "UTC" } },
    });
    assert.equal(JSON.stringify(actual, null, 2), JSON.stringify(expected, null, 2));
  });

  it("a mode without any arm switched on is off as well", async () => {
    const actual = await runArmsGoldenScenarios({
      runRecallPipeline,
      formatRelevantMemoriesContext,
      extra: { retrievalArms: { mode: "on" }, enrichmentIndex: throwingIndex },
    });
    assert.equal(JSON.stringify(actual, null, 2), JSON.stringify(expected, null, 2));
  });
});

describe("retrieval arms in shadow mode", () => {
  it("leave the memories of every scenario unchanged and only add the arms report", async () => {
    const index = goldenIndex();
    const shadow = { retrievalArms: { mode: "shadow", entity: true, eventTime: true, timeoutMs: 2_000 }, enrichmentIndex: () => ({ index, complete: true }) };
    for (const scenario of pipelineScenarios(shadow)) {
      if (scenario.slowEmbed) continue; // keyword fallback: no vector, the arms are never fused
      const result = await runRecallPipeline({
        ...scenario.params,
        dbTable: goldenTable(goldenRows()),
        embeddings: goldenEmbeddings({
          activities: unitVector([1, 0.3, 0, 0, 0.1]),
          painted: unitVector([0, 1, 0.2, 0, 0]),
          dog: unitVector([0, 0, 1, 0.1, 0]),
          yesterday: unitVector([0.5, 0.5, 0.2, 0.2, 0]),
          When: unitVector([0, 0.1, 0.2, 1, 0]),
        }),
      });
      const recorded = expected[scenario.name];
      assert.equal(JSON.stringify(result.memories), JSON.stringify(recorded.memories), scenario.name);
      assert.equal(result.arms.mode, "shadow", scenario.name);
      assert.equal(typeof result.arms.ms, "number");
    }
  });

  it("report what the arms would add for a collection question", async () => {
    const index = goldenIndex();
    const params = {
      ...pipelineScenarios()[3].params, // collection-query-capped
      topN: 4,
      budget: 4,
      candidateTopK: 4,
      rerankCandidates: 4,
      dbTable: goldenTable(goldenRows()),
      // The vector points at Caroline's painting rows; the arm finds Melanie's sport rows.
      embeddings: goldenEmbeddings({ activities: unitVector([0.2, 1, 0, 0, 0]) }),
      now: GOLDEN_NOW,
    };
    const off = await runRecallPipeline(params);
    const result = await runRecallPipeline({
      ...params,
      dbTable: goldenTable(goldenRows()),
      retrievalArms: { mode: "shadow", entity: true, timeoutMs: 2_000 },
      enrichmentIndex: () => ({ index, complete: true }),
    });
    assert.deepEqual(result.arms.entity.facets, ["hobby", "sport", "art"]);
    assert.equal(result.arms.added.length, 2, "RRF over 4 slots: two vector rows, two arm rows");
    assert.equal(result.arms.displaced.length, 2);
    assert.ok(result.arms.added.every((id) => Number(id.slice(1)) % 4 === 0), "added rows are Melanie's sport rows");
    assert.equal(JSON.stringify(result.memories), JSON.stringify(off.memories), "shadow adds nothing to the memories");
  });
});
