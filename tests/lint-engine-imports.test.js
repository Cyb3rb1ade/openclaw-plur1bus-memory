/**
 * tests/lint-engine-imports.test.js — PR-03a.
 *
 * Review Focus item 3: an ESM cycle between adapter and engine modules yields
 * an undefined binding at call time, not a load error, so it must be caught
 * statically.
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
const script = join(root, "scripts", "lint-engine-imports.mjs");

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
 * Materialise a throwaway tree with `engine/` and `adapter/` roots.
 * Cleanup is handled by makeTempDir's own process-exit hook.
 * @param {import("node:test").TestContext} _t Unused; kept for call-site symmetry.
 * @param {Record<string, string>} files Root-relative path → source.
 * @returns {string} The tmpdir root.
 */
function fixture(_t, files) {
  const base = makeTempDir("lint-engine-");
  mkdirSync(join(base, "engine"), { recursive: true });
  mkdirSync(join(base, "adapter"), { recursive: true });
  for (const [relativePath, source] of Object.entries(files)) {
    const full = join(base, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return base;
}

describe("lint-engine-imports", () => {
  it("passes on the current tree", () => {
    const result = run(root);
    assert.equal(result.status, 0, result.out);
  });

  it("allows an adapter module importing an engine module", (t) => {
    const base = fixture(t, {
      "engine/a.js": 'import { applyGlobalInjectBudget } from "../lib/inject-budget.js";\nexport function a() { return applyGlobalInjectBudget; }\n',
      "adapter/r.js": 'import { a } from "../engine/a.js";\nexport function r(api) { return api.on("x", a); }\n',
    });
    const result = run(base);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /clean \(2 module\(s\)\)/);
  });

  it("rejects engine code importing the adapter lifecycle", (t) => {
    const base = fixture(t, {
      "engine/bad.js": 'import { runtimeIfUsable } from "../lib/runtime-shutdown.js";\nexport const x = runtimeIfUsable;\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /must not import lib\/runtime-shutdown\.js/);
  });

  it("rejects engine code importing the openclaw package", (t) => {
    const base = fixture(t, {
      "engine/host.js": 'import { thing } from "openclaw/plugin";\nexport const t = thing;\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /must not import the openclaw package/);
  });

  it("rejects an import of index.js", (t) => {
    const base = fixture(t, { "engine/shell.js": 'import plugin from "../index.js";\nexport const p = plugin;\n' });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /imports index\.js/);
  });

  it("rejects an import cycle", (t) => {
    const base = fixture(t, {
      "engine/b.js": 'import { c } from "./c.js";\nexport function b() { return c(); }\n',
      "engine/c.js": 'import { b } from "./b.js";\nexport function c() { return b(); }\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /import cycle: engine\/[bc]\.js/);
    // The report must name *both* files of the cycle, not just its entry point —
    // otherwise it does not say what to break.
    assert.match(result.out, /engine\/b\.js/);
    assert.match(result.out, /engine\/c\.js/);
  });

  it("rejects an engine↔adapter cycle across the two roots", (t) => {
    const base = fixture(t, {
      "engine/e.js": 'import { r } from "../adapter/d.js";\nexport function e() { return r(); }\n',
      "adapter/d.js": 'import { e } from "../engine/e.js";\nexport function r() { return e(); }\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/e\.js/);
    assert.match(result.out, /adapter\/d\.js/);
  });

  it("lints .mjs files under engine/ too", (t) => {
    const base = fixture(t, {
      "engine/tool.mjs": 'import { runtimeIfUsable } from "../lib/runtime-shutdown.js";\nexport const x = runtimeIfUsable;\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/tool\.mjs/);
  });

  it("sees a require() specifier, not just an import", (t) => {
    const base = fixture(t, {
      "engine/cjs.js": 'import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const host = req.call(null, require("openclaw"));\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /must not import the openclaw package/);
  });

  // Task 9 left `api` on HostServices as a transitional escape hatch so the
  // adapter can hand the raw OpenClaw api to code that has not been ported yet.
  // Engine code must never reach through it: `host.api.…` is the same host
  // coupling the extraction exists to remove, and the `api.`-only linter
  // (scripts/lint-no-api-outside-adapter.mjs) deliberately does not match a
  // dotted receiver.
  it("rejects engine code reading host.api", (t) => {
    const base = fixture(t, {
      "engine/hatch.js": 'export function h(host) {\n  return host.api.on("x", () => {});\n}\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/hatch\.js:2/);
    assert.match(result.out, /escape hatch/);
  });

  it("rejects any dotted `.api.` read in engine code", (t) => {
    const base = fixture(t, {
      "engine/hatch2.js": 'export function h(services) {\n  const { logger } = services.api;\n  return logger;\n}\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/hatch2\.js:2/);
  });

  it("allows the adapter to use host.api", (t) => {
    const base = fixture(t, {
      "adapter/ok.js": 'export function h(host) {\n  return host.api.on("x", () => {});\n}\n',
    });
    const result = run(base);
    assert.equal(result.status, 0, result.out);
  });

  // Rule 5 (PR-03i). A moved range can arrive in the engine still holding a
  // bare `api` parameter or ctx key; `.api` alone does not see that, and
  // scripts/lint-no-api-outside-adapter.mjs allowlists nothing but a member
  // read. The bare identifier is the form that actually appears when a
  // register()-scope block is lifted verbatim.
  it("rejects a bare api parameter in engine code", (t) => {
    const base = fixture(t, {
      "engine/bare.js": 'export function h(api) {\n  return api.on("x", () => {});\n}\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/bare\.js:1/);
    assert.match(result.out, /must not name the OpenClaw `api`/);
  });

  it("rejects a bare api destructured from the context object", (t) => {
    const base = fixture(t, {
      "engine/ctx.js": 'export function h(ctx) {\n  const { api, host } = ctx;\n  return [api, host];\n}\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/ctx\.js:2/);
  });

  it("does not fire on words that merely contain api", (t) => {
    const base = fixture(t, {
      "engine/near.js": 'export function h(apiKey, rapidMode, openaiClient) {\n  return [apiKey, rapidMode, openaiClient, { apiVersion: 1 }];\n}\n',
    });
    const result = run(base);
    assert.equal(result.status, 0, result.out);
  });

  it("does not fire on api inside a comment", (t) => {
    const base = fixture(t, {
      "engine/prose.js": '// the adapter hands api to the host; the engine never sees it\n/* api, again */\nexport const x = 1;\n',
    });
    const result = run(base);
    assert.equal(result.status, 0, result.out);
  });

  it("still allows a bare api in adapter code", (t) => {
    const base = fixture(t, {
      "adapter/bare-ok.js": 'export function h(api) {\n  return api.on("x", () => {});\n}\n',
    });
    const result = run(base);
    assert.equal(result.status, 0, result.out);
  });
});
