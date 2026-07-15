// tests/setup-feature-crons-symlink.test.js — proves IS_MAIN detection in
// scripts/setup-feature-crons.mjs survives being invoked through a symlink
// (pnpm, npm link, symlinked extensions dir all resolve argv[1] through a
// symlink; a plain `===` compare against fileURLToPath(import.meta.url)
// is false in that case and the script becomes a silent no-op — see
// .superpowers/sdd/task-1-brief.md item 3).
//
// Safety: never invokes the real `openclaw` CLI. PATH is pointed at an
// empty directory so the script's own `openclaw --version` probe fails
// fast and deterministically, and only --dry-run --json is used.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "..", "scripts", "setup-feature-crons.mjs");

describe("setup-feature-crons.mjs IS_MAIN detection through a symlink", () => {
  it("still runs (prints non-empty JSON) when argv[1] is a symlinked path", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "setup-feature-crons-symlink-"));
    const emptyPathDir = path.join(workDir, "empty-path");
    mkdirSync(emptyPathDir);

    const linkDir = path.join(workDir, "linked-scripts");
    // Symlink the whole scripts/ directory (mirrors how pnpm/npm link expose
    // a package's bin/scripts through a symlinked directory).
    symlinkSync(path.dirname(scriptPath), linkDir);
    const symlinkedScriptPath = path.join(linkDir, path.basename(scriptPath));

    const result = spawnSync(process.execPath, [symlinkedScriptPath, "--dry-run", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPathDir },
      timeout: 10_000,
    });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    const stdout = result.stdout.trim();
    assert.notStrictEqual(stdout, "", "expected non-empty stdout JSON when run through a symlink");

    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.reason, "cli-unavailable");
  });
});
