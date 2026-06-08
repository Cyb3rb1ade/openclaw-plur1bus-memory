# Semantic Link Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dreaming-phase pipeline that uses LanceDB vector similarity to pre-compute a link index, enabling the Obsidian graph view to display edges between semantically related records.

**Architecture:** Two new modules — `link-index.js` (pure I/O: load/save/hash/queue) and `semantic-link-discoverer.js` (runs LanceDB searches, updates the index) — are called from `index.js` after each REM dream. At dashboard rebuild time, `obsidian-bridge.js` reads the link index from disk and passes it to `graph-link-writer.js`, which uses it for Tier 3 links with no re-embedding.

**Tech Stack:** Node.js ESM, `node:crypto` (SHA-256), `node:fs` (atomic write via existing `atomicWriteText`), `node:test` (tests), LanceDB via existing `pool.getDb()` API.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/obsidian/link-index.js` | **Create** | Load/save link-index.json; compute content hashes; build priority queue |
| `lib/obsidian/semantic-link-discoverer.js` | **Create** | Run LanceDB similarity search, update link index |
| `lib/obsidian/graph-link-writer.js` | **Modify** lines 199–215 | Replace inline LanceDB Tier 3 with link-index read |
| `lib/obsidian-bridge.js` | **Modify** lines 1635–1666 | Load link index and pass to `writeGraphLinks` in `rebuildDashboards` |
| `index.js` | **Modify** lines 1891–1919 and 1955 | Run discovery after rem-dream; add `discover-semantic-links` subcommand |
| `tests/smoke-semantic-link-discoverer.test.js` | **Create** | Unit + integration tests for link-index and semantic-link-discoverer |
| `tests/smoke-graph-link-writer.test.js` | **Modify** | Add Tier 3 tests |

---

## Task 1: `lib/obsidian/link-index.js` — link index I/O helpers

**Files:**
- Create: `lib/obsidian/link-index.js`
- Test: `tests/smoke-semantic-link-discoverer.test.js`

- [ ] **Step 1: Write the failing tests for link-index helpers**

Create `tests/smoke-semantic-link-discoverer.test.js` with this content:

```javascript
/**
 * Tests for link-index.js and semantic-link-discoverer.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeContentHash,
  buildPriorityQueue,
  loadLinkIndex,
  saveLinkIndex,
} from "../lib/obsidian/link-index.js";

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
      { plur1bus_id: "known", vector: [1] },
      { plur1bus_id: "new-a", vector: [1] },
      { plur1bus_id: "new-b", vector: [1] },
    ];
    const index = {
      entries: {
        "known": { similar: [], contentHash: "sha256:abc", firstDiscoveredAt: "2026-01-01T00:00:00.000Z", lastCheckedAt: "2026-01-02T00:00:00.000Z" },
      },
    };
    const queue = buildPriorityQueue(records, index);
    assert.strictEqual(queue[0].plur1bus_id, "new-a");
    assert.strictEqual(queue[1].plur1bus_id, "new-b");
    assert.strictEqual(queue[2].plur1bus_id, "known");
  });

  it("sorts processed records by oldest lastCheckedAt", () => {
    const records = [
      { plur1bus_id: "r1", vector: [1] },
      { plur1bus_id: "r2", vector: [1] },
    ];
    const index = {
      entries: {
        "r1": { lastCheckedAt: "2026-06-01T00:00:00.000Z", similar: [], contentHash: "x", firstDiscoveredAt: "2026-01-01T00:00:00.000Z" },
        "r2": { lastCheckedAt: "2026-05-01T00:00:00.000Z", similar: [], contentHash: "y", firstDiscoveredAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    const queue = buildPriorityQueue(records, index);
    assert.strictEqual(queue[0].plur1bus_id, "r2");
    assert.strictEqual(queue[1].plur1bus_id, "r1");
  });

  it("skips records without plur1bus_id", () => {
    const records = [
      { path: "records/x.md", vector: [1] },
      { plur1bus_id: "valid", vector: [1] },
    ];
    const queue = buildPriorityQueue(records, { entries: {} });
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].plur1bus_id, "valid");
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/smoke-semantic-link-discoverer.test.js 2>&1 | head -30
```

Expected: error — `Cannot find module '../lib/obsidian/link-index.js'`

- [ ] **Step 3: Implement `lib/obsidian/link-index.js`**

Create `lib/obsidian/link-index.js`:

```javascript
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./safe-paths.js";

const INDEX_PATH_REL = ".plur1bus/link-index.json";

export function computeContentHash(record) {
  const raw = (record.text || "") + ":" + (record.summary || "");
  return "sha256:" + createHash("sha256").update(raw, "utf8").digest("hex");
}

export function loadLinkIndex(vaultPath) {
  const indexPath = join(vaultPath, INDEX_PATH_REL);
  if (!existsSync(indexPath)) return { version: "1", entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    if (!parsed.entries || typeof parsed.entries !== "object") return { version: "1", entries: {} };
    return parsed;
  } catch {
    return { version: "1", entries: {} };
  }
}

export function saveLinkIndex(vaultPath, index) {
  const indexPath = join(vaultPath, INDEX_PATH_REL);
  atomicWriteText(indexPath, JSON.stringify({ ...index, generatedAt: new Date().toISOString() }, null, 2));
}

export function buildPriorityQueue(records, existingIndex) {
  const entries = (existingIndex && typeof existingIndex.entries === "object") ? existingIndex.entries : {};
  const withId = records.filter((r) => r.plur1bus_id);
  const neverProcessed = withId.filter((r) => !entries[r.plur1bus_id]);
  const processed = withId
    .filter((r) => entries[r.plur1bus_id])
    .sort((a, b) => {
      const ta = entries[a.plur1bus_id]?.lastCheckedAt || "0";
      const tb = entries[b.plur1bus_id]?.lastCheckedAt || "0";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  return [...neverProcessed, ...processed];
}
```

- [ ] **Step 4: Run tests — all should pass**

```bash
node --test tests/smoke-semantic-link-discoverer.test.js 2>&1
```

Expected: all tests in `link-index: computeContentHash`, `link-index: buildPriorityQueue`, `link-index: loadLinkIndex / saveLinkIndex` pass

- [ ] **Step 5: Commit**

```bash
git add lib/obsidian/link-index.js tests/smoke-semantic-link-discoverer.test.js
git commit -m "feat(semantic-links): add link-index.js with load/save/hash/queue helpers"
```

---

## Task 2: `lib/obsidian/semantic-link-discoverer.js` — discovery pipeline

**Files:**
- Create: `lib/obsidian/semantic-link-discoverer.js`
- Modify: `tests/smoke-semantic-link-discoverer.test.js` (append integration tests)

- [ ] **Step 1: Append integration tests to `tests/smoke-semantic-link-discoverer.test.js`**

Add this block at the end of the file:

```javascript
import { discoverSemanticLinks } from "../lib/obsidian/semantic-link-discoverer.js";

describe("discoverSemanticLinks", () => {
  function makeVault() {
    return mkdtempSync(join(tmpdir(), "plur1bus-sld-"));
  }

  function makePool(searchResults = []) {
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

  it("throws early when pool not provided", async () => {
    const vault = makeVault();
    const records = [{ plur1bus_id: "r1", vector: [0.1, 0.2] }];
    await assert.rejects(
      () => discoverSemanticLinks(baseConfig(vault), records, {}),
      /pool/
    );
  });

  it("returns zero counts for empty records array", async () => {
    const vault = makeVault();
    const result = await discoverSemanticLinks(baseConfig(vault), [], { pool: makePool() });
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(result.indexUpdated, false);
  });

  it("skips records without vector", async () => {
    const vault = makeVault();
    const records = [{ plur1bus_id: "r1" }];
    const result = await discoverSemanticLinks(baseConfig(vault), records, { pool: makePool() });
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.processed, 0);
  });

  it("processes a record and writes index", async () => {
    const vault = makeVault();
    const searchResults = [
      { plur1bus_id: "r2" },
      { plur1bus_id: "r1" },
    ];
    const records = [
      { plur1bus_id: "r1", vector: [0.1], agentId: "main" },
      { plur1bus_id: "r2", vector: [0.2], agentId: "main" },
    ];
    const pool = makePool(searchResults);
    const result = await discoverSemanticLinks(baseConfig(vault), records, { pool });
    assert.ok(result.processed >= 1);
    assert.strictEqual(result.indexUpdated, true);
    const idx = loadLinkIndex(vault);
    assert.ok(idx.entries["r1"] || idx.entries["r2"]);
  });

  it("is idempotent — second run with same contentHash returns unchanged", async () => {
    const vault = makeVault();
    const records = [{ plur1bus_id: "r1", vector: [0.1], text: "hello", summary: "world" }];
    const pool = makePool([{ plur1bus_id: "r2" }]);
    await discoverSemanticLinks(baseConfig(vault), records, { pool });
    const second = await discoverSemanticLinks(baseConfig(vault), records, { pool });
    assert.strictEqual(second.unchanged, 1);
    assert.strictEqual(second.processed, 0);
    assert.strictEqual(second.indexUpdated, false);
  });

  it("respects maxPerRun — processes only first N records", async () => {
    const vault = makeVault();
    const records = Array.from({ length: 10 }, (_, i) => ({
      plur1bus_id: `r${i}`,
      vector: [i * 0.1],
    }));
    const result = await discoverSemanticLinks(
      { ...baseConfig(vault), graphLinks: { semanticDiscovery: { maxPerRun: 3, threshold: 0.5 } } },
      records,
      { pool: makePool([]) }
    );
    assert.strictEqual(result.processed + result.skipped + result.unchanged, 3);
  });

  it("excludes self from similar results", async () => {
    const vault = makeVault();
    const records = [{ plur1bus_id: "self", vector: [0.1] }];
    const pool = makePool([{ plur1bus_id: "self" }, { plur1bus_id: "other" }]);
    await discoverSemanticLinks(baseConfig(vault), records, { pool });
    const idx = loadLinkIndex(vault);
    assert.ok(!idx.entries["self"]?.similar.includes("self"));
  });
});
```

- [ ] **Step 2: Run tests to confirm the new `discoverSemanticLinks` describe block fails**

```bash
node --test tests/smoke-semantic-link-discoverer.test.js 2>&1 | head -20
```

Expected: `Cannot find module '../lib/obsidian/semantic-link-discoverer.js'`

- [ ] **Step 3: Implement `lib/obsidian/semantic-link-discoverer.js`**

Create `lib/obsidian/semantic-link-discoverer.js`:

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
  const { pool, logger } = options;
  if (!pool) throw new Error("discoverSemanticLinks: options.pool is required");

  const vaultPath = rawConfig.vaultPath;
  const { maxPerRun, threshold, maxLinksPerRecord } = resolveDiscoveryConfig(rawConfig);

  if (!records.length) return { processed: 0, skipped: 0, unchanged: 0, errors: 0, indexUpdated: false };

  const existingIndex = loadLinkIndex(vaultPath);
  const queue = buildPriorityQueue(records, existingIndex).slice(0, maxPerRun);

  let processed = 0, skipped = 0, unchanged = 0, errors = 0;
  let dirty = false;

  for (const record of queue) {
    if (!record.vector) { skipped++; continue; }

    const currentHash = computeContentHash(record);
    const existing = existingIndex.entries[record.plur1bus_id];
    if (existing && existing.contentHash === currentHash) {
      unchanged++;
      continue;
    }

    let searchResults;
    try {
      const db = pool.getDb(record.agentId || "default");
      searchResults = await db.search(record.vector, 15, threshold);
    } catch (err) {
      const status = err?.status || err?.statusCode || (err?.message?.includes("429") ? 429 : 0);
      if (status === 429) {
        logger?.warn?.("plur1bus-semantic: 429 — aborting batch early");
        if (dirty) saveLinkIndex(vaultPath, existingIndex);
        return { processed, skipped, unchanged, errors, indexUpdated: dirty, batchAborted: true };
      }
      logger?.warn?.(`plur1bus-semantic: search failed for ${record.plur1bus_id}: ${err?.message}`);
      errors++;
      continue;
    }

    const selfId = record.plur1bus_id;
    const tier1Ids = new Set([
      ...(Array.isArray(record.memoryIds) ? record.memoryIds : []),
      ...(Array.isArray(record.sourceRefs) ? record.sourceRefs : []),
    ]);

    const similar = (searchResults || [])
      .map((r) => r.plur1bus_id || r.id || null)
      .filter((id) => id && id !== selfId && !tier1Ids.has(id))
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

- [ ] **Step 4: Run all tests in the file — all should pass**

```bash
node --test tests/smoke-semantic-link-discoverer.test.js 2>&1
```

Expected: all tests in `link-index: *` and `discoverSemanticLinks` pass (no failures)

- [ ] **Step 5: Commit**

```bash
git add lib/obsidian/semantic-link-discoverer.js tests/smoke-semantic-link-discoverer.test.js
git commit -m "feat(semantic-links): add semantic-link-discoverer.js with LanceDB pipeline"
```

---

## Task 3: Update `graph-link-writer.js` — replace Tier 3 with link index read

**Files:**
- Modify: `lib/obsidian/graph-link-writer.js` lines 199–215
- Modify: `tests/smoke-graph-link-writer.test.js` (append Tier 3 tests)

- [ ] **Step 1: Append Tier 3 tests to `tests/smoke-graph-link-writer.test.js`**

Add this block at the end of the file (after the existing `writeGraphLinks` describe block):

```javascript
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
    // Only 1 of those IDs exists in byId, but maxPerNote=2 should cap
    const byIdRecords = [
      { plur1bus_id: "s1", path: "records/sources/s1.md", title: "S1", memoryIds: [], sourceRefs: [] },
      { plur1bus_id: "s2", path: "records/sources/s2.md", title: "S2", memoryIds: [], sourceRefs: [] },
      { plur1bus_id: "s3", path: "records/sources/s3.md", title: "S3", memoryIds: [], sourceRefs: [] },
    ];
    mkdirSync(join(vault, "plur1bus", "records", "sources"), { recursive: true });
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
```

- [ ] **Step 2: Run Tier 3 tests to confirm they fail**

```bash
node --test tests/smoke-graph-link-writer.test.js 2>&1 | grep -A2 "Tier 3"
```

Expected: the 4 new tests fail (Tier 3 block not yet implemented)

- [ ] **Step 3: Replace Tier 3 in `lib/obsidian/graph-link-writer.js`**

In `lib/obsidian/graph-link-writer.js`, find the Tier 3 block (lines 199–215) and replace it:

Current code to replace:
```javascript
    // Tier 3: semantic (only if record.vector already present — no re-embedding at rebuild time)
    if (includeSemantic && tiers.includes("semantic") && record.vector && options.pool && links.length < maxPerNote) {
      try {
        const db = options.pool.getDb(record.agentId || "default");
        const semanticResults = await db.search(record.vector, maxPerNote - links.length, cfg.semanticThreshold);
        for (const r of (semanticResults || [])) {
          if (links.length >= maxPerNote) break;
          const t = r.entry || r;
          const targetId = t.plur1bus_id || t.id;
          if (!targetId || existingIds.has(targetId)) continue;
          const linked = byId[targetId];
          if (!linked) continue;
          links.push(buildLinkLine(linked, reviewRoot, formatDisplayTitle(linked), `ähnlich, ${(r.score ?? 0).toFixed(2)}`));
          tiersUsed.add("semantic");
        }
      } catch (_) {
        // semantic search failure is non-fatal
      }
    }
```

Replace with:
```javascript
    // Tier 3: semantic (read from pre-built link index — no re-embedding)
    if (includeSemantic && tiers.includes("semantic") && links.length < maxPerNote) {
      const indexEntries = options.linkIndex?.entries || {};
      const entry = indexEntries[record.plur1bus_id];
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

- [ ] **Step 4: Run all graph-link-writer tests — all should pass**

```bash
node --test tests/smoke-graph-link-writer.test.js 2>&1
```

Expected: all tests pass including the 4 new Tier 3 tests

- [ ] **Step 5: Run all tests to confirm no regressions**

```bash
node --test tests/*.test.js 2>&1 | tail -10
```

Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add lib/obsidian/graph-link-writer.js tests/smoke-graph-link-writer.test.js
git commit -m "feat(semantic-links): replace Tier 3 inline search with link-index read"
```

---

## Task 4: Update `lib/obsidian-bridge.js` — load link index at rebuild time

**Files:**
- Modify: `lib/obsidian-bridge.js` (import + `rebuildDashboards` function)

- [ ] **Step 1: Add the import for `loadLinkIndex`**

In `lib/obsidian-bridge.js`, find the existing import block near line 29–31:

```javascript
import { generateDashboards } from "./obsidian/dashboard-generator.js";
import { readRecords } from "./obsidian/record-index.js";
import { writeGraphLinks } from "./obsidian/graph-link-writer.js";
```

Add `loadLinkIndex` to the existing graph-link-writer import (or add a new import line after it):

```javascript
import { generateDashboards } from "./obsidian/dashboard-generator.js";
import { readRecords } from "./obsidian/record-index.js";
import { writeGraphLinks } from "./obsidian/graph-link-writer.js";
import { loadLinkIndex } from "./obsidian/link-index.js";
```

- [ ] **Step 2: Update `rebuildDashboards` to pass `linkIndex`**

In `lib/obsidian-bridge.js`, find the `writeGraphLinks` call inside `rebuildDashboards` (around line 1654):

```javascript
          const glResult = await writeGraphLinks(vaultCfg, records, { logger });
```

Replace it with:

```javascript
          const linkIndex = loadLinkIndex(vaultCfg.vaultPath);
          const glResult = await writeGraphLinks(vaultCfg, records, { logger, linkIndex });
```

- [ ] **Step 3: Verify syntax (Node.js --check)**

```bash
node --check lib/obsidian-bridge.js
```

Expected: exits 0 with no output

- [ ] **Step 4: Run full test suite**

```bash
node --test tests/*.test.js 2>&1 | tail -10
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add lib/obsidian-bridge.js
git commit -m "feat(semantic-links): pass link index to writeGraphLinks in rebuildDashboards"
```

---

## Task 5: Update `index.js` — add dreaming integration + internal command

**Files:**
- Modify: `index.js` (import, rem-dream handler, new internal subcommand, error list)

- [ ] **Step 1: Add the import for `discoverSemanticLinks`**

In `index.js`, find the existing obsidian-related imports near the top (around line 42):

```javascript
import { createObsidianBridgeService } from "./lib/obsidian-bridge.js";
```

Add after it:

```javascript
import { discoverSemanticLinks } from "./lib/obsidian/semantic-link-discoverer.js";
import { loadLinkIndex } from "./lib/obsidian/link-index.js";
```

- [ ] **Step 2: Run after rem-dream in the rem-dream handler**

In `index.js`, find the rem-dream result logging line (around line 1918–1919):

```javascript
                api.logger?.info?.(`plur1bus internal rem-dream[${internalAgent}]: ${JSON.stringify(result.report || result)}`);
                return formatJsonCommandResult({ job: "rem-dream", ...(result.report || result) });
```

Insert semantic discovery between those two lines — so it runs after REM dream, before the return:

```javascript
                api.logger?.info?.(`plur1bus internal rem-dream[${internalAgent}]: ${JSON.stringify(result.report || result)}`);
                const semanticCfg = obsidianBridgeCfg?.graphLinks?.semanticDiscovery;
                if (semanticCfg?.enabled && commandCtx.workspaceDir) {
                  const semVaultCfg = { ...obsidianBridgeCfg, vaultPath: commandCtx.workspaceDir };
                  const { readRecords: readRecs } = await import("./lib/obsidian/record-index.js");
                  const semRecords = readRecs(semVaultCfg);
                  discoverSemanticLinks(semVaultCfg, semRecords, { pool, logger: api.logger })
                    .then((r) => api.logger?.info?.(`plur1bus-semantic: processed=${r.processed} unchanged=${r.unchanged} errors=${r.errors}${r.batchAborted ? " (aborted-429)" : ""}`))
                    .catch((err) => api.logger?.warn?.(`plur1bus-semantic: discovery failed: ${String(err)}`));
                }
                return formatJsonCommandResult({ job: "rem-dream", ...(result.report || result) });
```

- [ ] **Step 3: Add `discover-semantic-links` internal subcommand**

In `index.js`, find the final `return formatJsonCommandResult` for unknown internal jobs (line ~1955):

```javascript
              return formatJsonCommandResult({ error: `unknown internal job: ${subKey || "(none)"}`, valid: ["consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream", "skill-miner", "reminder-dispatch"] });
```

Insert the new subcommand handler BEFORE that line:

```javascript
              if (subKey === "discover-semantic-links") {
                const semBridgeCfg = obsidianBridgeCfg || {};
                if (!commandCtx.workspaceDir) {
                  return formatJsonCommandResult({ job: "discover-semantic-links", skipped: true, reason: "no_workspace_dir" });
                }
                const semVaultCfg = { ...semBridgeCfg, vaultPath: commandCtx.workspaceDir };
                const { readRecords: readRecsInternal } = await import("./lib/obsidian/record-index.js");
                const semRecords = readRecsInternal(semVaultCfg);
                const semResult = await discoverSemanticLinks(semVaultCfg, semRecords, { pool, logger: api.logger });
                api.logger?.info?.(`plur1bus internal discover-semantic-links[${internalAgent}]: ${JSON.stringify(semResult)}`);
                return formatJsonCommandResult({ job: "discover-semantic-links", ...semResult });
              }
              return formatJsonCommandResult({ error: `unknown internal job: ${subKey || "(none)"}`, valid: ["consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream", "skill-miner", "reminder-dispatch", "discover-semantic-links"] });
```

(Note: also update the `valid` list in the original error return — the replacement above already does this.)

- [ ] **Step 4: Verify syntax**

```bash
node --check index.js
```

Expected: exits 0

- [ ] **Step 5: Run full test suite**

```bash
node --test tests/*.test.js 2>&1 | tail -10
```

Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(semantic-links): wire discover-semantic-links into rem-dream and internal command"
```

---

## Task 6: Manual smoke test against Bernd's vault

**Files:**
- Create: `scripts/run-semantic-discover-once.mjs` (one-shot test script, not tracked long-term)

- [ ] **Step 1: Create one-shot script**

```javascript
#!/usr/bin/env node
// One-shot: run discoverSemanticLinks against Bernd's vault
import { readRecords } from "../lib/obsidian/record-index.js";
import { discoverSemanticLinks } from "../lib/obsidian/semantic-link-discoverer.js";
import { loadLinkIndex } from "../lib/obsidian/link-index.js";
import AgentDbPool from "../lib/agent-db-pool.js";
import { join } from "node:path";

const rawConfig = {
  vaultPath: "/root/.openclaw/workspace",
  reviewRoot: "plur1bus",
  graphLinks: {
    includeSemantic: true,
    semanticDiscovery: { enabled: true, maxPerRun: 50, threshold: 0.78 },
  },
};

const pool = new AgentDbPool(join("/root/.openclaw/workspace", ".plur1bus", "lancedb"), 1536);

console.log("Reading records...");
const records = readRecords(rawConfig);
console.log(`Found ${records.length} records. Running discoverSemanticLinks (maxPerRun=50)...`);

const result = await discoverSemanticLinks(rawConfig, records, {
  pool,
  logger: { info: console.log, warn: console.warn },
});

console.log("\n=== Result ===");
console.log(JSON.stringify(result, null, 2));

const idx = loadLinkIndex(rawConfig.vaultPath);
const filled = Object.values(idx.entries).filter((e) => e.similar?.length > 0).length;
console.log(`\nLink index: ${Object.keys(idx.entries).length} entries, ${filled} with similar links`);
await pool.shutdown?.();
```

- [ ] **Step 2: Check that AgentDbPool exists at the expected path**

```bash
ls /root/lib/agent-db-pool.js 2>/dev/null || find /root/lib -name "*pool*" -o -name "*agent-db*" | head -5
```

If the path differs, update the import in the script.

- [ ] **Step 3: Run the script (dry-run style — maxPerRun=50)**

```bash
node scripts/run-semantic-discover-once.mjs 2>&1
```

Expected:
- No crash
- Some `processed` > 0 OR all `skipped` (if records have no vectors — this is expected for `duplicate-candidates` type which may lack LanceDB embeddings)
- If `indexUpdated: true` → check that `.plur1bus/link-index.json` was created

- [ ] **Step 4: Verify link index file created**

```bash
ls -la /root/.openclaw/workspace/.plur1bus/link-index.json 2>/dev/null && echo "exists" || echo "missing"
```

- [ ] **Step 5: Commit the script**

```bash
git add scripts/run-semantic-discover-once.mjs
git commit -m "chore: add one-shot semantic link discovery test script"
```

---

## Self-Review

**Spec coverage check:**
- ✅ `link-index.js` — Task 1 (`loadLinkIndex`, `saveLinkIndex`, `computeContentHash`, `buildPriorityQueue`)
- ✅ `semantic-link-discoverer.js` — Task 2 (`discoverSemanticLinks`, all edge cases)
- ✅ `graph-link-writer.js` Tier 3 rewrite — Task 3
- ✅ `obsidian-bridge.js` link index pass-through — Task 4
- ✅ `index.js` after rem-dream hook — Task 5
- ✅ `index.js` `discover-semantic-links` command — Task 5
- ✅ Config `graphLinks.semanticDiscovery.*` — Task 2 (`resolveDiscoveryConfig`) + Task 5 (`semanticCfg?.enabled`)
- ✅ 429 batch-abort — Task 2 (semantic-link-discoverer, error handling)
- ✅ contentHash skip (idempotency) — Task 2 (unchanged counter)
- ✅ Priority queue (never-processed first, oldest lastCheckedAt) — Task 1 (`buildPriorityQueue`)
- ✅ `firstDiscoveredAt` preserved — Task 2 (`existing?.firstDiscoveredAt || now`)
- ✅ Tests — Tasks 1, 2, 3

**Placeholder scan:** No TBD, no "add appropriate error handling" patterns. All code blocks complete.

**Type consistency:**
- `loadLinkIndex(vaultPath)` — used in Task 1 (tests), Task 2 (discoverer), Task 4 (bridge), Task 6 (script): consistent
- `saveLinkIndex(vaultPath, index)` — used in Task 1 (tests), Task 2 (discoverer): consistent
- `discoverSemanticLinks(rawConfig, records, options)` — used in Task 2 (tests + impl), Task 5 (index.js): consistent
- `buildPriorityQueue(records, existingIndex)` — Task 1 (tests), Task 2 (impl): consistent
- `existingIndex.entries[id]` shape: `{ similar, contentHash, firstDiscoveredAt, lastCheckedAt }` — consistent across Tasks 1 and 2
