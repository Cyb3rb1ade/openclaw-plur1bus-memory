# Spec B — Retroactive Interference

**Date:** 2026-06-11
**Status:** Approved

---

## Context

When a new memory is stored, semantically similar older memories are unaffected. In human memory research, learning new information about a topic weakens related older memories through *retroactive interference* — the new trace competes with and partially overwrites similar existing traces.

The current system treats every write as isolated: storing "Eva hat einen neuen Job bei Google" does not affect the decaying strength of "Eva arbeitete bei Siemens", even though the two memories are semantically close and partially contradictory.

This spec adds a fire-and-forget decay step that runs asynchronously after a successful store and applies a fixed strength penalty to semantically similar older memories.

---

## Design

### Trigger

After `storeDb.store(entry)` completes in `storeMemoryFromToolParams()` — the normal-store path only. Not triggered by:
- Merge-store (already consolidates similar memories)
- `safeUpdate()` from `/correct` (corrects an existing memory, not a new competing one)

### Algorithm

```
applyRetroactiveInterference(db, newEntry, opts):
  1. Guard: if newEntry.id or newEntry.vector is missing → return (no-op)
  2. candidates = db.search(newEntry.vector, maxAffected + 1, threshold)
     — search returns only score >= threshold (built into db.search)
  3. For each candidate (up to maxAffected):
       - Skip if candidate.id == newEntry.id (self-exclusion)
       - Skip if isCoreMemory(candidate)  (neverForget or memoryClass=core)
       - next = Math.max(0.01, candidate.memoryStrength * multiplier)
       - db.update(candidate.id, { memoryStrength: next, lastDynamicsAt: now })
```

### Parameters (defaults, all configurable)

| Parameter | Default | Meaning |
|---|---|---|
| `threshold` | `0.65` | Minimum cosine similarity to be considered a competing memory |
| `multiplier` | `0.9` | Fixed strength penalty (10% reduction per interfering write) |
| `maxAffected` | `5` | Maximum number of older memories to decay per write |

### Feature Flag

`memory.retroactiveInterference.enabled` in `openclaw.json`. Default: `false`.

Full config block:
```json
{
  "memory": {
    "retroactiveInterference": {
      "enabled": false,
      "threshold": 0.65,
      "multiplier": 0.9,
      "maxAffected": 5
    }
  }
}
```

### Error handling

Errors in `applyRetroactiveInterference` must never propagate to the write caller. The fire-and-forget wrapper in `index.js` catches all rejections and logs them at `warn` level. A failed interference pass is silently skipped — data integrity of the new memory is never at risk.

---

## Files changed

| File | Change |
|---|---|
| `lib/retroactive-interference.js` | New — stateless utility function `applyRetroactiveInterference(db, newEntry, opts)` |
| `index.js` | Add import; add `riCfg` config read; add `setImmediate` hook after `storeDb.store(entry)` (line 1814) |
| `tests/smoke-retroactive-interference.test.js` | New — 6 test cases against mock DB, all directly awaited |

---

## Tests

New file: `tests/smoke-retroactive-interference.test.js`

Six test cases, all using in-memory stubs (no real LanceDB, no timing dependencies):

1. **Happy path:** Two candidates above threshold → both receive `memoryStrength * 0.9`; `lastDynamicsAt` is updated.
2. **No-op below threshold:** `db.search` returns empty (score < threshold) → `db.update` never called.
3. **Core memory excluded:** Candidate with `memoryClass: "core"` → skipped; `db.update` not called for it.
4. **Self-exclusion:** Candidate with same `id` as `newEntry` → skipped.
5. **maxAffected limit:** 7 candidates above threshold, `maxAffected=5` → exactly 5 updates.
6. **Guard: missing vector:** `newEntry` with no `vector` field → returns immediately; `db.search` not called.

---

## Verification

```bash
# New tests pass
node --test tests/smoke-retroactive-interference.test.js

# Full suite — no regressions
npm test
```

Manual: Store two semantically similar memories (e.g., "Eva arbeitet bei Siemens" then "Eva hat einen neuen Job bei Google"), enable `retroactiveInterference`, confirm in LanceDB that the first memory's `memoryStrength` is reduced by ~10% and `lastDynamicsAt` is updated.
