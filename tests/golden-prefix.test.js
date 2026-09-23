/**
 * tests/golden-prefix.test.js
 *
 * The behaviour-neutrality gate for the engine extraction: every scenario's
 * prependContext must stay byte-identical to the oracle captured on main
 * @ 89148f9. If this fails, the refactor changed what the model sees.
 *
 * F4 concurrency investigation (fix/recall-inject-budget, 2026-09-23):
 * `npm test` already pins `--test-concurrency=1` for the whole suite, over a
 * concern recorded during the M1a review as "LanceDB tie-break makes the
 * golden suite depend on --test-concurrency=1". Running just this file with
 * `--test-concurrency=4`, three times, produced 0 failures — because none of
 * the `it()`s below (or in any other *.test.js file) declare
 * `{ concurrency: true }`, Node's test runner still executes a describe's
 * subtests sequentially regardless of `--test-concurrency` (that flag governs
 * how many top-level test *files* run at once, not subtests within one); a
 * timed run at concurrency 1 vs. 4 took the same ~2s either way, confirming
 * no parallelism actually occurred here.
 *
 * The recorded concern is real, but it is not an equal-score ranking-order
 * bug: `compareRecallCandidate` (lib/recall-pipeline.js) already breaks ties
 * on a deterministic `ordinal`, and the plain `.sort((a,b) => b.score -
 * a.score)` call sites rely on `Array.prototype.sort`'s ES2019 stability
 * over an otherwise-deterministic input order — so no ranking secondary key
 * was missing, and none was added here.
 *
 * Driving `runScenario` (tests/helpers/golden-prefix-driver.js) truly
 * concurrently instead — via `Promise.all` over several scenarios, bypassing
 * node:test's own sequential-subtest scheduling — DOES reproduce corruption
 * (observed: `recall-canonical-flagged`'s canonical KNOWLEDGE.md record
 * silently missing from the output). The cause is the driver's shared
 * *process*-global mutable state, restored per scenario in a try/finally:
 * `globalThis.Date` (freezeClock), `LocalTransformersEmbeddingProvider
 * .prototype._embedBatchForPurpose`/`_computeBatch` (stubEmbedder), and
 * `process.env.OPENCLAW_HOME`. Two scenarios racing means one's teardown
 * (restoreEmbedder/restoreClock, or restoring OPENCLAW_HOME) can run while
 * another is still mid-flight and depending on its own patched values —
 * this is a test-harness hazard in how these globals are shared, not a
 * production ranking non-determinism. Since it reproduces only by bypassing
 * node:test's own scheduling (not through any `--test-concurrency` value
 * this suite's `it()`s actually observe), and since the root cause is
 * unrelated to ranking ties, no code change was made for it; `npm test`
 * keeping `--test-concurrency=1` (and no describe here ever opting into
 * `{ concurrency: true }`) remains the correct guard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const expectedDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-prefix", "expected");

describe("golden prefix corpus", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} produces the recorded prependContext byte for byte`, async () => {
      const expected = readFileSync(join(expectedDir, `${scenario.name}.txt`), "utf8");
      const actual = await runScenario(scenario);
      assert.equal(typeof actual, "string", `${scenario.name} returned no prependContext`);
      assert.equal(actual, expected);
    });
  }

  it("is deterministic across two fresh registrations", async () => {
    const scenario = SCENARIOS[0];
    const first = await runScenario(scenario);
    const second = await runScenario(scenario);
    assert.equal(first, second);
  });

  it("covers at least seven scenarios", () => {
    assert.ok(SCENARIOS.length >= 7, `expected >= 7 scenarios, found ${SCENARIOS.length}`);
  });
});
