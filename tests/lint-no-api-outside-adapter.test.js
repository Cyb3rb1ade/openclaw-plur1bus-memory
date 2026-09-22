/**
 * tests/lint-no-api-outside-adapter.test.js — PR-02d.
 *
 * The boundary rule is only worth having if it fails on a real violation, so
 * the test plants one and checks the linter's report.
 *
 * Every fixture lives in a tmpdir and the linter is pointed at it with its
 * optional root argument. Writing probe modules into the real `engine/` and
 * `adapter/` would mean a crashed test run leaves behind a module that then
 * fails `npm run lint` for everyone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers/temp-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "lint-no-api-outside-adapter.mjs");

/**
 * @param {string} target Root the linter should scan.
 * @returns {{status: number, out: string}} Exit status and combined output.
 */
function run(target) {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script, target], { cwd: root, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * Materialise a throwaway tree. Cleanup is handled by makeTempDir's own
 * process-exit hook.
 * @param {Record<string, string>} files Root-relative path → source.
 * @returns {string} The tmpdir root.
 */
function fixture(files) {
  const base = makeTempDir("lint-no-api-");
  for (const [relativePath, source] of Object.entries(files)) {
    const full = join(base, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return base;
}

describe("lint-no-api-outside-adapter", () => {
  it("passes on the current tree", () => {
    const result = run(root);
    assert.equal(result.status, 0, result.out);
  });

  it("fails on an api. reference under engine/", () => {
    const base = fixture({ "engine/bad.js": "export function x(api) { return api.logger; }\n" });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/bad\.js:1/);
  });

  it("allows an api. reference inside the adapter", () => {
    const base = fixture({ "adapter/ok.js": "export function x(api) { return api.on(\"gateway_stop\", () => {}); }\n" });
    assert.equal(run(base).status, 0);
  });
});
