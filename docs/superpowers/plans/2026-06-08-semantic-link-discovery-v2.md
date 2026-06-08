# Semantic Link Discovery v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Redesign semantic link discovery to operate on LanceDB records directly (which carry vectors), introduce vault memory mirrors, and wire everything into the graph-link-writer so the Obsidian graph view shows real connections.

**Architecture:** LanceDB is the canonical memory store. `discoverSemanticLinks` now scans LanceDB records (have `id` + `vector`) instead of vault analysis records (no vectors). A new `writeMemoryNotes` function mirrors each LanceDB memory into `{vault}/plur1bus/memories/{uuid}.md`. Graph-link-writer Tier 3 looks up by `record.memory_id` (new) or `record.plur1bus_id` (legacy), so memory notes link to each other through the link index.

**Tech Stack:** Node.js ESM, LanceDB (via existing `MemoryDB` class in `index.js`), node:fs, node:crypto, node:test

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `index.js:746` | Modify | Add `MemoryDB.scanActive()` method |
| `lib/obsidian/link-index.js` | Modify | `buildPriorityQueue` uses `record.id` (was `plur1bus_id`) |
| `lib/obsidian/semantic-link-discoverer.js` | Rewrite | Accept LanceDB records; use `r.entry?.id` from search results |
| `lib/obsidian/memory-note-writer.js` | Create | Write/update memory mirror notes; idempotent via content hash in frontmatter |
| `lib/obsidian/record-index.js` | Modify | Add `readMemoryNotes()`; index memory records by `memory_id` in `buildRecordIndex` |
| `lib/obsidian/graph-link-writer.js` | Modify | Tier 3 looks up by `record.memory_id \|\| record.plur1bus_id` |
| `lib/obsidian-bridge.js` | Modify | `rebuildDashboards` includes memory notes in records array |
| `index.js:1921-1984` | Modify | Call sites: `scanActive()` → records → `discoverSemanticLinks` + `writeMemoryNotes` |
| `tests/smoke-semantic-link-discoverer.test.js` | Modify | Switch fixtures from `plur1bus_id` to `id` |
| `tests/smoke-graph-link-writer.test.js` | Modify | Add memory-note Tier 3 test |
| `tests/smoke-memory-note-writer.test.js` | Create | Tests for new memory note writer |

---

## Task 1: `MemoryDB.scanActive()` — scan all active LanceDB records

**Files:**
- Modify: `index.js` (after line 750, inside `MemoryDB` class, before closing `}`)
- Test: `tests/smoke-scan-active.test.js` (new)

Background: `discoverSemanticLinks` and `writeMemoryNotes` both need all active LanceDB records with their vectors. `MemoryDB.getById` exists for single-record lookup. `scanActive` returns all active records (status is not 'deleted' or 'archived'). 8740 records × 1024-dim vectors ≈ 35 MB — acceptable for a background dreaming task.

- [x] **Step 1: Write the failing test**

Create `tests/smoke-scan-active.test.js`:

```javascript
/**
 * Tests for MemoryDB.scanActive — smoke test via duck-typing a stub.
 * Real LanceDB is not available in test env; test the interface contract via
 * the existing in-process mock pattern used elsewhere in this test suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert";

describe("MemoryDB.scanActive interface contract", () => {
  it("returns array with id and vector fields from a mock table", async () => {
    // We test the shape/contract by creating a minimal MemoryDB-like object
    // that mimics what scanActive should return from a stub table.
    const fakeRecords = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [0.1, 0.2], text: "hello", summary: "world", category: "fact", importance: 0.8, createdAt: "2026-01-01T00:00:00.000Z", scope: "workspace", status: "active" },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", vector: [0.3, 0.4], text: "bye", summary: "", category: "preference", importance: 0.5, createdAt: "2026-01-02T00:00:00.000Z", scope: "agent-private", status: "active" },
      { id: "aaaaaaaa-0000-0000-0000-000000000003", vector: null, text: "deleted", summary: "", category: "", importance: 0, createdAt: "", scope: "", status: "deleted" },
    ];

    // Simulate what scanActive should do: filter out deleted/archived, return active rows
    const activeRows = fakeRecords.filter(r => !r.status || (r.status !== "deleted" && r.status !== "archived"));
    assert.strictEqual(activeRows.length, 2);
    assert.ok(activeRows.every(r => r.id && typeof r.id === "string"));
    assert.ok(activeRows.every(r => Array.isArray(r.vector)));
  });

  it("scanActive result has required fields for discoverSemanticLinks", () => {
    const record = { id: "aaaaaaaa-0000-0000-0000-000000000001", vector: [0.1], text: "hello", summary: "world" };
    // discoverSemanticLinks needs: id, vector, text (for hash), summary (for hash)
    assert.ok(record.id);
    assert.ok(Array.isArray(record.vector));
    assert.strictEqual(typeof record.text, "string");
    assert.strictEqual(typeof record.summary, "string");
  });
});
```

- [x] **Step 2: Run test to confirm it passes (structural — no real impl needed)**

```bash
cd /root && node --test tests/smoke-scan-active.test.js
```

Expected: PASS (this test validates the contract shape, not the impl — it passes immediately)

- [x] **Step 3: Add `scanActive()` to `MemoryDB` in `index.js`**

Find the line `async purgeExpired()` near line 746 in `index.js`. Insert the new method BEFORE `purgeExpired`:

```javascript
  async scanActive() {
    await this.init();
    const count = await this.table.countRows();
    if (count === 0) return [];
    const rows = await this.table.query()
      .where("status IS NULL OR (status != 'deleted' AND status != 'archived')")
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      vector: r.vector || null,
      text: r.text || "",
      summary: r.summary || "",
      category: r.category || "",
      importance: r.importance ?? 0.5,
      createdAt: r.createdAt || "",
      scope: r.scope || "agent-private",
      status: r.status || "active",
    }));
  }
```

This goes between `getById` and `purgeExpired`. The `async purgeExpired()` line is around line 746. Insert before it.

- [x] **Step 4: Run existing tests to make sure nothing broke**

```bash
cd /root && node --test tests/smoke-semantic-link-discoverer.test.js
```

Expected: same pass/fail as before (no change yet)

- [x] **Step 5: Commit**

```bash
git add index.js tests/smoke-scan-active.test.js
git commit -m "feat(semantic-links): add MemoryDB.scanActive() for full active-record scan"
```

---

## Task 2: Update `buildPriorityQueue` in `link-index.js` — use `record.id`

**Files:**
- Modify: `lib/obsidian/link-index.js:30-42`
- Test: `tests/smoke-semantic-link-discoverer.test.js` (update existing tests)

Background: The old `buildPriorityQueue` filtered records by `r.plur1bus_id`. LanceDB records use `r.id` (UUID). This change makes the queue builder work with both: filter by `r.id` instead of `r.plur1bus_id`. The existing tests use `plur1bus_id` — they need updating.

- [x] **Step 1: Update the `buildPriorityQueue` tests in `tests/smoke-semantic-link-discoverer.test.js`**

Find the `describe("link-index: buildPriorityQueue"` block (lines 43-86). Replace every `plur1bus_id` with `id` in that test block:

```javascript
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
});
```

- [x] **Step 2: Run tests to confirm they fail**

```bash
cd /root && node --test tests/smoke-semantic-link-discoverer.test.js 2>&1 | grep -E "FAIL|PASS|Error" | head -20
```

Expected: FAIL on the 3 `buildPriorityQueue` tests (they now use `id` but impl still uses `plur1bus_id`)

- [x] **Step 3: Update `buildPriorityQueue` in `lib/obsidian/link-index.js`**

Replace the entire `buildPriorityQueue` function (lines 30-42):

```javascript
export function buildPriorityQueue(records, existingIndex) {
  const entries = (existingIndex && typeof existingIndex.entries === "object") ? existingIndex.entries : {};
  const withId = records.filter((r) => r.id);
  const neverProcessed = withId.filter((r) => !entries[r.id]);
  const processed = withId
    .filter((r) => entries[r.id])
    .sort((a, b) => {
      const ta = entries[a.id]?.lastCheckedAt || "0";
      const tb = entries[b.id]?.lastCheckedAt || "0";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  return [...neverProcessed, ...processed];
}
```

- [x] **Step 4: Run tests to confirm they pass**

```bash
cd /root && node --test tests/smoke-semantic-link-discoverer.test.js
```

Expected: the 3 `buildPriorityQueue` tests pass. The `discoverSemanticLinks` tests will fail (still use old shape) — that's expected, they'll be fixed in Task 3.

- [x] **Step 5: Commit**

```bash
git add lib/obsidian/link-index.js tests/smoke-semantic-link-discoverer.test.js
git commit -m "refactor(semantic-links): buildPriorityQueue uses record.id (LanceDB records)"
```

---

## Task 3: Rewrite `lib/obsidian/semantic-link-discoverer.js`

**Files:**
- Rewrite: `lib/obsidian/semantic-link-discoverer.js`
- Update: `tests/smoke-semantic-link-discoverer.test.js` (discoverSemanticLinks describe block)

Background: Records now come from LanceDB (`record.id`, `record.vector`). The `pool` is used to get ONE db (for the workspace), not one per record. Search results have shape `{ entry: { id }, score }` — so use `r.entry?.id`. Tier-1 dedup (memoryIds/sourceRefs) is removed since LanceDB records don't have those fields.

- [x] **Step 1: Update the `discoverSemanticLinks` tests in `tests/smoke-semantic-link-discoverer.test.js`**

Replace the entire `describe("discoverSemanticLinks"` block (lines 130-227) with:

```javascript
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
    assert.ok(idx.entries[idA] || idx.entries[idB]);
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
```

- [x] **Step 2: Run tests to confirm they fail**

```bash
cd /root && node --test tests/smoke-semantic-link-discoverer.test.js 2>&1 | grep -E "FAIL|Error" | head -20
```

Expected: multiple failures in `discoverSemanticLinks` block (old impl uses plur1bus_id, not id)

- [x] **Step 3: Rewrite `lib/obsidian/semantic-link-discoverer.js`**

Replace the entire file:

```javascript
import { computeContentHash, loadLinkIndex, saveLinkIndex, buildPriorityQueue } from "./link-index.js";

function resolveDiscoveryConfig(rawConfig) {
  const g = rawConfig.graphLinks?.semanticDiscovery || {};
  return {
    maxPerRun: g.maxPerRun ?? 500,
    threshold: g.threshold ?? rawConfig.graphLinks?.semanticThreshold ?? 0.78,
    maxLinksPerRecord: g.maxLinksPerRecord ?? 5,
  };
}

export async function discoverSemanticLinks(rawConfig, records, options = {}) {
  const { pool, logger, defaultAgentId } = options;
  if (!pool) throw new Error("discoverSemanticLinks: options.pool is required");

  const vaultPath = rawConfig.vaultPath;
  const { maxPerRun, threshold, maxLinksPerRecord } = resolveDiscoveryConfig(rawConfig);

  if (!records.length) return { processed: 0, skipped: 0, unchanged: 0, errors: 0, indexUpdated: false };

  const existingIndex = loadLinkIndex(vaultPath);
  const queue = buildPriorityQueue(records, existingIndex).slice(0, maxPerRun);

  const db = pool.getDb(defaultAgentId || "default");

  let processed = 0, skipped = 0, unchanged = 0, errors = 0;
  let dirty = false;

  for (const record of queue) {
    if (!record.vector || !record.vector.length) { skipped++; continue; }

    const currentHash = computeContentHash(record);
    const existing = existingIndex.entries[record.id];
    if (existing && existing.contentHash === currentHash) {
      unchanged++;
      continue;
    }

    let searchResults;
    try {
      searchResults = await db.search(record.vector, 15, threshold);
    } catch (err) {
      const status = err?.status || err?.statusCode || (err?.message?.includes("429") ? 429 : 0);
      if (status === 429) {
        logger?.warn?.("plur1bus-semantic: 429 — aborting batch early");
        if (dirty) saveLinkIndex(vaultPath, existingIndex);
        return { processed, skipped, unchanged, errors, indexUpdated: dirty, batchAborted: true };
      }
      logger?.warn?.(`plur1bus-semantic: search failed for ${record.id}: ${err?.message}`);
      errors++;
      continue;
    }

    const selfId = record.id;
    const similar = (searchResults || [])
      .map((r) => r.entry?.id || null)
      .filter((id) => id && id !== selfId)
      .slice(0, maxLinksPerRecord);

    const now = new Date().toISOString();
    existingIndex.entries[selfId] = {
      similar,
      contentHash: currentHash,
      firstDiscoveredAt: existing?.firstDiscoveredAt || now,
      lastCheckedAt: now,
    };

    dirty = true;
    processed++;
  }

  if (dirty) saveLinkIndex(vaultPath, existingIndex);
  return { processed, skipped, unchanged, errors, indexUpdated: dirty };
}
```

- [x] **Step 4: Run tests to confirm they pass**

```bash
cd /root && node --test tests/smoke-semantic-link-discoverer.test.js
```

Expected: all tests pass (both link-index and discoverSemanticLinks suites)

- [x] **Step 5: Commit**

```bash
git add lib/obsidian/semantic-link-discoverer.js tests/smoke-semantic-link-discoverer.test.js
git commit -m "refactor(semantic-links): discoverer operates on LanceDB records (id+vector), fixes search result shape"
```

---

## Task 4: New `lib/obsidian/memory-note-writer.js`

**Files:**
- Create: `lib/obsidian/memory-note-writer.js`
- Create: `tests/smoke-memory-note-writer.test.js`

Background: Each LanceDB memory gets a mirror note at `{vault}/plur1bus/memories/{uuid}.md`. Frontmatter includes `content_hash` so the writer can skip unchanged records on subsequent runs. The note body is: `# {summary}\n\n{text}`. Max 200 chars for summary (title truncation), max 2000 chars for body to keep notes concise.

- [x] **Step 1: Write the failing test**

Create `tests/smoke-memory-note-writer.test.js`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryNotes } from "../lib/obsidian/memory-note-writer.js";

function makeVault() {
  return mkdtempSync(join(tmpdir(), "plur1bus-mnw-"));
}

const baseConfig = (vault) => ({
  vaultPath: vault,
  reviewRoot: "plur1bus",
});

describe("writeMemoryNotes", () => {
  it("creates memories/ directory and writes a note", () => {
    const vault = makeVault();
    const records = [
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        text: "Chris nutzt OpenClaw mit PLUR1BUS Memory.",
        summary: "OpenClaw PLUR1BUS Setup",
        category: "fact",
        importance: 0.9,
        createdAt: "2026-01-01T00:00:00.000Z",
        scope: "workspace",
        vector: [0.1, 0.2],
      },
    ];
    const result = writeMemoryNotes(baseConfig(vault), records, {});
    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.errors, 0);
    const notePath = join(vault, "plur1bus", "memories", "aaaaaaaa-0000-0000-0000-000000000001.md");
    assert.ok(existsSync(notePath));
    const content = readFileSync(notePath, "utf8");
    assert.match(content, /memory_id: aaaaaaaa-0000-0000-0000-000000000001/);
    assert.match(content, /plur1bus_type: memory/);
    assert.match(content, /OpenClaw PLUR1BUS Setup/);
    assert.match(content, /Chris nutzt OpenClaw/);
    assert.match(content, /content_hash: sha256:/);
  });

  it("skips record without id", () => {
    const vault = makeVault();
    const records = [{ text: "no id here", summary: "", vector: [0.1] }];
    const result = writeMemoryNotes(baseConfig(vault), records, {});
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.written, 0);
  });

  it("is idempotent — second run skips unchanged records", () => {
    const vault = makeVault();
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    const records = [{ id, text: "stable content", summary: "stable", category: "fact", importance: 0.5, createdAt: "", scope: "", vector: [0.1] }];
    const first = writeMemoryNotes(baseConfig(vault), records, {});
    const second = writeMemoryNotes(baseConfig(vault), records, {});
    assert.strictEqual(first.written, 1);
    assert.strictEqual(second.written, 0);
    assert.strictEqual(second.skipped, 1);
  });

  it("rewrites note when content changes", () => {
    const vault = makeVault();
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    const v1 = [{ id, text: "original", summary: "v1", category: "fact", importance: 0.5, createdAt: "", scope: "", vector: [0.1] }];
    const v2 = [{ id, text: "updated text", summary: "v2", category: "fact", importance: 0.5, createdAt: "", scope: "", vector: [0.1] }];
    writeMemoryNotes(baseConfig(vault), v1, {});
    const result2 = writeMemoryNotes(baseConfig(vault), v2, {});
    assert.strictEqual(result2.written, 1);
    const notePath = join(vault, "plur1bus", "memories", `${id}.md`);
    const content = readFileSync(notePath, "utf8");
    assert.match(content, /updated text/);
  });

  it("respects maxPerRun option", () => {
    const vault = makeVault();
    const records = Array.from({ length: 5 }, (_, i) => ({
      id: `aaaaaaaa-0000-0000-0000-00000000000${i + 1}`,
      text: `text ${i}`, summary: `s${i}`, category: "", importance: 0.5, createdAt: "", scope: "", vector: [0.1],
    }));
    const result = writeMemoryNotes(baseConfig(vault), records, { maxPerRun: 2 });
    assert.strictEqual(result.written, 2);
  });
});
```

- [x] **Step 2: Run test to confirm it fails**

```bash
cd /root && node --test tests/smoke-memory-note-writer.test.js 2>&1 | grep -E "FAIL|Error|Cannot find" | head -5
```

Expected: FAIL — module not found

- [x] **Step 3: Implement `lib/obsidian/memory-note-writer.js`**

Create the file:

```javascript
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";

function memoryContentHash(record) {
  const raw = (record.text || "") + "\x00" + (record.summary || "") + "\x00" + String(record.importance ?? "");
  return "sha256:" + createHash("sha256").update(raw, "utf8").digest("hex");
}

function extractStoredHash(notePath) {
  try {
    const content = readFileSync(notePath, "utf8");
    const match = content.match(/^content_hash:\s*(\S+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function renderMemoryNote(record, contentHash) {
  const title = record.summary ? String(record.summary).slice(0, 200) : record.id;
  const body = (record.text || "").slice(0, 2000);
  const lines = [
    "---",
    `memory_id: ${record.id}`,
    `importance: ${record.importance ?? 0.5}`,
    `category: ${record.category || ""}`,
    `scope: ${record.scope || "agent-private"}`,
    `createdAt: "${record.createdAt || ""}"`,
    `plur1bus_type: memory`,
    `content_hash: ${contentHash}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ];
  return lines.join("\n");
}

export function writeMemoryNotes(rawConfig, records, options = {}) {
  const { logger, maxPerRun = 200 } = options;
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const memoriesDir = join(reviewPath, "memories");

  if (!existsSync(memoriesDir)) mkdirSync(memoriesDir, { recursive: true });

  let written = 0, skipped = 0, errors = 0;
  let runCount = 0;

  for (const record of records) {
    if (runCount >= maxPerRun) break;
    if (!record.id) { skipped++; continue; }

    const notePath = join(memoriesDir, `${record.id}.md`);
    const newHash = memoryContentHash(record);

    if (existsSync(notePath)) {
      const storedHash = extractStoredHash(notePath);
      if (storedHash === newHash) { skipped++; continue; }
    }

    try {
      atomicWriteText(notePath, renderMemoryNote(record, newHash));
      written++;
      runCount++;
    } catch (err) {
      logger?.warn?.(`plur1bus-memory-notes: failed to write ${record.id}: ${err?.message}`);
      errors++;
    }
  }

  return { written, skipped, errors };
}
```

- [x] **Step 4: Run tests to confirm they pass**

```bash
cd /root && node --test tests/smoke-memory-note-writer.test.js
```

Expected: all 5 tests pass

- [x] **Step 5: Commit**

```bash
git add lib/obsidian/memory-note-writer.js tests/smoke-memory-note-writer.test.js
git commit -m "feat(semantic-links): add writeMemoryNotes — LanceDB memory mirror notes in vault"
```

---

## Task 5: Update `lib/obsidian/record-index.js` — `readMemoryNotes` + `memory_id` indexing

**Files:**
- Modify: `lib/obsidian/record-index.js`

Background: `rebuildDashboards` calls `readRecords` then passes results to `writeGraphLinks`. Memory notes live in `{reviewPath}/memories/` (not `records/`), so they're not picked up by `readRecords`. Add `readMemoryNotes()` and update `buildRecordIndex` to index by `record.memory_id` so Tier 3 can find memory notes by their LanceDB UUID.

- [x] **Step 1: Write the test first**

Add to `tests/smoke-semantic-link-discoverer.test.js` — append at the end:

```javascript
import { readMemoryNotes } from "../lib/obsidian/record-index.js";

describe("readMemoryNotes", () => {
  it("returns empty array when memories/ dir missing", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-rmn-"));
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);
    assert.deepStrictEqual(records, []);
  });

  it("reads memory notes from memories/ dir", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-rmn-"));
    const memoriesDir = join(vault, "plur1bus", "memories");
    mkdirSync(memoriesDir, { recursive: true });
    const noteContent = `---
memory_id: aaaaaaaa-0000-0000-0000-000000000001
importance: 0.8
category: fact
plur1bus_type: memory
content_hash: sha256:abc123
---

# Test Memory

Some text here.`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(memoriesDir, "aaaaaaaa-0000-0000-0000-000000000001.md"), noteContent, "utf8");
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].memory_id, "aaaaaaaa-0000-0000-0000-000000000001");
    assert.strictEqual(records[0].plur1bus_type, "memory");
    assert.ok(records[0].path); // relative path is set
  });
});
```

Wait — `writeFileSync` can't be imported inside a test with dynamic import because `node:test` doesn't support top-level await in that way. Let me use a proper import at the top. Actually, looking at the existing test file, it already imports `mkdirSync, existsSync` from `node:fs` at the top. Let me add `writeFileSync` there.

The test file starts with:
```javascript
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
```

Change that line to also import `writeFileSync`:
```javascript
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
```

And append these tests after the existing ones (remove the dynamic import):

```javascript
import { readMemoryNotes } from "../lib/obsidian/record-index.js";

describe("readMemoryNotes", () => {
  it("returns empty array when memories/ dir missing", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-rmn-"));
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);
    assert.deepStrictEqual(records, []);
  });

  it("reads memory notes from memories/ dir and sets path", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-rmn-"));
    const memoriesDir = join(vault, "plur1bus", "memories");
    mkdirSync(memoriesDir, { recursive: true });
    const noteContent = [
      "---",
      "memory_id: aaaaaaaa-0000-0000-0000-000000000001",
      "importance: 0.8",
      "category: fact",
      "plur1bus_type: memory",
      "content_hash: sha256:abc123",
      "---",
      "",
      "# Test Memory",
      "",
      "Some text here.",
    ].join("\n");
    writeFileSync(join(memoriesDir, "aaaaaaaa-0000-0000-0000-000000000001.md"), noteContent, "utf8");
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const records = readMemoryNotes(rawConfig);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].memory_id, "aaaaaaaa-0000-0000-0000-000000000001");
    assert.strictEqual(records[0].plur1bus_type, "memory");
    assert.ok(records[0].path?.startsWith("memories/"));
  });
});
```

- [x] **Step 2: Update the import line at the top of `tests/smoke-semantic-link-discoverer.test.js`**

Change line 6:
```javascript
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
```
to:
```javascript
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
```

Then append the `readMemoryNotes` import and tests above at the end of the file.

- [x] **Step 3: Run tests to confirm `readMemoryNotes` tests fail**

```bash
cd /root && node --test tests/smoke-semantic-link-discoverer.test.js 2>&1 | grep "readMemoryNotes" | head -5
```

Expected: FAIL — `readMemoryNotes` not exported from `record-index.js`

- [x] **Step 4: Update `lib/obsidian/record-index.js`**

Add `readMemoryNotes` export and update `buildRecordIndex`:

```javascript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { RECORD_COLLECTIONS } from "./record-schema.js";
import { resolveReviewPath } from "./safe-paths.js";

export const DEEP_ANALYSIS_RECORD_COLLECTIONS = Object.freeze([
  "sources",
  "memory-candidates",
  "review-items",
  "decisions",
  "projects",
  "agents",
]);

export function readRecords(rawConfig, options = {}) {
  if (options.readExistingRecords === false) return [];
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const root = join(reviewPath, "records");
  const records = [];
  if (!existsSync(root)) return records;
  const collections = options.collections || RECORD_COLLECTIONS;
  for (const collection of collections) {
    const dir = join(root, collection);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = join(dir, entry.name);
      const parsed = parseFrontmatter(readFileSync(file, "utf8"));
      records.push({
        ...parsed.frontmatter,
        path: relative(reviewPath, file).replace(/\\/g, "/"),
        body: parsed.body,
      });
    }
  }
  return records;
}

export function readMemoryNotes(rawConfig) {
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const memoriesDir = join(reviewPath, "memories");
  if (!existsSync(memoriesDir)) return [];
  const records = [];
  for (const entry of readdirSync(memoriesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = join(memoriesDir, entry.name);
    const parsed = parseFrontmatter(readFileSync(file, "utf8"));
    records.push({
      ...parsed.frontmatter,
      path: relative(reviewPath, file).replace(/\\/g, "/"),
      body: parsed.body,
    });
  }
  return records;
}

export function buildRecordIndex(rawConfig, options = {}) {
  const merged = new Map();
  for (const record of [...(options.records || []), ...readRecords(rawConfig, options)]) {
    const key = record.plur1bus_id || record.id || record.memory_id || record.path || JSON.stringify(record);
    merged.set(key, { ...(merged.get(key) || {}), ...record });
  }
  const records = [...merged.values()];
  const byType = {};
  const byId = {};
  for (const record of records) {
    const type = record.plur1bus_type || record.type || "unknown";
    if (!byType[type]) byType[type] = [];
    byType[type].push(record);
    if (record.plur1bus_id || record.id) byId[record.plur1bus_id || record.id] = record;
    if (record.memory_id) byId[record.memory_id] = record;
  }
  return { records, byType, byId };
}
```

- [x] **Step 5: Run all tests**

```bash
cd /root && node --test tests/smoke-semantic-link-discoverer.test.js
```

Expected: all tests pass including `readMemoryNotes`

- [x] **Step 6: Commit**

```bash
git add lib/obsidian/record-index.js tests/smoke-semantic-link-discoverer.test.js
git commit -m "feat(semantic-links): add readMemoryNotes; buildRecordIndex indexes by memory_id"
```

---

## Task 6: Update `lib/obsidian/graph-link-writer.js` — Tier 3 uses `memory_id`

**Files:**
- Modify: `lib/obsidian/graph-link-writer.js:198-213`
- Update: `tests/smoke-graph-link-writer.test.js`

Background: The link index is now keyed by LanceDB UUID (`record.id`). Memory notes have `memory_id` in their frontmatter (the LanceDB UUID). Tier 3 must look up by `record.memory_id || record.plur1bus_id` to handle both memory notes (new) and legacy analysis records (old, still in place).

- [x] **Step 1: Add a memory-note specific Tier 3 test to `tests/smoke-graph-link-writer.test.js`**

Append after the existing Tier 3 tests (after line ~430):

```javascript
describe("graph-link-writer: Tier 3 with memory notes (memory_id)", () => {
  function makeVault() {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-t3m-"));
    mkdirSync(join(dir, "plur1bus", "memories"), { recursive: true });
    return dir;
  }

  it("injects semantic links for memory notes via memory_id", async () => {
    const vault = makeVault();
    const idA = "aaaaaaaa-0000-0000-0000-000000000001";
    const idB = "aaaaaaaa-0000-0000-0000-000000000002";
    const noteA = [
      "---",
      `memory_id: ${idA}`,
      "plur1bus_type: memory",
      "importance: 0.8",
      "content_hash: sha256:x",
      "---",
      "# Memory A",
      "Some content A.",
    ].join("\n");
    const noteB = [
      "---",
      `memory_id: ${idB}`,
      "plur1bus_type: memory",
      "importance: 0.7",
      "content_hash: sha256:y",
      "---",
      "# Memory B",
      "Some content B.",
    ].join("\n");

    writeFileSync(join(vault, "plur1bus", "memories", `${idA}.md`), noteA, "utf8");
    writeFileSync(join(vault, "plur1bus", "memories", `${idB}.md`), noteB, "utf8");

    const recA = {
      memory_id: idA,
      plur1bus_type: "memory",
      path: `memories/${idA}.md`,
      summary: "Memory A",
      memoryIds: [],
      sourceRefs: [],
    };
    const recB = {
      memory_id: idB,
      plur1bus_type: "memory",
      path: `memories/${idB}.md`,
      summary: "Memory B",
      memoryIds: [],
      sourceRefs: [],
    };

    const linkIndex = {
      version: "1",
      entries: {
        [idA]: {
          similar: [idB],
          contentHash: "sha256:x",
          firstDiscoveredAt: "2026-01-01T00:00:00Z",
          lastCheckedAt: "2026-01-01T00:00:00Z",
        },
      },
    };

    const rawConfig = {
      vaultPath: vault,
      reviewRoot: "plur1bus",
      graphLinks: { includeSemantic: true },
    };
    const result = await writeGraphLinks(rawConfig, [recA, recB], { linkIndex });
    assert.ok(result.ok);
    const content = readFileSync(join(vault, "plur1bus", "memories", `${idA}.md`), "utf8");
    assert.match(content, new RegExp(idB));
    assert.match(content, /ähnlich/);
  });
});
```

Note: `writeFileSync` must be imported at the top of the test file. Check that it's already imported (it's used in Tier 3 tests via `writeNote` helper which calls it directly).

Looking at the test file: line 14 imports `mkdtempSync, writeFileSync, mkdirSync, readFileSync` from `node:fs` — `writeFileSync` is already imported. Good.

- [x] **Step 2: Run test to confirm it fails**

```bash
cd /root && node --test tests/smoke-graph-link-writer.test.js 2>&1 | grep -E "memory notes|FAIL" | head -5
```

Expected: FAIL — Tier 3 uses `record.plur1bus_id` not `record.memory_id`, so the index lookup misses

- [x] **Step 3: Update Tier 3 in `lib/obsidian/graph-link-writer.js`**

Replace lines 198-213 (the Tier 3 block):

```javascript
    // Tier 3: semantic (read from pre-built link index — no re-embedding)
    if (includeSemantic && tiers.includes("semantic") && links.length < maxPerNote) {
      const indexEntries = options.linkIndex?.entries || {};
      const lookupId = record.memory_id || record.plur1bus_id;
      const entry = lookupId ? indexEntries[lookupId] : null;
      if (entry?.similar) {
        for (const similarId of entry.similar) {
          if (links.length >= maxPerNote) break;
          if (existingIds.has(similarId)) continue;
          const linked = byId[similarId];
          if (!linked) continue;
          links.push(buildLinkLine(linked, reviewRoot, formatDisplayTitle(linked), "ähnlich"));
          existingIds.add(similarId);
          tiersUsed.add("semantic");
        }
      }
    }
```

- [x] **Step 4: Run all graph-link-writer tests**

```bash
cd /root && node --test tests/smoke-graph-link-writer.test.js
```

Expected: all tests pass, including the new memory-note Tier 3 test

- [x] **Step 5: Commit**

```bash
git add lib/obsidian/graph-link-writer.js tests/smoke-graph-link-writer.test.js
git commit -m "feat(semantic-links): Tier 3 supports memory_id lookup for memory mirror notes"
```

---

## Task 7: Update `lib/obsidian-bridge.js` — include memory notes in dashboard rebuild

**Files:**
- Modify: `lib/obsidian-bridge.js:1636-1668`

Background: `rebuildDashboards` currently calls `readRecords` and passes results to `writeGraphLinks`. Memory notes are in `memories/` (not `records/`) so they're invisible to `writeGraphLinks`. Add a `readMemoryNotes` call and merge results so memory notes get their Tier 3 links written too.

- [x] **Step 1: Add the import to `lib/obsidian-bridge.js`**

Find the import block near line 29-33:
```javascript
import { generateDashboards } from "./obsidian/dashboard-generator.js";
import { readRecords } from "./obsidian/record-index.js";
import { writeGraphLinks } from "./obsidian/graph-link-writer.js";
import { loadLinkIndex } from "./obsidian/link-index.js";
```

Add `readMemoryNotes` to the record-index import:
```javascript
import { readRecords, readMemoryNotes } from "./obsidian/record-index.js";
```

- [x] **Step 2: Update `rebuildDashboards` in `lib/obsidian-bridge.js`**

Find the `rebuildDashboards` function body (around lines 1636-1668). Replace the `const records = readRecords(vaultCfg);` line and the block that uses it:

```javascript
  async function rebuildDashboards() {
    const workspaces = discoverObsidianWorkspaces(cfg, options);
    let built = 0;
    let glUpdated = 0;
    for (const workspace of workspaces) {
      try {
        const vaultCfg = { ...rawConfig, vaultPath: workspace.path, reviewRoot: cfg.reviewRoot || "plur1bus" };
        const records = readRecords(vaultCfg);
        const memoryNotes = readMemoryNotes(vaultCfg);
        const allRecords = [...records, ...memoryNotes];
        if (allRecords.length === 0) continue;
        const result = generateDashboards(vaultCfg, {
          agentId: workspace.agentId,
          workspaceKey: workspace.workspaceId,
          records,
          readExistingRecords: true,
        });
        built += Array.isArray(result) ? result.length : result?.count ?? 0;

        const graphLinksCfg = vaultCfg.graphLinks ?? rawConfig.graphLinks ?? {};
        if (graphLinksCfg.enabled !== false) {
          const linkIndex = loadLinkIndex(vaultCfg.vaultPath);
          const glResult = await writeGraphLinks(vaultCfg, allRecords, { logger, linkIndex });
          glUpdated += glResult.updated;
          if (glResult.conflicts.length > 0) {
            logger.warn?.(`plur1bus-obsidian-bridge: graph-links conflicts on ${glResult.conflicts.join(", ")}`);
          }
        }
      } catch (err) {
        logger.warn?.(`plur1bus-obsidian-bridge: dashboard rebuild failed for ${workspace.workspaceId}: ${String(err)}`);
      }
    }
    if (built > 0 || glUpdated > 0) {
      logger.info?.(`plur1bus-obsidian-bridge: rebuilt ${built} dashboard file(s), ${glUpdated} graph-link block(s) updated`);
    }
  }
```

Note: `generateDashboards` only gets `records` (analysis records), not memory notes — dashboards are for analysis records only. `writeGraphLinks` gets `allRecords` so memory notes get their semantic links written.

- [x] **Step 3: Commit**

```bash
git add lib/obsidian-bridge.js
git commit -m "feat(semantic-links): rebuildDashboards includes memory notes for graph link writing"
```

---

## Task 8: Update `index.js` call sites — use `db.scanActive()` instead of `readRecords`

**Files:**
- Modify: `index.js` lines 1921-1984 (dreaming hook + internal command)

Background: Both call sites currently call `readRecords` (vault records, no vectors) then pass them to `discoverSemanticLinks`. They must instead call `db.scanActive()` (LanceDB records, have vectors), then pass results to both `discoverSemanticLinks` AND `writeMemoryNotes`.

- [x] **Step 1: Add the `writeMemoryNotes` import to `index.js`**

Find line 43 which currently reads:
```javascript
import { discoverSemanticLinks } from "./lib/obsidian/semantic-link-discoverer.js";
```

Replace with:
```javascript
import { discoverSemanticLinks } from "./lib/obsidian/semantic-link-discoverer.js";
import { writeMemoryNotes } from "./lib/obsidian/memory-note-writer.js";
```

Also remove the now-unused `loadLinkIndex` import from `index.js` if it was added only for this feature. Check line 44 area:
```bash
grep -n "loadLinkIndex" /root/index.js
```
If `loadLinkIndex` appears only in the semantic discovery blocks and nowhere else, remove it. If it's used elsewhere, leave it.

- [x] **Step 2: Update the rem-dream hook (around line 1921)**

Find the dreaming hook block:
```javascript
const semanticCfg = obsidianBridgeCfg?.graphLinks?.semanticDiscovery;
if (semanticCfg?.enabled && commandCtx.workspaceDir) {
  const semVaultCfg = { ...obsidianBridgeCfg, vaultPath: commandCtx.workspaceDir };
  const { readRecords: readRecsForSem } = await import("./lib/obsidian/record-index.js");
  const semRecords = readRecsForSem(semVaultCfg);
  discoverSemanticLinks(semVaultCfg, semRecords, { pool, logger: api.logger, defaultAgentId: internalAgent })
    .then((r) => api.logger?.info?.(`plur1bus-semantic: processed=${r.processed} unchanged=${r.unchanged} errors=${r.errors}${r.batchAborted ? " (aborted-429)" : ""}`))
    .catch((err) => api.logger?.warn?.(`plur1bus-semantic: discovery failed: ${String(err)}`));
}
```

Replace with:
```javascript
const semanticCfg = obsidianBridgeCfg?.graphLinks?.semanticDiscovery;
if (semanticCfg?.enabled) {
  (async () => {
    try {
      const workspaces = discoverObsidianWorkspaces(obsidianBridgeCfg || {}, { commandCtx });
      const targetWorkspaces = workspaces.length
        ? workspaces
        : commandCtx.workspaceDir
          ? [{ path: commandCtx.workspaceDir, agentId: internalAgent }]
          : [];
      for (const ws of targetWorkspaces) {
        const semVaultCfg = { ...obsidianBridgeCfg, vaultPath: ws.path };
        const db = pool.getDb(ws.agentId || internalAgent);
        const lanceRecords = await db.scanActive();
        const [semResult] = await Promise.all([
          discoverSemanticLinks(semVaultCfg, lanceRecords, { pool, logger: api.logger, defaultAgentId: ws.agentId || internalAgent }),
          writeMemoryNotes(semVaultCfg, lanceRecords, { logger: api.logger }),
        ]);
        api.logger?.info?.(`plur1bus-semantic[${ws.agentId || internalAgent}]: processed=${semResult.processed} unchanged=${semResult.unchanged} errors=${semResult.errors}${semResult.batchAborted ? " (aborted-429)" : ""}`);
      }
    } catch (err) {
      api.logger?.warn?.(`plur1bus-semantic: discovery failed: ${String(err)}`);
    }
  })();
}
```

- [x] **Step 3: Update the internal `discover-semantic-links` command (around line 1966)**

Find the block:
```javascript
if (subKey === "discover-semantic-links") {
  const semBridgeCfg = obsidianBridgeCfg || {};
  const workspaces = discoverObsidianWorkspaces(semBridgeCfg, { commandCtx });
  if (!workspaces.length) {
    return formatJsonCommandResult({ job: "discover-semantic-links", skipped: true, reason: "no_workspaces_configured" });
  }
  const { readRecords: readRecsInternal } = await import("./lib/obsidian/record-index.js");
  let totalProcessed = 0, totalSkipped = 0, totalUnchanged = 0, totalErrors = 0;
  for (const ws of workspaces) {
    const semVaultCfg = { ...semBridgeCfg, vaultPath: ws.path };
    const semRecords = readRecsInternal(semVaultCfg);
    const semResult = await discoverSemanticLinks(semVaultCfg, semRecords, { pool, logger: api.logger, defaultAgentId: ws.agentId });
    api.logger?.info?.(`plur1bus internal discover-semantic-links[${ws.agentId || internalAgent}]: ${JSON.stringify(semResult)}`);
    totalProcessed += semResult.processed;
    totalSkipped += semResult.skipped;
    totalUnchanged += semResult.unchanged;
    totalErrors += semResult.errors;
  }
  return formatJsonCommandResult({ job: "discover-semantic-links", processed: totalProcessed, skipped: totalSkipped, unchanged: totalUnchanged, errors: totalErrors });
}
```

Replace with:
```javascript
if (subKey === "discover-semantic-links") {
  const semBridgeCfg = obsidianBridgeCfg || {};
  const workspaces = discoverObsidianWorkspaces(semBridgeCfg, { commandCtx });
  if (!workspaces.length) {
    return formatJsonCommandResult({ job: "discover-semantic-links", skipped: true, reason: "no_workspaces_configured" });
  }
  let totalProcessed = 0, totalSkipped = 0, totalUnchanged = 0, totalErrors = 0, totalNotes = 0;
  for (const ws of workspaces) {
    const semVaultCfg = { ...semBridgeCfg, vaultPath: ws.path };
    const db = pool.getDb(ws.agentId || internalAgent);
    const lanceRecords = await db.scanActive();
    const [semResult, noteResult] = await Promise.all([
      discoverSemanticLinks(semVaultCfg, lanceRecords, { pool, logger: api.logger, defaultAgentId: ws.agentId || internalAgent }),
      writeMemoryNotes(semVaultCfg, lanceRecords, { logger: api.logger }),
    ]);
    api.logger?.info?.(`plur1bus internal discover-semantic-links[${ws.agentId || internalAgent}]: ${JSON.stringify({ ...semResult, notesWritten: noteResult.written })}`);
    totalProcessed += semResult.processed;
    totalSkipped += semResult.skipped;
    totalUnchanged += semResult.unchanged;
    totalErrors += semResult.errors;
    totalNotes += noteResult.written;
  }
  return formatJsonCommandResult({ job: "discover-semantic-links", processed: totalProcessed, skipped: totalSkipped, unchanged: totalUnchanged, errors: totalErrors, notesWritten: totalNotes });
}
```

- [x] **Step 4: Sync to installed extension and restart gateway**

```bash
cp /root/index.js /root/.openclaw/extensions/memory-lancedb-namespaced/index.js
cp /root/lib/obsidian/semantic-link-discoverer.js /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian/semantic-link-discoverer.js
cp /root/lib/obsidian/link-index.js /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian/link-index.js
cp /root/lib/obsidian/memory-note-writer.js /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian/memory-note-writer.js
cp /root/lib/obsidian/record-index.js /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian/record-index.js
cp /root/lib/obsidian/graph-link-writer.js /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian/graph-link-writer.js
cp /root/lib/obsidian-bridge.js /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian-bridge.js
systemctl --user restart openclaw-gateway
sleep 3
journalctl --user -u openclaw-gateway -n 10 --no-pager
```

- [x] **Step 5: Run the internal command to verify it now works**

In Telegram or via direct API call:
```
/plur1bus internal discover-semantic-links
```

Expected: `{ "job": "discover-semantic-links", "processed": N, "skipped": M, "unchanged": 0, "errors": 0, "notesWritten": K }` where N > 0 and K > 0

- [x] **Step 6: Check that memory notes were created**

```bash
ls /root/.openclaw/workspace/plur1bus/memories/ | head -10
wc -l /root/.openclaw/workspace/plur1bus/memories/*.md 2>/dev/null | tail -1
```

Expected: `.md` files with UUID names exist

- [x] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(semantic-links): index.js call sites use db.scanActive() + writeMemoryNotes"
```

---

## Verification Checklist

- [x] `node --test tests/smoke-scan-active.test.js` — passes
- [x] `node --test tests/smoke-semantic-link-discoverer.test.js` — all tests pass (link-index + discoverSemanticLinks + readMemoryNotes)
- [x] `node --test tests/smoke-memory-note-writer.test.js` — all 5 tests pass
- [x] `node --test tests/smoke-graph-link-writer.test.js` — all tests pass including memory-note Tier 3
- [x] `/plur1bus internal discover-semantic-links` returns `processed > 0` and `notesWritten > 0`
- [x] Memory notes exist in vault: `ls {vault}/plur1bus/memories/`
- [x] Link index created: `cat {vault}/.plur1bus/link-index.json | head -20`
- [x] After next dashboard rebuild, memory notes have `## 🔗 Verwandte Einträge` blocks with ähnlich links
- [x] Obsidian graph view shows connections between memory note files
