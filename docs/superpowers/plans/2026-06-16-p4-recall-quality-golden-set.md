# P4 Plan: Recall Quality Golden-Set / Behavioral Regression

**Goal:** Add deterministic, fixture-driven behavioral regression tests that lock the
expected recall behavior of the memory subsystem. The tests must be fast,
DB-free, and must not change vector DB schemas, embedding dimensions, default
trace visibility, or deployment/test infrastructure.

**Baseline:** `main` @ `ce01a7b` — lint, test (1463 tests), and audit all green.
**Branch:** `test/recall-quality-golden-set-2026-06-16`

---

## 1. Reconnaissance summary

The existing recall surface is already well covered by unit tests, but several
high-value behavioral paths lack a deterministic golden fixture:

- Full `runRecallPipeline` ranking with explicit per-row vectors/scores.
- Score-threshold boundaries (`recallMinScore`, `canonicalMinScore`,
  `graphHydrationRelevanceThreshold`).
- Combined emotional + strength + importance boost behavior.
- Query-refiner integration path.
- Temporal filter integration path.
- Reranker timeout/fallback path.
- ACL filtering inside the pipeline.
- Trace summary counters after a full pipeline run.
- Memory-text contradiction rendering through the formatter.
- Overlay contradiction humility rendering.
- Fact-quality edge cases and multi-language/negation patterns.

Existing harness patterns we reuse:

- `mockTable(vectorRows, queryRows)` with `vectorSearch` / `query().where()`
  chain.
- `makeRow({ id, text, summary, category, origin, status, importance,
  memoryStrength, _distance })`.
- `makeEmbeddings()` returning deterministic vectors.
- `mkdtempSync` for temp `KNOWLEDGE.md` / workspace dirs.
- `node --test` native test runner.

Existing golden-set file to extend:

- `tests/recall-golden-set.test.js` (tokenize, decay, dedup, summary).

---

## 2. Hard constraints

- **No vector DB schema changes.** Use mocked LanceDB tables only.
- **No embedding model or dimension changes.** Keep `VECTOR_DIM = 4` in tests.
- **No LanceDB schema or migration changes.**
- **No deploy/protect/update logic changes.**
- **No lint/test infrastructure changes.**
- **No default trace visibility changes.** `decisionTrace.includeInPrompt` stays
  default `false`; trace rendering remains opt-in inside tests.
- **Do not weaken #49–#56 safeguards.** Fact-quality, categorization,
  importance, and promotion guards must not be bypassed or loosened.
- **Deterministic-only fixtures.** No live LLM or embedding calls in golden-set
  tests. Mock LLMs where contradiction/overlay paths are exercised.
- **Additive recall only.** CRR, semantic lens, and graph associative spread
  append results; golden tests must not assert replacement of primary recall.

---

## 3. Fixture / harness design

### 3.1 Shared golden harness (`tests/helpers/golden-recall-harness.js`)

Pure helpers to keep golden tests readable and DRY:

```js
export const VECTOR_DIM = 4;

export function vectorFor(text) { /* deterministic hash → unit vector */ }
export function makeEmbeddings(vectorMap = {}) { /* embed() / embedQuery() */ }
export function makeRow(opts) { /* same shape as existing tests */ }
export function mockTable(vectorRows, queryRows) { /* reuse existing pattern */ }
export function makeKnowledgeDir(sections) { /* temp KNOWLEDGE.md dir */ }
export function expectOrderedIds(results, ids) { /* strict id + order assert */ }
export function expectTraceSummary(trace, expected) { /* assert summary counts */ }
```

Rules for the harness:

- `vectorFor` must be deterministic and stable across Node versions. Use a
  simple seeded hash → unit vector, not crypto randomness.
- Do **not** add a dependency; keep it in plain JS.
- Use the same row shape (`entry`, `score`, `source`, `depth`, etc.) that the
  pipeline already emits.

### 3.2 Fixture data shape

Each golden scenario is a plain object:

```js
{
  name: "project signal dominates ephemeral chat",
  query: "Project Alpha auth",
  rows: [
    { id: "ephemeral-1", text: "lol ok", category: "conversation", _distance: 0.0, importance: 0.3 },
    { id: "project-1", text: "Project Alpha uses OAuth2 for internal tools", category: "project", _distance: 0.2, importance: 0.8 },
  ],
  config: { topN: 5, recallMinScore: 0.1, importanceBoost: 0.3 },
  expected: {
    ids: ["project-1", "ephemeral-1"],
    scores: { "project-1": 0.833..., "ephemeral-1": 0.1... },
    traceSummary: { included: 2, rejected: 0 }
  }
}
```

Score expectations use `assert.ok(Math.abs(actual - expected) < 1e-9)` or a
small epsilon where floating-point summation order matters.

---

## 4. Golden scenarios to implement

Scenarios are grouped by behavioral area. Each group becomes one `describe`
block in `tests/recall-golden-set.test.js` or a dedicated new file if it becomes
large.

### 4.1 Ranking / scoring

1. **Importance boost does not let a low-relevance high-importance item
   overtake a high-relevance item.** Already covered for `applyImportanceBoost`;
   extend to full pipeline.
2. **Combined boost ordering.** Emotional boost clamped to `[0.9, 1.1]`,
   strength boost additive, importance boost additive; final order is stable.
3. **Score-threshold boundary at `recallMinScore`.** A result with score exactly
   `0.15` is rejected; a result with score `0.150001` is included.
4. **Tie-breaking / input-order stability.** Equal scores preserve input order.
5. **Vector distance → score mapping.** `distanceToScore(0) === 1.0`,
   `distanceToScore(1) === 0.5`.

### 4.2 Dedup

6. **Jaccard 0.78 boundary.** Two memories with Jaccard `0.77` survive; two with
   `0.79` collapse to the first.
7. **Dedup preserves the first occurrence.** Reorder input and assert first
   wins.

### 4.3 Budget / tier allocation

8. **Core → canonical → project → episodic → associative priority.** Build a
   fixture with one item per tier and assert final order.
9. **Associative 30 % cap.** 10 episodic + 10 associative with budget 10 → at
   most 3 associative in output.
10. **Canonical slot reservation.** 5 canonical hits + 12 vector hits with
    `topN=12` → 5 canonical + 7 vector.

### 4.4 Graph / associative

11. **Graph-only cap H1-01.** A graph-only candidate with raw score `0.9` and
    best vector score `0.8` is capped below `0.8 * 0.85 = 0.68`.
12. **Overlap preserves vector score H1-02.** Same id in vector and graph keeps
    vector score and `source="both"`.
13. **Graph hydration drops inactive / superseded / archived rows.**
14. **Graph hydration relevance threshold boundary.** Candidate at exactly
    `graphHydrationRelevanceThreshold` is dropped; candidate above is kept.

### 4.5 Canonical / KNOWLEDGE.md

15. **`canonicalMinScore` boundary.** A chunk scoring exactly `0.30` is kept;
    `0.299999` is dropped.
16. **`canonicalMaxItems` cap.** 10 eligible chunks → at most 5 returned.
17. **Short sections (< 30 chars) ignored.**

### 4.6 Temporal filter

18. **Range filter keeps only memories inside `[from, to]`.**
19. **Anchor resolution.** A temporal anchor query resolves to a 48 h window
    around the top-1 match.

### 4.7 Query refiner

20. **Refiner triggers when all results score below `minScore`.** Assert the
    refined query includes synonyms/context keywords and that original + refined
    results are merged and deduplicated.

### 4.8 Reranker

21. **Mock reranker reorders results.**
22. **Reranker timeout falls back to pre-rerank order.**
23. **Reranker error with `rerankerFallbackOnError=true` falls back.**

### 4.9 ACL

24. **Agent/workspace ACL denies foreign memories.** Denied IDs produce
    `stage: "acl"` trace decisions and are absent from output.

### 4.10 Decision trace

25. **Full pipeline trace summary counters.** For a known fixture assert exact
    `included`, `rejected`, `deduped`, `downrank`, `superseded` counts.
26. **Trace text preview truncation.** Long text is previewed, never stored
    verbatim.

### 4.11 Contradiction / overlays

27. **Memory-text contradiction rendering.** Older factual memory renders
    `status="superseded"`, `superseded-by`, and `[superseded]` prefix.
28. **Overlay contradiction humility.** A flagged contradictory overlay renders
    the humility phrase.
29. **Version ranking golden table.** Compact table of (version, status, source,
    time) → expected winner.

### 4.12 Fact quality / categorization / importance

30. **Categorization → importance → promotion chain.** A representative set of
    inputs flows through `categorizeMemoryWithReason` → `computeMemoryImportance`
    → `shouldPromoteMemory` with expected outcomes.
31. **Edge cases:** negation + temporal markers, multi-language correction
    patterns, emotion-only and tech-only salad demotion.

### 4.13 Faded / degraded recall formatting

32. **Faded threshold boundary.** `memoryStrength === threshold` is **not**
    faded; `< threshold` is faded; `< threshold/2` is very-faded.
33. **Graph-sourced items are faded at `depth >= 1` regardless of strength.**

---

## 5. Optional golden-set report utility

A small CLI reporter (`scripts/golden-set-report.js`) that:

- Runs only the golden-set tests.
- Prints a compact markdown table: scenario name, status, duration, regression
  delta if a baseline file exists.
- Returns exit code 0 only if all golden scenarios pass.

This is optional. If time is short, skip it and rely on `npm test`.

---

## 6. Implementation order

1. Create `tests/helpers/golden-recall-harness.js`.
2. Extend `tests/recall-golden-set.test.js` with the ranking/dedup/budget/
   canonical/temporal/refiner/reranker/ACL/trace scenarios.
3. Add `tests/recall-golden-set-contradiction.test.js` for contradiction and
   overlay rendering.
4. Add `tests/recall-golden-set-fact-quality.test.js` for categorization →
   importance → promotion chain.
5. Add `tests/recall-golden-set-formatter.test.js` for faded/formatter edge
   cases if not covered by existing formatter tests.
6. Run full verification.
7. If a real behavioral regression is exposed, apply the minimal code fix in a
   separate commit with a regression test.
8. Write followup document and create PR.

---

## 7. Verification commands

```bash
npm run lint
npm test
npm audit --audit-level=moderate
git diff --stat
git diff --check
# Optional sensitive diff check:
git diff | grep -iE '(password|secret|token|key|private)' || true
```

Expected final state:

- Lint passes.
- All existing tests still pass.
- New golden-set tests pass.
- `npm audit` reports 0 moderate+ vulnerabilities.
- Diff is limited to test/helper files and, only if needed, minimal behavior
  fixes.

---

## 8. Expected final report

The PR description and followup document will include:

- Number of new golden scenarios added.
- Coverage areas (ranking, dedup, budget, graph, canonical, temporal, refiner,
  reranker, ACL, trace, contradiction, fact quality, formatter).
- Any behavioral regressions found and fixed.
- Verification evidence (`npm test`, `npm run lint`, `npm audit`).
- Notes on fixtures that are intentionally skipped or marked TODO.
