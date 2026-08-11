import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const [{ files, version }] = JSON.parse(execFileSync(
    npm,
    ["pack", "--dry-run", "--json"],
    { encoding: "utf8" },
  ));
  const paths = files.map(({ path }) => path);

  assert.equal(version, "7.2.6-hermes.1");
  assert.deepEqual(packageJson.publishConfig, {
    registry: "https://npm.pkg.github.com",
    tag: "hermes",
  });
  for (const path of REQUIRED_HERMES_PATHS) {
    assert(paths.includes(path), `expected npm package to include ${path}`);
  }
  const generatedArtifacts = paths.filter((path) => PACKAGE_ARTIFACT_PATTERN.test(path));
  assert.deepEqual(generatedArtifacts, []);
});

test("Hermes release instructions use future coordinates and the selected Python", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /will create the immutable `hermes-v0\.3\.0` tag/);
  assert.match(readme, /will publish `7\.2\.6-hermes\.1` to GitHub Packages/);
  assert.match(readme, /export HERMES_PYTHON="\$\{HERMES_PYTHON:-python3\}"/);
  assert.equal(
    (readme.match(/"\$HERMES_PYTHON" -m pip install/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(readme, /Hermes 0\.3\.0 is released/);
  assert.doesNotMatch(readme, /7\.2\.6-hermes\.1` is published/);
});
