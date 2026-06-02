# Phase 7: Memory Dynamics — Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Retrieval Ledger, Memory Strength/Forgetting Curve, and Flashbulb Encoding to PLUR1BUS.

**Architecture:** Extend the existing LanceDB schema with retrieval metadata. Log every recall to `retrieval-ledger.jsonl` via Neo-Store. A daily background job reads the ledger idempotently, aggregates retrievals per memory, applies reinforcement, then applies decay. Flashbulb encoding runs at store time. **No content mutation during recall.**

**Tech Stack:** Node.js ESM, LanceDB, OpenAI/local-transformers embeddings.

---

## File Structure

| File | Responsibility |
|------|--------------|
| `lib/memory-dynamics.js` | Pure functions: decay, reinforcement, flashbulb scoring, ledger entry creation |
| `lib/jobs/memory-dynamics-maintenance.js` | Daily job: processes ledger, aggregates retrievals, applies reinforcement + decay |
| `tests/memory-dynamics.test.js` | Unit tests for decay, reinforcement, flashbulb |
| `index.js` | Wire dynamics defaults into all store paths, pass `workspaceKey`/`agentId`/`retrievalLogger` to pipeline |
| `lib/neo-arch.js` | Add `retrieval-ledger.jsonl` to NEO_JSONL_FILES, append/read methods |
| `lib/jobs/daily-consolidation.js` | Add memory-dynamics-maintenance step |
| `lib/recall-pipeline.js` | Multiply `strengthFactor` into final score, emit ledger events via callback |
| `lib/db-adapter.js` | Add new columns with workspace-safe cache key |

---

## Foundation Sanity (Task 0)

- [ ] **Step 0.1: Verify `run-state.json` is NOT in `NEO_JSONL_FILES`**

Check `lib/neo-arch.js`:
```javascript
// run-state.json should be in NEO_JSON_FILES (JSON), not NEO_JSONL_FILES (JSONL)
```

If it's in `NEO_JSONL_FILES`, move it to `NEO_JSON_FILES`.

- [ ] **Step 0.2: Verify `run-state.json` is not pruned/capped/tailed**

Check `neoStore.pruneAll()` — ensure `run-state.json` is excluded from pruning.

- [ ] **Step 0.3: Commit**

```bash
git add lib/neo-arch.js
git commit -m "fix(neo-arch): ensure run-state.json is not treated as JSONL"
```

---

## Task 1: Update `lib/db-adapter.js`

**Files:**
- Modify: `lib/db-adapter.js`

- [ ] **Step 1.1: Fix `ensureDynamicsColumns` signature**

```javascript
async function ensureDynamicsColumns({ agent, table, basePath, logger }) {
  if (!table || !basePath) return;
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

- [ ] **Step 1.2: Call with basePath**

```javascript
await ensureDynamicsColumns({ agent, table, basePath, logger });
```

- [ ] **Step 1.3: Commit**

```bash
git add lib/db-adapter.js
git commit -m "feat(db-adapter): workspace-safe dynamics schema cache with basePath"
```

---

## Task 2: Update `index.js` — MemoryDB.init() + MemoryDB.search()

**Files:**
- Modify: `index.js`

- [ ] **Step 2.1: Add dynamics fields to schema creation**

In `MemoryDB.init()`, in the `__schema__` row, add:
```javascript
retrievalCount: 0,
lastRetrievedAt: 0,
memoryStrength: 1.0,
halfLifeDays: 30,
lastStrengthenedAt: 0,
lastDynamicsAt: 0,
```

- [ ] **Step 2.2: Add existing-table migration**

After schema creation, add:
```javascript
const dynamicsColumns = [
  { name: 'retrievalCount', valueSql: '0' },
  { name: 'lastRetrievedAt', valueSql: '0' },
  { name: 'memoryStrength', valueSql: '1.0' },
  { name: 'halfLifeDays', valueSql: '30' },
  { name: 'lastStrengthenedAt', valueSql: '0' },
  { name: 'lastDynamicsAt', valueSql: '0' },
];
for (const col of dynamicsColumns) {
  if (!schema.fields.some(f => f.name === col.name)) {
    await this.table.addColumns([col]);
  }
}
```

- [ ] **Step 2.3: Add dynamics fields to MemoryDB.search()**

```javascript
retrievalCount: r.retrievalCount ?? 0,
lastRetrievedAt: r.lastRetrievedAt ?? 0,
memoryStrength: r.memoryStrength ?? 1.0,
halfLifeDays: r.halfLifeDays ?? 30,
lastStrengthenedAt: r.lastStrengthenedAt ?? 0,
lastDynamicsAt: r.lastDynamicsAt ?? 0,
```

- [ ] **Step 2.4: Commit**

```bash
git add index.js
git commit -m "feat(memory-db): dynamics schema + migration + search fields"
```

---

## Task 3: Create `lib/memory-dynamics.js`

**Files:**
- Create: `lib/memory-dynamics.js`

- [ ] **Step 3.1: Write pure functions**

```javascript
import { randomUUID, createHash } from "node:crypto";

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function firstValidTimestamp(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now();
}

export function computeDecayedStrength(row, now = Date.now()) {
  const base = clamp01(row.memoryStrength ?? 1.0);
  const anchor = firstValidTimestamp(
    row.lastDynamicsAt,
    row.lastStrengthenedAt,
    row.createdAt,
    now
  );
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
  const { memoryId, workspaceKey, agentId, query, recallScore, memoryStrength } = opts;
  const queryHash = createHash("sha256").update(String(query || "")).digest("hex").slice(0, 16);
  return {
    id: randomUUID(),
    memoryId: memoryId || "",
    workspaceKey: workspaceKey || "default",
    agentId: agentId || "default",
    queryHash,
    recallScore: Number(recallScore) || 0,
    memoryStrength: Number(memoryStrength) || 1.0,
    returnedToPrompt: opts.returnedToPrompt === true,
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 3.2: Commit**

```bash
git add lib/memory-dynamics.js
git commit -m "feat(memory-dynamics): decay, reinforcement, flashbulb, ledger entry"
```

---

## Task 4: Write tests for `lib/memory-dynamics.js`

**Files:**
- Create: `tests/memory-dynamics.test.js`

- [ ] **Step 4.1: Write 9 tests**

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
    assert.ok(old < young);
  });

  it("computeDecayedStrength respects halfLifeDays", () => {
    const short = computeDecayedStrength({ createdAt: Date.now() - 60 * 86400000, memoryStrength: 1.0, halfLifeDays: 10 }, Date.now());
    const long = computeDecayedStrength({ createdAt: Date.now() - 60 * 86400000, memoryStrength: 1.0, halfLifeDays: 90 }, Date.now());
    assert.ok(short < long);
  });

  it("applyRetrievalReinforcement increments count and boosts strength", () => {
    const before = { retrievalCount: 3, memoryStrength: 0.5, createdAt: Date.now() };
    const after = applyRetrievalReinforcement(before, Date.now());
    assert.strictEqual(after.retrievalCount, 4);
    assert.ok(after.memoryStrength > before.memoryStrength);
    assert.strictEqual(after.lastStrengthenedAt, after.lastRetrievedAt);
  });

  it("applyDailyDecay does not strengthen via old retrievalCount", () => {
    const before = { retrievalCount: 20, memoryStrength: 0.8, createdAt: Date.now() };
    const after = applyDailyDecay(before, Date.now());
    assert.strictEqual(after.retrievalCount, undefined);
    assert.ok(after.memoryStrength <= before.memoryStrength + 0.001);
  });

  it("computeFlashbulbScore uses all components", () => {
    const low = computeFlashbulbScore({ emotionalIntensity: 0.1, importance: 0.2 });
    const high = computeFlashbulbScore({ emotionalIntensity: 0.9, importance: 0.9, category: "decision", sourceUrl: "http://x" });
    assert.ok(low < high);
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
    assert.ok(result.memoryStrength > 1.0 || result.halfLifeDays > 30);
  });

  it("createRetrievalLedgerEntry creates valid hash", () => {
    const entry = createRetrievalLedgerEntry({ query: "hello world", memoryId: "abc", recallScore: 0.8 });
    assert.ok(entry.queryHash);
    assert.strictEqual(entry.queryHash.length, 16);
    assert.strictEqual(entry.memoryId, "abc");
    assert.ok(entry.id.includes("-"));
  });
});
```

- [ ] **Step 4.2: Run tests**

```bash
cd /tmp/memory-analysis && node --test tests/memory-dynamics.test.js
```

Expected: 9 passing

- [ ] **Step 4.3: Commit**

```bash
git add tests/memory-dynamics.test.js
git commit -m "test(memory-dynamics): 9 tests for decay, reinforcement, flashbulb"
```

---

## Task 5: Update `lib/neo-arch.js`

**Files:**
- Modify: `lib/neo-arch.js`

- [ ] **Step 5.1: Add `retrieval-ledger.jsonl` to `NEO_JSONL_FILES`**

```javascript
export const NEO_JSONL_FILES = Object.freeze([
  // ... existing entries ...
  "retrieval-ledger.jsonl",
]);
```

- [ ] **Step 5.2: Add paths and accessors in `createNeoStore`**

```javascript
retrievalLedger: join(workspaceDir, "retrieval-ledger.jsonl"),
```

```javascript
appendRetrievalLedger: (items) => appendJsonl(paths.retrievalLedger, items),
readRetrievalLedger: (limit = 10_000) => readJsonlTail(paths.retrievalLedger, limit),
```

- [ ] **Step 5.3: Commit**

```bash
git add lib/neo-arch.js
git commit -m "feat(neo-arch): add retrieval-ledger jsonl"
```

---

## Task 6: Update `lib/recall-pipeline.js`

**Files:**
- Modify: `lib/recall-pipeline.js`

- [ ] **Step 6.1: Import and add params**

```javascript
import { computeDecayedStrength, createRetrievalLedgerEntry } from "./memory-dynamics.js";

export async function runRecallPipeline({
  // ... existing params ...
  workspaceKey = "default",
  agentId = "default",
  retrievalLogger = null,
})
```

- [ ] **Step 6.2: Apply strength factor**

After vector search results:
```javascript
const strengthBoosted = results.map(r => {
  const strength = computeDecayedStrength(r.entry, Date.now());
  const strengthFactor = 0.65 + 0.35 * strength;
  return { ...r, score: r.score * strengthFactor, memoryStrength: strength };
});
```

- [ ] **Step 6.3: Emit ledger events via callback**

After importance boost:
```javascript
if (retrievalLogger && boosted.length > 0) {
  const entries = boosted.slice(0, topN).map((r, idx) =>
    createRetrievalLedgerEntry({
      memoryId: r.entry.id,
      workspaceKey,
      agentId,
      query,
      recallScore: r.score,
      memoryStrength: r.memoryStrength,
      returnedToPrompt: idx < topN,
    })
  );
  retrievalLogger(entries);
}
```

- [ ] **Step 6.4: Commit**

```bash
git add lib/recall-pipeline.js
git commit -m "feat(recall-pipeline): strength factor + retrievalLogger callback"
```

---

## Task 7: Create `lib/jobs/memory-dynamics-maintenance.js`

**Files:**
- Create: `lib/jobs/memory-dynamics-maintenance.js`

- [ ] **Step 7.1: Write processRetrievalLedger**

```javascript
import { applyRetrievalReinforcement, applyDailyDecay } from "../memory-dynamics.js";

function sqlQuoteId(id) {
  return String(id).replaceAll("'", "''");
}

export async function processRetrievalLedger(db, neoStore, opts = {}) {
  const { logger = { info: () => {}, warn: () => {} }, dryRun = false } = opts;
  if (!db || !db.table || !neoStore) {
    return { reinforced: 0, skipped: true, reason: "missing_db_or_store" };
  }

  const state = neoStore.readRunState ? neoStore.readRunState() : {};
  const dynamicsState = state.memoryDynamics || {};
  const lastProcessedAt = dynamicsState.lastRetrievalLedgerProcessedAt || 0;

  const entries = neoStore
    .readRetrievalLedger(50_000)
    .filter(e => Number(new Date(e.createdAt || 0)) > lastProcessedAt);

  if (entries.length === 0) {
    return { reinforced: 0, reason: "no_new_entries" };
  }

  // Group by memoryId
  const byMemoryId = new Map();
  for (const e of entries) {
    if (!e.memoryId) continue;
    const bucket = byMemoryId.get(e.memoryId) || [];
    bucket.push(e);
    byMemoryId.set(e.memoryId, bucket);
  }

  let reinforced = 0;
  const now = Date.now();

  for (const [memoryId, events] of byMemoryId) {
    if (memoryId === "__schema__") continue;

    try {
      const rows = await db.table.query()
        .where(`id = '${sqlQuoteId(memoryId)}'`)
        .limit(1)
        .toArray();
      if (rows.length === 0) continue;
      let row = rows[0];

      // Apply each retrieval event sequentially
      for (const event of events) {
        const eventTime = Number(new Date(event.createdAt || now));
        row = { ...row, ...applyRetrievalReinforcement(row, eventTime) };
      }

      if (!dryRun) {
        await db.table.update({
          where: `id = '${sqlQuoteId(memoryId)}'`,
          values: {
            retrievalCount: row.retrievalCount,
            lastRetrievedAt: row.lastRetrievedAt,
            memoryStrength: row.memoryStrength,
            lastStrengthenedAt: row.lastStrengthenedAt,
            lastDynamicsAt: row.lastDynamicsAt,
          },
        });
      }
      reinforced++;
    } catch (err) {
      logger.warn?.(`dynamics-maintenance: reinforcement failed for ${memoryId}: ${err.message}`);
    }
  }

  // Update state
  const maxCreatedAt = entries
    .map(e => Number(new Date(e.createdAt || 0)))
    .reduce((a, b) => Math.max(a, b), lastProcessedAt);

  if (!dryRun && neoStore.writeRunState) {
    const newState = {
      ...state,
      memoryDynamics: {
        ...dynamicsState,
        lastRetrievalLedgerProcessedAt: maxCreatedAt,
      },
    };
    neoStore.writeRunState(newState);
  }

  logger.info?.(`dynamics-maintenance: ${reinforced} memories reinforced from ${entries.length} ledger entries`);
  return { reinforced, entriesProcessed: entries.length, dryRun };
}
```

- [ ] **Step 7.2: Write applyDailyDecay**

```javascript
export async function applyDailyDecayToAll(db, opts = {}) {
  const { logger = { info: () => {}, warn: () => {} }, dryRun = false } = opts;
  if (!db || !db.table) {
    return { decayed: 0, skipped: true, reason: "no_table" };
  }

  const rows = await db.table.query().limit(5000).toArray();
  const now = Date.now();
  let decayed = 0;

  for (const row of rows) {
    if (row.id === "__schema__") continue;
    const patch = applyDailyDecay(row, now);
    const oldStrength = row.memoryStrength ?? 1.0;
    if (Math.abs(patch.memoryStrength - oldStrength) > 0.001) {
      if (!dryRun) {
        try {
          await db.table.update({
            where: `id = '${sqlQuoteId(row.id)}'`,
            values: {
              memoryStrength: patch.memoryStrength,
              lastDynamicsAt: patch.lastDynamicsAt,
            },
          });
          decayed++;
        } catch (err) {
          logger.warn?.(`dynamics-maintenance: decay failed for ${row.id}: ${err.message}`);
        }
      } else {
        decayed++;
      }
    }
  }

  logger.info?.(`dynamics-maintenance: ${decayed} memories decayed`);
  return { decayed, dryRun };
}
```

- [ ] **Step 7.3: Commit**

```bash
git add lib/jobs/memory-dynamics-maintenance.js
git commit -m "feat(memory-dynamics-maintenance): ledger processing + daily decay"
```

---

## Task 8: Update `lib/jobs/daily-consolidation.js`

**Files:**
- Modify: `lib/jobs/daily-consolidation.js`

- [ ] **Step 8.1: Import maintenance job**

```javascript
import { processRetrievalLedger, applyDailyDecayToAll } from "./memory-dynamics-maintenance.js";
```

- [ ] **Step 8.2: Add maintenance step**

After TTL expiration:
```javascript
// ── 1.5 Memory Dynamics: Ledger Processing + Decay ──────────────────────
let dynamics = null;
if (opts.rawDb?.table) {
  try {
    const ledgerResult = await processRetrievalLedger(opts.rawDb, opts.neoStore, { logger, dryRun: opts.dryRun === true });
    const decayResult = await applyDailyDecayToAll(opts.rawDb, { logger, dryRun: opts.dryRun === true });
    dynamics = { ...ledgerResult, ...decayResult };
    logger.info?.(`daily-consolidation[${agent}]: dynamics ${dynamics.reinforced || 0} reinforced, ${dynamics.decayed || 0} decayed`);
  } catch (err) {
    logger.warn?.(`daily-consolidation[${agent}]: dynamics threw: ${err.message}`);
  }
}
```

- [ ] **Step 8.3: Add dynamics to report**

```javascript
const report = {
  // ... existing fields ...
  dynamics: dynamics || { reinforced: 0, decayed: 0 },
};
```

- [ ] **Step 8.4: Commit**

```bash
git add lib/jobs/daily-consolidation.js
git commit -m "feat(daily-consolidation): integrate memory dynamics maintenance"
```

---

## Task 9: Update `index.js` — central dynamics defaults + pipeline wiring

**Files:**
- Modify: `index.js`

- [ ] **Step 9.1: Import at module level**

```javascript
import { applyDynamicsDefaults } from "./lib/memory-dynamics.js";
```

- [ ] **Step 9.2: Wrap every db.store() with applyDynamicsDefaults**

All store paths:
```javascript
await db.store(applyDynamicsDefaults({ ...entry }));
```

- [ ] **Step 9.3: Pass retrievalLogger to runRecallPipeline**

In both pipeline calls:
```javascript
workspaceKey: workspaceKeyFromContext(ctx, event) || "default",
agentId,
retrievalLogger: (items) => {
  try { neoStore.appendRetrievalLedger(items); } catch (err) {
    api.logger.warn?.(`retrieval-ledger append failed: ${String(err)}`);
  }
},
```

- [ ] **Step 9.4: Pass rawDb to daily consolidation**

```javascript
const rawDb = pool.getDb(internalAgent);
await rawDb.init();

const result = await runDailyConsolidation(memoryDbAdapter, internalAgent, {
  ...opts,
  rawDb,
});
```

- [ ] **Step 9.5: Commit**

```bash
git add index.js
git commit -m "feat(index): dynamics defaults, retrievalLogger, rawDb for consolidation"
```

---

## Task 10: Run all tests

- [ ] **Step 10.1: Run full suite**

```bash
cd /tmp/memory-analysis && node --test tests/*.test.js
```

Expected: 49 passing (40 existing + 9 new)

- [ ] **Step 10.2: Commit**

```bash
git commit -m "test: all tests passing with memory-dynamics"
```

---

## Self-Review Checklist

- [ ] **Ledger processed idempotently:** `lastRetrievalLedgerProcessedAt` state tracked
- [ ] **No workspaceDir in pipeline:** Only `workspaceKey`/`agentId`/`retrievalLogger`
- [ ] **Existing tables migrated:** `addColumns` in `MemoryDB.init()`
- [ ] **`firstValidTimestamp` skips 0:** Proper fallback chain
- [ ] **`__schema__` skipped in decay**
- [ ] **SQL IDs safely quoted:** `replaceAll("'", "''")`
- [ ] **`applyRetrievalReinforcement` used in ledger processor**
- [ ] **9 tests, not 8**
- [ ] **`randomUUID()` used in ledger entries**
- [ ] **`returnedToPrompt` not `usedInAnswer`**
- [ ] **`run-state.json` not in JSONL list**
- [ ] **Dry-run respected throughout**

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-01-memory-dynamics-v3.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
