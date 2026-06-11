# Correction-as-Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `/correct` saves a corrected memory, treat the correction as a recall event by refreshing `lastRetrievedAt` and incrementing `retrievalCount` on the new versioned card.

**Architecture:** `safeUpdate()` already returns `{ newId }`. After it completes in the `/correct` handler's `updateMemory` callback, we load the new card via `rawDb.getById(newId)`, call `applyRetrievalReinforcement(card, Date.now())` (already exported from `lib/memory-dynamics.js`), and write the patch back via `rawDb.update(newId, patch)`. The null guard `if (correctedCard)` ensures a race condition on `getById` does not throw.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`

---

## File Map

| File | Action | What changes |
|---|---|---|
| `index.js` | Modify | Add `applyRetrievalReinforcement` to the `lib/memory-dynamics.js` import on line 125; add 4-line reinforcement block inside the `updateMemory` callback (~line 2574) |
| `tests/smoke-correct-recall.test.js` | Create | Two tests: happy path (patch has `lastRetrievedAt > 0`, `retrievalCount === 1`) and null guard (no throw, no update call when `getById` returns null) |

---

## Task 1: Smoke tests for correction-as-recall

**Files:**
- Create: `tests/smoke-correct-recall.test.js`

Context: `applyRetrievalReinforcement` is a pure function in `lib/memory-dynamics.js` — it takes a memory row and a `now` timestamp and returns a patch object. We test it directly to document the contract. The null-guard test simulates the inline `if (card) await rawDb.update(...)` pattern we are adding to index.js.

- [ ] **Step 1: Create the test file**

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { applyRetrievalReinforcement } from "../lib/memory-dynamics.js";

describe("smoke-correct-recall: applyRetrievalReinforcement contract", () => {
  it("refreshes lastRetrievedAt and increments retrievalCount from zero", () => {
    const card = {
      retrievalCount: 0,
      lastRetrievedAt: 0,
      memoryStrength: 0.8,
      lastStrengthenedAt: 0,
      lastDynamicsAt: 0,
      halfLifeDays: 7,
      memoryClass: "standard",
      neverForget: 0,
      coreMemoryScore: 0.0,
    };
    const now = Date.now();
    const patch = applyRetrievalReinforcement(card, now);
    assert.strictEqual(patch.retrievalCount, 1, "retrievalCount should be 1 after first recall");
    assert.ok(patch.lastRetrievedAt >= now, "lastRetrievedAt should be >= now");
    assert.ok(patch.memoryStrength > 0.8, "memoryStrength should increase");
  });

  it("null guard: if getById returns null, rawDb.update is not called", async () => {
    let updateCalled = false;
    const mockDb = {
      getById: async () => null,
      update: async () => { updateCalled = true; },
    };
    // Simulate the exact inline pattern from index.js updateMemory callback
    const correctedCard = await mockDb.getById("some-new-id");
    if (correctedCard) {
      await mockDb.update("some-new-id", applyRetrievalReinforcement(correctedCard, Date.now()));
    }
    assert.strictEqual(updateCalled, false, "update must not be called when card is null");
  });
});
```

- [ ] **Step 2: Run the test**

```bash
node --test tests/smoke-correct-recall.test.js
```

Expected: Both tests **PASS** (we are testing the pure function contract before wiring it in). Confirm output shows `2 pass, 0 fail`.

- [ ] **Step 3: Commit**

```bash
git add tests/smoke-correct-recall.test.js
git commit -m "test(correct): smoke tests for correction-as-recall reinforcement"
```

---

## Task 2: Wire reinforcement into the /correct handler

**Files:**
- Modify: `index.js` line 125 (import) and lines ~2574–2588 (updateMemory callback)

Context: The `/correct` confirmation handler lives at `index.js:2562`. The `updateMemory` callback starts at line 2571. `safeUpdate()` is called at line 2576 — it already returns `{ oldId, newId, versionNumber, inline }`. We capture `newId` and apply the reinforcement patch immediately after.

- [ ] **Step 1: Update the import on line 125**

Find:
```js
import { applyDynamicsDefaults, createRetrievalLedgerEntry, resolveHalfLifeDays } from "./lib/memory-dynamics.js";
```

Replace with:
```js
import { applyDynamicsDefaults, applyRetrievalReinforcement, createRetrievalLedgerEntry, resolveHalfLifeDays } from "./lib/memory-dynamics.js";
```

- [ ] **Step 2: Update the updateMemory callback (~line 2571)**

Find this block (lines 2571–2589):
```js
              updateMemory: async ({ id, newContent }) => {
                const rawDb = pool.getDb(agentId);
                await rawDb.init();
                const vector = await embeddings.embed(newContent);
                const neoStore = getNeoStore(commandCtx, {});
                await safeUpdate(
                  rawDb,
                  id,
                  { text: newContent, summary: newContent.split(/\r?\n/)[0].slice(0, 200), vector },
                  {
                    updateSource: "telegram:/correct",
                    updateEvidence: pending.payload?.oldText
                      ? `User corrected "${pending.payload.oldText}" to "${newContent}"`
                      : `User correction via /correct`,
                    confidence: 1,
                  },
                  { neoStore, logger: api.logger, skipDriftGate: true },
                );
              },
```

Replace with:
```js
              updateMemory: async ({ id, newContent }) => {
                const rawDb = pool.getDb(agentId);
                await rawDb.init();
                const vector = await embeddings.embed(newContent);
                const neoStore = getNeoStore(commandCtx, {});
                const { newId } = await safeUpdate(
                  rawDb,
                  id,
                  { text: newContent, summary: newContent.split(/\r?\n/)[0].slice(0, 200), vector },
                  {
                    updateSource: "telegram:/correct",
                    updateEvidence: pending.payload?.oldText
                      ? `User corrected "${pending.payload.oldText}" to "${newContent}"`
                      : `User correction via /correct`,
                    confidence: 1,
                  },
                  { neoStore, logger: api.logger, skipDriftGate: true },
                );
                const correctedCard = await rawDb.getById(newId);
                if (correctedCard) {
                  await rawDb.update(newId, applyRetrievalReinforcement(correctedCard, Date.now()));
                }
              },
```

- [ ] **Step 3: Run the smoke test**

```bash
node --test tests/smoke-correct-recall.test.js
```

Expected: `2 pass, 0 fail`.

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: Same pass count as before this task ± 2 (the 2 new tests). If a pre-existing perf timing test flakes, that is expected and not caused by this change. Any other new failure must be investigated and fixed before committing.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(correct): treat /correct as recall event — refresh lastRetrievedAt after safeUpdate"
```

---

## Verification

```bash
# Smoke tests
node --test tests/smoke-correct-recall.test.js

# Full suite
npm test
```

Manual: In a live session, run `/correct <old text> → <new text>`, confirm, then immediately run `/memory <corrected topic>`. The corrected card should surface at the top of results (reinforced strength). To inspect timestamps: the corrected card in LanceDB should have `lastRetrievedAt` close to `Date.now()` at time of correction.
