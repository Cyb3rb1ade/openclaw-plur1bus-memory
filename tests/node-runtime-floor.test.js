import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readRepoFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Node.js 22.5 is the package, CI, and installation runtime floor", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));
  const packageLock = JSON.parse(readRepoFile("package-lock.json"));
  const workflow = readRepoFile(".github/workflows/ci.yml");
  const readme = readRepoFile("README.md");

  assert.equal(packageJson.engines.node, ">=22.5.0");
  assert.equal(packageLock.packages[""].engines.node, ">=22.5.0");
  assert.match(workflow, /node-version:\s*\['22\.5\.0', 22\]/);
  assert.doesNotMatch(workflow, /20\.9\.0/);
  assert.match(readme, /Node\.js 22\.5 or newer/);
  assert.match(
    readme,
    /node:sqlite.*available throughout the supported Node\.js runtime range/,
  );
});
