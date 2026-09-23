/**
 * tools/capture-golden-prefix.mjs — write the golden-prefix oracle.
 *
 * Runs every scenario twice, each with a fresh plugin.register(), and refuses
 * to write anything unless both runs are byte-identical. Run once, on
 * unmodified main. Never re-run to "fix" a failing golden test.
 *
 * Usage: node tools/capture-golden-prefix.mjs [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "../tests/fixtures/golden-prefix/scenarios.js";
import { runScenario } from "../tests/helpers/golden-prefix-driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "tests", "fixtures", "golden-prefix", "expected");
const force = process.argv.includes("--force");

mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const scenario of SCENARIOS) {
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  if (first !== second) {
    console.error(`NON-DETERMINISTIC: ${scenario.name}`);
    console.error(`  run 1: ${JSON.stringify(first)}`);
    console.error(`  run 2: ${JSON.stringify(second)}`);
    failures += 1;
    continue;
  }
  if (first === null) {
    console.error(`EMPTY: ${scenario.name} produced no prependContext; fix the scenario`);
    failures += 1;
    continue;
  }
  const target = join(outDir, `${scenario.name}.txt`);
  if (existsSync(target) && !force) {
    console.error(`REFUSING to overwrite existing oracle ${target} (pass --force only if you know why)`);
    failures += 1;
    continue;
  }
  writeFileSync(target, first, "utf8");
  console.log(`wrote ${target} (${first.length} chars)`);
}

if (failures > 0) {
  console.error(`${failures} scenario(s) failed; no partial oracle is trustworthy`);
  process.exit(1);
}
console.log(`captured ${SCENARIOS.length} scenarios`);
