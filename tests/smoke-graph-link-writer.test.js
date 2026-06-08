/**
 * Task 1: Link formatting helpers + module skeleton
 *
 * Tests:
 * 1. formatLinkTarget constructs vault-relative wikilink path
 * 2. formatLinkTarget falls back to plur1bus_id when path missing
 * 3. formatDisplayTitle uses title first
 * 4. formatDisplayTitle falls back to summary slice
 * 5. formatDisplayTitle falls back to plur1bus_id
 * 6. buildLinkLine produces correct wikilink markdown
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryNotes, buildRecordIndex } from "../lib/obsidian/record-index.js";
import {
  formatLinkTarget,
  formatDisplayTitle,
  buildLinkLine,
  resolveGraphConfig,
  collectTier1Links,
  collectTier2Links,
  writeGraphLinks,
} from "../lib/obsidian/graph-link-writer.js";

describe("graph-link-writer: helpers", () => {
  it("formatLinkTarget constructs vault-relative wikilink path", () => {
    const record = { path: "records/decisions/dec-abc.md" };
    assert.strictEqual(
      formatLinkTarget(record, "plur1bus"),
      "plur1bus/records/decisions/dec-abc"
    );
  });

  it("formatLinkTarget falls back to plur1bus_id when path missing", () => {
    const record = { plur1bus_id: "dec-xyz", plur1bus_type: "decision" };
    assert.strictEqual(formatLinkTarget(record, "plur1bus"), "plur1bus/records/decision/dec-xyz");
  });

  it("formatDisplayTitle uses title first", () => {
    assert.strictEqual(
      formatDisplayTitle({ title: "My Note", summary: "Sum" }),
      "My Note"
    );
  });

  it("formatDisplayTitle falls back to summary slice", () => {
    const long = "A".repeat(80);
    assert.strictEqual(formatDisplayTitle({ summary: long }).length, 60);
  });

  it("formatDisplayTitle falls back to plur1bus_id", () => {
    assert.strictEqual(
      formatDisplayTitle({ plur1bus_id: "dec-abc" }),
      "dec-abc"
    );
  });

  it("buildLinkLine produces correct wikilink markdown", () => {
    const line = buildLinkLine(
      { path: "records/decisions/dec-abc.md" },
      "plur1bus",
      "Meine Decision",
      "memoryId"
    );
    assert.strictEqual(
      line,
      "- [[plur1bus/records/decisions/dec-abc|Meine Decision]] _(memoryId)_"
    );
  });
});

describe("graph-link-writer: config", () => {
  it("resolveGraphConfig returns defaults when graphLinks absent", () => {
    const cfg = resolveGraphConfig({});
    assert.strictEqual(cfg.maxPerNote, 5);
    assert.strictEqual(cfg.includeSemantic, false);
    assert.deepStrictEqual(cfg.tiers, ["explicit", "type", "semantic"]);
    assert.strictEqual(cfg.blockId, "graph-links");
    assert.strictEqual(cfg.semanticThreshold, 0.78);
  });

  it("resolveGraphConfig merges user config over defaults", () => {
    const cfg = resolveGraphConfig({ graphLinks: { maxPerNote: 3, tiers: ["explicit"] } });
    assert.strictEqual(cfg.maxPerNote, 3);
    assert.deepStrictEqual(cfg.tiers, ["explicit"]);
    assert.strictEqual(cfg.includeSemantic, false);
    assert.strictEqual(cfg.blockId, "graph-links");
  });
});

describe("graph-link-writer: tier1", () => {
  const reviewRoot = "plur1bus";
  const byId = {
    "src-001": { plur1bus_id: "src-001", path: "records/sources/src-001.md", title: "Kimi Docs" },
    "dec-abc": { plur1bus_id: "dec-abc", path: "records/decisions/dec-abc.md", title: "Auth Decision" },
  };

  it("collects memoryIds as links", () => {
    const record = { plur1bus_id: "cand-x", memoryIds: ["dec-abc"], sourceRefs: [] };
    const links = collectTier1Links(record, byId, reviewRoot, 5);
    assert.strictEqual(links.length, 1);
    assert.match(links[0], /\[\[plur1bus\/records\/decisions\/dec-abc\|Auth Decision\]\]/);
    assert.match(links[0], /_\(memoryId\)_/);
  });

  it("collects sourceRefs as links", () => {
    const record = { plur1bus_id: "dec-x", memoryIds: [], sourceRefs: ["src-001"] };
    const links = collectTier1Links(record, byId, reviewRoot, 5);
    assert.strictEqual(links.length, 1);
    assert.match(links[0], /Kimi Docs/);
    assert.match(links[0], /_\(Quelle\)_/);
  });

  it("skips unknown IDs", () => {
    const record = { plur1bus_id: "x", memoryIds: ["nonexistent"], sourceRefs: [] };
    const links = collectTier1Links(record, byId, reviewRoot, 5);
    assert.strictEqual(links.length, 0);
  });

  it("respects maxPerNote", () => {
    const record = { plur1bus_id: "x", memoryIds: ["dec-abc", "src-001"], sourceRefs: ["src-001"] };
    const links = collectTier1Links(record, byId, reviewRoot, 1);
    assert.strictEqual(links.length, 1);
  });
});

describe("graph-link-writer: tier2", () => {
  const reviewRoot = "plur1bus";
  const decRecord = {
    plur1bus_id: "dec-001",
    plur1bus_type: "decision",
    path: "records/decisions/dec-001.md",
    title: "Auth Decision",
    memoryIds: ["cand-001"],
    sourceRefs: [],
  };
  const byType = { decision: [decRecord] };
  const byId = { "dec-001": decRecord };

  it("memory_candidate gets links to decisions that reference it", () => {
    const record = { plur1bus_id: "cand-001", plur1bus_type: "memory_candidate" };
    const links = collectTier2Links(record, byId, byType, reviewRoot, 5, new Set());
    assert.strictEqual(links.length, 1);
    assert.match(links[0], /dec-001/);
    assert.match(links[0], /_\(Entscheidung\)_/);
  });

  it("skips already-linked records", () => {
    const record = { plur1bus_id: "cand-001", plur1bus_type: "memory_candidate" };
    const links = collectTier2Links(record, byId, byType, reviewRoot, 5, new Set(["dec-001"]));
    assert.strictEqual(links.length, 0);
  });

  it("review_item gets links to siblings with same reviewBundleId", () => {
    const sibling = {
      plur1bus_id: "ri-002",
      plur1bus_type: "review_item",
      path: "records/review-items/ri-002.md",
      title: "Sibling Review",
      reviewBundleId: "bundle-x",
    };
    const self = { plur1bus_id: "ri-001", plur1bus_type: "review_item", reviewBundleId: "bundle-x" };
    const bt = { "review_item": [self, sibling] };
    const links = collectTier2Links(self, {}, bt, reviewRoot, 5, new Set());
    assert.strictEqual(links.length, 1);
    assert.match(links[0], /ri-002/);
  });

  it("unknown type returns empty", () => {
    const record = { plur1bus_id: "src-001", plur1bus_type: "source" };
    const links = collectTier2Links(record, byId, byType, reviewRoot, 5, new Set());
    assert.strictEqual(links.length, 0);
  });
});

describe("graph-link-writer: writeGraphLinks", () => {
  function makeVault() {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-glw-"));
    mkdirSync(join(dir, "plur1bus", "records", "decisions"), { recursive: true });
    mkdirSync(join(dir, "plur1bus", "records", "sources"), { recursive: true });
    return dir;
  }

  function writeNote(dir, relPath, content) {
    writeFileSync(join(dir, relPath), content, "utf8");
  }

  it("injects graph-links block into a record note with sourceRefs", async () => {
    const vault = makeVault();
    const srcRecord = {
      plur1bus_id: "src-001",
      plur1bus_type: "source",
      path: "records/sources/src-001.md",
      title: "Kimi API Docs",
      memoryIds: [],
      sourceRefs: [],
    };
    const decRecord = {
      plur1bus_id: "dec-001",
      plur1bus_type: "decision",
      path: "records/decisions/dec-001.md",
      title: "Auth Decision",
      memoryIds: [],
      sourceRefs: ["src-001"],
    };
    writeNote(vault, "plur1bus/records/sources/src-001.md", "# Kimi API Docs\n\nContent here.\n");
    writeNote(vault, "plur1bus/records/decisions/dec-001.md", "# Auth Decision\n\nContent here.\n");

    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const result = await writeGraphLinks(rawConfig, [srcRecord, decRecord], {});

    assert.ok(result.ok);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.conflicts.length, 0);

    const decContent = readFileSync(join(vault, "plur1bus/records/decisions/dec-001.md"), "utf8");
    assert.match(decContent, /plur1bus:managed:start id="graph-links"/);
    assert.match(decContent, /Kimi API Docs/);
    assert.match(decContent, /Quelle/);
  });

  it("is idempotent — second run returns unchanged=1", async () => {
    const vault = makeVault();
    const record = {
      plur1bus_id: "dec-002",
      plur1bus_type: "decision",
      path: "records/decisions/dec-002.md",
      title: "Standalone",
      memoryIds: [],
      sourceRefs: [],
    };
    writeNote(vault, "plur1bus/records/decisions/dec-002.md", "# Standalone\n");
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    await writeGraphLinks(rawConfig, [record], {});
    const second = await writeGraphLinks(rawConfig, [record], {});
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.unchanged, 1);
  });

  it("skips note if file does not exist on disk", async () => {
    const vault = makeVault();
    const record = {
      plur1bus_id: "dec-ghost",
      plur1bus_type: "decision",
      path: "records/decisions/dec-ghost.md",
      title: "Ghost",
    };
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const result = await writeGraphLinks(rawConfig, [record], {});
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.updated, 0);
  });

  it("detects conflict when block was manually edited", async () => {
    const vault = makeVault();
    const record = {
      plur1bus_id: "dec-003",
      plur1bus_type: "decision",
      path: "records/decisions/dec-003.md",
      title: "Conflicted",
      memoryIds: [],
      sourceRefs: [],
    };
    const tampered = `# Conflicted\n\n<!-- plur1bus:managed:start id="graph-links" version="4.2.18" hash="sha256:badhash" -->\n- manually edited\n<!-- plur1bus:managed:end -->\n`;
    writeNote(vault, "plur1bus/records/decisions/dec-003.md", tampered);
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const result = await writeGraphLinks(rawConfig, [record], {});
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0], "dec-003");
    assert.strictEqual(result.updated, 0);
    const content = readFileSync(join(vault, "plur1bus/records/decisions/dec-003.md"), "utf8");
    assert.match(content, /manually edited/);
  });
});

describe("graph-link-writer: Tier 3 (semantic link index)", () => {
  function makeVault() {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-t3-"));
    mkdirSync(join(dir, "plur1bus", "records", "decisions"), { recursive: true });
    return dir;
  }

  function writeNote(dir, relPath, content) {
    writeFileSync(join(dir, relPath), content, "utf8");
  }

  it("injects semantic links when linkIndex has entries", async () => {
    const vault = makeVault();
    const recA = {
      plur1bus_id: "dec-A",
      plur1bus_type: "decision",
      path: "records/decisions/dec-A.md",
      title: "Decision A",
      memoryIds: [],
      sourceRefs: [],
    };
    const recB = {
      plur1bus_id: "dec-B",
      plur1bus_type: "decision",
      path: "records/decisions/dec-B.md",
      title: "Decision B",
      memoryIds: [],
      sourceRefs: [],
    };
    writeNote(vault, "plur1bus/records/decisions/dec-A.md", "# A\n");
    writeNote(vault, "plur1bus/records/decisions/dec-B.md", "# B\n");

    const linkIndex = {
      version: "1",
      entries: {
        "dec-A": { similar: ["dec-B"], contentHash: "x", firstDiscoveredAt: "2026-01-01T00:00:00Z", lastCheckedAt: "2026-01-01T00:00:00Z" },
      },
    };
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus", graphLinks: { includeSemantic: true } };
    const result = await writeGraphLinks(rawConfig, [recA, recB], { linkIndex });

    assert.ok(result.ok);
    const content = readFileSync(join(vault, "plur1bus/records/decisions/dec-A.md"), "utf8");
    assert.match(content, /dec-B/);
    assert.match(content, /ähnlich/);
  });

  it("Tier 3 skips when includeSemantic is false (default)", async () => {
    const vault = makeVault();
    const rec = {
      plur1bus_id: "dec-C",
      plur1bus_type: "decision",
      path: "records/decisions/dec-C.md",
      title: "Decision C",
      memoryIds: [],
      sourceRefs: [],
    };
    writeNote(vault, "plur1bus/records/decisions/dec-C.md", "# C\n");
    const linkIndex = {
      version: "1",
      entries: { "dec-C": { similar: ["dec-B"], contentHash: "x", firstDiscoveredAt: "2026-01-01T00:00:00Z", lastCheckedAt: "2026-01-01T00:00:00Z" } },
    };
    // No graphLinks.includeSemantic — default is false
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    await writeGraphLinks(rawConfig, [rec], { linkIndex });
    const content = readFileSync(join(vault, "plur1bus/records/decisions/dec-C.md"), "utf8");
    assert.match(content, /keine Querverweise/);
  });

  it("Tier 3 respects maxPerNote cap", async () => {
    const vault = makeVault();
    mkdirSync(join(vault, "plur1bus", "records", "sources"), { recursive: true });
    const mainRec = {
      plur1bus_id: "main", plur1bus_type: "decision",
      path: "records/decisions/dec-A.md", title: "Main",
      memoryIds: [], sourceRefs: [],
    };
    writeNote(vault, "plur1bus/records/decisions/dec-A.md", "# Main\n");

    const linkIndex = {
      version: "1",
      entries: {
        "main": {
          similar: ["s1", "s2", "s3", "s4", "s5", "s6"],
          contentHash: "x", firstDiscoveredAt: "2026-01-01T00:00:00Z", lastCheckedAt: "2026-01-01T00:00:00Z",
        },
      },
    };
    const byIdRecords = [
      { plur1bus_id: "s1", path: "records/sources/s1.md", title: "S1", memoryIds: [], sourceRefs: [] },
      { plur1bus_id: "s2", path: "records/sources/s2.md", title: "S2", memoryIds: [], sourceRefs: [] },
      { plur1bus_id: "s3", path: "records/sources/s3.md", title: "S3", memoryIds: [], sourceRefs: [] },
    ];
    for (const r of byIdRecords) writeNote(vault, `plur1bus/${r.path}`, `# ${r.title}\n`);

    const rawConfig = {
      vaultPath: vault,
      reviewRoot: "plur1bus",
      graphLinks: { includeSemantic: true, maxPerNote: 2 },
    };
    await writeGraphLinks(rawConfig, [mainRec, ...byIdRecords], { linkIndex });

    const content = readFileSync(join(vault, "plur1bus/records/decisions/dec-A.md"), "utf8");
    const matches = content.match(/ähnlich/g) || [];
    assert.ok(matches.length <= 2, `Expected <= 2 semantic links, got ${matches.length}`);
  });

  it("Tier 3 skips IDs already linked by Tier 1", async () => {
    const vault = makeVault();
    mkdirSync(join(vault, "plur1bus", "records", "sources"), { recursive: true });
    const srcRecord = {
      plur1bus_id: "src-dup",
      plur1bus_type: "source",
      path: "records/sources/src-dup.md",
      title: "Duplicate Source",
      memoryIds: [],
      sourceRefs: [],
    };
    const decRecord = {
      plur1bus_id: "dec-dup",
      plur1bus_type: "decision",
      path: "records/decisions/dec-A.md",
      title: "With Tier1",
      memoryIds: [],
      sourceRefs: ["src-dup"],
    };
    writeNote(vault, "plur1bus/records/sources/src-dup.md", "# Src\n");
    writeNote(vault, "plur1bus/records/decisions/dec-A.md", "# Dec\n");

    const linkIndex = {
      version: "1",
      entries: {
        "dec-dup": { similar: ["src-dup"], contentHash: "x", firstDiscoveredAt: "2026-01-01T00:00:00Z", lastCheckedAt: "2026-01-01T00:00:00Z" },
      },
    };
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus", graphLinks: { includeSemantic: true } };
    await writeGraphLinks(rawConfig, [srcRecord, decRecord], { linkIndex });
    const content = readFileSync(join(vault, "plur1bus/records/decisions/dec-A.md"), "utf8");
    const ähnlichCount = (content.match(/ähnlich/g) || []).length;
    assert.strictEqual(ähnlichCount, 0, "src-dup already in Tier1, must not appear as Tier3 ähnlich");
  });
});

describe("readMemoryNotes", () => {
  it("reads memory notes from memories dir", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-rmn-"));
    const memoriesDir = join(vault, "plur1bus", "memories");
    mkdirSync(memoriesDir, { recursive: true });

    const note1 = [
      "---",
      "memory_id: aaaaaaaa-0000-0000-0000-000000000001",
      "plur1bus_type: memory",
      "category: fact",
      "importance: 0.9",
      "scope: workspace",
      "created_at: 2026-01-01T00:00:00.000Z",
      "content_hash: sha256:abc123",
      "---",
      "",
      "# First Memory Title",
      "",
      "Some memory text.",
    ].join("\n");

    const note2 = [
      "---",
      "memory_id: aaaaaaaa-0000-0000-0000-000000000002",
      "plur1bus_type: memory",
      "category: preference",
      "importance: 0.7",
      "scope: agent-private",
      "created_at: 2026-02-01T00:00:00.000Z",
      "content_hash: sha256:def456",
      "---",
      "",
      "# Second Memory Title",
      "",
      "Other memory text.",
    ].join("\n");

    writeFileSync(join(memoriesDir, "aaaaaaaa-0000-0000-0000-000000000001.md"), note1, "utf8");
    writeFileSync(join(memoriesDir, "aaaaaaaa-0000-0000-0000-000000000002.md"), note2, "utf8");

    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);

    assert.strictEqual(records.length, 2);
    const rec1 = records.find((r) => r.memory_id === "aaaaaaaa-0000-0000-0000-000000000001");
    assert.ok(rec1, "should find record with memory_id 1");
    assert.strictEqual(rec1.memory_id, "aaaaaaaa-0000-0000-0000-000000000001");
    assert.strictEqual(rec1.category, "fact");
    assert.strictEqual(rec1.importance, 0.9);
    assert.strictEqual(rec1.title, "First Memory Title");
  });

  it("returns empty array when memories dir missing", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-rmn-"));
    mkdirSync(join(vault, "plur1bus"), { recursive: true });
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);
    assert.deepStrictEqual(records, []);
  });

  it("skips non-memory files (plur1bus_type !== memory)", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-rmn-"));
    const memoriesDir = join(vault, "plur1bus", "memories");
    mkdirSync(memoriesDir, { recursive: true });

    const memoryNote = [
      "---",
      "memory_id: aaaaaaaa-0000-0000-0000-000000000001",
      "plur1bus_type: memory",
      "category: fact",
      "importance: 0.8",
      "scope: workspace",
      "created_at: 2026-01-01T00:00:00.000Z",
      "content_hash: sha256:abc",
      "---",
      "",
      "# Memory Note",
    ].join("\n");

    const recordNote = [
      "---",
      "plur1bus_id: rec-001",
      "plur1bus_type: record",
      "category: decision",
      "importance: 0.5",
      "scope: workspace",
      "created_at: 2026-01-01T00:00:00.000Z",
      "content_hash: sha256:xyz",
      "---",
      "",
      "# Record Note",
    ].join("\n");

    writeFileSync(join(memoriesDir, "aaaaaaaa-0000-0000-0000-000000000001.md"), memoryNote, "utf8");
    writeFileSync(join(memoriesDir, "rec-001.md"), recordNote, "utf8");

    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].plur1bus_type, "memory");
  });

  it("returns null title when body has no heading", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-ri-"));
    const memoriesDir = join(vault, "plur1bus", "memories");
    mkdirSync(memoriesDir, { recursive: true });
    writeFileSync(
      join(memoriesDir, "aaaaaaaa-0000-0000-0000-000000000001.md"),
      [
        "---",
        "memory_id: aaaaaaaa-0000-0000-0000-000000000001",
        "plur1bus_type: memory",
        "category: fact",
        "importance: 0.5",
        "scope: agent-private",
        "created_at: 2026-01-01",
        "content_hash: sha256:abc",
        "---",
        "",
        "This note has no heading, just body text.",
      ].join("\n")
    );
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].title, null);
  });

  it("buildRecordIndex indexes by memory_id", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-bri-"));
    mkdirSync(join(vault, "plur1bus"), { recursive: true });

    const uuid = "aaaaaaaa-0000-0000-0000-000000000001";
    const records = [
      {
        memory_id: uuid,
        plur1bus_type: "memory",
        path: `memories/${uuid}.md`,
        title: "A Memory",
        importance: 0.9,
      },
    ];
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const index = buildRecordIndex(rawConfig, { records, readExistingRecords: false });

    assert.ok(index.byMemoryId, "index should have byMemoryId");
    assert.ok(index.byMemoryId[uuid], `byMemoryId should contain ${uuid}`);
    assert.strictEqual(index.byMemoryId[uuid].memory_id, uuid);
    assert.strictEqual(index.byMemoryId[uuid].title, "A Memory");
  });
});
