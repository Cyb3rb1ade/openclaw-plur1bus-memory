# P6 Runtime Memory Pressure / Timeout Stabilization Followup

## 1. Summary

Implemented runtime stabilization fixes for the memory plugin after #58 went live on `vmd190201`. The work is contained in branch `fix/runtime-memory-pressure-timeout-stability-2026-06-17`.

## 2. Production evidence that motivated the changes

- Post-#58 gateway restart at 02:33:35 CEST dropped RSS from ~8.2 GiB to ~2.0 GiB, but timeout symptoms persisted at a lower rate:
  - 5× `MemoryDB.vectorSearchActive timed out`
  - 1× `recall worker timed out`
  - 1× `rerank failed`
  - 2× `memory pressure`
- Full 2h window before restart showed:
  - 190× `MemoryDB.store timed out`
  - 117× `MemoryDB.search.countRows timed out`
  - 37× `MemoryDB.vectorSearchActive timed out`
  - 23× `recall worker timed out`
  - 32× `Cannot read properties of undefined (reading 'summary')`
  - 44× critical memory pressure
  - 2× Bernhardine context overflow / prompt too large

## 3. Files changed

### Production code
- `index.js` — `purgeExpired` hot-path throttle (max once per 5 min per DB).
- `lib/recall-pipeline.js` — LanceDB read timeouts, `fetchLimit` ceiling, rerank result validation, missing-text guard.
- `lib/relevant-memory-context.js` — hard `maxTotalChars` output cap, Map-based trace lookup.
- `lib/recall-decision-trace.js` — caps on `decisions`, `guards`, and `storeDecisions`.
- `lib/temporal-filter.js` — LanceDB read timeout on anchor vector search.
- `lib/memory-graph.js` — LanceDB read timeout on semantic edge discovery.
- `lib/embedding-cache.js` — lower defaults (128 entries / 5 min TTL), capped cache-key length.
- `lib/bounded-cache.js` — optional idle-TTL eviction.
- `lib/providers/config-normalize.js` — pass through `embeddingCacheEnabled`, `embeddingCacheMaxEntries`, `embeddingCacheTtlMs`.
- `openclaw.plugin.json` — updated schema defaults to match code defaults.

### Tests
- `tests/recall-pipeline-timeout.test.js` (new)
- `tests/relevant-memory-context.test.js`
- `tests/recall-decision-trace.test.js`
- `tests/db-adapter-purge-throttle.test.js` (new)
- `tests/temporal-filter.test.js` (new)
- `tests/memory-graph-edges.test.js`
- `tests/embedding-cache.test.js`
- `tests/bounded-cache.test.js` (new)
- `tests/config-audit.test.js`

## 4. Fixes implemented

### A. Rerank timeout / summary TypeError (`lib/recall-pipeline.js`)
- Rerank doc construction now uses `(r.entry.text || "")` so missing text never becomes the literal string `"undefined"`.
- Reranker results are validated before indexing: only objects with integer `index` in bounds are used.
- On timeout, malformed result, or out-of-bounds index, the pipeline falls back to `boosted.slice(0, topN)` and records a `rerank` guard with `passed=false`.

### B. Context overflow (`lib/relevant-memory-context.js`, `lib/recall-decision-trace.js`)
- `formatRelevantMemoriesContext` now has a `maxTotalChars` cap (default 12,000) and truncates the final XML with a visible marker, preserving the `<operational-memory-warning>` block.
- `recall-decision-trace.js` caps `decisions` (200), `guards` (200), and `storeDecisions` (100), mirroring the existing `candidates` cap.
- `resolveMemoryTrace` builds Maps for candidates/decisions once, eliminating O(n×m) lookup cost.

### C. MemoryDB / LanceDB timeout pressure (`lib/recall-pipeline.js`, `lib/temporal-filter.js`, `lib/memory-graph.js`, `index.js`)
- Raw LanceDB `vectorSearch`/`query` calls in the recall pipeline, temporal filter, and memory graph are now wrapped with `withTimeout(10_000)`.
- Per-candidate embedding in `computeQueryRelevance` is wrapped with a 5 s timeout; timeout returns score 0.
- `fetchLimit` is capped to an absolute maximum of 100.
- `purgeExpired()` on the hot `before_prompt_build` path is throttled to once per 5 minutes per DB.

### D. Memory pressure / cache retention (`lib/embedding-cache.js`, `lib/bounded-cache.js`, `lib/providers/config-normalize.js`)
- Embedding cache defaults lowered from 500 entries / 30 min to 128 entries / 5 min.
- Cache keys truncate the query portion to 256 chars.
- `bounded-cache.js` supports optional `maxIdleMs` eviction.
- Config normalization now passes through user-configured embedding-cache settings.

## 5. Fixes intentionally deferred

- No changes to the embedding model, vector dimensions, or LanceDB schema.
- No DB migrations or re-embedding.
- No deletion of existing memory records.
- No changes to deploy/protect/update scripts or cronjobs.
- No automatic production deploy.
- Native memory growth (RSS >> heap) remains a watch item; if RSS climbs back toward 8 GiB, a deeper investigation of LanceDB/Arrow native buffers and table-handle lifecycle will be needed.

## 6. Tests

- `npm run lint` ✅
- `npm test` ✅ 1594 tests, 0 failures
- `npm audit --audit-level=moderate` ✅ 0 vulnerabilities
- `git diff --check` ✅ no whitespace errors

## 7. Operational guidance

- After merge/deploy, monitor `journalctl --user -u openclaw-gateway.service` for:
  - `MemoryDB.* timed out` counts
  - `recall worker timed out` / `capture worker timed out`
  - `memory pressure: level=critical`
  - `Context overflow: prompt too large`
- The `purgeExpired` throttle means expired rows may persist up to 5 minutes longer on the hot path; this is acceptable for the current expiration semantics.
- If embedding API quota usage rises due to smaller cache, adjust `embeddingCacheMaxEntries` / `embeddingCacheTtlMs` in OpenClaw config.

## 8. Rollback plan

1. Revert the PR or reset `/root` to the previous `main` commit.
2. Sync the live extension via `scripts/verify-plugin-deploy.mjs --repair` or `git archive HEAD`.
3. Restart `openclaw-gateway.service`.
4. Verify logs read-only.

## 9. Vector / DB invariance

- Embedding model: unchanged.
- Vector dimensions: unchanged.
- LanceDB schema: unchanged.
- No migrations; no re-embedding.
- No deploy/protect/update script changes.
- No cronjob/service topology changes.
- No deletion of existing memory records.

## 10. Remaining risks

- If LanceDB tables are very large or files are fragmented, operation-level timeouts will cause empty recall results for that stage. The plugin already handles missing memory context gracefully, but recall quality may degrade until the DB responds.
- Native memory growth was not fully explained; if RSS resumes climbing, further work is needed.
- The `protect-plur1bus-deploy.sh` guard expects `scripts/cleanup-stores.mjs` to exist; that file is still missing. The current changes do not address this latent drift trigger.

## 11. PR recommendation

Create a PR from `fix/runtime-memory-pressure-timeout-stability-2026-06-17` to `main`, review the diff, run CI, and merge. Do not deploy automatically; follow the manual rollout steps in the plan document.
