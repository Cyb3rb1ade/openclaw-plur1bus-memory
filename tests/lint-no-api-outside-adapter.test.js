/**
 * tests/lint-no-api-outside-adapter.test.js — PR-02d.
 *
 * The boundary rule is only worth having if it fails on a real violation, so
 * the test plants one under engine/ and removes it again.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "lint-no-api-outside-adapter.mjs");

function run() {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

describe("lint-no-api-outside-adapter", () => {
  it("passes on the current tree", () => {
    const result = run();
    assert.equal(result.status, 0, result.out);
  });

  it("fails on an api. reference under engine/", (t) => {
    const dir = join(root, "engine", "__lint_probe__");
    mkdirSync(dir, { recursive: true });
    t.after(() => rmSync(join(root, "engine", "__lint_probe__"), { recursive: true, force: true }));
    writeFileSync(join(dir, "bad.js"), "export function x(api) { return api.logger; }\n");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/__lint_probe__\/bad\.js:1/);
  });

  it("allows an api. reference inside the adapter", (t) => {
    const dir = join(root, "adapter", "__lint_probe__");
    mkdirSync(dir, { recursive: true });
    t.after(() => rmSync(join(root, "adapter", "__lint_probe__"), { recursive: true, force: true }));
    writeFileSync(join(dir, "ok.js"), "export function x(api) { return api.on(\"gateway_stop\", () => {}); }\n");
    assert.equal(run().status, 0);
  });
});
