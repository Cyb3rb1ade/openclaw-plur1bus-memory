# P1 Graph Scoring & Recall Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent weak associative memories from overtaking direct vector relevance in recall ranking by separating graph scores, hardening traversal/edges, disciplining boosts, and enforcing a tiered recall budget.

**Architecture:** Keep the existing `runRecallPipeline` entry contract (`{ canonical, memories, queryVector }`) unchanged. Fix scoring inside `lib/memory-graph.js` so graph-only hits can never outrank the best vector hit and graph overlap no longer artificially boosts vector scores. Harden `traverseGraph` and `buildEdgesForSession` so deeper/weaker edges stop earlier. Cap emotional/importance/strength boosts in `lib/recall-pipeline.js` so they act as tie-breakers, not score multipliers. Finally, wire `allocateMemoryTiers` into the pipeline so associative memories are capped at 30% of the final prompt budget.

**Tech Stack:** Node.js built-in test runner (`node:test` + `node:assert/strict`), LanceDB table API, existing `lib/memory-graph.js`, `lib/recall-pipeline.js`, `lib/recall-budget.js`.

---

## File Structure Map

| File | Current Responsibility | P1 Change |
|------|------------------------|-----------|
| `lib/memory-graph.js` | Graph read, traversal, edge generation, score merging | Separate graph/vector scoring, harden traversal defaults, raise edge-quality thresholds |
| `lib/recall-pipeline.js` | Vector search, canonical lookup, boosts, graph merge, hydration, rerank, dedup | Replace multiplicative boosts with capped/additive boosts, call budget allocator |
| `lib/recall-budget.js` | Pure `resolveRecallBudget` and `allocateMemoryTiers` | Add `applyRecallBudget` helper that partitions pipeline results into tiers |
| `index.js` | Calls `runRecallPipeline` for auto and manual recall | Pass `budget` from `maxPromptMemories`; no return-shape change |
| `openclaw.plugin.json` | JSON schema for config defaults | Lower `associativeRecall.maxDepth` default, expose `graphHydrationRelevanceThreshold` |
| `tests/memory-graph-scoring.test.js` | *new* | H1-01 / H1-02 score separation |
| `tests/memory-graph-traversal.test.js` | *new* | H1-03 depth/relevance scaling |
| `tests/memory-graph-edges.test.js` | *new* | H1-04 edge-quality rules |
| `tests/recall-pipeline-boosts.test.js` | *new* | H1-07 boost discipline |
| `tests/recall-pipeline-budget.test.js` | *new* | H1-06 budget integration |

---

## Task 1: H1-01 + H1-02 — Separate associative scores from vector scores

**Files:**
- Modify: `lib/memory-graph.js:174-198`
- Create: `tests/memory-graph-scoring.test.js`

### Step 1: Write the failing test

Create `tests/memory-graph-scoring.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeAssociativeResults } from "../lib/memory-graph.js";

function makeMemory(id, score = 0.8) {
  return { entry: { id }, score };
}

describe("mergeAssociativeResults – H1-01 graph-only score cap", () => {
  it("caps graph-only score below the best vector score", () => {
    const originals = [makeMemory("v1", 0.95), makeMemory("v2", 0.70)];
    const associative = [
      { memoryId: "g1", associatedScore: 0.99, depth: 1, path: ["v1", "g1"] },
    ];
    const merged = mergeAssociativeResults(originals, associative, 10);
    const graphItem = merged.find(r => r.entry?.id === "g1");
    assert.ok(graphItem, "graph item must be present");
    assert.ok(graphItem.score <= 0.95 * 0.85 + 1e-9, `expected <= ${0.95 * 0.85}, got ${graphItem.score}`);
    assert.strictEqual(graphItem.source, "graph");
  });

  it("downscales graph-only scores when no vector results exist", () => {
    const originals = [];
    const associative = [
      { memoryId: "g1", associatedScore: 0.8, depth: 1, path: [] },
    ];
    const merged = mergeAssociativeResults(originals, associative, 10);
    const graphItem = merged.find(r => r.entry?.id === "g1");
    assert.ok(graphItem, "graph item must be present");
    assert.ok(graphItem.score < 0.8, "graph score must be downscaled when no vector anchor exists");
  });
});

describe("mergeAssociativeResults – H1-02 no artificial vector boost", () => {
  it("does not raise a vector score just because graph also found it", () => {
    const originals = [makeMemory("v1", 0.50)];
    const associative = [
      { memoryId: "v1", associatedScore: 0.95, depth: 1, path: ["seed", "v1"] },
    ];
    const merged = mergeAssociativeResults(originals, associative, 10);
    const item = merged.find(r => r.entry?.id === "v1");
    assert.ok(item, "item must be present");
    assert.strictEqual(item.score, 0.50, "vector score must stay unchanged");
    assert.strictEqual(item.source, "both");
  });
});
```

### Step 2: Run the failing tests

Run:

```bash
node --test tests/memory-graph-scoring.test.js
```

Expected: FAIL — graph item score is not capped and vector score is boosted.

### Step 3: Implement score separation

Replace `lib/memory-graph.js:174-198` with:

```js
export function mergeAssociativeResults(originalResults, associativeResults, maxTotal = 15) {
  const byId = new Map();
  const maxVectorScore = originalResults.reduce(
    (max, r) => Math.max(max, r.score || 0),
    0,
  );

  for (const r of originalResults) {
    byId.set(r.entry?.id || r.id, { ...r, source: "vector" });
  }

  for (const assoc of associativeResults) {
    const id = assoc.memoryId;
    const existing = byId.get(id);
    if (existing) {
      // H1-02: graph overlap must not artificially inflate vector score.
      // The item is already recalled directly; keep its vector score.
      existing.source = "both";
    } else {
      // H1-01: graph-only hits compete in a separate lane.
      // Cap them below the best vector hit, or scale them down if there is no anchor.
      const rawGraphScore = assoc.associatedScore;
      const cappedGraphScore = maxVectorScore > 0
        ? Math.min(rawGraphScore, maxVectorScore * 0.85)
        : rawGraphScore * 0.7;
      byId.set(id, {
        entry: { id: assoc.memoryId },
        score: cappedGraphScore,
        source: "graph",
        depth: assoc.depth,
      });
    }
  }

  const merged = Array.from(byId.values());
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, maxTotal);
}
```

### Step 4: Run the tests again

```bash
node --test tests/memory-graph-scoring.test.js
```

Expected: all PASS.

### Step 5: Commit

```bash
git add lib/memory-graph.js tests/memory-graph-scoring.test.js
git commit -m "fix(graph): separate associative scores from vector scores

- H1-01: graph-only hits are capped below the best vector hit
- H1-02: graph overlap no longer artificially boosts vector scores"
```

---

## Task 2: H1-03 — Harden graph traversal depth and cumulative relevance

**Files:**
- Modify: `lib/memory-graph.js:97-170`
- Modify: `openclaw.plugin.json:567`
- Create: `tests/memory-graph-traversal.test.js`

### Step 1: Write the failing test

Create `tests/memory-graph-traversal.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { traverseGraph, readGraph, DEFAULT_TRAVERSAL_CONFIG } from "../lib/memory-graph.js";

function makeEdge(source, target, strength = 0.9) {
  return { source, target, type: "semantic", strength, directed: false };
}

describe("traverseGraph – H1-03 depth/relevance hardening", () => {
  it("default maxDepth is 2", () => {
    assert.strictEqual(DEFAULT_TRAVERSAL_CONFIG.maxDepth, 2);
  });

  it("scales min cumulative relevance with depth, dropping deeper weak paths", () => {
    // seed -> n1 (0.6) -> n2 (0.6). With default minCumulativeRelevance 0.2 and
    // depthRelevanceScale 0.5, depth-2 threshold is 0.2 * (1 + 2*0.5) = 0.4.
    // Cumulative after two edges = 0.6 * 0.6 = 0.36, so depth-2 item should be dropped.
    const edges = [makeEdge("seed", "n1", 0.6), makeEdge("n1", "n2", 0.6)];
    const { adjacency } = readGraph(edges);
    const seeds = [{ entry: { id: "seed" }, score: 0.9 }];
    const results = traverseGraph(seeds, adjacency, DEFAULT_TRAVERSAL_CONFIG);
    const depth2 = results.find(r => r.memoryId === "n2");
    assert.ok(!depth2, "weak depth-2 path should be pruned by scaled threshold");
  });

  it("stronger deep paths still survive", () => {
    const edges = [makeEdge("seed", "n1", 0.95), makeEdge("n1", "n2", 0.95)];
    const { adjacency } = readGraph(edges);
    const seeds = [{ entry: { id: "seed" }, score: 0.9 }];
    const results = traverseGraph(seeds, adjacency, DEFAULT_TRAVERSAL_CONFIG);
    const depth2 = results.find(r => r.memoryId === "n2");
    assert.ok(depth2, "strong depth-2 path should survive");
  });
});
```

### Step 2: Run the failing tests

```bash
node --test tests/memory-graph-traversal.test.js
```

Expected: FAIL — default `maxDepth` is 3 and depth scaling does not exist.

### Step 3: Harden traversal defaults

In `lib/memory-graph.js`, change `DEFAULT_TRAVERSAL_CONFIG` (line 97-104) to:

```js
export const DEFAULT_TRAVERSAL_CONFIG = {
  seedCount: 5,
  maxDepth: 2,
  maxNeighborsPerNode: 8,
  minCumulativeRelevance: 0.2,
  depthRelevanceScale: 0.5,
  maxVisitedNodes: 150,
  maxAssociatedResults: 40,
};
```

In `traverseGraph` (around line 157), replace:

```js
const nextCumulative = current.cumulativeRelevance * (edge.strength || 0.1);
if (nextCumulative < cfg.minCumulativeRelevance) continue;
```

with:

```js
const nextCumulative = current.cumulativeRelevance * (edge.strength || 0.1);
const depthScaledThreshold = cfg.minCumulativeRelevance * (1 + current.depth * (cfg.depthRelevanceScale ?? 0));
if (nextCumulative < depthScaledThreshold) continue;
```

Also increase the depth penalty in the score calculation (line 138) from `0.25` to `0.5`:

```js
const depthPenalty = 1 / (1 + current.depth * 0.5);
```

### Step 4: Update schema default

In `openclaw.plugin.json` line 567, change:

```json
"maxDepth": { "type": "number", "default": 3 },
```

to:

```json
"maxDepth": { "type": "number", "default": 2 },
```

### Step 5: Run tests

```bash
node --test tests/memory-graph-traversal.test.js
```

Expected: PASS.

### Step 6: Commit

```bash
git add lib/memory-graph.js openclaw.plugin.json tests/memory-graph-traversal.test.js
git commit -m "fix(graph): harden traversal defaults and depth relevance scaling

- default maxDepth reduced from 3 to 2
- minCumulativeRelevance now scales with depth
- depth penalty increased"
```

---

## Task 3: H1-04 — Raise edge-quality thresholds

**Files:**
- Modify: `lib/memory-graph.js:337-373`
- Create: `tests/memory-graph-edges.test.js`

### Step 1: Write the failing test

Create `tests/memory-graph-edges.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEdgesForSession } from "../lib/memory-graph.js";

async function runWithRows(newMemories, existingRows) {
  const dbTable = {
    vectorSearch: () => ({ limit: () => ({ toArray: async () => existingRows }) }),
  };
  return buildEdgesForSession(newMemories, existingRows, dbTable, null);
}

describe("buildEdgesForSession – H1-04 edge quality", () => {
  it("entity edges require at least 2 shared tokens", async () => {
    const existing = [{ id: "e1", topics: ["api", "memory"], createdAt: new Date().toISOString() }];
    const mem = { id: "m1", topics: ["memory"], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const entityEdges = edges.filter(e => e.type === "entity");
    assert.strictEqual(entityEdges.length, 0, "single-token overlap must not create entity edge");
  });

  it("entity edges require jaccard >= 0.5", async () => {
    const existing = [{ id: "e1", topics: ["a", "b", "c", "d"], createdAt: new Date().toISOString() }];
    const mem = { id: "m1", topics: ["a", "b", "x", "y", "z"], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const entityEdges = edges.filter(e => e.type === "entity" && (e.source === "m1" || e.target === "m1"));
    assert.strictEqual(entityEdges.length, 0, "jaccard 2/7 < 0.5 must not create edge");
  });

  it("emotional edges require shared content token", async () => {
    const existing = [
      { id: "e1", emotionalDominant: "joy", emotionalIntensity: 0.8, topics: [], createdAt: new Date().toISOString() },
    ];
    const mem = { id: "m1", emotionalDominant: "joy", emotionalIntensity: 0.8, topics: ["party"], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const emotionalEdges = edges.filter(e => e.type === "emotional");
    assert.strictEqual(emotionalEdges.length, 0, "same emotion without shared token must not create edge");
  });

  it("strong emotional edges with shared token are weaker than semantic edges", async () => {
    const existing = [
      { id: "e1", emotionalDominant: "joy", emotionalIntensity: 1.0, topics: ["party"], createdAt: new Date().toISOString() },
    ];
    const mem = { id: "m1", emotionalDominant: "joy", emotionalIntensity: 1.0, topics: ["party"], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const emotional = edges.find(e => e.type === "emotional");
    assert.ok(emotional, "shared-token emotional edge should exist");
    assert.ok(emotional.strength <= 0.5, `emotional edge strength ${emotional.strength} must be <= 0.5`);
  });
});
```

### Step 2: Run failing tests

```bash
node --test tests/memory-graph-edges.test.js
```

Expected: FAIL.

### Step 3: Implement edge-quality rules

In `lib/memory-graph.js`, add a helper before `buildEdgesForSession` (after `runWithConcurrency` around line 280):

```js
function topicOverlap(aTopics = [], bTopics = []) {
  const a = new Set(aTopics.map(String).map(t => t.toLowerCase()));
  const b = new Set(bTopics.map(String).map(t => t.toLowerCase()));
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap;
}
```

Then modify the entity edge block (lines 349-364) to:

```js
    // Entity: shared topics/entities via index (O(K) instead of O(M))
    const memTopics = new Set(mem.topics || mem.entities || []);
    const candidateSet = new Map(); // otherId -> { other, overlapCount }
    for (const t of memTopics) {
      for (const other of topicIndex.get(t) || []) {
        if (other.id === memId) continue;
        candidateSet.set(other.id, { other, overlap: (candidateSet.get(other.id)?.overlap || 0) + 1 });
      }
    }
    for (const { other, overlap } of candidateSet.values()) {
      if (overlap < 2) continue;
      const otherTopics = new Set(other.topics || other.entities || []);
      const union = new Set([...memTopics, ...otherTopics]).size;
      const jaccard = union > 0 ? overlap / union : 0;
      if (jaccard < 0.5) continue;
      edges.push(createEdge(memId, other.id, "entity", Math.min(jaccard * 0.8, 0.7), false));
    }
```

Modify the emotional edge block (lines 366-373) to:

```js
    // Emotional: same dominant emotion, but only if there is also content overlap
    if (mem.emotionalDominant) {
      for (const other of emotionIndex.get(mem.emotionalDominant) || []) {
        if (other.id === memId) continue;
        const sharedTokens = topicOverlap(
          mem.topics || mem.entities || [],
          other.topics || other.entities || [],
        );
        if (sharedTokens === 0) continue;
        const intensityMatch = 1 - Math.abs((mem.emotionalIntensity || 0.5) - (other.emotionalIntensity || 0.5));
        edges.push(createEdge(memId, other.id, "emotional", intensityMatch * 0.4, false));
      }
    }
```

### Step 4: Run tests

```bash
node --test tests/memory-graph-edges.test.js
```

Expected: PASS.

### Step 5: Commit

```bash
git add lib/memory-graph.js tests/memory-graph-edges.test.js
git commit -m "fix(graph): raise edge-quality thresholds

- entity edges require >=2 shared tokens and jaccard >= 0.5
- emotional edges require shared content token and use lower weight"
```

---

## Task 4: H1-07 — Discipline vector boosts

**Files:**
- Modify: `lib/recall-pipeline.js:45-53` and `lib/recall-pipeline.js:571-603`
- Create: `tests/recall-pipeline-boosts.test.js`

### Step 1: Write the failing test

Create `tests/recall-pipeline-boosts.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyImportanceBoost } from "../lib/recall-pipeline.js";

describe("applyImportanceBoost – H1-07 additive discipline", () => {
  it("uses additive boost, not multiplicative", () => {
    const results = [
      { entry: { id: "a", importance: 1.0 }, score: 0.50 },
      { entry: { id: "b", importance: 0.5 }, score: 0.49 },
    ];
    const boosted = applyImportanceBoost(results, 0.3);
    const a = boosted.find(r => r.entry.id === "a");
    const b = boosted.find(r => r.entry.id === "b");
    // additive: a = 0.50 + (1.0 - 0.5)*0.3 = 0.65 ; b = 0.49 + 0 = 0.49
    assert.ok(a.score > b.score, "higher-importance item with much lower relevance must not overtake");
    assert.ok(a.score < 0.7, "boost must be capped");
  });

  it("returns unchanged results when boost is 0", () => {
    const results = [{ entry: { id: "a", importance: 1.0 }, score: 0.5 }];
    const boosted = applyImportanceBoost(results, 0);
    assert.strictEqual(boosted[0].score, 0.5);
  });
});
```

### Step 2: Run failing tests

```bash
node --test tests/recall-pipeline-boosts.test.js
```

Expected: FAIL — current `applyImportanceBoost` is multiplicative.

### Step 3: Make importance boost additive

Replace `lib/recall-pipeline.js:45-53` with:

```js
export function applyImportanceBoost(results, boost) {
  if (!boost || boost <= 0) return results;
  const boosted = results.map(r => ({
    ...r,
    score: r.score + ((r.entry.importance ?? 0.5) - 0.5) * boost,
  }));
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}
```

### Step 4: Cap emotional and strength boosts

Replace the scoring block in `runRecallPipeline` (`lib/recall-pipeline.js:571-603`) with a single helper-style block:

```js
  let boosted = results;
  if (results.length > 0) {
    const applyImportance = importanceBoost && importanceBoost > 0;
    boosted = results.map((r) => {
      let score = r.score;

      // 4a. Importance boost — additive, never lets low-relevance memories overtake
      if (applyImportance) {
        score += ((r.entry.importance ?? 0.5) - 0.5) * importanceBoost;
      }

      // 4b. Emotional boost — clamped to ±10% so it acts as a tie-breaker
      if (emotionalState) {
        const rawValence = r.entry.emotionalValence;
        const valence = typeof rawValence === "string"
          ? deserializeEmotionalValence(rawValence)
          : (rawValence || {});
        if (valence && typeof valence === "object" && valence.emotionalIntensity === undefined) {
          valence.emotionalIntensity = r.entry.emotionalIntensity ?? 0;
        }
        const factor = emotionalState.computeRecallBoost(valence, r.entry.importance);
        score *= Math.min(Math.max(factor, 0.9), 1.1);
      }

      // 4c. Memory strength boost — additive minor nudge
      score += (r.entry.memoryStrength ?? 1.0) - 1.0;

      return { ...r, score };
    });
    boosted.sort((a, b) => b.score - a.score);
  }
```

### Step 5: Run tests

```bash
node --test tests/recall-pipeline-boosts.test.js
```

Expected: PASS.

### Step 6: Check for regressions in emotional boost tests

Run:

```bash
node --test tests/stress-congruence-boost.test.js plur1bus/tests/stress-congruence-boost.test.js
```

If failures are due to expected multiplicative boost, update the expectations to additive/capped behavior. The plan assumes tests are updated as part of this task.

### Step 7: Commit

```bash
git add lib/recall-pipeline.js tests/recall-pipeline-boosts.test.js
git commit -m "fix(recall): discipline importance/emotion/strength boosts

- importance boost is additive
- emotional boost is clamped to +/-10%
- memory strength is an additive nudge"
```

---

## Task 5: H1-06 — Wire `allocateMemoryTiers` into the pipeline

**Files:**
- Modify: `lib/recall-budget.js`
- Modify: `lib/recall-pipeline.js:211-222` and `lib/recall-pipeline.js:641-648`
- Modify: `index.js:4076-4104`
- Create: `tests/recall-pipeline-budget.test.js`

### Step 1: Write the failing test

Create `tests/recall-pipeline-budget.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyRecallBudget } from "../lib/recall-budget.js";

describe("applyRecallBudget – H1-06 associative cap", () => {
  it("caps associative memories at 30% of the budget", () => {
    const memories = [
      { entry: { id: "v1", category: "fact" }, score: 0.9, source: "vector" },
      { entry: { id: "v2", category: "fact" }, score: 0.8, source: "vector" },
      { entry: { id: "v3", category: "fact" }, score: 0.7, source: "vector" },
      { entry: { id: "v4", category: "fact" }, score: 0.6, source: "vector" },
      { entry: { id: "v5", category: "fact" }, score: 0.5, source: "vector" },
      { entry: { id: "v6", category: "fact" }, score: 0.4, source: "vector" },
      { entry: { id: "v7", category: "fact" }, score: 0.3, source: "vector" },
      { entry: { id: "g1", category: "fact" }, score: 0.95, source: "graph", depth: 1 },
      { entry: { id: "g2", category: "fact" }, score: 0.94, source: "graph", depth: 1 },
      { entry: { id: "g3", category: "fact" }, score: 0.93, source: "graph", depth: 1 },
      { entry: { id: "g4", category: "fact" }, score: 0.92, source: "graph", depth: 1 },
    ];
    const result = applyRecallBudget(memories, { budget: 10 });
    assert.strictEqual(result.selected.length, 10);
    const assocCount = result.selected.filter(r => r.source === "graph").length;
    assert.strictEqual(assocCount, 3, "associative must be capped at 30% of budget");
  });

  it("prioritizes core memories", () => {
    const memories = [
      { entry: { id: "core1", coreMemoryScore: 0.9 }, score: 0.5, source: "vector" },
      { entry: { id: "v1" }, score: 0.9, source: "vector" },
    ];
    const result = applyRecallBudget(memories, { budget: 1 });
    assert.deepStrictEqual(result.selected.map(r => r.entry.id), ["core1"]);
  });
});
```

### Step 2: Run failing tests

```bash
node --test tests/recall-pipeline-budget.test.js
```

Expected: FAIL — `applyRecallBudget` does not exist.

### Step 3: Add `applyRecallBudget` helper

Append to `lib/recall-budget.js` (after line 109):

```js
/**
 * Partition recall results into tiers and enforce a strict budget.
 *
 * Priority: core → canonical → project → episodic → associative.
 * Canonical items come from KNOWLEDGE.md and are passed separately because the
 * pipeline keeps them in a separate array.
 *
 * @param {Array} memories — results from the merged/hydrated recall pipeline
 * @param {Object} opts
 * @param {Array} [opts.canonical=[]]
 * @param {number} opts.budget
 * @returns {{ selected: Array, tierCounts: Object }}
 */
export function applyRecallBudget(memories, { canonical = [], budget } = {}) {
  if (!Array.isArray(memories)) memories = [];
  const core = [];
  const project = [];
  const episodic = [];
  const associative = [];

  for (const m of memories) {
    if ((m.entry?.coreMemoryScore ?? 0) >= 0.7) {
      core.push(m);
    } else if (m.source === "graph" || m.graphSource === "graph") {
      associative.push(m);
    } else if (m.entry?.category === "project" || m.entry?.category === "plan") {
      project.push(m);
    } else {
      episodic.push(m);
    }
  }

  // Each tier is already ranked by score from the pipeline; preserve that order.
  return allocateMemoryTiers({
    core,
    canonical,
    project,
    episodic,
    associative,
    budget,
  });
}
```

### Step 4: Wire budget into `runRecallPipeline`

In `lib/recall-pipeline.js`, add `budget` to the function signature (line 369-398). Insert `budget = topN,` near `topN = 12,`.

After graph hydration (line 641-648), add the budget call:

```js
  // 4.8 Recall budget — enforce tier caps before final dedup/rerank.
  // Canonical items are kept separate; episodic/associative share the remaining slots.
  if (budget > 0 && boosted.length > 0) {
    const budgetResult = applyRecallBudget(boosted, { canonical: canonicalHits, budget });
    boosted = budgetResult.selected;
  }
```

### Step 5: Pass budget from callers

In `index.js` auto-recall block (line 4076-4104), add `budget: maxPromptMemories` to the `runRecallPipeline` call:

```js
const { canonical: canonicalHits, memories: ordered } = await runRecallPipeline({
  ...
  topN: maxPromptMemories,
  budget: maxPromptMemories,
  ...
});
```

Do the same for the manual `memory_recall` call around line 3540:

```js
const { canonical: canonicalHits, memories: ordered } = await runRecallPipeline({
  ...
  topN: maxPromptMemories,
  budget: maxPromptMemories,
  ...
});
```

### Step 6: Run tests

```bash
node --test tests/recall-pipeline-budget.test.js
```

Expected: PASS.

### Step 7: Commit

```bash
git add lib/recall-budget.js lib/recall-pipeline.js index.js tests/recall-pipeline-budget.test.js
git commit -m "fix(recall): integrate allocateMemoryTiers into pipeline

- add applyRecallBudget helper
- enforce 30% associative cap before final dedup/rerank
- pass budget from manual and auto recall callers"
```

---

## Task 6: Expose missing config in schema

**Files:**
- Modify: `openclaw.plugin.json:557-572`

### Step 1: Add `graphHydrationRelevanceThreshold`

Add inside `continuityEngine.associativeRecall.properties`:

```json
"graphHydrationRelevanceThreshold": {
  "type": "number",
  "default": 0.25
}
```

### Step 2: Update `index.js` to pass it through

In `index.js` auto-recall `graphConfig` object (line 4099-4104), add:

```js
graphHydrationRelevanceThreshold: assocCfg.graphHydrationRelevanceThreshold ?? 0.25,
```

Do the same for the manual `memory_recall` call around line 3540 if a `graphConfig` is added there.

### Step 3: Commit

```bash
git add openclaw.plugin.json index.js
git commit -m "chore(config): expose graphHydrationRelevanceThreshold in schema"
```

---

## Task 7: Regression suite & final verification

### Step 1: Run full test suite

```bash
npm test
```

Expected: all passing (target 1230+).

### Step 2: Run lint

```bash
npm run lint
```

Expected: clean.

### Step 3: Run audit

```bash
npm audit --audit-level=moderate
```

Expected: 0 vulnerabilities.

### Step 4: Commit if all green

```bash
git commit --allow-empty -m "test(p1): full suite green after graph scoring and budget fixes"
```

---

## Self-Review

### 1. Spec coverage

| Audit ID | Task implementing it |
|----------|----------------------|
| H1-01 Graph-only hits mixed with vector hits | Task 1 — graph-only score capped below best vector |
| H1-02 vector+graph score artificially boosted | Task 1 — overlap no longer changes vector score |
| H1-03 Graph traversal too deep / threshold too low | Task 2 — `maxDepth=2`, depth-scaled relevance, stronger depth penalty |
| H1-04 Weak emotional/temporal/entity edges | Task 3 — overlap and Jaccard thresholds, lower emotional weight |
| H1-06 `allocateMemoryTiers` not productively used | Task 5 — `applyRecallBudget` wired into pipeline |
| H1-07 Importance/Emotion/Strength boost overtakes relevance | Task 4 — additive/clamped boosts |

### 2. Placeholder scan

- No "TBD", "TODO", or "implement later".
- Every step contains exact file paths, exact code blocks, exact commands, and expected outputs.
- No "write tests for the above" without test code.

### 3. Type consistency

- `mergeAssociativeResults` still returns objects with `{ entry, score, source, depth }`.
- `applyRecallBudget` consumes the same memory-shape used by the pipeline and returns `{ selected, tierCounts }` matching `allocateMemoryTiers`.
- `runRecallPipeline` signature keeps all existing parameters; `budget` is added with a default equal to `topN`, preserving backward compatibility.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-16-p1-graph-scoring-recall-budget.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
