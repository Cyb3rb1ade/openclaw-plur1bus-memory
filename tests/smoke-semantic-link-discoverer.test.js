/**
 * Tests for link-index.js and semantic-link-discoverer.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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
  applySemanticLinkIndex,
  loadLanceDbVectorSidecar,
  joinMemoryMirrorVectorSidecar,
  planSemanticLinkIndexDryRun,
  readMemoryMirrorRecords,
  runSemanticLinkIndexBatch,
} from "../lib/obsidian/semantic-link-discoverer.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";

function semanticPolicy(vault, agentId = "main", workspaceIdentity = "workspace:v1:main") {
  return parseObsidianCommandPlan(["semantic-discovery", "confirm"], {
    memoryCtx: { agentId, workspaceIdentity },
    baseDbPath: vault,
    mode: "apply",
    allowWrite: true,
    vaultConfirmed: true,
    actionConfirmed: true,
  }).mutationPolicy;
}

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
    saveLinkIndex(vault, original, { mutationPolicy: semanticPolicy(vault) });
    const loaded = loadLinkIndex(vault);
    assert.strictEqual(loaded.version, "1");
    assert.deepStrictEqual(loaded.entries["rec-001"].similar, ["rec-002"]);
    assert.strictEqual(loaded.entries["rec-001"].contentHash, "sha256:abc123");
  });

  it("saveLinkIndex writes atomically to .plur1bus/ subfolder", () => {
    const vault = makeVault();
    saveLinkIndex(vault, { version: "1", entries: {} }, { mutationPolicy: semanticPolicy(vault) });
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

  it("blocks index writes without explicit confirm", async () => {
    const vault = makeVault();
    const idA = "aaaaaaaa-0000-0000-0000-000000000001";
    const idB = "aaaaaaaa-0000-0000-0000-000000000002";
    const records = [
      { id: idA, vector: [0.1], text: "hello", summary: "world" },
      { id: idB, vector: [0.2], text: "bye", summary: "later" },
    ];

    const result = await discoverSemanticLinks(baseConfig(vault), records, {
      pool: makePool([idB]),
      defaultAgentId: "main",
    });

    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, "bound_confirmation_required");
    assert.strictEqual(result.indexUpdated, false);
    assert.strictEqual(existsSync(join(vault, ".plur1bus", "link-index.json")), false);
  });

  it("processes a record and writes index when confirmed", async () => {
    const vault = makeVault();
    const idA = "aaaaaaaa-0000-0000-0000-000000000001";
    const idB = "aaaaaaaa-0000-0000-0000-000000000002";
    const records = [
      { id: idA, vector: [0.1], text: "hello", summary: "world" },
      { id: idB, vector: [0.2], text: "bye", summary: "later" },
    ];
    const pool = makePool([idB]);
    const result = await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main", confirm: true, mutationPolicy: semanticPolicy(vault) });
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
    await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main", confirm: true, mutationPolicy: semanticPolicy(vault) });
    const second = await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main", confirm: true, mutationPolicy: semanticPolicy(vault) });
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
    await discoverSemanticLinks(baseConfig(vault), records, { pool, defaultAgentId: "main", confirm: true, mutationPolicy: semanticPolicy(vault) });
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

  it("loads LanceDB vector sidecar with typed/toArray vectors and scope filtering", async () => {
    const result = await loadLanceDbVectorSidecar({}, {
      agentId: "main",
      workspaceId: "main",
      loadLanceDbRows: async () => [
        { id: "mem-main", type: "memory", vector: { toArray: () => Float32Array.from([0.1, 0.2, 0.3]) }, agentId: "main", workspaceId: "main" },
        { id: "mem-generated", type: "provenance", vector: [0.1, 0.2, 0.3], agentId: "main", workspaceId: "main" },
        { id: "mem-other", type: "memory", vector: Float32Array.from([0.1, 0.2, 0.3]), agentId: "other", workspaceId: "other" },
      ],
    });

    assert.strictEqual(result.records.length, 1);
    const vector = result.records[0].vector;
    assert.ok(Math.abs(vector[0] - 0.1) < 1e-6);
    assert.ok(Math.abs(vector[1] - 0.2) < 1e-6);
    assert.ok(Math.abs(vector[2] - 0.3) < 1e-6);
    assert.strictEqual(result.records[0].memory_id, "mem-main");
    assert.strictEqual(result.skipped.generated, 1);
    assert.strictEqual(result.skipped.scopeMismatch, 1);
    assert.strictEqual(result.skipped.withoutVector, 0);
  });

  it("plans semantic links deterministically without writing link-index.json", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "Alpha topic body.");
    writeMirror(vault, "mem-b", {}, "Beta topic body.");
    writeMirror(vault, "mem-c", {}, "Gamma topic body.");

    const result = await planSemanticLinkIndexDryRun({
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

  it("uses searchSimilar callback in ANN mode and remains deterministic", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "Alpha topic body.");
    writeMirror(vault, "mem-b", {}, "Beta topic body.");
    writeMirror(vault, "mem-c", {}, "Gamma topic body.");

    let calls = 0;
    const result = await planSemanticLinkIndexDryRun({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-c", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      searchSimilar: async (record, { topK }) => {
        calls++;
        assert.strictEqual(topK, 20);
        if (record.id === "mem-a") {
          return [
            { id: "mem-a", score: 0.99 },
            { id: "mem-b", score: 0.95 },
            { id: "mem-c", score: 0.95 },
            { id: "mem-zzz", score: 0.97 },
          ];
        }
        if (record.id === "mem-b") {
          return [{ id: "mem-c", score: 0.98 }, { id: "mem-a", score: 0.99 }];
        }
        return [{ id: "mem-a", score: 0.97 }, { id: "mem-b", score: 0.96 }];
      },
      maxSimilar: 2,
      threshold: 0.9,
      topK: 20,
    });

    assert.strictEqual(calls, 3);
    assert.strictEqual(result.searchCalls, 3);
    assert.deepStrictEqual(result.entries["mem-a"].similar, ["mem-b", "mem-c"]);
    assert.deepStrictEqual(result.entries["mem-a"].links.map((link) => link.id), ["mem-b", "mem-c"]);
    assert.strictEqual(result.entries["mem-a"].links.length, 2);
    assert.ok(result.entries["mem-a"].links[0].score >= result.entries["mem-a"].links[1].score);
  });

  it("filters ANN results: self-links, generated records, scope/status mismatches", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "Alpha topic body.");
    writeMirror(vault, "mem-b", {}, "Beta topic body.");
    writeMirror(vault, "mem-c", {}, "Gamma topic body.");

    const result = await planSemanticLinkIndexDryRun({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-c", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      searchSimilar: async () => [
        { id: "mem-a", score: 0.99 },
        { id: "mem-b", score: 0.95, type: "provenance" },
        { id: "mem-c", score: 0.93, status: "active", workspace_id: "other", agent_id: "other" },
        { id: "mem-x", score: 0.92, status: "archived" },
        { id: "mem-b", score: 0.91, memory_id: "mem-b", workspace_id: "main", agent_id: "main" },
      ],
      maxSimilar: 5,
      threshold: 0.9,
    });

    assert.deepStrictEqual(result.entries["mem-a"].similar, ["mem-b"]);
    assert.deepStrictEqual(result.entries["mem-a"].links.map((link) => link.id), ["mem-b"]);
  });

  it("does not index records without vectors", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a");
    writeMirror(vault, "mem-b");

    const result = await planSemanticLinkIndexDryRun({
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

  it("blocks semantic link-index apply without explicit confirm", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "One body.");

    const result = await applySemanticLinkIndex(
      {
        vaultPath: vault,
        reviewRoot: "plur1bus",
        agentId: "main",
        workspaceKey: "main",
      },
      {
        sidecarRecords: [
          { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        ],
      },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(existsSync(join(vault, ".plur1bus", "link-index.json")), false);
  });

  it("applies index only when confirm is true and keeps mirror files unchanged", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "Alpha body.");
    writeMirror(vault, "mem-b", {}, "Beta body.");
    const before = readFileSync(join(vault, "plur1bus", "memories", "mem-a.md"), "utf8");

    const result = await applySemanticLinkIndex(
      {
        vaultPath: vault,
        reviewRoot: "plur1bus",
        agentId: "main",
        workspaceKey: "main",
      },
      {
        confirm: true,
        mutationPolicy: semanticPolicy(vault),
        sidecarRecords: [
          { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
          { id: "mem-b", vector: [0.99, 0.01], agent_id: "main", workspace_id: "main" },
        ],
      },
    );

    const path = join(vault, ".plur1bus", "link-index.json");
    const afterMemA = readFileSync(join(vault, "plur1bus", "memories", "mem-a.md"), "utf8");
    const index = JSON.parse(readFileSync(path, "utf8"));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.updated, 1);
    assert.ok(existsSync(path));
    assert.deepStrictEqual(Object.keys(index.entries).sort(), ["mem-a", "mem-b"]);
    assert.strictEqual(before, afterMemA);
    assert.ok(result.manifestPath);
    assert.ok(existsSync(result.manifestPath));
  });

  it("is idempotent on second confirmed apply", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "Same body.");
    writeMirror(vault, "mem-b", {}, "Same body one.");
    const baseCfg = {
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    };
    const options = {
      confirm: true,
      mutationPolicy: semanticPolicy(vault),
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [0.99, 0.01], agent_id: "main", workspace_id: "main" },
      ],
    };
    const first = await applySemanticLinkIndex(baseCfg, options);
    const second = await applySemanticLinkIndex(baseCfg, options);

    assert.strictEqual(first.updated, 1);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.unchanged, 1);
    assert.deepStrictEqual(loadLinkIndex(vault).entries["mem-a"].similar.length > 0, true);
  });

  it("writes only workspace-scoped records into the index", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-main", { agent_id: "main", workspace_id: "main" }, "Main body.");
    writeMirror(vault, "mem-other", { agent_id: "other", workspace_id: "other" }, "Other body.");
    const result = await applySemanticLinkIndex(
      {
        vaultPath: vault,
        reviewRoot: "plur1bus",
        agentId: "main",
        workspaceKey: "main",
      },
      {
        confirm: true,
        mutationPolicy: semanticPolicy(vault),
        sidecarRecords: [
          { id: "mem-main", vector: [1, 0], agent_id: "main", workspace_id: "main" },
          { id: "mem-other", vector: [0.9, 0.1], agent_id: "other", workspace_id: "other" },
        ],
      },
    );

    const index = loadLinkIndex(vault);
    const keys = Object.keys(index.entries).sort();
    assert.strictEqual(result.updated, 1);
    assert.deepStrictEqual(keys, ["mem-main"]);
  });

  it("excludes generated records from confirmed apply index writes", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-good", {}, "Good body.");
    writeMirror(vault, "mem-provenance", { plur1bus_type: "provenance" }, "Bad body.");
    const result = await applySemanticLinkIndex(
      {
        vaultPath: vault,
        reviewRoot: "plur1bus",
        agentId: "main",
        workspaceKey: "main",
      },
      {
        confirm: true,
        mutationPolicy: semanticPolicy(vault),
        sidecarRecords: [
          { id: "mem-good", vector: [1, 0], agent_id: "main", workspace_id: "main" },
          { id: "mem-provenance", vector: [0.8, 0.2], agent_id: "main", workspace_id: "main" },
        ],
      },
    );

    const index = loadLinkIndex(vault);
    assert.strictEqual(result.updated, 1);
    assert.ok(index.entries["mem-good"]);
    assert.strictEqual(index.entries["mem-provenance"], undefined);
  });

  it("does not write index when no vectors are joinable", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-no-vector");
    const result = await applySemanticLinkIndex(
      {
        vaultPath: vault,
        reviewRoot: "plur1bus",
        agentId: "main",
        workspaceKey: "main",
      },
      {
        confirm: true,
        mutationPolicy: semanticPolicy(vault),
        sidecarRecords: [],
      },
    );

    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.unchanged, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "no_vector_matches");
    assert.strictEqual(existsSync(join(vault, ".plur1bus", "link-index.json")), false);
  });

  it("does not write when dedicated LanceDB loader has no vectors", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-no-loader");
    const result = await applySemanticLinkIndex(
      {
        vaultPath: vault,
        reviewRoot: "plur1bus",
        agentId: "main",
        workspaceKey: "main",
      },
      {
        confirm: true,
        mutationPolicy: semanticPolicy(vault),
        loadLanceDbRows: async () => [
          {
            id: "mem-no-loader",
            type: "memory",
            vector: null,
            agentId: "main",
            workspaceId: "main",
          },
        ],
      },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "no_vector_matches");
    assert.strictEqual(result.updated, 0);
  });

  it("writes manifest before writing link-index", async () => {
    const vault = makeMirrorVault();
    const manifestDir = join(vault, ".plur1bus", "apply-manifests");
    writeMirror(vault, "mem-a", {}, "Alpha.");
    writeMirror(vault, "mem-b", {}, "Beta.");

    const result = await applySemanticLinkIndex(
      {
        vaultPath: vault,
        reviewRoot: "plur1bus",
        agentId: "main",
        workspaceKey: "main",
      },
      {
        confirm: true,
        mutationPolicy: semanticPolicy(vault),
        manifestDir,
        sidecarRecords: [
          { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
          { id: "mem-b", vector: [0.4, 0.6], agent_id: "main", workspace_id: "main" },
        ],
      },
    );

    assert.ok(result.ok);
    assert.ok(result.manifestPath);
    assert.ok(result.manifestPath.startsWith(manifestDir));
    assert.ok(existsSync(result.manifestPath));
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.strictEqual(manifest.kind, "semantic-link-index");
    assert.strictEqual(manifest.entriesTotal, 2);
  });

  it("keeps dry-run resumable semantic-link batches entirely in memory", async () => {
    const vault = makeMirrorVault();
    writeMirror(vault, "mem-a", {}, "Alpha.");
    writeMirror(vault, "mem-b", {}, "Beta.");
    writeMirror(vault, "mem-c", {}, "Gamma.");
    const checkpointPath = join(vault, ".plur1bus", "tmp", "semantic-checkpoint.json");

    const first = await runSemanticLinkIndexBatch({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      checkpointPath,
      limit: 2,
      batchSize: 1,
      concurrency: 2,
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-c", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      searchSimilar: async (record) => record.id === "mem-a"
        ? [{ id: "mem-b", score: 0.98 }, { id: "mem-a", score: 1 }]
        : [{ id: "mem-a", score: 0.97 }],
    });

    assert.strictEqual(first.dryRun, true);
    assert.strictEqual(first.processed, 2);
    assert.strictEqual(first.nextOffset, 2);
    assert.strictEqual(first.concurrency, 2);
    assert.strictEqual(first.complete, false);
    assert.strictEqual(existsSync(checkpointPath), false);
    assert.strictEqual(existsSync(join(vault, ".plur1bus", "link-index.json")), false);

    const second = await runSemanticLinkIndexBatch({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      checkpointPath,
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-c", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      searchSimilar: async () => [{ id: "mem-a", score: 0.96 }],
    });

    assert.strictEqual(second.offset, 0);
    assert.strictEqual(second.processed, 3);
    assert.strictEqual(second.complete, true);
    assert.strictEqual(Object.keys(second.entries).sort().join(","), "mem-a,mem-b,mem-c");
  });

  it("confirmed resumable batch writes final index and manifest only when complete", async () => {
    const vault = makeMirrorVault();
    const manifestDir = join(vault, ".plur1bus", "apply-manifests");
    writeMirror(vault, "mem-a", {}, "Alpha.");
    writeMirror(vault, "mem-b", {}, "Beta.");
    const checkpointPath = join(vault, ".plur1bus", "tmp", "semantic-checkpoint.json");

    const partial = await runSemanticLinkIndexBatch({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      confirm: true,
      mutationPolicy: semanticPolicy(vault),
      checkpointPath,
      manifestDir,
      limit: 1,
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      searchSimilar: async () => [{ id: "mem-b", score: 0.97 }],
    });

    assert.strictEqual(partial.complete, false);
    assert.strictEqual(partial.updated, 0);
    assert.strictEqual(existsSync(join(vault, ".plur1bus", "link-index.json")), false);

    const done = await runSemanticLinkIndexBatch({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      confirm: true,
      mutationPolicy: semanticPolicy(vault),
      checkpointPath,
      manifestDir,
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      searchSimilar: async (record) => record.id === "mem-a" ? [{ id: "mem-b", score: 0.97 }] : [{ id: "mem-a", score: 0.97 }],
    });

    assert.strictEqual(done.complete, true);
    assert.strictEqual(done.updated, 1);
    assert.ok(done.manifestPath);
    assert.strictEqual(existsSync(done.manifestPath), true);
    assert.strictEqual(existsSync(join(vault, ".plur1bus", "link-index.json")), true);

    const repeat = await runSemanticLinkIndexBatch({
      vaultPath: vault,
      reviewRoot: "plur1bus",
      agentId: "main",
      workspaceKey: "main",
    }, {
      confirm: true,
      mutationPolicy: semanticPolicy(vault),
      checkpointPath,
      manifestDir,
      sidecarRecords: [
        { id: "mem-a", vector: [1, 0], agent_id: "main", workspace_id: "main" },
        { id: "mem-b", vector: [1, 0], agent_id: "main", workspace_id: "main" },
      ],
      searchSimilar: async (record) => record.id === "mem-a" ? [{ id: "mem-b", score: 0.97 }] : [{ id: "mem-a", score: 0.97 }],
    });

    assert.strictEqual(repeat.updated, 0);
    assert.strictEqual(repeat.unchanged, 1);
  });
});
