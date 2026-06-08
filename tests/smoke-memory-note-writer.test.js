import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryNotes } from "../lib/obsidian/memory-note-writer.js";

let tmpDir;

function makeVault() {
  return mkdtempSync(join(tmpdir(), "plur1bus-mnw-"));
}

const baseConfig = (vault) => ({
  vaultPath: vault,
  reviewRoot: "plur1bus",
});

function makeRecord(overrides = {}) {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    text: "Chris nutzt OpenClaw mit PLUR1BUS Memory.",
    summary: "OpenClaw PLUR1BUS Setup",
    category: "fact",
    importance: 0.9,
    createdAt: "2026-01-01T00:00:00.000Z",
    scope: "workspace",
    vector: [0.1, 0.2],
    ...overrides,
  };
}

describe("writeMemoryNotes", () => {
  it("writes new note with correct frontmatter and body", () => {
    const vault = makeVault();
    const records = [makeRecord()];
    const result = writeMemoryNotes(baseConfig(vault), records, {});

    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.errors, 0);

    const notePath = join(vault, "plur1bus", "memories", "aaaaaaaa-0000-0000-0000-000000000001.md");
    assert.ok(existsSync(notePath), "note file should exist");

    const content = readFileSync(notePath, "utf8");
    assert.match(content, /memory_id: aaaaaaaa-0000-0000-0000-000000000001/);
    assert.match(content, /plur1bus_type: memory/);
    assert.match(content, /content_hash: sha256:/);
    assert.match(content, /OpenClaw PLUR1BUS Setup/);
    assert.match(content, /Chris nutzt OpenClaw/);
  });

  it("skips unchanged record on second call (idempotent)", () => {
    const vault = makeVault();
    const records = [makeRecord()];

    const first = writeMemoryNotes(baseConfig(vault), records, {});
    assert.strictEqual(first.written, 1);

    const second = writeMemoryNotes(baseConfig(vault), records, {});
    assert.strictEqual(second.written, 0);
    assert.strictEqual(second.skipped, 1);
  });

  it("rewrites note when record text changes", () => {
    const vault = makeVault();
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    const v1 = [makeRecord({ id, text: "original text", summary: "v1" })];
    const v2 = [makeRecord({ id, text: "updated text", summary: "v2" })];

    writeMemoryNotes(baseConfig(vault), v1, {});
    const result = writeMemoryNotes(baseConfig(vault), v2, {});

    assert.strictEqual(result.written, 1);

    const notePath = join(vault, "plur1bus", "memories", `${id}.md`);
    const content = readFileSync(notePath, "utf8");
    assert.match(content, /updated text/);
  });

  it("respects maxPerRun — writes only first N records", () => {
    const vault = makeVault();
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `aaaaaaaa-0000-0000-0000-00000000000${String(i + 1).padStart(1, "0")}`,
      text: `text ${i}`,
      summary: `summary ${i}`,
      category: "fact",
      importance: 0.5,
      createdAt: "2026-01-01T00:00:00.000Z",
      scope: "workspace",
      vector: [0.1],
    }));

    const result = writeMemoryNotes(baseConfig(vault), records, { maxPerRun: 3 });
    assert.strictEqual(result.written, 3);
  });

  it("dryRun writes nothing and returns written=0", () => {
    const vault = makeVault();
    const records = [makeRecord()];

    const result = writeMemoryNotes(baseConfig(vault), records, { dryRun: true });
    assert.strictEqual(result.written, 0);

    const notePath = join(vault, "plur1bus", "memories", "aaaaaaaa-0000-0000-0000-000000000001.md");
    assert.ok(!existsSync(notePath), "file should not exist in dryRun mode");
  });
});
