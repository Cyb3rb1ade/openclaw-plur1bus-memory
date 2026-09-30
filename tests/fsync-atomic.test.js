/**
 * tests/fsync-atomic.test.js — lib/fsync-atomic.js on both platform branches.
 *
 * Windows cannot fsync a directory handle (EPERM), so writeTextFsync skips the
 * directory fsync there; the file itself is still written, fsynced and renamed.
 * The branch tests record fsync calls instead of issuing them, so the linux
 * branch also runs on a Windows host (a real directory fsync is EPERM there).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonFsync, writeTextFsync } from "../lib/fsync-atomic.js";
import { makeTempDir } from "./helpers/temp-dir.js";

describe("writeTextFsync", () => {
  for (const [platform, perWrite] of [["linux", 2], ["win32", 1]]) {
    it(`writes atomically and leaves no temp file (${platform} branch: ${perWrite} fsync per write)`, () => {
      const dir = join(makeTempDir("fsync-atomic-"), "nested");
      const file = join(dir, "SKILL.md");
      const synced = [];
      const fsync = (fd) => { synced.push(fd); };
      writeTextFsync(file, "first\n", { platform, fsync });
      writeTextFsync(file, "second\n", { platform, fsync });
      assert.equal(readFileSync(file, "utf8"), "second\n");
      assert.deepEqual(readdirSync(dir), ["SKILL.md"]);
      assert.equal(synced.length, 2 * perWrite);
    });
  }

  it("writes with real fsyncs on the host platform", () => {
    const file = join(makeTempDir("fsync-atomic-host-"), "SKILL.md");
    writeTextFsync(file, "host\n");
    assert.equal(readFileSync(file, "utf8"), "host\n");
  });

  it("writeJsonFsync keeps the default platform and writes one JSON line", () => {
    const file = join(makeTempDir("fsync-atomic-json-"), "cutoff.json");
    writeJsonFsync(file, { since: 1 });
    assert.equal(readFileSync(file, "utf8"), "{\"since\":1}\n");
  });
});
