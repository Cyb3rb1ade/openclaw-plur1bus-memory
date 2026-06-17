# P6 Runtime Memory Pressure / LanceDB Timeout Stabilization Plan

## 1. Goal

Make the memory plugin runtime stable under production load on `vmd190201` after #58 is live:

- Stop recall-worker and capture-worker timeouts caused by unbounded LanceDB calls.
- Make rerank degradation safe (no secondary `TypeError`).
- Bound the memory-context XML output so it cannot contribute to model prompt overflow.
- Reduce overlapping `purgeExpired` pressure on the hot prompt path.
- Keep all #49–#58 safety boundaries intact.

## 2. Non-goals

- No embedding model change.
- No vector dimension change.
- No LanceDB schema change.
- No DB migration or re-embedding.
- No deletion of existing memory data.
- No changes to deploy/protect/update scripts.
- No cronjob or service topology changes.
- No automatic production deploy.

## 3. Current production evidence

- Host: `vmd190201`, repo `/root`, branch `fix/runtime-memory-pressure-timeout-stability-2026-06-17`, live HEAD `f607388` (#58).
- Gateway restarted at 02:33:35 CEST; RSS dropped from ~8.2 GiB to ~2.0 GiB.
- Post-restart (since 02:33) still shows:
  - 5× `MemoryDB.vectorSearchActive timed out`
  - 1× `recall worker timed out`
  - 1× `rerank failed`
  - 2× `memory pressure` warnings
  - 1× `agent cleanup timed out`
- Full 2h window shows:
  - 190× `MemoryDB.store timed out`
  - 117× `MemoryDB.search.countRows timed out`
  - 37× `MemoryDB.vectorSearchActive timed out`
  - 13× `MemoryDB.purgeExpired timed out`
  - 23× `recall worker timed out`
  - 19× `capture worker timed out`
  - 32× `Cannot read properties of undefined (reading 'summary')`
  - 44× `memory pressure` (critical)
  - 2× context overflow / prompt too large (bernhardine)

## 4. Failure classes and root causes

### A. Rerank timeout / summary TypeError
- `lib/recall-pipeline.js` builds rerank docs with `r.entry.summary || generateSummary(r.entry.text, ...)`; missing text becomes the literal string `"undefined"`.
- `reranked.map(r => boosted[r.index])` assumes every result has a valid integer `index`; malformed/timeout responses cause `TypeError`.
- The Cohere reranker is failing (402 observed in logs); the chained local-transformers fallback scores sequentially and can exceed the 5 s rerank timeout.

### B. Context overflow
- `lib/relevant-memory-context.js` trusts upstream to bound the memory array and has no total output char cap.
- `lib/recall-decision-trace.js` caps `candidates` at 50 but does **not** cap `decisions`, `guards`, or `storeDecisions`, leading to unbounded trace growth and O(n×m) lookup cost in the formatter.

### C. MemoryDB / LanceDB timeout pressure
- `lib/recall-pipeline.js`, `lib/temporal-filter.js`, and `lib/memory-graph.js` call `dbTable.vectorSearch(...).toArray()` and `dbTable.query(...).toArray()` directly on the raw LanceDB table, bypassing the `MemoryDB._read()` / `withTimeout` wrappers.
- `index.js` passes `db.table` into `runRecallPipeline` instead of the wrapped `MemoryDB` instance.
- `db.purgeExpired()` is fired non-blocking on every `before_prompt_build` with no per-DB rate limit, causing overlapping table-wide deletes under load.
- `lib/runtime-scheduler.js` worker timeouts are soft: the LanceDB promise is not cancelled, so blocked calls continue to hold DB handles.

### D. Memory pressure / event-loop delay
- `lib/bounded-cache.js` keeps LanceDB table/DB handles cached indefinitely (50-entry LRU, no TTL).
- `lib/embedding-cache.js` defaults to 500 entries / 30 min TTL; config normalization drops user overrides, so defaults are always used.
- Heap usage (~400–600 MiB) is far below RSS (~8 GiB), suggesting native memory growth (LanceDB/Arrow buffers, retained vectors) rather than a pure JS heap leak.

## 5. Code surfaces

- `lib/recall-pipeline.js` — raw LanceDB calls, rerank mapping, fetchLimit, summary fallback.
- `lib/relevant-memory-context.js` — context formatter, no total cap.
- `lib/recall-decision-trace.js` — unbounded decisions/guards/storeDecisions.
- `lib/temporal-filter.js` — raw `dbTable.vectorSearch`.
- `lib/memory-graph.js` — raw concurrent `vectorSearch`.
- `index.js` — passes raw `db.table` to recall, `purgeExpired` hot-path throttle, config.
- `lib/runtime-scheduler.js` — soft worker timeouts.
- `lib/bounded-cache.js` / `lib/embedding-cache.js` — retention.
- `lib/providers/reranker-cohere.js` / `reranker-chained.js` / `reranker-local-transformers.js` — reranker result shapes.

## 6. Proposed minimal fixes

### 6.1 Rerank safety (lib/recall-pipeline.js)
- Guard summary/text fallback: use `(r.entry.text || "")` so missing text never becomes `"undefined"`.
- Validate reranker results: filter `reranked` for objects with integer `index` in bounds before mapping to `boosted`.
- On validation failure or timeout, fall back to `boosted.slice(0, topN)` and record a trace guard/reason.

### 6.2 Context caps (lib/relevant-memory-context.js + lib/recall-decision-trace.js)
- Add `maxTotalChars` (default 12_000) to `formatRelevantMemoriesContext`; truncate final XML with a marker if exceeded, preserving the operational warning block.
- Cap `trace.decisions`, `trace.guards`, and `trace.storeDecisions` in `lib/recall-decision-trace.js` (mirror the existing `candidates` cap).
- Use Map lookup in `lib/relevant-memory-context.js` for `resolveMemoryTrace` instead of O(n×m) `.find()`.

### 6.3 LanceDB operation timeouts (lib/recall-pipeline.js, lib/temporal-filter.js, lib/memory-graph.js)
- Import `withTimeout` from `./with-timeout.js` and use `LANCEDB_READ_TIMEOUT_MS = 10_000`.
- Wrap all raw `dbTable.vectorSearch(...).toArray()` and `dbTable.query(...).toArray()` calls inside the recall pipeline, temporal filter, and memory graph.
- Wrap per-candidate embedding in `computeQueryRelevance` with a short timeout.
- On timeout, return empty/fallback for that stage rather than letting the 45 s worker timeout fire.

### 6.4 Purge throttling (index.js)
- Add a lightweight per-DB in-memory throttle so `purgeExpired()` runs at most once per 5 min per agent DB on the hot path.
- Keep the existing non-blocking fire-and-forget behavior; just skip if already run recently.

### 6.5 Memory-pressure / cache mitigation
- Lower `embedding-cache.js` defaults to 128 entries / 5 min TTL and cap cache-key length.
- Pass `embeddingCacheEnabled`, `embeddingCacheMaxEntries`, `embeddingCacheTtlMs` through config normalization so live config is respected.
- Add an optional idle TTL to `bounded-cache.js` so LanceDB handles are closed after inactivity.

## 7. Test plan

- Add tests in `tests/recall-pipeline-timeout.test.js`:
  - `vectorSearch` hangs → returns empty with timeout reason, no worker timeout.
  - reranker returns malformed result → falls back safely, no TypeError.
  - missing text/summary → does not produce `"undefined"` rerank doc.
- Add tests in `tests/relevant-memory-context.test.js`:
  - huge memory list does not exceed configured char budget.
  - operational warning preserved under truncation.
  - stale operational marker preserved.
- Add tests in `tests/recall-decision-trace.test.js`:
  - decisions/guards/storeDecisions are capped.
- Add tests in `tests/db-adapter-purge-throttle.test.js`:
  - concurrent `purgeExpired` calls coalesce.
- Run existing `npm test` to ensure no regression.
- Run `npm run lint` and `npm audit --audit-level=moderate`.

## 8. Production rollout plan

1. Merge PR to `main`.
2. Sync `/root` to `origin/main`.
3. Run `npm run lint && npm test && npm audit --audit-level=moderate`.
4. Sync live extension via `git archive HEAD` or `scripts/verify-plugin-deploy.mjs --repair`.
5. Restart `openclaw-gateway.service`.
6. Read-only verify logs for timeout counts and memory pressure.

## 9. Vector / DB invariance statement

- Embedding model: unchanged.
- Vector dimensions: unchanged.
- LanceDB schema: unchanged (no `addColumns` / table schema changes).
- No migrations; no re-embedding.
- No deploy/protect/update script changes.
- No cronjob/service topology changes.
- No deletion of existing memory records.

## 10. Risks

- Wrapping LanceDB calls with `withTimeout` will turn slow operations into explicit failures; callers must handle empty recall gracefully. The existing fallback paths already handle missing memory context.
- Lowering embedding-cache defaults may increase embedding API calls. Monitor quota/rate limits.
- `purgeExpired` throttling means expired rows may persist up to 5 min longer on the hot path; this is acceptable for non-critical expiration.
- If LanceDB itself is corrupt or the table is extremely large, these code fixes may not fully eliminate timeouts; further native-memory investigation may be needed.
