import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureEpistemicCutoff,
  readEpistemicCutoff,
  epistemicCutoffDir,
  epistemicCutoffPath,
  isCreatedAtBeforeCutoff,
  isCreatedAtOnOrAfterCutoff,
  toFiniteMs,
} from "../lib/epistemic-cutoff.js";

function tempBase() {
  const root = mkdtempSync(join(tmpdir(), "epi-cutoff-"));
  const baseDbPath = join(root, "lancedb-namespaced");
  mkdirSync(baseDbPath, { recursive: true });
  return { root, baseDbPath };
}

describe("epistemic cutoff marker", () => {
  it("lives as a sibling of baseDbPath, not inside it", () => {
    const { root, baseDbPath } = tempBase();
    const dir = epistemicCutoffDir(baseDbPath);
    assert.equal(dir, join(root, "_epistemic"));
    assert.ok(!dir.startsWith(baseDbPath));
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a monotonic cutoff on first boot", () => {
    const { root, baseDbPath } = tempBase();
    const first = ensureEpistemicCutoff(baseDbPath, 1_700_000_000_000);
    assert.equal(first.ok, true);
    assert.equal(first.since, 1_700_000_000_000);
    assert.equal(first.legacyOpen, true);
    const again = ensureEpistemicCutoff(baseDbPath, 1_800_000_000_000);
    assert.equal(again.since, 1_700_000_000_000);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not mint a new cutoff when enabled exists and cutoff is gone", () => {
    const { root, baseDbPath } = tempBase();
    ensureEpistemicCutoff(baseDbPath, 1_700_000_000_000);
    rmSync(epistemicCutoffPath(baseDbPath), { force: true });
    const lost = ensureEpistemicCutoff(baseDbPath, 1_900_000_000_000);
    assert.equal(lost.ok, false);
    assert.equal(lost.legacyOpen, false);
    assert.equal(lost.reason, "cutoff_missing_after_upgrade");
    assert.equal(existsSync(epistemicCutoffPath(baseDbPath)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it("treats unreadable cutoff as fail-closed", () => {
    const { root, baseDbPath } = tempBase();
    mkdirSync(epistemicCutoffDir(baseDbPath), { recursive: true });
    writeFileSync(epistemicCutoffPath(baseDbPath), "{not-json", "utf8");
    const read = readEpistemicCutoff(baseDbPath);
    assert.equal(read.ok, false);
    assert.equal(read.legacyOpen, false);
    assert.equal(read.reason, "cutoff_read_error");
    rmSync(root, { recursive: true, force: true });
  });

  it("compares BigInt createdAt safely", () => {
    assert.equal(toFiniteMs(100n), 100);
    assert.equal(isCreatedAtBeforeCutoff(99n, 100), true);
    assert.equal(isCreatedAtOnOrAfterCutoff(100n, 100), true);
    assert.equal(isCreatedAtBeforeCutoff(100n, 100), false);
  });
});
