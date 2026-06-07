# Design: Obsidian Graph Link Writer

**Date:** 2026-06-07  
**Status:** Approved  
**Branch:** new feature branch off `main`

---

## Context

The PLUR1BUS Obsidian Bridge writes memory records and control-room items as `.md` files into the Obsidian vault, but currently injects no `[[wikilinks]]` between notes. As a result, Obsidian's Graph View shows only isolated nodes — no edges, no visible knowledge structure.

`lib/obsidian/link-suggestions.js` exists but only writes a passive review file (`plur1bus/link-suggestions.md`). It never touches note bodies.

**Goal:** Automatically inject a `🔗 Verwandte Einträge` Managed Block into each record note during the existing dashboard-rebuild cycle, creating real graph edges from the record's own reference data.

---

## Approach: New `graph-link-writer.js` Module (Ansatz A)

A standalone module called from `rebuildDashboards()` in `obsidian-bridge.js` after `generateDashboards()`. Three link-tiers determine which notes link to which.

---

## Architecture

### New File

**`lib/obsidian/graph-link-writer.js`**

```javascript
export function writeGraphLinks(rawConfig, records, options = {})
// options: { pool?, logger? }
// returns: { ok, updated, unchanged, skipped, conflicts: string[], tiersUsed: string[] }
```

- `rawConfig` — the workspace obsidian config (same shape used by all other bridge modules); provides `vaultPath`, `reviewRoot` (default `"plur1bus"`), and `graphLinks` config section
- `records` — pre-built record array from `buildRecordIndex()` (reused from dashboard pipeline, no extra I/O)
- `options.pool` — LanceDB pool, required only for Tier 3 semantic search

### Managed Block Written to Each Record Note

```
<!-- plur1bus:managed:start id="graph-links" version="4.2.18" tiers="explicit,type" hash="sha256:..." -->
## 🔗 Verwandte Einträge

- [[plur1bus/records/sources/source-abc|API Doku Kimi]] _(Quelle)_
- [[plur1bus/records/decisions/decision-xyz|Auth-Entscheidung 2026]] _(memoryId)_
<!-- plur1bus:managed:end -->
```

- `tiers` attr in start tag records which tiers contributed (for debugging)
- Empty state: `- _(keine Querverweise)_` — stable hash, prevents repeated re-scanning
- Conflict (hash mismatch = user edited the block manually): skip + add to `conflicts[]`, never overwrite

---

## The Three Link-Tiers

### Tier 1 — Explicit References (always active)

For each record:
1. `record.memoryIds[]` → lookup in `byId` index → `[[plur1bus/records/{coll}/{id}|title]] _(memoryId)_`
2. `record.sourceRefs[]` → lookup in `byId` or `byPath` index → `[[plur1bus/records/{coll}/{id}|title]] _(Quelle)_`

Stop adding when `maxPerNote` is reached.

### Tier 2 — Type Rules (always active, supplementary)

Fills remaining slots after Tier 1:

| Record Type | Rule |
|---|---|
| `memory_candidate` | Find all `decision` records whose `memoryIds` contains this record's `plur1bus_id` |
| `review_item` | Find all records sharing the same `reviewBundleId` |
| `decision` | (sourceRefs already covered by Tier 1) |

### Tier 3 — Semantic (optional, phase 2)

Only active when `graphLinks.includeSemantic: true` AND `options.pool` is provided:
1. `db = pool.getDb(record.agentId || "default")`
2. Use `record.vector` if available in index, otherwise skip (no re-embedding at rebuild time)
3. `db.search(vector, maxPerNote, semanticThreshold)` → filter already-linked IDs → fill remaining slots
4. Link label: `_(ähnlich, {score.toFixed(2)})_`

---

## Link Format

```
[[{reviewRoot}/records/{collection}/{id}|{displayTitle}]] _(label)_
```

- `displayTitle` = `record.title || record.summary?.slice(0, 60) || record.plur1bus_id`
- `reviewRoot` from `rawConfig.reviewRoot || "plur1bus"`
- Fallback: if `record.path` is available in the index, use it directly; otherwise construct from `recordRelativePath()`

---

## Config Schema

New section inside `obsidianBridge` config (in `openclaw.json`):

```json
{
  "obsidianBridge": {
    "graphLinks": {
      "enabled": true,
      "maxPerNote": 5,
      "includeSemantic": false,
      "semanticThreshold": 0.78,
      "blockId": "graph-links"
    }
  }
}
```

Default: `enabled: true`, `maxPerNote: 5`, `includeSemantic: false`.  
If `graphLinks` key is absent, defaults apply (feature is ON by default).

---

## Integration Point

In `lib/obsidian-bridge.js`, inside `rebuildDashboards()`:

```javascript
import { writeGraphLinks } from "./obsidian/graph-link-writer.js";

function rebuildDashboards() {
  for (const workspace of workspaces) {
    const vaultCfg = ...;
    generateDashboards(vaultCfg, derivedOptions);

    // NEW: inject graph links into record notes
    const graphLinksCfg = vaultCfg.graphLinks ?? {};
    if (graphLinksCfg.enabled !== false) {
      const { records } = buildRecordIndex(vaultCfg, derivedOptions);
      writeGraphLinks(vaultCfg, records, { pool, logger: api.logger });
    }
  }
}
```

`buildRecordIndex` is already imported in `obsidian-bridge.js` (used in other places). No new dependencies needed.

---

## Return Value

```javascript
{
  ok: true,
  updated: 12,      // blocks written/replaced
  unchanged: 5,     // hash matched, no write needed
  skipped: 2,       // record note file doesn't exist yet on disk
  conflicts: ["decision-abc123"],  // hash mismatch, user edit protected
  tiersUsed: ["explicit", "type"]  // which tiers contributed at least one link
}
```

---

## Files to Create/Modify

| File | Change |
|---|---|
| `lib/obsidian/graph-link-writer.js` | **NEW** — complete implementation |
| `lib/obsidian-bridge.js` | Add import + call in `rebuildDashboards()` |
| `lib/i18n-dictionary.js` | No new keys needed (no Telegram output) |

Dependencies reused (no new imports beyond existing bridge modules):
- `lib/obsidian/managed-blocks.js` — `buildManagedBlock`, `replaceManagedBlock`
- `lib/obsidian/safe-paths.js` — `resolveReviewPath`
- `lib/obsidian/record-schema.js` — `recordRelativePath`
- `lib/obsidian/record-index.js` — `buildRecordIndex` (already called in bridge)

---

## Verification

1. **Unit test (node script):**
   - Load a workspace's records via `buildRecordIndex`
   - Call `writeGraphLinks` with `pool: null` (Tiers 1+2 only)
   - Inspect a record note: should have `<!-- plur1bus:managed:start id="graph-links" -->` block
   - Re-run: `unchanged` count should equal total records (idempotent)

2. **Conflict test:**
   - Manually edit the `graph-links` block in a note (change one char)
   - Re-run: that note should appear in `conflicts[]`, block untouched

3. **Obsidian Graph View:**
   - Open vault in Obsidian
   - Graph View should show edges between decision/source/candidate nodes
   - No manual content should be affected

4. **Dashboard rebuild integration:**
   - Confirm `graphLinks` count appears in bridge log line: `plur1bus-obsidian-bridge: rebuilt N dashboard file(s)` (extend log message)
