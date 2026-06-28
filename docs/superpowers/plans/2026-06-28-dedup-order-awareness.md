# Order-aware Memory Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memory deduplication order-aware so role-reversed facts (same tokens, different word order) are stored separately instead of being silently collapsed as duplicates.

**Architecture:** Add a significant-token bigram-overlap signal in `lib/memory-merge-safety.js`. Wire it into the shared `hasMeaningfulDifference` so both call sites (`isSafeDuplicate` and the merge-check gate at `index.js:2305`) become order-aware — the latter stores separately without an LLM call. Also make `isSafeDuplicate`'s early canonical check order-preserving (drop `.sort()`).

**Tech Stack:** Node.js, `node:test` + `node:assert`. No new dependencies.

## Global Constraints

- Module: `lib/memory-merge-safety.js` only (no index.js change needed — it already calls `hasMeaningfulDifference`).
- Bigram-overlap threshold: `0.5` (below → order differs). High token-set overlap gate reuses existing `0.8`.
- `< 2` significant tokens on either side → bigram overlap returns `1` (no order signal; fall back to existing behavior).
- Reuse existing in-module helpers `normalizeMemoryText`, `STOP_WORDS`, `canonicalizeTech` — do not duplicate them.
- Existing `tests/memory-store-merge-safety.test.js` and all merge-safety tests must stay green.

---

### Task 1: `significantBigramOverlap` helper

**Files:**
- Modify: `lib/memory-merge-safety.js` (add + export new helper near the other exported helpers)
- Test: `tests/memory-merge-safety-order-aware.test.js` (new)

**Interfaces:**
- Produces: `export function significantBigramOverlap(a: string, b: string): number` — Jaccard (0..1) of adjacent significant-token bigram sets; returns `1` when either side has `< 2` significant tokens.

- [ ] **Step 1: Write the failing test**

```js
// tests/memory-merge-safety-order-aware.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { significantBigramOverlap } from "../lib/memory-merge-safety.js";

describe("significantBigramOverlap", () => {
  it("is low (disjoint) for role-reversed text", () => {
    const o = significantBigramOverlap("Erik überweist Eva 50€", "Eva überweist Erik 50€");
    assert.ok(o < 0.5, `expected low overlap, got ${o}`);
  });
  it("is high for the same fact with an added article (stop word)", () => {
    const o = significantBigramOverlap("Projekt Alpha nutzt Auth-Service", "Projekt Alpha nutzt den Auth-Service");
    assert.ok(o >= 0.9, `expected high overlap, got ${o}`);
  });
  it("returns 1 when a side has fewer than 2 significant tokens", () => {
    assert.strictEqual(significantBigramOverlap("Hallo", "Hallo Welt heute"), 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/memory-merge-safety-order-aware.test.js`
Expected: FAIL — `significantBigramOverlap` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/memory-merge-safety.js` (near `hasMeaningfulDifference`):

```js
export function significantBigramOverlap(a, b) {
  const toks = (s) => normalizeMemoryText(s).split(/\s+/).filter((t) => t && !STOP_WORDS.has(t));
  const bigrams = (ts) => {
    const out = new Set();
    for (let i = 0; i < ts.length - 1; i++) out.add(`${ts[i]}${ts[i + 1]}`);
    return out;
  };
  const ta = toks(a);
  const tb = toks(b);
  if (ta.length < 2 || tb.length < 2) return 1; // no order signal for very short memories
  const ba = bigrams(ta);
  const bb = bigrams(tb);
  let inter = 0;
  for (const x of ba) if (bb.has(x)) inter += 1;
  const union = ba.size + bb.size - inter;
  return union > 0 ? inter / union : 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/memory-merge-safety-order-aware.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add lib/memory-merge-safety.js tests/memory-merge-safety-order-aware.test.js
git commit -m "feat(merge-safety): add significantBigramOverlap order signal"
```

---

### Task 2: order-aware `hasMeaningfulDifference`

**Files:**
- Modify: `lib/memory-merge-safety.js` (`hasMeaningfulDifference`, final token-set Jaccard block)
- Test: `tests/memory-merge-safety-order-aware.test.js` (append)

**Interfaces:**
- Consumes: `significantBigramOverlap(a, b)` from Task 1.
- Produces: `hasMeaningfulDifference(a, b)` returns `true` for same-tokens/different-order text.

- [ ] **Step 1: Write the failing test (append to the file)**

```js
import { hasMeaningfulDifference } from "../lib/memory-merge-safety.js";

describe("hasMeaningfulDifference — order awareness", () => {
  it("flags role-reversed text as meaningfully different", () => {
    assert.strictEqual(hasMeaningfulDifference("Erik überweist Eva 50€", "Eva überweist Erik 50€"), true);
  });
  it("does not flag an added article as different", () => {
    assert.strictEqual(hasMeaningfulDifference("Projekt Alpha nutzt Auth-Service", "Projekt Alpha nutzt den Auth-Service"), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/memory-merge-safety-order-aware.test.js`
Expected: FAIL — role-reversed case currently returns `false`.

- [ ] **Step 3: Write minimal implementation**

In `hasMeaningfulDifference`, replace the final two lines:

```js
  const jaccard = union > 0 ? intersection / union : 0;
  return jaccard < 0.8;
```

with:

```js
  const jaccard = union > 0 ? intersection / union : 0;
  // Same words but a different order (e.g. role reversal "Erik->Eva" vs
  // "Eva->Erik") is a meaningful difference even though the token sets overlap.
  if (jaccard >= 0.8 && significantBigramOverlap(a, b) < 0.5) return true;
  return jaccard < 0.8;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/memory-merge-safety-order-aware.test.js`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add lib/memory-merge-safety.js tests/memory-merge-safety-order-aware.test.js
git commit -m "fix(merge-safety): hasMeaningfulDifference detects reordered tokens"
```

---

### Task 3: order-aware `isSafeDuplicate`

**Files:**
- Modify: `lib/memory-merge-safety.js` (`isSafeDuplicate`, canonical-token block)
- Test: `tests/memory-merge-safety-order-aware.test.js` (append)

**Interfaces:**
- Consumes: order-aware `hasMeaningfulDifference` from Task 2.
- Produces: `isSafeDuplicate(a, b)` returns `false` for role-reversed text, `true` for article-only variants.

- [ ] **Step 1: Write the failing test (append to the file)**

```js
import { isSafeDuplicate } from "../lib/memory-merge-safety.js";

describe("isSafeDuplicate — order awareness", () => {
  it("does NOT treat role-reversed facts as duplicates", () => {
    assert.strictEqual(isSafeDuplicate("Erik überweist Eva 50€", "Eva überweist Erik 50€"), false);
    assert.strictEqual(isSafeDuplicate("Eva liebt Erik", "Erik liebt Eva"), false);
  });
  it("still treats an added article as a duplicate", () => {
    assert.strictEqual(isSafeDuplicate("Projekt Alpha nutzt Auth-Service", "Projekt Alpha nutzt den Auth-Service"), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/memory-merge-safety-order-aware.test.js`
Expected: FAIL — role-reversed cases currently return `true` (collapsed via the sorted canonical check).

- [ ] **Step 3: Write minimal implementation**

In `isSafeDuplicate`, change the canonical block — remove the two `.sort()` calls so the canonicalized token **sequence** is compared in order:

```js
  const canonA = na.split(/\s+/).map(canonicalizeTech).join(" ");
  const canonB = nb.split(/\s+/).map(canonicalizeTech).join(" ");
  if (canonA === canonB) return true;
```

(The later `if (hasMeaningfulDifference(a, b)) return false;` — now order-aware from Task 2 — handles role reversal.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/memory-merge-safety-order-aware.test.js`
Expected: PASS (7/7).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0` (existing merge-safety + store tests stay green).

- [ ] **Step 6: Commit**

```bash
git add lib/memory-merge-safety.js tests/memory-merge-safety-order-aware.test.js
git commit -m "fix(merge-safety): isSafeDuplicate is order-aware (no role-reversal collapse)"
```
