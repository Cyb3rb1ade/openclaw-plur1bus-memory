/**
 * tests/speaker-mapping-merge-results-missing.test.js
 *
 * Regression: getMergeResultByMediaOutputId queries a `merge_results` table that
 * this module never creates (ensureSchema only makes speaker_mappings — the
 * table is created by an external diarization component). The unwrapped
 * db.prepare(...) threw `no such table: merge_results` into the caller. It must
 * degrade to null when the table is absent.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getMergeResultByMediaOutputId,
  resetSpeakerMappingDbForTests,
} from "../lib/speaker-mapping-store.js";

describe("getMergeResultByMediaOutputId — missing merge_results table", () => {
  let tmpDir, originalStateDir;

  beforeEach(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plur1bus-merge-results-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    resetSpeakerMappingDbForTests();
  });

  afterEach(async () => {
    resetSpeakerMappingDbForTests();
    if (originalStateDir !== undefined) process.env.OPENCLAW_STATE_DIR = originalStateDir;
    else delete process.env.OPENCLAW_STATE_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null instead of throwing when merge_results does not exist", () => {
    let result;
    assert.doesNotThrow(() => {
      result = getMergeResultByMediaOutputId("some-media-output-id");
    }, "must not throw 'no such table: merge_results'");
    assert.strictEqual(result, null);
  });
});
