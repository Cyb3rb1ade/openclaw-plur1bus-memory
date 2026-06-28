# Order-aware memory deduplication — design

Date: 2026-06-28
Module: `lib/memory-merge-safety.js`
Status: approved (brainstorming) → ready for implementation plan

## Problem

`isSafeDuplicate(a, b)` and the shared `hasMeaningfulDifference(a, b)` compare
texts by **token multiset**, ignoring word order. In SVO languages word order
carries meaning, so role-reversed facts with the same tokens are treated as
identical:

- `"Erik überweist Eva 50€"` vs `"Eva überweist Erik 50€"`
- `"Eva liebt Erik"` vs `"Erik liebt Eva"`

Two order-insensitive paths cause this:

1. `isSafeDuplicate` line ~209-211: `na.split(...).map(canonicalizeTech).sort().join(" ")`
   — sorting destroys order, so the canonical strings are equal → returns
   `true` (duplicate).
2. `hasMeaningfulDifference` final fallback: token-set Jaccard `< 0.8`. Role
   reversal has high token-set overlap → Jaccard ≥ 0.8 → returns `false` (no
   meaningful difference). `isSafeDuplicate`'s own final Jaccard `>= 0.9`
   (line ~225) has the same flaw.

### Impact

Wired/reachable at `index.js:2288` (store flow). A `true` from `isSafeDuplicate`
rejects the new memory (logged to the curation log, recoverable, but absent from
active memory/recall). The structured-difference detector does not catch role
reversal (same entities, same numbers). Confirmed by the wave-3 review.

## Decision

Role-reversed / reordered text must be treated as **distinct and stored
separately, without an LLM merge call** (user decision). The existing merge-check
path already stores separately without the LLM when `hasMeaningfulDifference` is
true (`index.js:2305`), so making that detector order-aware satisfies the
"no LLM" requirement automatically.

## Design

A **significant-token bigram overlap** signal. Bigrams (adjacent significant-token
pairs) encode order:

- `"eva überweist erik"` → `{eva·überweist, überweist·erik}`
- `"erik überweist eva"` → `{erik·überweist, überweist·eva}` → disjoint → order differs.

### Components (all in `lib/memory-merge-safety.js`)

1. **`significantBigramOverlap(a, b) → number`** (new internal helper)
   - Normalize (`normalizeMemoryText`), split, drop `STOP_WORDS`.
   - Build adjacent bigrams (`token[i]·token[i+1]`) for each side.
   - Return Jaccard of the two bigram sets.
   - If either side has < 2 significant tokens (no bigram), return `1` (no order
     signal — fall back to existing behavior; short memories rarely role-reverse).

2. **`hasMeaningfulDifference(a, b)`** — before the final token-set Jaccard
   `return jaccard < 0.8`, add an order check: if the token **set** overlaps highly
   (same words, `jaccard >= 0.8`) **but** `significantBigramOverlap(a, b) < 0.5`,
   the word order differs meaningfully → `return true`.
   - Benefits both call sites: `isSafeDuplicate` (line 212) and the merge-check
     gate (`index.js:2305`, no LLM).

3. **`isSafeDuplicate(a, b)`** — remove `.sort()` from the line ~209-211 canonical
   check: compare the canonicalized token **sequence** (in order) instead of the
   sorted multiset. Role reversal → unequal canonical sequences → falls through to
   the now-order-aware `hasMeaningfulDifference` at line 212.

### Constants

- Bigram-overlap threshold: `0.5` (tunable). Below → order differs.
- High token-set overlap gate reuses the existing `0.8`.

## Behavior preserved (must stay duplicates)

- Article add/remove: `"Projekt Alpha nutzt Auth-Service"` vs `"… nutzt den
  Auth-Service"` — stop words filtered before bigrams → bigram sets match → high
  overlap → still duplicate.
- Tech-term normalization variants (`canonicalizeTech`) in the same order — the
  ordered canonical check still matches.

## Behavior changed (now distinct)

- Role-reversed subject/object with the same tokens → `isSafeDuplicate` false,
  `hasMeaningfulDifference` true → stored separately, no LLM.

## Out of scope (YAGNI)

- Entity-role / dependency parsing (too heavy; bigrams approximate order well).
- Multilingual stop-word expansion beyond the current `STOP_WORDS`.

## Testing

- Role reversal (`Erik↔Eva` transfer; `X liebt Y`) → `isSafeDuplicate` false,
  `hasMeaningfulDifference` true.
- Article add/remove → still `isSafeDuplicate` true.
- Same fact reordered-but-equivalent vs genuinely role-reversed — boundary cases
  around the 0.5 threshold.
- `< 2` significant tokens → no false order signal (existing behavior).
- Existing `tests/memory-store-merge-safety.test.js` + merge-safety unit tests
  stay green.
