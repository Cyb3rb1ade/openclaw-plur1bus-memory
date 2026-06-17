# P4 Recall Quality Golden-Set / Behavioral Regression — Followup

**Date:** 2026-06-16  
**Branch:** `test/recall-quality-golden-set-2026-06-16`  
**Goal:** Add behavioral golden-set regression coverage for recall quality after #49–#56.

---

## 1. Summary

This block adds deterministic, DB-free golden-set tests that prove the memory system:

- retrieves the correct direct memories,
- prefers corrected/current facts over old facts,
- marks or suppresses superseded facts,
- keeps graph/associative memories as weak evidence,
- does not treat associations as facts,
- avoids recalling trivial/temporary/noisy memories as strong context,
- preserves durable preferences and project facts,
- produces explainable recall decisions via #53 decision traces.

A minimal behavioral fix was required: canonical KNOWLEDGE.md results must stay separate from vector/graph results inside `applyRecallBudget`, because they have a different shape (`{ heading, text, score }` vs `{ entry, score, source }`). Mixing them broke downstream dedup, ACL, and formatter expectations.

---

## 2. Files changed

| File | Change |
|------|--------|
| `docs/superpowers/plans/2026-06-16-p4-recall-quality-golden-set.md` | Plan document |
| `docs/superpowers/plans/2026-06-16-p4-recall-quality-golden-set-followup.md` | This followup |
| `tests/helpers/golden-recall-harness.js` | Deterministic test harness |
| `tests/recall-golden-set-pipeline.test.js` | Pipeline behavioral tests (ranking, dedup, budget, reranker, ACL, trace, graph scoring) |
| `tests/recall-golden-set-fact-quality.test.js` | Fact-quality / categorization / promotion chain tests |
| `tests/recall-golden-set-contradiction.test.js` | Contradiction version ranking, superseded rendering, overlay humility tests |
| `lib/recall-pipeline.js` | Keep canonical items separate from vector/graph results in `applyRecallBudget` |
| `tests/recall-p0.test.js` | Update canonical test to create a real `KNOWLEDGE.md` and assert `canonical.length` separately |

---

## 3. Golden scenarios added

### Pipeline behavior

1. **Vector ranking** — results ordered by descending vector score, `recallMinScore` enforced.
2. **Importance boost stability** — high-relevance memory still wins over boosted lower-relevance memory when the gap is large.
3. **Emotional boost clamping** — emotional factor limited to ±10%.
4. **Dedup boundary** — distinct memories preserved, near-duplicates collapsed, first occurrence wins.
5. **Budget / tiers** — core > project > episodic priority, associative capped at 30%, canonical slots reserved.
6. **Reranker** — mock reranker reorders results, timeout falls back to unreranked order.
7. **ACL** — agent-private memories from another agent are rejected and recorded in trace.
8. **Decision trace** — candidates, guards, and decisions are recorded when enabled.
9. **Graph/associative scoring (H1-01)** — graph-only scores are capped below the best vector score.
10. **Graph overlap (H1-02)** — vector+graph overlap keeps vector score and source=`both`.
11. **Graph hydration status filter** — non-active graph candidates are dropped.

### Fact quality

12. **Categorization → importance → promotion chain** — explicit instructions, corrections, and durable preferences are promoted; filler/temporary/episodic text is not.
13. **Trivial text downrank** — "ok", "weiter", "go on!!!!" stay low-importance.
14. **Promotion gate** — only decision/fact/entity/config categories can be promoted regardless of raw importance.

### Contradiction / superseded

15. **Version ranking** — higher version wins; then active status; then authoritative update source; then recency.
16. **Superseded rendering** — superseded memories render `superseded-by` attribute and prefix.
17. **Overlay humility** — contradictory overlays render a humility phrase.

---

## 4. Test harness design

`tests/helpers/golden-recall-harness.js` provides:

- `VECTOR_DIM` and deterministic `vectorFor(text)` / `makeEmbeddings()` helpers.
- `makeRow(opts)` — constructs LanceDB-shaped rows with both snake_case and camelCase agent/workspace fields.
- `mockTable(vectorRows, queryRows)` — LanceDB stub supporting `vectorSearch`, `query().where().limit().toArray()`.
- `makeKnowledgeDirSync(sections)` / `cleanupDir(dir)` — temporary KNOWLEDGE.md fixtures.
- `expectOrderedIds(results, ids)` — strict order assertion.
- `expectScore(actual, expected, epsilon=1e-6)` — floating-point score assertion.
- `expectTraceSummary(trace)` — validates trace shape.

Rules followed:

- Deterministic.
- Fast.
- No network.
- No real OpenAI/LLM calls.
- No real DB migrations.
- No dependence on wall-clock except fixed timestamps.
- No hidden reliance on current user memory data.

---

## 5. Behaviors now protected

- Vector-score ranking and threshold gating.
- Importance/emotional/strength scoring invariants.
- Inter-result dedup semantics.
- Recall-budget tier enforcement and associative cap.
- Canonical-first slot reservation without corrupting vector/graph result shape.
- Reranker integration and timeout fallback.
- ACL rejection traceability.
- Decision trace population.
- Graph-only memory capping below best vector score (H1-01).
- Graph overlap preserving vector score and source=`both` (H1-02).
- Graph hydration dropping inactive/superseded rows.
- Categorization safety from #56.
- Fact-quality promotion/demotion from #56.
- Contradiction version ranking and superseded rendering from #51/#52.

---

## 6. Minimal behavioral fix

### Problem

After adding canonical-slot tests, `runRecallPipeline` crashed when `canonicalHits` were mixed into `boosted` before `applyRecallBudget`. `canonicalHits` have the shape `{ heading, text, score }`, while vector/graph results have `{ entry, score, source }`. Dedup, ACL, and downstream formatters expect the uniform `{ entry, ... }` shape.

### Fix

In `lib/recall-pipeline.js`, the budget call now passes `canonical: []`:

```js
const budgetResult = applyRecallBudget(boosted, { canonical: [], budget });
```

Canonical items are already returned separately in `result.canonical` and prepended by callers such as `index.js`. This preserves the existing public contract (`{ canonical, memories }`) while keeping internal result shapes uniform.

### Test update

`tests/recall-p0.test.js` was updated to:

1. Create a real temporary `KNOWLEDGE.md`.
2. Pass `workspaceDir` to `runRecallPipeline`.
3. Assert `canonical.length >= 5` and `memories.length <= 12` separately.

---

## 7. What is intentionally not covered

- Live LanceDB integration with real vectors (covered by existing integration tests; golden-set is pure/deterministic).
- End-to-end prompt rendering for every scenario (covered by existing `auto-recall-decision-trace` tests).
- Conversation reactivation recall (covered by existing CRR tests).
- Emotional state full integration (covered by existing emotion tests).
- Temporal reasoning beyond basic filter behavior.
- Performance / load regression.
- Optional `scripts/recall-quality-golden-report.mjs` diagnostic utility was skipped to keep the PR focused.

---

## 8. Vector / DB invariance

Verified:

- No changes to `lib/memory-db.js`.
- No changes to `lib/db-adapter.js`.
- No changes to `lib/embedding-cache.js` or any `lib/*embedding*` files.
- No changes to `openclaw.plugin.json`.
- No changes to `package.json` / `package-lock.json`.
- No changes to `scripts/` or `.github/`.
- Vector dimension (`VECTOR_DIM = 4`) is a test-only fixture constant.
- No LanceDB schema changes.
- No DB migrations.
- No re-embedding of historical memories.
- No deploy/protect/update script changes.
- Decision trace remains opt-in; default prompt trace visibility stays off.

---

## 9. Remaining risks

- The golden-set uses deterministic fake embeddings; real embedding model drift could change behavior not captured here.
- Graph scoring tests depend on the current `mergeAssociativeResults` capping logic (0.85 factor, `GRAPH_NO_ANCHOR_SCALE`). If these heuristics change intentionally, tests must be updated.
- `applyRecallBudget` canonical separation assumes callers prepend `result.canonical`; if a new caller consumes `canonical` differently, it should be tested.

---

## 10. Recommended next block

- **P5 Recall Observability / Metrics**: hook the golden-set scenarios into CI metrics so recall-quality regressions produce a numeric signal (precision@k, version-ranking accuracy, graph-evidence boundary score).
- **P6 Temporal Recall Golden-Set**: add deterministic scenarios for time-anchor queries and half-life decay behavior.
