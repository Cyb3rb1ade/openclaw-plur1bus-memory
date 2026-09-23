/**
 * tests/lint-engine-imports.test.js — PR-03a.
 *
 * Review Focus item 3: an ESM cycle between adapter and engine modules yields
 * an undefined binding at call time, not a load error, so it must be caught
 * statically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "lint-engine-imports.mjs");

function run() {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function probe(t, files) {
  const dirs = new Set();
  for (const [relativePath, source] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    dirs.add(dirname(full));
    writeFileSync(full, source);
  }
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}

describe("lint-engine-imports", () => {
  it("passes on the current tree", () => {
    const result = run();
    assert.equal(result.status, 0, result.out);
  });

  it("allows an adapter module importing an engine module", (t) => {
    probe(t, {
      "engine/__probe__/a.js": 'import { applyGlobalInjectBudget } from "../../lib/inject-budget.js";\nexport function a() { return applyGlobalInjectBudget; }\n',
      "adapter/__probe__/r.js": 'import { a } from "../../engine/__probe__/a.js";\nexport function r(api) { return api.on("x", a); }\n',
    });
    assert.equal(run().status, 0);
  });

  it("rejects engine code importing the adapter lifecycle", (t) => {
    probe(t, {
      "engine/__probe__/bad.js": 'import { runtimeIfUsable } from "../../lib/runtime-shutdown.js";\nexport const x = runtimeIfUsable;\n',
    });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /must not import lib\/runtime-shutdown\.js/);
  });

  it("rejects an import of index.js", (t) => {
    probe(t, { "engine/__probe__/shell.js": 'import plugin from "../../index.js";\nexport const p = plugin;\n' });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /imports index\.js/);
  });

  it("rejects an import cycle", (t) => {
    probe(t, {
      "engine/__probe__/b.js": 'import { c } from "./c.js";\nexport function b() { return c(); }\n',
      "engine/__probe__/c.js": 'import { b } from "./b.js";\nexport function c() { return b(); }\n',
    });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /import cycle: engine\/__probe__\/[bc]\.js/);
    // The report must name *both* files of the cycle, not just its entry point —
    // otherwise it does not say what to break.
    assert.match(result.out, /engine\/__probe__\/b\.js/);
    assert.match(result.out, /engine\/__probe__\/c\.js/);
  });

  // Task 9 left `api` on HostServices as a transitional escape hatch so the
  // adapter can hand the raw OpenClaw api to code that has not been ported yet.
  // Engine code must never reach through it: `host.api.…` is the same host
  // coupling the extraction exists to remove, and the `api.`-only linter
  // (scripts/lint-no-api-outside-adapter.mjs) deliberately does not match a
  // dotted receiver.
  it("rejects engine code reading host.api", (t) => {
    probe(t, {
      "engine/__probe__/hatch.js": 'export function h(host) {\n  return host.api.on("x", () => {});\n}\n',
    });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/__probe__\/hatch\.js:2/);
    assert.match(result.out, /escape hatch/);
  });

  it("rejects any dotted `.api.` read in engine code", (t) => {
    probe(t, {
      "engine/__probe__/hatch2.js": 'export function h(services) {\n  const { logger } = services.api;\n  return logger;\n}\n',
    });
    assert.equal(run().status, 1);
  });

  it("allows the adapter to use host.api", (t) => {
    probe(t, {
      "adapter/__probe__/ok.js": 'export function h(host) {\n  return host.api.on("x", () => {});\n}\n',
    });
    assert.equal(run().status, 0);
  });
});
