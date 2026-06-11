# Spec B — Retroactive Interference: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a new memory is stored, asynchronously decay the `memoryStrength` of semantically similar older memories by a fixed multiplier (`0.9`). Feature-flagged, disabled by default.

**Architecture:** New stateless utility module `lib/retroactive-interference.js` exports `applyRetroactiveInterference(db, newEntry, opts)`. Called fire-and-forget via `setImmediate` after `storeDb.store(entry)` in `storeMemoryFromToolParams()`. Errors are caught in `.catch()` and logged at `warn` level — never propagate to the write caller.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`

---

## File Map

| File | Action | What changes |
|---|---|---|
| `lib/retroactive-interference.js` | Create | New stateless utility — `applyRetroactiveInterference` function |
| `tests/smoke-retroactive-interference.test.js` | Create | 6 smoke tests against mock DB |
| `index.js` | Modify | Import + `riCfg` config read + `setImmediate` hook after line 1814 |

---

## Task 1: Create the module

**File:** `lib/retroactive-interference.js`

- [ ] **Step 1: Create the file**

```js
import { isCoreMemory } from "./memory-dynamics.js";

export async function applyRetroactiveInterference(db, newEntry, opts = {}) {
  const { threshold = 0.65, multiplier = 0.9, maxAffected = 5 } = opts;
  if (!newEntry?.id || !newEntry?.vector) return;

  const candidates = await db.search(newEntry.vector, maxAffected + 1, threshold);
  const now = Date.now();
  let affectedCount = 0;

  for (const { entry: candidate } of candidates) {
    if (affectedCount >= maxAffected) break;
    if (candidate.id === newEntry.id) continue;
    if (isCoreMemory(candidate)) continue;

    const prev = candidate.memoryStrength ?? 1.0;
    const next = Math.max(0.01, prev * multiplier);
    await db.update(candidate.id, { memoryStrength: next, lastDynamicsAt: now });
    affectedCount++;
  }
}
```

Notes:
- `isCoreMemory` from `lib/memory-dynamics.js` checks `memoryClass === "core"` or `neverForget === 1/true`
- `db.search(vector, limit, minScore)` already filters results to `score >= minScore` (line 733 of index.js)
- `db.update(id, patch)` has guaranteed patch semantics: internally does `{ ...existing, ...patch }` (line 797) — minimal patch is safe
- No logger parameter — errors are handled in the `.catch()` at the call site

---

## Task 2: Smoke tests

**File:** `tests/smoke-retroactive-interference.test.js`

- [ ] **Step 1: Create the test file**

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { applyRetroactiveInterference } from "../lib/retroactive-interference.js";

// Mock DB factory
function makeDb({ searchResults = [], updateFn = () => {} } = {}) {
  return {
    searchCalls: [],
    updateCalls: [],
    async search(vector, limit, minScore) {
      this.searchCalls.push({ vector, limit, minScore });
      return searchResults;
    },
    async update(id, patch) {
      this.updateCalls.push({ id, patch });
      await updateFn(id, patch);
    },
  };
}

function makeEntry(overrides = {}) {
  return {
    id: "new-id",
    vector: [0.1, 0.2, 0.3],
    memoryStrength: 1.0,
    memoryClass: "standard",
    neverForget: 0,
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    entry: {
      id: "old-id",
      memoryStrength: 0.8,
      memoryClass: "standard",
      neverForget: 0,
      ...overrides,
    },
    score: 0.72,
  };
}

describe("smoke-retroactive-interference: applyRetroactiveInterference", () => {
  it("happy path: decays similar memories by multiplier", async () => {
    const db = makeDb({
      searchResults: [makeCandidate({ id: "old-1" }), makeCandidate({ id: "old-2" })],
    });
    const now = Date.now();
    await applyRetroactiveInterference(db, makeEntry(), { threshold: 0.65, multiplier: 0.9, maxAffected: 5 });

    assert.strictEqual(db.updateCalls.length, 2, "should update 2 candidates");
    for (const call of db.updateCalls) {
      assert.ok(call.patch.memoryStrength <= 0.8 * 0.9 + 0.001, "memoryStrength should be reduced");
      assert.ok(call.patch.lastDynamicsAt >= now, "lastDynamicsAt should be updated");
    }
  });

  it("no-op: db.update not called when search returns nothing", async () => {
    const db = makeDb({ searchResults: [] });
    await applyRetroactiveInterference(db, makeEntry(), {});
    assert.strictEqual(db.updateCalls.length, 0, "update must not be called");
  });

  it("core memory excluded: memoryClass=core is skipped", async () => {
    const db = makeDb({
      searchResults: [makeCandidate({ id: "core-mem", memoryClass: "core" })],
    });
    await applyRetroactiveInterference(db, makeEntry(), {});
    assert.strictEqual(db.updateCalls.length, 0, "core memory must not be decayed");
  });

  it("self-exclusion: new memory id is skipped", async () => {
    const newEntry = makeEntry({ id: "self-id" });
    const db = makeDb({
      searchResults: [makeCandidate({ id: "self-id" })],
    });
    await applyRetroactiveInterference(db, newEntry, {});
    assert.strictEqual(db.updateCalls.length, 0, "new memory must not decay itself");
  });

  it("maxAffected limit: only maxAffected candidates are updated", async () => {
    const candidates = Array.from({ length: 7 }, (_, i) =>
      makeCandidate({ id: `old-${i}` })
    );
    const db = makeDb({ searchResults: candidates });
    await applyRetroactiveInterference(db, makeEntry(), { maxAffected: 5 });
    assert.strictEqual(db.updateCalls.length, 5, "exactly maxAffected updates");
  });

  it("guard: missing vector → no-op, db.search not called", async () => {
    const db = makeDb({ searchResults: [] });
    await applyRetroactiveInterference(db, { id: "x" }, {});  // no vector
    assert.strictEqual(db.searchCalls.length, 0, "db.search must not be called");
    assert.strictEqual(db.updateCalls.length, 0, "db.update must not be called");
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
node --test tests/smoke-retroactive-interference.test.js
```

Expected: `6 pass, 0 fail`

- [ ] **Step 3: Commit**

```bash
git add lib/retroactive-interference.js tests/smoke-retroactive-interference.test.js
git commit -m "feat(memory): Spec B — retroactive interference module + smoke tests"
```

---

## Task 3: Wire into index.js

**File:** `index.js`

- [ ] **Step 1: Add import**

Find the block of `./lib/` imports near the top of `index.js`. Add:
```js
import { applyRetroactiveInterference } from "./lib/retroactive-interference.js";
```

- [ ] **Step 2: Read riCfg from config**

In the config-reading block (~line 1525, after `const gcCfg = cfg.gc || {};`), add:
```js
const riCfg = cfg.retroactiveInterference ?? {};
```

- [ ] **Step 3: Add setImmediate hook after storeDb.store(entry)**

Find line 1814: `await storeDb.store(entry);`

Immediately after that line (before the `if (storeCtx.workspaceDir) appendCurationLog(...)` call), add:
```js
if (riCfg.enabled) {
  setImmediate(() => {
    applyRetroactiveInterference(storeDb, entry, {
      threshold: riCfg.threshold ?? 0.65,
      multiplier: riCfg.multiplier ?? 0.9,
      maxAffected: riCfg.maxAffected ?? 5,
    }).catch((err) => {
      api.logger?.warn?.("[retroactive-interference] failed", err?.message ?? err);
    });
  });
}
```

- [ ] **Step 4: Run smoke tests**

```bash
node --test tests/smoke-retroactive-interference.test.js
```

Expected: `6 pass, 0 fail`

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: Same pass count as before ± 6 (the 6 new tests). Any other new failure must be investigated before committing.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(memory): wire retroactive interference into store path (feature-flagged, default off)"
```

---

## Verification

```bash
# Smoke tests
node --test tests/smoke-retroactive-interference.test.js

# Full suite
npm test
```

Manual (requires `retroactiveInterference.enabled: true` in openclaw.json):
1. Store a first memory: "Eva arbeitete bei Siemens als Ingenieurin."
2. Note its `memoryStrength` and `id` in LanceDB.
3. Store a second, semantically related memory: "Eva hat einen neuen Job bei Google angetreten."
4. After a moment, query LanceDB directly for the first memory's `id` — `memoryStrength` should be ≈ `prev × 0.9` and `lastDynamicsAt` should be near `Date.now()` at time of the second store.
