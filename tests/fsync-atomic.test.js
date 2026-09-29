/**
 * tests/fsync-atomic.test.js — lib/fsync-atomic.js on both platform branches.
 *
 * Windows cannot fsync a directory handle (EPERM), so writeTextFsync skips the
 * directory fsync there; the file itself is still written, fsynced and renamed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonFsync, writeTextFsync } from "../lib/fsync-atomic.js";
import { makeTempDir } from "./helpers/temp-dir.js";

describe("writeTextFsync", () => {
  for (const platform of ["linux", "win32"]) {
    it(`writes atomically and leaves no temp file (${platform} branch)`, () => {
      const dir = join(makeTempDir("fsync-atomic-"), "nested");
      const file = join(dir, "SKILL.md");
      writeTextFsync(file, "first\n", { platform });
      writeTextFsync(file, "second\n", { platform });
      assert.equal(readFileSync(file, "utf8"), "second\n");
      assert.deepEqual(readdirSync(dir), ["SKILL.md"]);
    });
  }

  it("writeJsonFsync keeps the default platform and writes one JSON line", () => {
    const file = join(makeTempDir("fsync-atomic-json-"), "cutoff.json");
    writeJsonFsync(file, { since: 1 });
    assert.equal(readFileSync(file, "utf8"), "{\"since\":1}\n");
  });
});
