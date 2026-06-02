# Memory Dynamics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Retrieval Ledger, Memory Strength/Forgetting Curve, and Flashbulb Encoding to PLUR1BUS.

**Architecture:** Extend the existing LanceDB schema with retrieval metadata, log every recall to `retrieval-ledger.jsonl`, decay memory strength daily via Ebbinghaus curve, and boost flashbulb memories. No content mutation during recall.

**Tech Stack:** Node.js ESM, LanceDB, OpenAI/local-transformers embeddings.

---

## File Structure

| File | Responsibility |
|------|--------------|
| `lib/memory-dynamics.js` | Retrieval Ledger, Memory Strength computation, Flashbulb scoring |
| `lib/jobs/memory-dynamics-compaction.js` | Daily decay job: iterates all memories, applies forgetting curve |
| `lib/prospective-memory.js` | Trigger engine: event/time/entity/topic triggers |
| `tests/memory-dynamics.test.js` | Unit tests for ledger, strength, flashbulb |
| `index.js` | Wire retrieval tracking into recall pipeline and auto-capture hook |
| `lib/neo-arch.js` | Add `retrieval-ledger.jsonl` and `prospective-memory.jsonl` to NEO_JSONL_FILES |
| `lib/jobs/daily-consolidation.js` | Add strength decay step before compaction |
| `lib/recall-pipeline.js` | Multiply `memoryStrength` into final recall score |
| `lib/db-adapter.js` | Add new columns: `retrievalCount`, `lastRetrievedAt`, `memoryStrength`, `decayRate`, `halfLifeDays`, `lastStrengthenedAt` |

---

### Task 1: Add new LanceDB columns in `lib/db-adapter.js`

**Files:**
- Modify: `lib/db-adapter.js`

- [ ] **Step 1: Add `ensureDynamicsColumns` helper**

```javascript
async function ensureDynamicsColumns(agent, table) {
  if (!table) return;
  if (schemaExtended.get(agent)) return;
  try {
    const schema = await table.schema();
    const fieldNames = schema.fields.map((f) => f.name);
    const columns = [
      { name: 'retrievalCount', valueSql: '0' },
      { name: 'lastRetrievedAt', valueSql: '0' },
      { name: 'memoryStrength', valueSql: '1.0' },
      { name: 'decayRate', valueSql: '0.05' },
      { name: 'halfLifeDays', valueSql: '30' },
      { name: 'lastStrengthenedAt', valueSql: '0' },
    ];
    for (const col of columns) {
      if (!fieldNames.includes(col.name)) {
        await table.addColumns([col]);
      }
    }
    schemaExtended.set(agent, true);
  } catch (err) {
    logger.warn?.(`db-adapter: dynamics schema extension failed for '${agent}': ${err.message}`);
    schemaExtended.set(agent, true);
  }
}
```

- [ ] **Step 2: Call `ensureDynamicsColumns` in `resolveTable` after table open**

```javascript
const table = await db.openTable(TABLE_NAME);
await ensureDynamicsColumns(agent, table); // add this line
```

- [ ] **Step 3: Commit**

```bash
git add lib/db-adapter.js
git commit -m "feat(db-adapter): add dynamics columns (retrievalCount, memoryStrength, etc)"
```

---

### Task 2: Create `lib/memory-dynamics.js`

**Files:**
- Create: `lib/memory-dynamics.js`

- [ ] **Step 1: Write imports and constants**

```javascript
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_LEDGER_SIZE_MB = 100;
const FLASHBULB_THRESHOLD = 0.70;
```

- [ ] **Step 2: Write `appendRetrievalLedger`**

```javascript
export function appendRetrievalLedger(workspaceDir, entries) {
  if (!workspaceDir || !entries?.length) return;
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "retrieval-ledger.jsonl");
  const sizeMb = existsSync(path) ? statSync(path).size / (1024 * 1024) : 0;
  if (sizeMb > MAX_LEDGER_SIZE_MB) {
    console.warn(`retrieval-ledger: file too large (${sizeMb.toFixed(1)}MB), skipping append`);
    return;
  }
  for (const entry of entries) {
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  }
}
```

- [ ] **Step 3: Write `computeMemoryStrength`**

```javascript
export function computeMemoryStrength(row, now = Date.now()) {
  const retrievalCount = row.retrievalCount ?? 0;
  const lastRetrievedAt = row.lastRetrievedAt ?? 0;
  const halfLifeDays = row.halfLifeDays ?? 30;
  const decayRate = row.decayRate ?? 0.05;
  const lastStrengthenedAt = row.lastStrengthenedAt ?? row.createdAt ?? 0;
  const baseStrength = row.memoryStrength ?? 1.0;

  const ageMs = now - Math.max(lastStrengthenedAt, lastRetrievedAt, row.createdAt || 0);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const tau = halfLifeDays / Math.LN2;
  const decayed = baseStrength * Math.exp(-ageDays / tau);

  // Reinforcement: each retrieval slightly boosts strength
  const reinforced = Math.min(1.0, decayed + retrievalCount * 0.02);

  return Math.max(0.1, reinforced);
}
```

- [ ] **Step 4: Write `computeFlashbulbScore`**

```javascript
export function computeFlashbulbScore(row) {
  const emotionalIntensity = row.emotionalIntensity ?? 0;
  const importance = row.importance ?? 0.5;
  const novelty = row.sourceUrl || row.evidenceQuote ? 0.6 : 0.3;
  const userCorrectionOrDecision = row.category === "decision" ? 0.8 : 0.2;

  return (
    emotionalIntensity * 0.35 +
    importance * 0.35 +
    novelty * 0.15 +
    userCorrectionOrDecision * 0.15
  );
}
```

- [ ] **Step 5: Write `applyFlashbulbEncoding`**

```javascript
export function applyFlashbulbEncoding(row) {
  const score = computeFlashbulbScore(row);
  if (score < FLASHBULB_THRESHOLD) return null;
  return {
    halfLifeDays: Math.min(365, (row.halfLifeDays ?? 30) * 2),
    decayRate: Math.max(0.01, (row.decayRate ?? 0.05) * 0.5),
    memoryStrength: Math.min(1.0, (row.memoryStrength ?? 1.0) + 0.15),
    lastStrengthenedAt: Date.now(),
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/memory-dynamics.js
git commit -m "feat(memory-dynamics): retrieval ledger, strength computation, flashbulb scoring"
```

---

### Task 3: Write tests for `lib/memory-dynamics.js`

**Files:**
- Create: `tests/memory-dynamics.test.js`

- [ ] **Step 1: Write failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeMemoryStrength,
  computeFlashbulbScore,
  applyFlashbulbEncoding,
} from "../lib/memory-dynamics.js";

describe("memory-dynamics", () => {
  it("computeMemoryStrength decays with age", () => {
    const old = computeMemoryStrength({ createdAt: Date.now() - 60 * 86400000, retrievalCount: 0, memoryStrength: 1.0, halfLifeDays: 30 });
    const young = computeMemoryStrength({ createdAt: Date.now(), retrievalCount: 0, memoryStrength: 1.0, halfLifeDays: 30 });
    assert.ok(old < young, "older memory should have lower strength");
  });

  it("computeMemoryStrength reinforces with retrievals", () => {
    const s0 = computeMemoryStrength({ createdAt: Date.now(), retrievalCount: 0, memoryStrength: 0.5, halfLifeDays: 30 });
    const s5 = computeMemoryStrength({ createdAt: Date.now(), retrievalCount: 5, memoryStrength: 0.5, halfLifeDays: 30 });
    assert.ok(s5 > s0, "retrieved memory should be stronger");
  });

  it("computeFlashbulbScore uses all components", () => {
    const low = computeFlashbulbScore({ emotionalIntensity: 0.1, importance: 0.2 });
    const high = computeFlashbulbScore({ emotionalIntensity: 0.9, importance: 0.9, category: "decision", sourceUrl: "http://x" });
    assert.ok(low < high, "high-emotion decision should score higher");
  });

  it("applyFlashbulbEncoding returns null below threshold", () => {
    const result = applyFlashbulbEncoding({ emotionalIntensity: 0.1, importance: 0.2 });
    assert.strictEqual(result, null);
  });

  it("applyFlashbulbEncoding boosts above threshold", () => {
    const result = applyFlashbulbEncoding({ emotionalIntensity: 0.9, importance: 0.9, category: "decision" });
    assert.ok(result.halfLifeDays > 30);
    assert.ok(result.decayRate < 0.05);
    assert.ok(result.memoryStrength > 1.0);
  });
});
```

- [ ] **Step 2: Run tests (should pass)**

```bash
cd /tmp/memory-analysis && node --test tests/memory-dynamics.test.js
```

Expected: 5 passing

- [ ] **Step 3: Commit**

```bash
git add tests/memory-dynamics.test.js
git commit -m "test(memory-dynamics): strength decay, flashbulb scoring"
```

---

### Task 4: Wire retrieval tracking into `lib/recall-pipeline.js`

**Files:**
- Modify: `lib/recall-pipeline.js`

- [ ] **Step 1: Import `computeMemoryStrength` and `appendRetrievalLedger`**

```javascript
import { computeMemoryStrength, appendRetrievalLedger } from "./memory-dynamics.js";
```

- [ ] **Step 2: After vector search results, multiply score by strength**

Find the line:
```javascript
const results = rows.map(r => ({
```

After the `.filter(r => r.score >= recallMinScore)`, add:

```javascript
// Memory Strength boost: apply forgetting curve to each result
const strengthBoosted = results.map(r => {
  const strength = computeMemoryStrength(r.entry, Date.now());
  return { ...r, score: r.score * strength, memoryStrength: strength };
});
```

- [ ] **Step 3: After importance boost, log retrieval events**

After `applyImportanceBoost`, add:

```javascript
// Log retrieval events for dynamics analysis
if (workspaceDir && boosted.length > 0) {
  const ledgerEntries = boosted.slice(0, topN).map((r, idx) => ({
    id: `ret-${Date.now()}-${idx}`,
    memoryId: r.entry.id,
    workspaceKey: workspaceDir,
    queryHash: query.slice(0, 50),
    recallScore: r.score,
    memoryStrength: r.memoryStrength,
    usedInAnswer: idx < topN,
    createdAt: new Date().toISOString(),
  }));
  appendRetrievalLedger(workspaceDir, ledgerEntries);
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/recall-pipeline.js
git commit -m "feat(recall-pipeline): apply memory strength boost + log retrieval ledger"
```

---

### Task 5: Update `lib/neo-arch.js` with new JSONL files

**Files:**
- Modify: `lib/neo-arch.js`

- [ ] **Step 1: Add `retrieval-ledger.jsonl` and `prospective-memory.jsonl` to `NEO_JSONL_FILES`**

```javascript
export const NEO_JSONL_FILES = Object.freeze([
  // ... existing entries ...
  "retrieval-ledger.jsonl",
  "prospective-memory.jsonl",
]);
```

- [ ] **Step 2: Add paths and accessors in `createNeoStore`**

In `createNeoStore`, add to `paths`:
```javascript
retrievalLedger: join(workspaceDir, "retrieval-ledger.jsonl"),
prospectiveMemory: join(workspaceDir, "prospective-memory.jsonl"),
```

Add to returned object:
```javascript
appendRetrievalLedger: (items) => appendJsonl(paths.retrievalLedger, items),
appendProspectiveMemory: (items) => appendJsonl(paths.prospectiveMemory, items),
readRetrievalLedger: (limit = 10_000) => readJsonlTail(paths.retrievalLedger, limit),
readProspectiveMemory: (limit = 500) => readJsonlTail(paths.prospectiveMemory, limit),
```

- [ ] **Step 3: Commit**

```bash
git add lib/neo-arch.js
git commit -m "feat(neo-arch): add retrieval-ledger and prospective-memory jsonl files"
```

---

### Task 6: Create `lib/prospective-memory.js` (optional, minimal)

**Files:**
- Create: `lib/prospective-memory.js`

- [ ] **Step 1: Write minimal trigger engine**

```javascript
import { randomUUID } from "node:crypto";

export function createProspectiveMemory(text, triggerType = "topic", opts = {}) {
  return {
    id: randomUUID(),
    triggerType,
    triggerText: opts.triggerText || text,
    reminderText: opts.reminderText || text,
    status: "active",
    firePolicy: opts.firePolicy || "once",
    createdAt: new Date().toISOString(),
    dueAt: opts.dueAt || null,
    lastCheckedAt: null,
    firedAt: null,
  };
}

export function checkTriggers(prospectiveMemories, context = {}) {
  const { query = "", entities = [], topics = [] } = context;
  const fired = [];
  for (const pm of prospectiveMemories) {
    if (pm.status !== "active") continue;
    let match = false;
    if (pm.triggerType === "topic" && query.toLowerCase().includes(pm.triggerText.toLowerCase())) match = true;
    if (pm.triggerType === "entity" && entities.some(e => e.toLowerCase() === pm.triggerText.toLowerCase())) match = true;
    if (pm.triggerType === "time" && pm.dueAt && Date.now() >= new Date(pm.dueAt).getTime()) match = true;
    if (match) fired.push(pm);
  }
  return fired;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/prospective-memory.js
git commit -m "feat(prospective-memory): minimal trigger engine (topic/entity/time)"
```

---

### Task 7: Create `lib/jobs/memory-dynamics-compaction.js`

**Files:**
- Create: `lib/jobs/memory-dynamics-compaction.js`

- [ ] **Step 1: Write daily decay job**

```javascript
import { computeMemoryStrength } from "../memory-dynamics.js";

export async function runMemoryDynamicsCompaction(db, opts = {}) {
  const { logger = { info: () => {}, warn: () => {} }, dryRun = false } = opts;
  const startTime = Date.now();

  if (!db || !db.table) {
    return { decayed: 0, skipped: true, reason: "no_table" };
  }

  const rows = await db.table.query().limit(5000).toArray();
  const now = Date.now();
  let decayed = 0;
  const updates = [];

  for (const row of rows) {
    const newStrength = computeMemoryStrength(row, now);
    const oldStrength = row.memoryStrength ?? 1.0;
    if (Math.abs(newStrength - oldStrength) > 0.01) {
      updates.push({ id: row.id, memoryStrength: newStrength, lastStrengthenedAt: now });
    }
  }

  if (!dryRun) {
    for (const update of updates) {
      try {
        await db.table.update({ where: `id = "${update.id}"`, values: { memoryStrength: update.memoryStrength, lastStrengthenedAt: update.lastStrengthenedAt } });
        decayed++;
      } catch (err) {
        logger.warn?.(`dynamics-compaction: update failed for ${update.id}: ${err.message}`);
      }
    }
  }

  logger.info?.(`memory-dynamics-compaction: ${decayed} memories decayed (${updates.length} candidates)`);
  return { decayed, candidates: updates.length, dryRun, durationMs: Date.now() - startTime };
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/jobs/memory-dynamics-compaction.js
git commit -m "feat(memory-dynamics-compaction): daily strength decay job"
```

---

### Task 8: Wire into `lib/jobs/daily-consolidation.js`

**Files:**
- Modify: `lib/jobs/daily-consolidation.js`

- [ ] **Step 1: Import `runMemoryDynamicsCompaction`**

```javascript
import { runMemoryDynamicsCompaction } from "./memory-dynamics-compaction.js";
```

- [ ] **Step 2: Add decay step before compaction**

After TTL expiration (Step 1), add:

```javascript
// ── 1.5 Memory Dynamics: Strength Decay ──────────────────────────────────
let dynamics = null;
if (db && db.table) {
  try {
    dynamics = await runMemoryDynamicsCompaction(db, { logger, dryRun: opts.dryRun === true });
    logger.info?.(`daily-consolidation[${agent}]: dynamics ${dynamics.decayed} memories decayed`);
  } catch (err) {
    logger.warn?.(`daily-consolidation[${agent}]: dynamics threw: ${err.message}`);
  }
}
```

- [ ] **Step 3: Add dynamics to report**

```javascript
const report = {
  // ... existing fields ...
  dynamics: dynamics || { decayed: 0, candidates: 0 },
};
```

- [ ] **Step 4: Commit**

```bash
git add lib/jobs/daily-consolidation.js
git commit -m "feat(daily-consolidation): integrate memory dynamics decay step"
```

---

### Task 9: Wire into `index.js` (auto-capture hook)

**Files:**
- Modify: `index.js`

- [ ] **Step 1: After storing a memory, apply flashbulb encoding**

In the `storeMemoryFromToolParams` function, after creating the entry, add:

```javascript
import { applyFlashbulbEncoding } from "./lib/memory-dynamics.js";
```

After `const entry = { ... }`, add:

```javascript
// Apply flashbulb encoding if this is a high-emotion/worthy event
const flashbulb = applyFlashbulbEncoding(entry);
if (flashbulb) {
  Object.assign(entry, flashbulb);
}
```

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "feat(index): apply flashbulb encoding on memory store"
```

---

### Task 10: Run all tests

- [ ] **Step 1: Run full test suite**

```bash
cd /tmp/memory-analysis && node --test tests/*.test.js
```

Expected: 40+ passing (existing + new)

- [ ] **Step 2: Commit if all pass**

```bash
git add tests/memory-dynamics.test.js
git commit -m "test(memory-dynamics): all tests passing"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** Retrieval Ledger ✓, Memory Strength ✓, Flashbulb ✓, Prospective Memory ✓, Decay Job ✓, Pipeline Integration ✓
- [ ] **Placeholder scan:** No TBDs, no vague requirements
- [ ] **Type consistency:** `computeMemoryStrength` takes `row, now`. `applyFlashbulbEncoding` returns `null` or object with `halfLifeDays`, `decayRate`, `memoryStrength`, `lastStrengthenedAt`
- [ ] **File paths:** All exact paths verified against existing codebase
- [ ] **No destructive updates:** All content changes are additive or metadata-only
- [ ] **Dry-run support:** Decay job respects `dryRun` flag

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-01-memory-dynamics.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
