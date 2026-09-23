/**
 * tests/golden-prefix.test.js
 *
 * The behaviour-neutrality gate for the engine extraction: every scenario's
 * prependContext must stay byte-identical to the oracle captured on main
 * @ 89148f9. If this fails, the refactor changed what the model sees.
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

  it("covers at least five scenarios", () => {
    assert.ok(SCENARIOS.length >= 5, `expected >= 5 scenarios, found ${SCENARIOS.length}`);
  });
});
