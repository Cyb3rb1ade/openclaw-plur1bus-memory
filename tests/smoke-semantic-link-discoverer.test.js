/**
 * Tests for link-index.js and semantic-link-discoverer.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeContentHash,
  buildPriorityQueue,
  loadLinkIndex,
  saveLinkIndex,
} from "../lib/obsidian/link-index.js";
import {
  joinMemoryMirrorVectorSidecar,
  planSemanticLinkIndexDryRun,
  readMemoryMirrorRecords,
} from "../lib/obsidian/semantic-link-discoverer.js";

describe("link-index: computeContentHash", () => {
  it("returns deterministic sha256 string", () => {
    const r = { text: "hello", summary: "world" };
    const h1 = computeContentHash(r);
    const h2 = computeContentHash(r);
    assert.strictEqual(h1, h2);
    assert.match(h1, /^sha256:[a-f0-9]{64}$/);
  });

  it("tolerates missing summary", () => {
    const h = computeContentHash({ text: "only text" });
    assert.match(h, /^sha256:[a-f0-9]{64}$/);
  });

  it("is stable — same input always produces same hash", () => {
    const a = computeContentHash({ text: "abc", summary: "def" });
    const b = computeContentHash({ text: "abc", summary: "def" });
    assert.strictEqual(a, b);
  });

  it("changes when content changes", () => {
    const a = computeContentHash({ text: "abc", summary: "def" });
    const b = computeContentHash({ text: "xyz", summary: "def" });
    assert.notStrictEqual(a, b);
  });
});

describe("link-index: buildPriorityQueue", () => {
  it("puts never-processed records first", () => {
    const records = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [1] },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", vector: [1] },
      { id: "aaaaaaaa-0000-0000-0000-000000000003", vector: [1] },
    ];
    const index = {
      entries: {
        "aaaaaaaa-0000-0000-0000-000000000001": { similar: [], contentHash: "sha256:abc", firstDiscoveredAt: "2026-01-01T00:00:00.000Z", lastCheckedAt: "2026-01-02T00:00:00.000Z" },
      },
    };
    const queue = buildPriorityQueue(records, index);
    assert.strictEqual(queue[0].id, "aaaaaaaa-0000-0000-0000-000000000002");
    assert.strictEqual(queue[1].id, "aaaaaaaa-0000-0000-0000-000000000003");
    assert.strictEqual(queue[2].id, "aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("sorts processed records by oldest lastCheckedAt", () => {
    const records = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [1] },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", vector: [1] },
    ];
    const index = {
      entries: {
        "aaaaaaaa-0000-0000-0000-000000000001": { lastCheckedAt: "2026-06-01T00:00:00.000Z", similar: [], contentHash: "x", firstDiscoveredAt: "2026-01-01T00:00:00.000Z" },
        "aaaaaaaa-0000-0000-0000-000000000002": { lastCheckedAt: "2026-05-01T00:00:00.000Z", similar: [], contentHash: "y", firstDiscoveredAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    const queue = buildPriorityQueue(records, index);
    assert.strictEqual(queue[0].id, "aaaaaaaa-0000-0000-0000-000000000002");
    assert.strictEqual(queue[1].id, "aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("skips records without id", () => {
    const records = [
      { path: "records/x.md", vector: [1] },
      { id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [1] },
    ];
    const queue = buildPriorityQueue(records, { entries: {} });
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].id, "aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("returns empty array when records is empty", () => {
    const queue = buildPriorityQueue([], { entries: {} });
    assert.deepStrictEqual(queue, []);
  });

  it("returns all records when none are in the index", () => {
    const records = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [1] },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", vector: [1] },
    ];
    const queue = buildPriorityQueue(records, { entries: {} });
    assert.strictEqual(queue.length, 2);
    assert.strictEqual(queue[0].id, "aaaaaaaa-0000-0000-0000-000000000001");
    assert.strictEqual(queue[1].id, "aaaaaaaa-0000-0000-0000-000000000002");
  });

  it("handles null existingIndex gracefully", () => {
    const records = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [1] }];
    const queue = buildPriorityQueue(records, null);
    assert.strictEqual(queue.length, 1);
  });
});

describe("link-index: loadLinkIndex / saveLinkIndex", () => {
  function makeVault() {
    return mkdtempSync(join(tmpdir(), "plur1bus-li-"));
  }

  it("loadLinkIndex returns empty index when file missing", () => {
    const vault = makeVault();
    const idx = loadLinkIndex(vault);
    assert.strictEqual(idx.version, "1");
    assert.deepStrictEqual(idx.entries, {});
  });

  it("saveLinkIndex + loadLinkIndex roundtrip", () => {
    const vault = makeVault();
    const now = new Date().toISOString();
    const original = {
      version: "1",
      generatedAt: now,
      threshold: 0.78,
      entries: {
        "rec-001": {
          similar: ["rec-002"],
          contentHash: "sha256:abc123",
          firstDiscoveredAt: now,
          lastCheckedAt: now,
        },
      },
    };
    saveLinkIndex(vault, original);
    const loaded = loadLinkIndex(vault);
    assert.strictEqual(loaded.version, "1");
    assert.deepStrictEqual(loaded.entries["rec-001"].similar, ["rec-002"]);
    assert.strictEqual(loaded.entries["rec-001"].contentHash, "sha256:abc123");
  });

  it("saveLinkIndex writes atomically to .plur1bus/ subfolder", () => {
    const vault = makeVault();
    saveLinkIndex(vault, { version: "1", entries: {} });
    assert.ok(existsSync(join(vault, ".plur1bus", "link-index.json")));
  });
});

import { discoverSemanticLinks } from "../lib/obsidian/semantic-link-discoverer.js";

describe("discoverSemanticLinks", () => {
  function makeVault() {
    return mkdtempSync(join(tmpdir(), "plur1bus-sld-"));
  }

  // pool.getDb() returns a MemoryDB-like object.
  // db.search() returns [{ entry: { id }, score }] — matching real MemoryDB.search() format.
  function makePool(searchEntries = []) {
    const searchResults = searchEntries.map((id) => ({ entry: { id }, score: 0.9 }));
    return {
      getDb: (_agentId) => ({
        search: async (_vector, _topN, _threshold) => searchResults,
      }),
    };
  }

  const baseConfig = (vault) => ({
    vaultPath: vault,
    reviewRoot: "plur1bus",
  });

  it("throws when pool not provided", async () => {
    const vault = makeVault();
    const records = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [0.1] }];
    await assert.rejects(
      () => discoverSemanticLinks(baseConfig(vault), records, {}),
      /pool/
    );
  });

  it("returns zero counts for empty records array", async () => {
    const vault = makeVault();
    const result = await discoverSemanticLinks(baseConfig(vault), [], { pool: makePool(), defaultAgentId: "main" });
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(result.indexUpdated, false);
  });

  it("skips records without vector", async () => {
    const vault = makeVault();
    const records = [{ id: "aaaaaaaa-0000-0000-0000-000000000001" }];
    const result = await discoverSemanticLinks(baseConfig(vault), records, { pool: makePool(), defaultAgentId: "main" });
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.processed, 0);
  });

  it("processes a record and writes index", async () => {
    const vault = makeVault();
    const idA = "aaaaaaaa-0000-0000-0000-000000000001";
    const idB = "aaaaaaaa-0000-0000-0000-000000000002";
    const records = [
      { id: idA, vector: [0.1], text: "hello", summary: "world" },
      { id: idB, vector: [0.2], text: "bye", summary: "later" },
    ];
    const pool = makePool([idB]);
    const result = await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main" });
    assert.ok(result.processed >= 1);
    assert.strictEqual(result.indexUpdated, true);
    const idx = loadLinkIndex(vault);
    // At minimum, check idA was processed and its similar list contains idB
    assert.ok(result.processed >= 1);
    const entryA = idx.entries[idA];
    assert.ok(entryA, "idA should have an index entry");
    assert.ok(Array.isArray(entryA.similar), "similar should be an array");
    assert.ok(entryA.similar.includes(idB), "idA similar list should include idB");
    assert.ok(!entryA.similar.includes(idA), "idA should not link to itself");
  });

  it("is idempotent — second run with same contentHash returns unchanged", async () => {
    const vault = makeVault();
    const idA = "aaaaaaaa-0000-0000-0000-000000000001";
    const records = [{ id: idA, vector: [0.1], text: "hello", summary: "world" }];
    const pool = makePool(["aaaaaaaa-0000-0000-0000-000000000002"]);
    await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main" });
    const second = await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main" });
    assert.strictEqual(second.unchanged, 1);
    assert.strictEqual(second.processed, 0);
    assert.strictEqual(second.indexUpdated, false);
  });

  it("respects maxPerRun — processes only first N records", async () => {
    const vault = makeVault();
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `aaaaaaaa-0000-0000-0000-00000000000${i}`,
      vector: [i * 0.1],
      text: `text${i}`, summary: "",
    }));
    const result = await discoverSemanticLinks(
      { ...baseConfig(vault), graphLinks: { semanticDiscovery: { maxPerRun: 3, threshold: 0.5 } } },
      records,
      { pool: makePool([]), defaultAgentId: "main" }
    );
    assert.strictEqual(result.processed + result.skipped + result.unchanged, 3);
  });

  it("excludes self from similar results", async () => {
    const vault = makeVault();
    const selfId = "aaaaaaaa-0000-0000-0000-000000000001";
    const records = [{ id: selfId, vector: [0.1], text: "t", summary: "" }];
    // search returns self + other
    const pool = makePool([selfId, "aaaaaaaa-0000-0000-0000-000000000002"]);
    await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main" });
    const idx = loadLinkIndex(vault);
    assert.ok(!idx.entries[selfId]?.similar.includes(selfId));
  });

  it("aborts batch on 429 and returns batchAborted=true", async () => {
    const vault = makeVault();
    const records = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [0.1], text: "t", summary: "" },
    ];
    const pool = {
      getDb: () => ({
        search: async () => { const e = new Error("429 Too Many Requests"); e.status = 429; throw e; },
      }),
    };
    const result = await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main" });
    assert.strictEqual(result.batchAborted, true);
  });
});

describe("semantic-link dry-run from memory mirrors", () => {
  function makeMirrorVault() {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-mirror-dry-"));
    mkdirSync(join(vault, "plur1bus", "memories"), { recursive: true });
    return vault;
  }

  function writeMirror(vault, id, frontmatter = {}, body = "Body text with enough content for indexing.") {
    const fm = {
      memory_id: id,
      plur1bus_type: "memory",
      agent_id: "main",
      workspace_id: "main",
      content_hash: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
      ...frontmatter,
    };
    const lines = ["---"];
    for (const [key, value] of Object.entries(fm)) lines.push(`${key}: ${value}`);
    lines.push("---", "", `# Title ${id}`, "", body);
    writeFileSync(join(vault, "plur1bus", "memories", `${id}.md`), lines.join("\n"), "utf8");
  }

  it("reads memory mirror records with body text and workspace scope", () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a");

    const result = readMemoryMirrorRecords({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    });

    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.skipped.scopeMismatch, 0);
    assert.strictEqual(result.records[0].id, "mem-a");
    assert.strictEqual(result.records[0].memory_id, "mem-a");
    assert.strictEqual(result.records[0].agent_id, "main");
    assert.strictEqual(result.records[0].workspace_id, "main");
    assert.match(result.records[0].text, /Body text/);
    assert.strictEqual(result.records[0].title, "Title mem-a");
  });

  it("excludes generated records from memory mirror input", () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-generated", { plur1bus_type: "provenance" });

    const result = readMemoryMirrorRecords({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    });

    assert.strictEqual(result.records.length, 0);
    assert.strictEqual(result.skipped.generated, 1);
  });

  it("skips memory mirrors with mismatched workspace scope", () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-wrong-scope", { workspace_id: "other" });

    const result = readMemoryMirrorRecords({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    });

    assert.strictEqual(result.records.length, 0);
    assert.strictEqual(result.skipped.scopeMismatch, 1);
  });

  it("joins LanceDB vectors only for matching workspace and agent scope", () => {
    const mirrors = [
      { id: "mem-a", memory_id: "mem-a", agent_id: "main", workspace_id: "main", text: "a" },
      { id: "mem-b", memory_id: "mem-b", agent_id: "main", workspace_id: "main", text: "b" },
    ];
    const sidecar = [
      { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      { id: "mem-b", vector: [0, 1], agent_id: "other", workspace_id: "other" },
    ];

    const result = joinMemoryMirrorVectorSidecar(mirrors, sidecar, { agentId: "main", workspaceId: "main" });

    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.records[0].id, "mem-a");
    assert.deepStrictEqual(result.records[0].vector, [1, 0]);
    assert.strictEqual(result.skippedWithoutVector, 1);
    assert.strictEqual(result.skippedScopeMismatch, 1);
  });

  it("plans semantic links deterministically without writing link-index.json", () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "Alpha topic body.");
    writeMirror(vault, "mem-b", {}, "Beta topic body.");
    writeMirror(vault, "mem-c", {}, "Gamma topic body.");

    const result = planSemanticLinkIndexDryRun({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-c", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      maxSimilar: 2,
    });

    assert.strictEqual(result.indexableRecords, 3);
    assert.deepStrictEqual(result.entries["mem-a"].similar, ["mem-b", "mem-c"]);
    assert.ok(result.entries["mem-a"].links.every((link) => typeof link.score === "number"));
    assert.strictEqual(existsSync(join(vault, ".plur1bus", "link-index.json")), false);
  });

  it("does not index records without vectors", () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a");
    writeMirror(vault, "mem-b");

    const result = planSemanticLinkIndexDryRun({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      maxSimilar: 5,
    });

    assert.strictEqual(result.indexableRecords, 1);
    assert.strictEqual(result.skippedWithoutVector, 1);
    assert.deepStrictEqual(Object.keys(result.entries), ["mem-a"]);
  });
});
