import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveLancedbOptimizePlan, summarizeLancedbOptimize } from "../lib/lancedb-optimize.js";

// 7.12.31: naechtliche LanceDB-Kompaktierung.
describe("resolveLancedbOptimizePlan", () => {
  it("defaults to enabled, 24 h of versions and a 10-minute budget", () => {
    const now = Date.parse("2026-09-10T02:00:00Z");
    const plan = resolveLancedbOptimizePlan(undefined, now);
    assert.equal(plan.enabled, true);
    assert.equal(plan.keepVersionsHours, 24);
    assert.equal(plan.cleanupOlderThan.toISOString(), "2026-09-09T02:00:00.000Z");
    assert.equal(plan.timeoutMs, 600_000);
  });

  it("honours the config and clamps nonsense", () => {
    const now = Date.parse("2026-09-10T02:00:00Z");
    assert.equal(resolveLancedbOptimizePlan({ enabled: false }, now).enabled, false);
    const plan = resolveLancedbOptimizePlan({ keepVersionsHours: 6, timeoutMs: 120_000 }, now);
    assert.equal(plan.keepVersionsHours, 6);
    assert.equal(plan.cleanupOlderThan.toISOString(), "2026-09-09T20:00:00.000Z");
    assert.equal(plan.timeoutMs, 120_000);
    const clamped = resolveLancedbOptimizePlan({ keepVersionsHours: 0.1, timeoutMs: 5 }, now);
    assert.equal(clamped.keepVersionsHours, 24);
    assert.equal(clamped.timeoutMs, 600_000);
  });
});

describe("summarizeLancedbOptimize", () => {
  it("flattens LanceDB stats and converts BigInt", () => {
    const summary = summarizeLancedbOptimize(
      { compaction: { fragmentsRemoved: 344n, fragmentsAdded: 4n, filesRemoved: 611n, filesAdded: 4n }, prune: { bytesRemoved: 66252827n, oldVersionsRemoved: 1050n } },
      { totalBytes: 153125665n, fragmentStats: { numFragments: 352n, numSmallFragments: 352n, lengths: { p50: 1n } } },
      { totalBytes: 133514291n, fragmentStats: { numFragments: 12n, numSmallFragments: 12n, lengths: { p50: 268n } } },
    );
    assert.deepEqual(summary, {
      fragmentsRemoved: 344, fragmentsAdded: 4, filesRemoved: 611, oldVersionsRemoved: 1050, bytesRemoved: 66252827,
      before: { fragments: 352, smallFragments: 352, medianRows: 1, bytes: 153125665 },
      after: { fragments: 12, smallFragments: 12, medianRows: 268, bytes: 133514291 },
    });
    assert.doesNotThrow(() => JSON.stringify(summary));
    assert.equal(summarizeLancedbOptimize({}, null, null).before, null);
  });
});
