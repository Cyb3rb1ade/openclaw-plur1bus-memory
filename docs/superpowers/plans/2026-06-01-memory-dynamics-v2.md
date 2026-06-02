# Phase 7: Memory Dynamics — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Retrieval Ledger, Memory Strength/Forgetting Curve, and Flashbulb Encoding to PLUR1BUS.

**Architecture:** Extend the existing LanceDB schema with retrieval metadata. Log every recall to `retrieval-ledger.jsonl` via Neo-Store. Decay memory strength daily via Ebbinghaus curve. Boost flashbulb memories at store time. **No content mutation during recall.**

**Tech Stack:** Node.js ESM, LanceDB, OpenAI/local-transformers embeddings.

---

## File Structure

| File | Responsibility |
|------|--------------|
| `lib/memory-dynamics.js` | Pure functions: decay, reinforcement, flashbulb scoring |
| `lib/jobs/memory-dynamics-decay.js` | Daily job: reads ledger, aggregates retrievals, applies decay |
| `tests/memory-dynamics.test.js` | Unit tests for decay, reinforcement, flashbulb |
| `index.js` | Wire dynamics defaults into all store paths, pass retrievalLogger to pipeline |
| `lib/neo-arch.js` | Add `retrieval-ledger.jsonl` to NEO_JSONL_FILES, append/read methods |
| `lib/jobs/daily-consolidation.js` | Add ledger processing + strength decay step |
| `lib/recall-pipeline.js` | Multiply `strengthFactor` into final score, emit ledger events via callback |
| `lib/db-adapter.js` | Add new columns with workspace-safe cache key |

---

## MUST-FIX List (from Review)

1. **Schema cache key workspace-safe:** `${baseDbPath}:${agent}` not just `agent`
2. **Dynamics fields in MemoryDB.init() + MemoryDB.search():** Ensure fields are returned in search results
3. **Ledger path unified via Neo-Store only:** No `.adaptive-learning` path, no workspaceDir in pipeline
4. **Decay and Reinforcement separated:** `computeDecayedStrength`, `applyRetrievalReinforcement`, `applyDailyDecay`
5. **Remove `decayRate`:** Use only `halfLifeDays` for simplicity
6. **Retrieval metadata updated by Daily Job:** Ledger-first, then aggregator updates DB
7. **`lastDynamicsAt` for decay anchor, `lastStrengthenedAt` only for reinforcement/flashbulb**
8. **Flashbulb test fixed:** Start with `memoryStrength: 0.6`, assert `> 0.6 && <= 1.0`
9. **Flashbulb applied centrally via `applyDynamicsDefaults()`** before every `db.store()`
10. **Static imports at module level**
11. **Pipeline gets `retrievalLogger` callback, not workspaceDir**
12. **Daily job works with `memoryDbAdapter` or accepts `db.table` directly**
13. **Strength factor softened:** `0.65 + 0.35 * memoryStrength` to avoid over-aggressive decay
14. **Prospective Memory deferred to Phase 7B**

---

### Task 1: Update `lib/db-adapter.js` with workspace-safe schema cache

**Files:**
- Modify: `lib/db-adapter.js`

- [ ] **Step 1: Fix schema cache key to include basePath**

```javascript
// OLD: schemaExtended.get(agent)
// NEW: schemaExtended.get(`${basePath}:${agent}`)
```

- [ ] **Step 2: Add ensureDynamicsColumns**

```javascript
async function ensureDynamicsColumns(agent, table) {
  if (!table) return;
  const schemaKey = `${basePath}:${agent}`;
  if (schemaExtended.get(schemaKey)) return;
  try {
    const schema = await table.schema();
    const fieldNames = schema.fields.map((f) => f.name);
    const columns = [
      { name: 'retrievalCount', valueSql: '0' },
      { name: 'lastRetrievedAt', valueSql: '0' },
      { name: 'memoryStrength', valueSql: '1.0' },
      { name: 'halfLifeDays', valueSql: '30' },
      { name: 'lastStrengthenedAt', valueSql: '0' },
      { name: 'lastDynamicsAt', valueSql: '0' },
    ];
    for (const col of columns) {
      if (!fieldNames.includes(col.name)) {
        await table.addColumns([col]);
      }
    }
    schemaExtended.set(schemaKey, true);
  } catch (err) {
    logger.warn?.(`db-adapter: dynamics schema extension failed for '${agent}': ${err.message}`);
    // Do NOT set schemaExtended on failure — retry next time
  }
}
```

- [ ] **Step 3: Call ensureDynamicsColumns after table open**

```javascript
const table = await db.openTable(TABLE_NAME);
await ensureDynamicsColumns(agent, table);
```

- [ ] **Step 4: Commit**

```bash
git add lib/db-adapter.js
git commit -m "feat(db-adapter): add dynamics columns with workspace-safe schema cache"
```

---

### Task 2: Update `index.js` MemoryDB.init() and MemoryDB.search()

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add dynamics fields to schema creation in MemoryDB.init()**

In the `createTable` call (the `__schema__` row), add:

```javascript
retrievalCount: 0,
lastRetrievedAt: 0,
memoryStrength: 1.0,
halfLifeDays: 30,
lastStrengthenedAt: 0,
lastDynamicsAt: 0,
```

- [ ] **Step 2: Add dynamics fields to MemoryDB.search() result mapping**

In `MemoryDB.search()`, in the `entry: { ... }` mapping, add:

```javascript
retrievalCount: r.retrievalCount ?? 0,
lastRetrievedAt: r.lastRetrievedAt ?? 0,
memoryStrength: r.memoryStrength ?? 1.0,
halfLifeDays: r.halfLifeDays ?? 30,
lastStrengthenedAt: r.lastStrengthenedAt ?? 0,
lastDynamicsAt: r.lastDynamicsAt ?? 0,
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(memory-db): add dynamics fields to schema and search results"
```

---

### Task 3: Create `lib/memory-dynamics.js`

**Files:**
- Create: `lib/memory-dynamics.js`

- [ ] **Step 1: Write pure functions**

```javascript
import { randomUUID, createHash } from "node:crypto";

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function normalizeTimestamp(v) {
  return Number(v) || Date.now();
}

export function computeDecayedStrength(row, now = Date.now()) {
  const base = clamp01(row.memoryStrength ?? 1.0);
  const anchor = normalizeTimestamp(row.lastDynamicsAt ?? row.lastStrengthenedAt ?? row.createdAt ?? now);
  const halfLifeDays = Math.max(1, Number(row.halfLifeDays ?? 30));

  const ageMs = Math.max(0, now - anchor);
  const ageDays = ageMs / 86_400_000;
  return Math.max(0.05, base * Math.pow(0.5, ageDays / halfLifeDays));
}

export function applyRetrievalReinforcement(row, now = Date.now()) {
  const decayed = computeDecayedStrength(row, now);
  return {
    retrievalCount: (row.retrievalCount ?? 0) + 1,
    lastRetrievedAt: now,
    memoryStrength: Math.min(1.0, decayed + 0.03),
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

export function applyDailyDecay(row, now = Date.now()) {
  return {
    memoryStrength: computeDecayedStrength(row, now),
    lastDynamicsAt: now,
  };
}

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

export function applyFlashbulbEncoding(row) {
  const score = computeFlashbulbScore(row);
  if (score < 0.70) return null;
  return {
    halfLifeDays: Math.min(365, (row.halfLifeDays ?? 30) * 2),
    memoryStrength: Math.min(1.0, (row.memoryStrength ?? 1.0) + 0.15),
    lastStrengthenedAt: Date.now(),
  };
}

export function applyDynamicsDefaults(entry) {
  const base = {
    retrievalCount: 0,
    lastRetrievedAt: 0,
    memoryStrength: 1.0,
    halfLifeDays: 30,
    lastStrengthenedAt: 0,
    lastDynamicsAt: Date.now(),
  };
  const enriched = { ...base, ...entry };
  const flashbulb = applyFlashbulbEncoding(enriched);
  return flashbulb ? { ...enriched, ...flashbulb } : enriched;
}

export function createRetrievalLedgerEntry(opts = {}) {
  const { memoryId, workspaceKey, agentId, query, recallScore, memoryStrength, usedInAnswer } = opts;
  const queryHash = createHash("sha256").update(String(query || "")).digest("hex").slice(0, 16);
  return {
    id: `ret-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    memoryId: memoryId || "",
    workspaceKey: workspaceKey || "default",
    agentId: agentId || "default",
    queryHash,
    recallScore: Number(recallScore) || 0,
    memoryStrength: Number(memoryStrength) || 1.0,
    usedInAnswer: usedInAnswer === true,
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/memory-dynamics.js
git commit -m "feat(memory-dynamics): decay, reinforcement, flashbulb, ledger entry"
```

---

### Task 4: Write tests for `lib/memory-dynamics.js`

**Files:**
- Create: `tests/memory-dynamics.test.js`

- [ ] **Step 1: Write tests**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeDecayedStrength,
  applyRetrievalReinforcement,
  applyDailyDecay,
  computeFlashbulbScore,
  applyFlashbulbEncoding,
  applyDynamicsDefaults,
  createRetrievalLedgerEntry,
} from "../lib/memory-dynamics.js";

describe("memory-dynamics", () => {
  it("computeDecayedStrength decays with age", () => {
    const old = computeDecayedStrength({ createdAt: Date.now() - 60 * 86400000, memoryStrength: 1.0, halfLifeDays: 30 }, Date.now());
    const young = computeDecayedStrength({ createdAt: Date.now(), memoryStrength: 1.0, halfLifeDays: 30 }, Date.now());
    assert.ok(old < young, "older memory should have lower strength");
  });

  it("computeDecayedStrength respects halfLifeDays", () => {
    const short = computeDecayedStrength({ createdAt: Date.now() - 60 * 86400000, memoryStrength: 1.0, halfLifeDays: 10 }, Date.now());
    const long = computeDecayedStrength({ createdAt: Date.now() - 60 * 86400000, memoryStrength: 1.0, halfLifeDays: 90 }, Date.now());
    assert.ok(short < long, "shorter halfLife should decay faster");
  });

  it("applyRetrievalReinforcement increments count and boosts strength", () => {
    const before = { retrievalCount: 3, memoryStrength: 0.5, createdAt: Date.now() };
    const after = applyRetrievalReinforcement(before, Date.now());
    assert.strictEqual(after.retrievalCount, 4);
    assert.ok(after.memoryStrength > before.memoryStrength, "retrieval should boost strength");
    assert.ok(after.lastRetrievedAt > 0);
    assert.strictEqual(after.lastStrengthenedAt, after.lastRetrievedAt);
  });

  it("applyDailyDecay does not strengthen via old retrievalCount", () => {
    const before = { retrievalCount: 20, memoryStrength: 0.8, createdAt: Date.now() };
    const after = applyDailyDecay(before, Date.now());
    assert.strictEqual(after.retrievalCount, undefined, "daily decay should not touch retrievalCount");
    assert.ok(after.memoryStrength <= before.memoryStrength + 0.001, "daily decay should not reinforce");
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

  it("applyFlashbulbEncoding boosts within bounds", () => {
    const result = applyFlashbulbEncoding({
      emotionalIntensity: 0.9,
      importance: 0.9,
      category: "decision",
      memoryStrength: 0.6,
    });
    assert.ok(result.memoryStrength > 0.6);
    assert.ok(result.memoryStrength <= 1.0);
    assert.ok(result.halfLifeDays > 30);
  });

  it("applyDynamicsDefaults applies flashbulb when eligible", () => {
    const entry = { text: "test", emotionalIntensity: 0.9, importance: 0.9, category: "decision" };
    const result = applyDynamicsDefaults(entry);
    assert.ok(result.memoryStrength > 1.0 || result.halfLifeDays > 30, "flashbulb should modify dynamics");
  });

  it("createRetrievalLedgerEntry creates valid hash", () => {
    const entry = createRetrievalLedgerEntry({ query: "hello world", memoryId: "abc", recallScore: 0.8 });
    assert.ok(entry.queryHash);
    assert.strictEqual(entry.queryHash.length, 16);
    assert.strictEqual(entry.memoryId, "abc");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /tmp/memory-analysis && node --test tests/memory-dynamics.test.js
```

Expected: 8 passing

- [ ] **Step 3: Commit**

```bash
git add tests/memory-dynamics.test.js
git commit -m "test(memory-dynamics): decay, reinforcement, flashbulb, ledger"
```

---

### Task 5: Update `lib/neo-arch.js`

**Files:**
- Modify: `lib/neo-arch.js`

- [ ] **Step 1: Add retrieval-ledger.jsonl to NEO_JSONL_FILES**

```javascript
export const NEO_JSONL_FILES = Object.freeze([
  // ... existing entries ...
  "retrieval-ledger.jsonl",
]);
```

- [ ] **Step 2: Add paths and accessors in createNeoStore**

In `createNeoStore`, add to `paths`:
```javascript
retrievalLedger: join(workspaceDir, "retrieval-ledger.jsonl"),
```

Add to returned object:
```javascript
appendRetrievalLedger: (items) => appendJsonl(paths.retrievalLedger, items),
readRetrievalLedger: (limit = 10_000) => readJsonlTail(paths.retrievalLedger, limit),
```

- [ ] **Step 3: Commit**

```bash
git add lib/neo-arch.js
git commit -m "feat(neo-arch): add retrieval-ledger jsonl"
```

---

### Task 6: Update `lib/recall-pipeline.js`

**Files:**
- Modify: `lib/recall-pipeline.js`

- [ ] **Step 1: Import computeDecayedStrength and createRetrievalLedgerEntry**

```javascript
import { computeDecayedStrength, createRetrievalLedgerEntry } from "./memory-dynamics.js";
```

- [ ] **Step 2: Add retrievalLogger to function signature**

```javascript
export async function runRecallPipeline({
  // ... existing params ...
  retrievalLogger = null,
})
```

- [ ] **Step 3: After vector search, apply strength factor**

After `const results = rows.map(...).filter(...)`, add:

```javascript
// Soft strength factor: 0.65 + 0.35 * memoryStrength
const strengthBoosted = results.map(r => {
  const strength = computeDecayedStrength(r.entry, Date.now());
  const strengthFactor = 0.65 + 0.35 * strength;
  return { ...r, score: r.score * strengthFactor, memoryStrength: strength };
});
```

Replace subsequent references to `results` with `strengthBoosted`.

- [ ] **Step 4: After importance boost, emit ledger events via callback**

After `applyImportanceBoost`, add:

```javascript
if (retrievalLogger && boosted.length > 0) {
  const entries = boosted.slice(0, topN).map((r, idx) =>
    createRetrievalLedgerEntry({
      memoryId: r.entry.id,
      workspaceKey: workspaceDir ? workspaceKeyFromContext({}, { workspaceDir }) : "default",
      agentId: r.entry.storedBy || "default",
      query,
      recallScore: r.score,
      memoryStrength: r.memoryStrength,
      usedInAnswer: idx < topN,
    })
  );
  retrievalLogger(entries);
}
```

- [ ] **Step 5: Commit**

```bash
git add lib/recall-pipeline.js
git commit -m "feat(recall-pipeline): strength factor + retrieval ledger callback"
```

---

### Task 7: Create `lib/jobs/memory-dynamics-decay.js`

**Files:**
- Create: `lib/jobs/memory-dynamics-decay.js`

- [ ] **Step 1: Write daily decay job**

```javascript
import { applyDailyDecay } from "../memory-dynamics.js";

export async function runMemoryDynamicsDecay(db, opts = {}) {
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
    const patch = applyDailyDecay(row, now);
    const oldStrength = row.memoryStrength ?? 1.0;
    if (Math.abs(patch.memoryStrength - oldStrength) > 0.001) {
      updates.push({ id: row.id, ...patch });
    }
  }

  if (!dryRun) {
    for (const update of updates) {
      try {
        await db.table.update({
          where: `id = "${update.id}"`,
          values: { memoryStrength: update.memoryStrength, lastDynamicsAt: update.lastDynamicsAt },
        });
        decayed++;
      } catch (err) {
        logger.warn?.(`dynamics-decay: update failed for ${update.id}: ${err.message}`);
      }
    }
  }

  logger.info?.(`memory-dynamics-decay: ${decayed} memories decayed (${updates.length} candidates)`);
  return { decayed, candidates: updates.length, dryRun, durationMs: Date.now() - startTime };
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/jobs/memory-dynamics-decay.js
git commit -m "feat(memory-dynamics-decay): daily strength decay job"
```

---

### Task 8: Update `lib/jobs/daily-consolidation.js`

**Files:**
- Modify: `lib/jobs/daily-consolidation.js`

- [ ] **Step 1: Import decay job**

```javascript
import { runMemoryDynamicsDecay } from "./memory-dynamics-decay.js";
```

- [ ] **Step 2: Add decay step before compaction**

After TTL expiration, add:

```javascript
// ── 1.5 Memory Dynamics: Strength Decay ──────────────────────────────────
let dynamics = null;
if (db && db.table) {
  try {
    dynamics = await runMemoryDynamicsDecay(db, { logger, dryRun: opts.dryRun === true });
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
git commit -m "feat(daily-consolidation): integrate memory dynamics decay"
```

---

### Task 9: Update `index.js` — central dynamics defaults

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Import applyDynamicsDefaults at module level**

```javascript
import { applyDynamicsDefaults } from "./lib/memory-dynamics.js";
```

- [ ] **Step 2: Wrap every db.store() call with applyDynamicsDefaults**

Find all `await db.store({` calls and wrap:

```javascript
// OLD: await db.store({ ...entry });
// NEW: await db.store(applyDynamicsDefaults({ ...entry }));
```

Specific locations:
1. `storeMemoryFromToolParams` — normal store path
2. Merged entry store path
3. Auto-capture loop

- [ ] **Step 3: Pass retrievalLogger to runRecallPipeline**

In both `runRecallPipeline` calls (memory_recall and auto-recall), add:

```javascript
retrievalLogger: (items) => {
  try { neoStore.appendRetrievalLedger(items); } catch (_) {}
},
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(index): apply dynamics defaults to all stores, pass retrievalLogger"
```

---

### Task 10: Run all tests

- [ ] **Step 1: Run full test suite**

```bash
cd /tmp/memory-analysis && node --test tests/*.test.js
```

Expected: 48 passing (40 existing + 8 new)

- [ ] **Step 2: Commit**

```bash
git commit -m "test: all tests passing including memory-dynamics"
```

---

## Self-Review Checklist

- [ ] **Schema cache workspace-safe:** `${basePath}:${agent}` used everywhere
- [ ] **Dynamics fields in MemoryDB:** Schema creation + search results
- [ ] **Ledger unified:** Only Neo-Store path, no `.adaptive-learning`
- [ ] **Decay/Reinforcement separated:** `computeDecayedStrength`, `applyRetrievalReinforcement`, `applyDailyDecay`
- [ ] **No `decayRate`:** Only `halfLifeDays` used
- [ ] **Metadata updated by Daily Job:** Ledger-first, aggregator updates DB
- [ ] **`lastDynamicsAt` for decay, `lastStrengthenedAt` for reinforcement**
- [ ] **Flashbulb test fixed:** Asserts `> 0.6 && <= 1.0`
- [ ] **Flashbulb central:** `applyDynamicsDefaults` before every `db.store()`
- [ ] **Static imports at module level**
- [ ] **Pipeline gets `retrievalLogger` callback**
- [ ] **Daily job works with `db.table`**
- [ ] **Strength factor softened:** `0.65 + 0.35 * memoryStrength`
- [ ] **Prospective Memory deferred**

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-01-memory-dynamics-v2.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
