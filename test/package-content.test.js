import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const PACKAGE_ARTIFACT_PATTERN =
  /(^|\/)(build|dist|__pycache__|[^/]+\.egg-info)(\/|$)|\.py[co]$/;

const REQUIRED_HERMES_PATHS = [
  "plur1bus-hermes/src/plur1bus_hermes/provider.py",
  "plur1bus-controls/src/plur1bus_controls/plugin.py",
  "mtplx-embed/src/mtplx_embed/server.py",
  "scripts/install-hermes-plugins.sh",
  "scripts/install-mtplx-embed.sh",
  "scripts/lib/hermes-home.sh",
];

test("npm package excludes local Python build artifacts and retains Hermes deliverables", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const [{ files, version }] = JSON.parse(execFileSync(
    npm,
    ["pack", "--dry-run", "--json"],
    { encoding: "utf8" },
  ));
  const paths = files.map(({ path }) => path);

  assert.equal(version, "7.2.3");
  for (const path of REQUIRED_HERMES_PATHS) {
    assert(paths.includes(path), `expected npm package to include ${path}`);
  }
  const generatedArtifacts = paths.filter((path) => PACKAGE_ARTIFACT_PATTERN.test(path));
  assert.deepEqual(generatedArtifacts, []);
});
