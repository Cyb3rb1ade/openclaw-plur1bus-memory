import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const PACKAGE_ARTIFACT_PATTERN = /(^|\/)(__pycache__|build)(\/|$)|\.py[co]$/;

test("npm package excludes local Python build artifacts and retains Hermes deliverables", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const [{ files, version }] = JSON.parse(execFileSync(
    npm,
    ["pack", "--dry-run", "--json"],
    { encoding: "utf8" },
  ));
  const paths = files.map(({ path }) => path);

  assert.equal(version, "7.2.3");
  assert(paths.includes("plur1bus-hermes/src/plur1bus_hermes/provider.py"));
  assert(paths.includes("plur1bus-controls/src/plur1bus_controls/plugin.py"));
  assert(paths.includes("mtplx-embed/src/mtplx_embed/server.py"));
  assert.equal(paths.some((path) => PACKAGE_ARTIFACT_PATTERN.test(path)), false);
});
