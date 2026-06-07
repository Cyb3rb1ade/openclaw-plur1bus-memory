# Graph Link Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject `[[wikilinks]]` into Obsidian record notes via a Managed Block during the existing dashboard-rebuild cycle, making Obsidian's Graph View show real edges between knowledge records.

**Architecture:** New standalone module `lib/obsidian/graph-link-writer.js` called from `rebuildDashboards()` in `lib/obsidian-bridge.js`. For each record note on disk, it computes links via three tiers (explicit refs → type rules → semantic), then writes/replaces a `id="graph-links"` Managed Block. Uses existing `buildManagedBlock`/`replaceManagedBlock` API and the record index already read during the dashboard rebuild.

**Tech Stack:** Node.js ESM, `node:fs`, `node:test` (test runner), existing bridge modules: `lib/obsidian/managed-blocks.js`, `lib/obsidian/safe-paths.js`, `lib/obsidian/record-index.js`, `lib/obsidian/record-schema.js`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/obsidian/graph-link-writer.js` | **CREATE** | All link-computation + block-injection logic |
| `lib/obsidian-bridge.js` | **MODIFY** (1 import + ~8 lines in `rebuildDashboards`) | Calls `writeGraphLinks` after `generateDashboards` |
| `tests/smoke-graph-link-writer.test.js` | **CREATE** | Unit + smoke tests for all tiers and edge cases |

---

## Task 1: Link Formatting Helpers + Skeleton

**Files:**
- Create: `lib/obsidian/graph-link-writer.js`
- Create: `tests/smoke-graph-link-writer.test.js`

### Background

`record.path` from `readRecords()` is relative to `reviewPath` (e.g. `records/decisions/decision-abc.md`).  
Obsidian wikilinks need path relative to **vault root**: `plur1bus/records/decisions/decision-abc`.  
So: `{reviewRoot}/{record.path.replace('.md', '')}`.

Display title: `record.title || record.summary?.slice(0, 60) || record.plur1bus_id || record.id || "(unbekannt)"`.

- [ ] **Step 1.1: Write failing tests for link helpers**

```javascript
// tests/smoke-graph-link-writer.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { formatLinkTarget, formatDisplayTitle, buildLinkLine } from "../lib/obsidian/graph-link-writer.js";

describe("graph-link-writer: helpers", () => {
  it("formatLinkTarget constructs vault-relative wikilink path", () => {
    const record = { path: "records/decisions/dec-abc.md" };
    assert.strictEqual(formatLinkTarget(record, "plur1bus"), "plur1bus/records/decisions/dec-abc");
  });

  it("formatLinkTarget falls back to plur1bus_id when path missing", () => {
    const record = { plur1bus_id: "dec-xyz", plur1bus_type: "decision" };
    assert.match(formatLinkTarget(record, "plur1bus"), /dec-xyz/);
  });

  it("formatDisplayTitle uses title first", () => {
    assert.strictEqual(formatDisplayTitle({ title: "My Note", summary: "Sum" }), "My Note");
  });

  it("formatDisplayTitle falls back to summary slice", () => {
    const long = "A".repeat(80);
    assert.strictEqual(formatDisplayTitle({ summary: long }).length, 60);
  });

  it("formatDisplayTitle falls back to plur1bus_id", () => {
    assert.strictEqual(formatDisplayTitle({ plur1bus_id: "dec-abc" }), "dec-abc");
  });

  it("buildLinkLine produces correct wikilink markdown", () => {
    const line = buildLinkLine({ path: "records/decisions/dec-abc.md" }, "plur1bus", "Meine Decision", "memoryId");
    assert.strictEqual(line, "- [[plur1bus/records/decisions/dec-abc|Meine Decision]] _(memoryId)_");
  });
});
```

- [ ] **Step 1.2: Run test to see it fail**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: `Error: Cannot find module '../lib/obsidian/graph-link-writer.js'`

- [ ] **Step 1.3: Create the module with helpers**

```javascript
// lib/obsidian/graph-link-writer.js
import { existsSync, readFileSync } from "node:fs";
import { buildManagedBlock, replaceManagedBlock } from "./managed-blocks.js";
import { resolveReviewPath } from "./safe-paths.js";
import { buildRecordIndex } from "./record-index.js";
import { atomicWriteText } from "./safe-paths.js";

export function formatLinkTarget(record, reviewRoot) {
  const rel = record.path
    || `records/${record.plur1bus_type || record.type || "unknown"}/${record.plur1bus_id || record.id || "unknown"}.md`;
  return `${reviewRoot}/${rel.replace(/\.md$/, "")}`;
}

export function formatDisplayTitle(record) {
  if (record.title) return record.title;
  if (record.summary) return String(record.summary).slice(0, 60);
  return record.plur1bus_id || record.id || "(unbekannt)";
}

export function buildLinkLine(record, reviewRoot, displayTitle, label) {
  const target = formatLinkTarget(record, reviewRoot);
  return `- [[${target}|${displayTitle}]] _(${label})_`;
}

export function writeGraphLinks(rawConfig, records, options = {}) {
  // Stub — filled in Tasks 2–4
  return { ok: true, updated: 0, unchanged: 0, skipped: 0, conflicts: [], tiersUsed: [] };
}
```

- [ ] **Step 1.4: Run tests — should pass**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: all 6 helper tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add lib/obsidian/graph-link-writer.js tests/smoke-graph-link-writer.test.js
git commit -m "feat(graph-links): add helper functions + module skeleton"
```

---

## Task 2: Config Resolution + Record Index

**Files:**
- Modify: `lib/obsidian/graph-link-writer.js`
- Modify: `tests/smoke-graph-link-writer.test.js`

### Background

Config comes from `rawConfig.graphLinks` with these defaults:
- `maxPerNote: 5`
- `includeSemantic: false`
- `semanticThreshold: 0.78`
- `blockId: "graph-links"`
- `tiers: ["explicit", "type", "semantic"]`

`buildRecordIndex(rawConfig, { records })` returns `{ records, byId, byType }`. `byId` keys are `plur1bus_id || id`.

- [ ] **Step 2.1: Write failing test for config defaults**

Add to `tests/smoke-graph-link-writer.test.js`:

```javascript
import { resolveGraphConfig } from "../lib/obsidian/graph-link-writer.js";

describe("graph-link-writer: config", () => {
  it("resolveGraphConfig returns defaults when graphLinks absent", () => {
    const cfg = resolveGraphConfig({});
    assert.strictEqual(cfg.maxPerNote, 5);
    assert.strictEqual(cfg.includeSemantic, false);
    assert.deepStrictEqual(cfg.tiers, ["explicit", "type", "semantic"]);
    assert.strictEqual(cfg.blockId, "graph-links");
  });

  it("resolveGraphConfig merges user config", () => {
    const cfg = resolveGraphConfig({ graphLinks: { maxPerNote: 3, tiers: ["explicit"] } });
    assert.strictEqual(cfg.maxPerNote, 3);
    assert.deepStrictEqual(cfg.tiers, ["explicit"]);
    assert.strictEqual(cfg.includeSemantic, false);
  });
});
```

- [ ] **Step 2.2: Run test — should fail**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: `SyntaxError: The requested module does not provide an export named 'resolveGraphConfig'`

- [ ] **Step 2.3: Implement `resolveGraphConfig`**

Add to `lib/obsidian/graph-link-writer.js` (before `writeGraphLinks`):

```javascript
export function resolveGraphConfig(rawConfig) {
  const g = rawConfig.graphLinks || {};
  return {
    maxPerNote: g.maxPerNote ?? 5,
    includeSemantic: g.includeSemantic ?? false,
    semanticThreshold: g.semanticThreshold ?? 0.78,
    blockId: g.blockId ?? "graph-links",
    tiers: Array.isArray(g.tiers) ? g.tiers : ["explicit", "type", "semantic"],
  };
}
```

- [ ] **Step 2.4: Run tests — all pass**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: all 8 tests PASS.

- [ ] **Step 2.5: Commit**

```bash
git add lib/obsidian/graph-link-writer.js tests/smoke-graph-link-writer.test.js
git commit -m "feat(graph-links): config resolution with defaults"
```

---

## Task 3: Tier 1 — Explicit References

**Files:**
- Modify: `lib/obsidian/graph-link-writer.js`
- Modify: `tests/smoke-graph-link-writer.test.js`

### Background

For a given record:
- `record.memoryIds` — array of `plur1bus_id` strings pointing to related records
- `record.sourceRefs` — array of `plur1bus_id` strings pointing to source records

For each ID, look it up in `byId`. If found, call `buildLinkLine(target, reviewRoot, displayTitle, label)`.  
Label: `"memoryId"` or `"Quelle"`.  
Stop collecting when `links.length >= maxPerNote`.

- [ ] **Step 3.1: Write failing Tier 1 test**

Add to `tests/smoke-graph-link-writer.test.js`:

```javascript
import { collectTier1Links } from "../lib/obsidian/graph-link-writer.js";

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
```

- [ ] **Step 3.2: Run test — should fail**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: `SyntaxError: The requested module does not provide an export named 'collectTier1Links'`

- [ ] **Step 3.3: Implement `collectTier1Links`**

Add to `lib/obsidian/graph-link-writer.js`:

```javascript
export function collectTier1Links(record, byId, reviewRoot, maxPerNote) {
  const links = [];
  const seen = new Set();
  const addLink = (id, label) => {
    if (links.length >= maxPerNote || seen.has(id)) return;
    const target = byId[id];
    if (!target) return;
    seen.add(id);
    links.push(buildLinkLine(target, reviewRoot, formatDisplayTitle(target), label));
  };
  for (const id of Array.isArray(record.memoryIds) ? record.memoryIds : []) addLink(id, "memoryId");
  for (const id of Array.isArray(record.sourceRefs) ? record.sourceRefs : []) addLink(id, "Quelle");
  return links;
}
```

- [ ] **Step 3.4: Run tests — all pass**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: all 12 tests PASS.

- [ ] **Step 3.5: Commit**

```bash
git add lib/obsidian/graph-link-writer.js tests/smoke-graph-link-writer.test.js
git commit -m "feat(graph-links): tier1 explicit references (memoryIds + sourceRefs)"
```

---

## Task 4: Tier 2 — Type Rules

**Files:**
- Modify: `lib/obsidian/graph-link-writer.js`
- Modify: `tests/smoke-graph-link-writer.test.js`

### Background

Tier 2 rules (fills slots remaining after Tier 1):

| `record.plur1bus_type` | Rule |
|---|---|
| `memory_candidate` | Find all `decision` records in `byType.decision[]` whose `memoryIds` includes `record.plur1bus_id` |
| `review_item` | Find all records in `byType["review-items"][]` sharing the same `reviewBundleId` (excluding self) |
| anything else | No Tier 2 links |

`existing` is a `Set<string>` of already-linked `plur1bus_id` values (to avoid duplicating Tier 1 links).

- [ ] **Step 4.1: Write failing Tier 2 test**

Add to `tests/smoke-graph-link-writer.test.js`:

```javascript
import { collectTier2Links } from "../lib/obsidian/graph-link-writer.js";

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
```

- [ ] **Step 4.2: Run test — should fail**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: `SyntaxError: ... 'collectTier2Links'`

- [ ] **Step 4.3: Implement `collectTier2Links`**

Add to `lib/obsidian/graph-link-writer.js`:

```javascript
export function collectTier2Links(record, byId, byType, reviewRoot, maxPerNote, existingIds) {
  const links = [];
  const type = record.plur1bus_type || record.type;
  const selfId = record.plur1bus_id || record.id;

  const addLink = (target, label) => {
    const targetId = target.plur1bus_id || target.id;
    if (links.length >= maxPerNote || existingIds.has(targetId) || targetId === selfId) return;
    links.push(buildLinkLine(target, reviewRoot, formatDisplayTitle(target), label));
  };

  if (type === "memory_candidate") {
    for (const dec of (byType.decision || [])) {
      if (Array.isArray(dec.memoryIds) && dec.memoryIds.includes(selfId)) addLink(dec, "Entscheidung");
    }
  } else if (type === "review_item" && record.reviewBundleId) {
    for (const sibling of (byType["review_item"] || [])) {
      if (sibling.reviewBundleId === record.reviewBundleId) addLink(sibling, "Bundle");
    }
  }
  return links;
}
```

- [ ] **Step 4.4: Run tests — all pass**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: all 16 tests PASS.

- [ ] **Step 4.5: Commit**

```bash
git add lib/obsidian/graph-link-writer.js tests/smoke-graph-link-writer.test.js
git commit -m "feat(graph-links): tier2 type-rules (memory_candidate, review_item)"
```

---

## Task 5: Block Injection + `writeGraphLinks` Main Function

**Files:**
- Modify: `lib/obsidian/graph-link-writer.js`
- Modify: `tests/smoke-graph-link-writer.test.js`

### Background

For each record:
1. Resolve `targetPath` = `resolveReviewPath(rawConfig, record.path).targetPath` (the absolute file path)
2. If file doesn't exist on disk → `skipped++`, continue
3. Compute links: Tier 1 + Tier 2 (Tier 3 requires `record.vector`, skip if absent)
4. Build block body:
   - If no links: `- _(keine Querverweise)_`
   - Else: joined link lines
5. `buildManagedBlock({ id: blockId, version: "4.2.18", body, attrs: { tiers: tiersUsed.join(",") } })`
6. Read existing file content, call `replaceManagedBlock(content, block)`:
   - If `result.conflict` → `conflicts.push(id)`, continue
   - If `result.changed` → `atomicWriteText(targetPath, result.content)`, `updated++`
   - Else → `unchanged++`
7. Return summary stats

- [ ] **Step 5.1: Write failing integration test**

Add to `tests/smoke-graph-link-writer.test.js`:

```javascript
import { writeGraphLinks } from "../lib/obsidian/graph-link-writer.js";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("injects graph-links block into a record note", () => {
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
    const result = writeGraphLinks(rawConfig, [srcRecord, decRecord], {});

    assert.ok(result.ok);
    assert.strictEqual(result.updated, 1, "dec-001 has a sourceRef, should be updated");
    // src-001 has no links → empty state block → still counts as updated (first write)
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.conflicts.length, 0);

    const decContent = readFileSync(join(vault, "plur1bus/records/decisions/dec-001.md"), "utf8");
    assert.match(decContent, /plur1bus:managed:start id="graph-links"/);
    assert.match(decContent, /Kimi API Docs/);
    assert.match(decContent, /Quelle/);
  });

  it("is idempotent — second run returns unchanged=N", () => {
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
    writeGraphLinks(rawConfig, [record], {});
    const second = writeGraphLinks(rawConfig, [record], {});
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.unchanged, 1);
  });

  it("skips note if file does not exist on disk", () => {
    const vault = makeVault();
    const record = {
      plur1bus_id: "dec-ghost",
      plur1bus_type: "decision",
      path: "records/decisions/dec-ghost.md",
      title: "Ghost",
    };
    const rawConfig = { vaultPath: vault, reviewRoot: "plur1bus" };
    const result = writeGraphLinks(rawConfig, [record], {});
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.updated, 0);
  });

  it("detects conflict when block body was manually edited", () => {
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
    const result = writeGraphLinks(rawConfig, [record], {});
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0], "dec-003");
    assert.strictEqual(result.updated, 0);
    // file must be untouched
    const content = readFileSync(join(vault, "plur1bus/records/decisions/dec-003.md"), "utf8");
    assert.match(content, /manually edited/);
  });
});
```

- [ ] **Step 5.2: Run test — should fail**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: `AssertionError: 0 == 1` (writeGraphLinks is still a stub returning 0)

- [ ] **Step 5.3: Implement full `writeGraphLinks`**

Replace the stub in `lib/obsidian/graph-link-writer.js`:

```javascript
export function writeGraphLinks(rawConfig, records, options = {}) {
  const { logger } = options;
  const cfg = resolveGraphConfig(rawConfig);
  const { blockId, maxPerNote, tiers, includeSemantic } = cfg;
  const reviewRoot = rawConfig.reviewRoot || "plur1bus";

  const { byId, byType } = buildRecordIndex(rawConfig, { records });

  let updated = 0, unchanged = 0, skipped = 0;
  const conflicts = [];
  const tiersUsedGlobal = new Set();

  for (const record of records) {
    if (!record.path) { skipped++; continue; }
    const { targetPath } = resolveReviewPath(rawConfig, record.path);
    if (!existsSync(targetPath)) { skipped++; continue; }

    const links = [];
    const tier1 = tiers.includes("explicit") ? collectTier1Links(record, byId, reviewRoot, maxPerNote) : [];
    links.push(...tier1);
    if (tier1.length > 0) tiersUsedGlobal.add("explicit");

    const existingIds = new Set(
      tier1.map(() => null).concat(
        (Array.isArray(record.memoryIds) ? record.memoryIds : [])
          .concat(Array.isArray(record.sourceRefs) ? record.sourceRefs : [])
      ).filter(Boolean)
    );

    if (tiers.includes("type") && links.length < maxPerNote) {
      const tier2 = collectTier2Links(record, byId, byType, reviewRoot, maxPerNote - links.length, existingIds);
      links.push(...tier2);
      if (tier2.length > 0) tiersUsedGlobal.add("type");
    }

    if (includeSemantic && tiers.includes("semantic") && record.vector && options.pool && links.length < maxPerNote) {
      try {
        const db = options.pool.getDb(record.agentId || "default");
        await db.init();
        const semanticResults = await db.search(record.vector, maxPerNote - links.length, cfg.semanticThreshold);
        for (const r of (semanticResults || [])) {
          const t = r.entry || r;
          const targetId = t.id || t.plur1bus_id;
          if (!targetId || existingIds.has(targetId)) continue;
          const linked = byId[targetId];
          if (!linked) continue;
          links.push(buildLinkLine(linked, reviewRoot, formatDisplayTitle(linked), `ähnlich, ${(r.score ?? 0).toFixed(2)}`));
          tiersUsedGlobal.add("semantic");
          if (links.length >= maxPerNote) break;
        }
      } catch (_) {
        // semantic search failure is non-fatal
      }
    }

    const body = links.length > 0
      ? "## 🔗 Verwandte Einträge\n\n" + links.join("\n")
      : "## 🔗 Verwandte Einträge\n\n- _(keine Querverweise)_";

    const block = buildManagedBlock({
      id: blockId,
      version: "4.2.18",
      body,
      attrs: { tiers: [...tiersUsedGlobal].join(",") || "none" },
    });

    const existing = readFileSync(targetPath, "utf8");
    const result = replaceManagedBlock(existing, { id: blockId, version: "4.2.18", body, attrs: { tiers: [...tiersUsedGlobal].join(",") || "none" } });

    if (result.conflict) {
      const id = record.plur1bus_id || record.id || record.path;
      conflicts.push(id);
      logger?.warn?.(`plur1bus-graph-links: conflict on ${id} — manual edit protected`);
      continue;
    }
    if (result.changed) {
      atomicWriteText(targetPath, result.content);
      updated++;
    } else {
      unchanged++;
    }
  }

  return { ok: true, updated, unchanged, skipped, conflicts, tiersUsed: [...tiersUsedGlobal] };
}
```

**Note:** The function uses `await` for Tier 3 but is synchronous for Tiers 1+2. Make the function `async` since `pool.getDb` and `db.search` are async:

```javascript
export async function writeGraphLinks(rawConfig, records, options = {}) {
```

- [ ] **Step 5.4: Fix the `existingIds` computation (bug in Step 5.3)**

The `existingIds` set should contain the actual IDs from Tier 1 targets. Replace the existingIds construction:

```javascript
const existingIds = new Set();
for (const id of (Array.isArray(record.memoryIds) ? record.memoryIds : [])) existingIds.add(id);
for (const id of (Array.isArray(record.sourceRefs) ? record.sourceRefs : [])) existingIds.add(id);
```

- [ ] **Step 5.5: Run all tests — should pass**

```bash
node --test tests/smoke-graph-link-writer.test.js
```
Expected: all 20 tests PASS.

- [ ] **Step 5.6: Commit**

```bash
git add lib/obsidian/graph-link-writer.js tests/smoke-graph-link-writer.test.js
git commit -m "feat(graph-links): full writeGraphLinks with block injection, conflict detection, idempotency"
```

---

## Task 6: Bridge Integration

**Files:**
- Modify: `lib/obsidian-bridge.js` — lines ~1634–1654 (`rebuildDashboards`)

### Background

Current `rebuildDashboards()`:
```javascript
function rebuildDashboards() {
  const workspaces = discoverObsidianWorkspaces(cfg, options);
  let built = 0;
  for (const workspace of workspaces) {
    try {
      const vaultCfg = { ...rawConfig, vaultPath: workspace.path, reviewRoot: cfg.reviewRoot || "plur1bus" };
      const records = readRecords(vaultCfg);
      if (records.length === 0) continue;
      const result = generateDashboards(vaultCfg, { agentId: workspace.agentId, workspaceKey: workspace.workspaceId, records, readExistingRecords: true });
      built += Array.isArray(result) ? result.length : result?.count ?? 0;
    } catch (err) {
      logger.warn?.(`plur1bus-obsidian-bridge: dashboard rebuild failed for ${workspace.workspaceId}: ${String(err)}`);
    }
  }
  if (built > 0) logger.info?.(`plur1bus-obsidian-bridge: rebuilt ${built} dashboard file(s)`);
}
```

`writeGraphLinks` is `async` (for Tier 3). `rebuildDashboards` is currently sync. Change it to `async function rebuildDashboards()` and `await writeGraphLinks(...)`. Then the callers in `start()` already use it via `setInterval` (fire-and-forget) or after `syncOnce` — wrapping in `.catch()` is fine.

- [ ] **Step 6.1: Add import to `lib/obsidian-bridge.js`**

Find the import block at the top of the file. Add after the existing obsidian imports:

```javascript
import { writeGraphLinks } from "./obsidian/graph-link-writer.js";
```

- [ ] **Step 6.2: Replace `rebuildDashboards` with async version**

Replace the entire `rebuildDashboards` function (lines ~1634–1654):

```javascript
async function rebuildDashboards() {
  const workspaces = discoverObsidianWorkspaces(cfg, options);
  let built = 0;
  let glUpdated = 0;
  for (const workspace of workspaces) {
    try {
      const vaultCfg = { ...rawConfig, vaultPath: workspace.path, reviewRoot: cfg.reviewRoot || "plur1bus" };
      const records = readRecords(vaultCfg);
      if (records.length === 0) continue;
      const result = generateDashboards(vaultCfg, {
        agentId: workspace.agentId,
        workspaceKey: workspace.workspaceId,
        records,
        readExistingRecords: true,
      });
      built += Array.isArray(result) ? result.length : result?.count ?? 0;

      // Graph links: inject [[wikilinks]] into record notes
      const graphLinksCfg = vaultCfg.graphLinks ?? rawConfig.graphLinks ?? {};
      if (graphLinksCfg.enabled !== false) {
        const glResult = await writeGraphLinks(vaultCfg, records, { logger });
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

- [ ] **Step 6.3: Verify the callers handle async correctly**

Check how `rebuildDashboards` is called (lines ~1663–1676 of original):

```javascript
// One-shot mode: already fire-and-forget
rebuildDashboards();     // line ~1664 — add .catch(...)

// Watch mode: interval callback
dashboardTimer = setInterval(() => {
  if (!running) return;
  rebuildDashboards();   // line ~1675 — add .catch(...)
}, dashboardRebuildIntervalMs);
```

Update both call sites to `.catch(err => logger.warn?.(...))` so unhandled promise rejections don't crash the process:

```javascript
// One-shot:
rebuildDashboards().catch((err) => logger.warn?.(`plur1bus-obsidian-bridge: dashboard rebuild failed: ${String(err)}`));

// Interval:
dashboardTimer = setInterval(() => {
  if (!running) return;
  rebuildDashboards().catch((err) => logger.warn?.(`plur1bus-obsidian-bridge: dashboard rebuild failed: ${String(err)}`));
}, dashboardRebuildIntervalMs);
```

- [ ] **Step 6.4: Run syntax check**

```bash
node --check lib/obsidian-bridge.js && node --check lib/obsidian/graph-link-writer.js
```
Expected: no output (clean)

- [ ] **Step 6.5: Run full test suite**

```bash
node --test tests/smoke-graph-link-writer.test.js && node --test tests/smoke-obsidian-apply.test.js
```
Expected: all tests PASS.

- [ ] **Step 6.6: Commit**

```bash
git add lib/obsidian-bridge.js lib/obsidian/graph-link-writer.js
git commit -m "feat(graph-links): wire writeGraphLinks into rebuildDashboards"
```

---

## Task 7: Sync to Installed Extension + PR

**Files:**
- Sync: `/root/.openclaw/extensions/memory-lancedb-namespaced/`

- [ ] **Step 7.1: Sync modified files to installed extension**

```bash
DEST=/root/.openclaw/extensions/memory-lancedb-namespaced
cp /root/lib/obsidian/graph-link-writer.js "$DEST/lib/obsidian/graph-link-writer.js"
cp /root/lib/obsidian-bridge.js "$DEST/lib/obsidian-bridge.js"
echo "Sync done"
```

- [ ] **Step 7.2: Run full project test suite**

```bash
node --test tests/*.test.js 2>&1 | tail -20
```
Expected: no new failures (pre-existing failures, if any, are unchanged).

- [ ] **Step 7.3: Create feature branch and PR**

```bash
git checkout -b feat/v6-graph-link-writer
git push -u origin feat/v6-graph-link-writer
gh pr create --title "feat(graph-links): inject [[wikilinks]] into Obsidian record notes" --body "$(cat <<'EOF'
## Summary

- New `lib/obsidian/graph-link-writer.js` module injects a \`🔗 Verwandte Einträge\` Managed Block into each record note during the dashboard-rebuild cycle
- Three link tiers: explicit refs (memoryIds/sourceRefs) → type rules (memory_candidate→decision, review_item→bundle siblings) → semantic (opt-in, Tier 3)
- Uses existing \`replaceManagedBlock()\` with hash-conflict detection — manual edits in the block are never overwritten
- Config: \`obsidianBridge.graphLinks.enabled/maxPerNote/tiers\` in openclaw.json; feature is ON by default
- Integration: \`rebuildDashboards()\` in obsidian-bridge.js calls \`writeGraphLinks\` after \`generateDashboards\`

## Test plan
- [ ] \`node --test tests/smoke-graph-link-writer.test.js\` — all 20 tests pass
- [ ] Re-run produces \`unchanged=N, updated=0\` (idempotent)
- [ ] Record with sourceRefs gets correct \`[[plur1bus/records/sources/...|Title]]\` link in vault
- [ ] Tampered block → \`conflicts[]\` entry, file untouched
- [ ] Open vault in Obsidian → Graph View shows edges between decision/source/candidate nodes
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered in task |
|---|---|
| New `graph-link-writer.js` module | Tasks 1–5 |
| `writeGraphLinks(rawConfig, records, options)` signature | Task 1 skeleton, Task 5 impl |
| Managed Block `id="graph-links"` with `tiers` in start tag | Task 5 |
| Empty state `- _(keine Querverweise)_` | Task 5 |
| Conflict detection via `replaceManagedBlock()` | Task 5 |
| Tier 1: memoryIds + sourceRefs | Task 3 |
| Tier 2: memory_candidate, review_item rules | Task 4 |
| Tier 3: optional semantic (skip if no vector) | Task 5 |
| Config defaults (maxPerNote=5, etc.) | Task 2 |
| `tiers` config key to disable individual tiers | Task 2 |
| Bridge integration after `generateDashboards` | Task 6 |
| `async rebuildDashboards` + `.catch()` at call sites | Task 6 |
| Return: `{ ok, updated, unchanged, skipped, conflicts, tiersUsed }` | Task 5 |
| Sync to installed extension | Task 7 |
| Link format `[[reviewRoot/records/{coll}/{id}|Title]]` | Task 1 helpers |

**No placeholders found.** All steps have code.

**Type consistency:**
- `formatLinkTarget`, `formatDisplayTitle`, `buildLinkLine` defined in Task 1, used in Tasks 3–5 ✓
- `collectTier1Links` defined Task 3, referenced Task 5 ✓
- `collectTier2Links` defined Task 4, referenced Task 5 ✓
- `resolveGraphConfig` defined Task 2, referenced Task 5 ✓
- `writeGraphLinks` stubbed Task 1, implemented Task 5 ✓
- `blockId` from `cfg.blockId` in Task 5, also used as `id` in `replaceManagedBlock` call ✓
