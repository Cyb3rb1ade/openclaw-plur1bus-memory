/**
 * tests/platform-callsites.test.js — PR-01b.
 *
 * Two guards that survive later refactors: no module writes a
 * permission with a raw fs chmod any more, and the embedding cache
 * directory no longer falls back to $HOME (host-contract f.2/f.9).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROUTED = [
  "lib/providers/scoped-embedding-ipc.js",
  "lib/shared-memory-migration.js",
  "lib/workspace-policy.js",
  "lib/model-preparation/state-store.js",
  "lib/reembedding/lance-backend.js",
  "lib/reembedding/state-store.js",
  "lib/llm-result-cache.js",
];

describe("PR-01b platform call sites", () => {
  for (const relative of ROUTED) {
    it(`${relative} secures permissions through lib/platform.js`, () => {
      const source = readFileSync(join(root, relative), "utf8");
      assert.match(source, /from "\.{1,2}\/platform\.js"/, `${relative} must import lib/platform.js`);
      assert.doesNotMatch(source, /\bchmodSync\s*\(/, `${relative} must not call chmodSync directly`);
      assert.doesNotMatch(source, /\bfchmodSync\s*\(/, `${relative} must not call fchmodSync directly`);
    });
  }

  it("the embedding adapter resolves the home directory with os.homedir()", () => {
    const source = readFileSync(join(root, "lib/providers/openclaw-memory-embedding-adapters.js"), "utf8");
    assert.doesNotMatch(source, /process\.env\.HOME/, "HOME is unset on Windows; use homedir()");
    assert.match(source, /homedir\(\)/);
  });

  it("no module outside lib/platform.js calls chmodSync or fchmodSync", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("grep", [
      "-rn", "--include=*.js", "-E", "\\b(f?chmodSync)\\s*\\(", "lib", "index.js",
    ], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean)
      .filter((line) => !line.startsWith("lib/platform.js:"));
    assert.deepEqual(out, [], `unrouted chmod call sites:\n${out.join("\n")}`);
  });
});
