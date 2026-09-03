import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readRepoFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Der Boden lag bis 7.5.0 auf 22.5.0 und hielt nicht: `node:sqlite` laeuft
// dort nur mit --experimental-sqlite, und die Auto-Capture-Tests scheitern auf
// 22.5 bis 22.11 an der Semantik des damaligen Testlaeufers (gemessen
// 03.09.26: 22.5.0, 22.6 und 22.9 rot, ab 22.12 gruen). Massgeblich ist der
// Host: OpenClaw 2026.8.2 verlangt `>=22.22.3 <23 || >=24.15.0 <25 ||
// >=25.9.0`, und dieses Plugin laeuft ausschliesslich in OpenClaw.
test("Node.js 22.22.3 is the package, CI, and installation runtime floor", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));
  const packageLock = JSON.parse(readRepoFile("package-lock.json"));
  const workflow = readRepoFile(".github/workflows/ci.yml");
  const readme = readRepoFile("README.md");

  assert.equal(packageJson.engines.node, ">=22.22.3");
  assert.equal(packageLock.packages[""].engines.node, ">=22.22.3");
  assert.match(workflow, /node-version:\s*\['22\.22\.3', 22\]/);
  assert.doesNotMatch(workflow, /20\.9\.0/);
  assert.doesNotMatch(workflow, /22\.5\.0/);
  assert.match(readme, /Node\.js 22\.22 or newer/);
  assert.match(
    readme,
    /node:sqlite.*available throughout the supported Node\.js runtime range/,
  );
});
