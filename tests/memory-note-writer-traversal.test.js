/**
 * tests/memory-note-writer-traversal.test.js
 *
 * Regression: writeMemoryNotes used the RAW record id as the note filename
 * (`${record.id}.md`), bypassing the safe-paths guard. A record id with path
 * segments ("../escape") wrote outside the memories dir — a vault-escape /
 * cross-agent write. The id is now slugged; UUID ids stay unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryNotes } from "../lib/obsidian/memory-note-writer.js";

const baseRecord = { text: "x", summary: "x", category: "fact", scope: "agent-private", createdAt: 1 };

describe("memory-note-writer path traversal", () => {
  it("contains a malicious '../' record id inside the memories dir", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-vault-"));
    writeMemoryNotes({ vaultPath: vault, reviewRoot: "plur1bus" },
      [{ ...baseRecord, id: "../escapePWNED" }], { dryRun: false });

    const reviewPath = join(vault, "plur1bus");
    const memoriesDir = join(reviewPath, "memories");
    assert.ok(!existsSync(join(reviewPath, "escapePWNED.md")), "note must not escape the memories dir");
    const md = existsSync(memoriesDir) ? readdirSync(memoriesDir).filter((f) => f.endsWith(".md")) : [];
    assert.strictEqual(md.length, 1, `one contained note expected, got ${JSON.stringify(md)}`);
  });

  it("preserves a UUID id as the filename", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-vault-"));
    const uuid = "8400e29b-1c2d-4e5f-9a0b-1c2d3e4f5a6b";
    writeMemoryNotes({ vaultPath: vault, reviewRoot: "plur1bus" },
      [{ ...baseRecord, id: uuid }], { dryRun: false });
    assert.ok(existsSync(join(vault, "plur1bus", "memories", `${uuid}.md`)), "UUID filename preserved");
  });
});
