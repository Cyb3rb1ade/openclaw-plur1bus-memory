# Semantic Link Discovery Design

## Overview

PLUR1BUS records currently have empty `memoryIds` and `sourceRefs` fields, so the graph-link-writer's Tier 1 and Tier 2 rules produce no links. This feature adds Tier 3: a dreaming-phase pipeline that uses LanceDB vector similarity to pre-compute a link index, which graph-link-writer reads at rebuild time — no re-embedding, no blocking.

---

## Problem

The Obsidian graph view shows no edges because:
1. All 8887 records have empty `memoryIds` and `sourceRefs` (no explicit cross-references)
2. Record types (`duplicate-candidates`, `sources`, `tasks`) don't match Tier 2 rules
3. Tier 3 semantic search was guarded behind `options.pool` and `record.vector` — neither available at rebuild time

The expensive work (vector similarity) must happen asynchronously. The cheap work (injecting wikilinks from a prebuilt index) happens at rebuild time.

---

## Architecture

```
Dreaming cycle (async, after REM dream)
    ↓
semantic-link-discoverer.js
    ├── reads LanceDB (pool.getDb per agentId)
    ├── uses record vectors (already embedded — no re-embedding)
    ├── builds/updates link-index.json (priority queue, incremental)
    └── writes atomically via atomicWriteText

graph-link-writer.js (Tier 3, at rebuild time)
    ├── reads link-index.json (sync, fast)
    └── injects wikilinks from index.entries[plur1bus_id].similar[]
```

**Key invariant:** link-index.json is write-only in the dreaming cycle, read-only in graph-link-writer. No locking needed.

---

## New Files

### `lib/obsidian/link-index.js`

Manages the persisted link index at `{vaultPath}/.plur1bus/link-index.json`.

**Index format:**
```json
{
  "version": "1",
  "generatedAt": "2026-06-08T14:00:00.000Z",
  "threshold": 0.78,
  "entries": {
    "rec-001": {
      "similar": ["rec-005", "rec-012"],
      "contentHash": "sha256:abc...",
      "firstDiscoveredAt": "2026-06-08T14:00:00.000Z",
      "lastCheckedAt": "2026-06-08T14:00:00.000Z"
    }
  }
}
```

**Exports:**
- `loadLinkIndex(vaultPath)` → `{ version, entries }` or `{ version: "1", entries: {} }` if missing
- `saveLinkIndex(vaultPath, index)` → atomicWriteText to `{vaultPath}/.plur1bus/link-index.json`
- `computeContentHash(record)` → `sha256(record.text + ":" + (record.summary || ""))`
- `buildPriorityQueue(records, existingIndex)` → sorted array: never-processed first, then oldest `lastCheckedAt`

**Index location:** `{vaultPath}/.plur1bus/link-index.json`

Rationale: contentHash stored only in index (not in LanceDB schema), atomic write for crash safety, version field for future migrations.

---

### `lib/obsidian/semantic-link-discoverer.js`

Runs the similarity search pipeline and updates the link index.

**Exported function:**
```javascript
export async function discoverSemanticLinks(rawConfig, records, options = {})
// options: { pool, logger }
// returns: { processed, skipped, unchanged, errors, indexUpdated: boolean }
```

**Algorithm:**
1. Load existing index from disk (`loadLinkIndex`)
2. Build priority queue (`buildPriorityQueue`) — never-processed first, then oldest `lastCheckedAt`
3. Slice to `maxPerRun` (default 500)
4. For each record in batch:
   a. If `contentHash` unchanged since `lastCheckedAt` → skip (mark `unchanged`)
   b. Get DB for `record.agentId || "default"` via `pool.getDb(agentId)`
   c. Call `db.search(record.vector, topN=15, threshold)` — returns up to 15 similar
   d. Post-filter: exclude self, exclude already-linked (Tier 1 IDs from `memoryIds + sourceRefs`)
   e. Keep top `maxLinksPerRecord` (default 5) by score — stored in index (graph-link-writer further caps at `maxPerNote`)
   f. Update `index.entries[record.plur1bus_id]` with `{ similar: [ids], contentHash, firstDiscoveredAt (preserve!), lastCheckedAt: now }`
5. If any entries updated → `saveLinkIndex` atomically
6. Return result stats

**Edge cases:**
- Empty vault / no records → returns `{ processed: 0, ... }` immediately
- `maxPerRun > records.length` → processes all records (no error)
- Vector search failure for one record → log warning, increment `errors`, continue
- HTTP 429 from vector DB → abort batch early, save partial index, return with `batchAborted: true`
- Missing `record.vector` → skip (mark `skipped`)
- `pool` not provided → throw early with clear error message

---

## Modified Files

### `lib/obsidian/graph-link-writer.js` — Tier 3 rewrite

Replace the current inline vector search with link index read:

```javascript
// Tier 3: semantic (read from pre-built link index)
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

`options.linkIndex` is passed in by the caller (obsidian-bridge.js at rebuild time). Scores not stored in index (scores change as corpus grows; the similarity relationship is what matters).

---

### `lib/obsidian-bridge.js` — dreaming hook + link index pass-through

**Two additions:**

1. **After REM dream hook** — calls `discoverSemanticLinks` if `graphLinks.semanticDiscovery.enabled`:
```javascript
async function runSemanticLinkDiscovery() {
  const records = readRecords(rawConfig);
  const result = await discoverSemanticLinks(rawConfig, records, { pool, logger });
  logger?.info?.(`plur1bus-semantic: processed=${result.processed} errors=${result.errors}`);
}
// registered as: afterRemDream hook in bridge init
```

2. **In `rebuildDashboards()`** — load link index and pass to `writeGraphLinks`:
```javascript
const linkIndex = loadLinkIndex(rawConfig.vaultPath);
await writeGraphLinks(rawConfig, records, { logger, linkIndex });
```

---

### `index.js` — `/plur1bus internal discover-semantic-links` command

Standalone trigger command for manual runs and testing:

```javascript
if (subCommand === "discover-semantic-links") {
  const records = readRecords(rawConfig);
  const result = await discoverSemanticLinks(rawConfig, records, { pool, logger });
  return `Semantic discovery: processed=${result.processed} unchanged=${result.unchanged} skipped=${result.skipped} errors=${result.errors}`;
}
```

---

## Configuration

```json
"graphLinks": {
  "includeSemantic": true,
  "semanticDiscovery": {
    "enabled": true,
    "maxPerRun": 500,
    "threshold": 0.78,
    "maxLinksPerRecord": 5
  }
}
```

Config location: `openclaw.json → plugins.entries.memory-lancedb-namespaced`

Default: `enabled: false` (opt-in). When `enabled: true`, dreaming hook fires after each REM dream cycle.

---

## Data Flow

```
LanceDB (agentId-namespaced tables)
    ↓  pool.getDb(agentId).search(vector, topN=15, threshold)
semantic-link-discoverer.js
    ↓  atomicWriteText
{vaultPath}/.plur1bus/link-index.json
    ↓  loadLinkIndex (sync)
graph-link-writer.js (Tier 3)
    ↓  buildLinkLine per similar ID
{vaultPath}/plur1bus/records/**/*.md (managed blocks)
    ↓  Obsidian renders
Obsidian Graph View (edges)
```

---

## Priority Queue Design

Records are sorted for processing by:
1. **Never processed** (not in index) → highest priority
2. **Oldest `lastCheckedAt`** → oldest processed first

`firstDiscoveredAt` is set on first write and never overwritten. `lastCheckedAt` updates on every processing run (even if `similar` unchanged).

If `maxPerRun = 500` and only 80 records exist → processes all 80 (queue slice just returns the full array).

---

## Index Versioning

`version: "1"` in the index file. When breaking changes require migration (e.g., adding bidirectionality, storing scores), bump to `"2"` and `loadLinkIndex` can detect and migrate or discard+rebuild.

---

## Multi-Workspace / Namespace

- Index location: `{vaultPath}/.plur1bus/link-index.json` — per workspace, not shared
- DB lookup: `pool.getDb(record.agentId || "default")` — per agentId namespace
- `discoverSemanticLinks` receives `rawConfig` (which contains `vaultPath`) — no global state

---

## Testing Strategy

**Unit tests** (`tests/smoke-semantic-link-discoverer.test.js`):
- `computeContentHash` — deterministic, stable
- `buildPriorityQueue` — never-processed first, then oldest `lastCheckedAt`
- `loadLinkIndex` — returns empty index if file missing
- `saveLinkIndex` + `loadLinkIndex` roundtrip — data survives disk cycle

**Integration tests** (in same file):
- `discoverSemanticLinks` with mock pool — processes batch, writes index
- Idempotency — second run with same contentHash = unchanged=N, no index write
- Skip on missing vector — increments `skipped`, not `errors`
- `maxPerRun` respected — processes only first N from priority queue

**graph-link-writer Tier 3 tests** (add to `tests/smoke-graph-link-writer.test.js`):
- Tier 3 injects links when `linkIndex` provided with matching entry
- Tier 3 respects `maxPerNote` cap
- Tier 3 skips IDs already linked by Tier 1/2 (`existingIds`)
- Tier 3 skips when `includeSemantic: false` (default)

---

## What This Does NOT Do

- No re-embedding at any point — vectors already exist in LanceDB
- No bidirectional links (A→B does not automatically create B→A in graph-link-writer)
- No score storage in index — similarity is binary (above threshold = linked), score volatility not worth the churn
- No immediate consistency — index is eventually consistent, rebuilt during dreaming
- No cross-agent similarity — each `agentId` namespace searched independently
