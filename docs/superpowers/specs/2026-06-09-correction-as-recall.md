# Correction-as-Recall

**Date:** 2026-06-09
**Status:** Approved

---

## Context

When a user runs `/correct` (the Telegram memory correction command), the corrected card is already re-embedded — `embeddings.embed(newContent)` is called and `safeUpdate()` writes the new vector to LanceDB. That part works.

What is missing: the correction is not treated as a recall event. After `safeUpdate()` inserts the new versioned card, the card inherits `lastRetrievedAt: 0` (or whatever the old card had). The decay clock is not refreshed, and `retrievalCount` is not incremented. If the old card was decaying, the corrected version continues from the same decay state as if the correction never happened.

Since a correction implies the bot recalled the memory (to present it to the user for correction), the correction should refresh the decay clock — exactly as a recall event does.

---

## Design

### Gap

`safeUpdate()` returns `{ oldId, newId, ... }`. After it returns, the new card exists in LanceDB but its `lastRetrievedAt`, `retrievalCount`, and `memoryStrength` are copied verbatim from the old card.

`applyRetrievalReinforcement(row, now)` in `lib/memory-dynamics.js` already computes the correct patch (increments `retrievalCount`, sets `lastRetrievedAt`, applies a small strength boost without changing the half-life tier). It is used by the retrieval ledger maintenance job for every normal recall event.

### Fix

In the `updateMemory` callback inside the `/correct` handler (`index.js` ~line 2571), after `safeUpdate()` completes:

```js
const { newId } = await safeUpdate(rawDb, id, { text: newContent, summary: ..., vector }, evidence, opts);
// Treat correction as recall — refresh decay clock
const correctedCard = await rawDb.getById(newId);
if (correctedCard) {
  await rawDb.update(newId, applyRetrievalReinforcement(correctedCard, Date.now()));
}
```

The `if (correctedCard)` guard ensures that if `getById` races or fails, the correction itself is not rolled back.

### Import

`applyRetrievalReinforcement` is exported from `lib/memory-dynamics.js` but not currently imported in `index.js`. Add it to the existing import on line 125:

```js
import { applyDynamicsDefaults, applyRetrievalReinforcement, createRetrievalLedgerEntry, resolveHalfLifeDays } from "./lib/memory-dynamics.js";
```

---

## Files changed

| File | Change |
|---|---|
| `index.js` | Add `applyRetrievalReinforcement` to import; add 4-line reinforcement block after `safeUpdate()` in `updateMemory` callback |

---

## Tests

New file: `tests/smoke-correct-recall.test.js`

Two test cases, both using in-memory stubs (no real LanceDB):

1. **Happy path**: `updateMemory` callback called with a fresh card (all dynamics fields at 0). After the callback, `rawDb.update` was called with a patch where `lastRetrievedAt > 0` and `retrievalCount === 1`.
2. **Null guard**: If `rawDb.getById(newId)` returns `null`, the callback does not throw and `rawDb.update` is not called.

---

## Verification

```bash
# New tests pass
node --test tests/smoke-correct-recall.test.js

# Full suite — no regressions
npm test
```

Manual: Send a `/correct` command, then immediately run `/memory <topic>` — the corrected card should surface at the top of results (reinforced strength), and `lastRetrievedAt` should be near the current timestamp when inspected via debug tooling.
