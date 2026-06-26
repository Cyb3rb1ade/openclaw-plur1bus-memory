# PLUR1BUS Performance Audit - main

Date: 2026-06-25
Scope: current `main` only, no release-readiness gate
Head: `3200573`
Package: `@cyb3rb1ade/plur1bus-memory` v6.7.8

## Baseline

- `git branch --show-current`: `main`
- `npm run lint`: pass
- Focused performance/timeout suite: 133 tests, 133 pass, 0 fail, 12.15 s
- Full `npm test`: 1905 tests, 1905 pass, 0 fail, 31.97 s
- Note: the first sandboxed `npm test` run failed in `tests/p1-robustness.test.js` because the sandbox blocked `listen 127.0.0.1` with `EPERM`. The same command passed outside the sandbox.

## Remediation Status

Applied on 2026-06-25 on `main`:

- Persistent embedding-cache handles are now scoped per resolved DB path, with a regression for two agent scopes in one cache instance.
- Local transformer embedding and reranking now try real batch calls and fall back to single-item calls when the pipeline does not support batching.
- `scripts/auto-capture-lancedb.mjs` now imports the plugin provider factory/config and uses `embedBatch()` for capture candidates.
- `MemoryDB.scanActive()` is backed by `scanActiveBatches()`, and GC plus semantic discovery use chunked scans.
- Targeted overlay loads stream/filter JSONL instead of materializing all overlays first.
- Bounded cache eviction no longer sorts the whole cache on each insert.
- Long-running jobs now pass explicit stale-lock horizons instead of relying on the 10 minute global default.

Verification after remediation:

- `npm run lint`: pass
- Focused remediation suite: 154 tests, 154 pass, 0 fail
- Full `npm test`: 1917 tests, 1917 pass, 0 fail, 31.82 s

Additional follow-up applied on 2026-06-25 on `fix/plur1bus-performance-audit`:

- `atomicJsonUpdate()` now uses `fs/promises` behind the existing per-file queue, with a static regression guard against sync filesystem calls and a stronger parallel-update assertion.
- `scripts/auto-capture-lancedb.mjs` now streams complete JSONL lines from the last byte offset instead of reading whole session files, leaves partial trailing records for the next run, and batches LanceDB inserts after duplicate checks with per-row fallback on batch failure.

Verification after follow-up:

- Initial follow-up focused suite before ANN-specific tests: 21 tests, 21 pass, 0 fail
- `node --test tests/*.test.js`: 1797 tests, 1797 pass, 0 fail, 31.87 s

Additional ANN follow-up applied on 2026-06-26 on `fix/plur1bus-performance-audit`:

- `scripts/auto-capture-lancedb.mjs` now uses LanceDB multi-query ANN duplicate checks via `addQueryVector()` and maps results by `query_index` before batch insert.
- The legacy cron path now also deduplicates candidates within the same new capture batch before `table.add(rowsToAdd)`.

Verification after ANN follow-up:

- `node --test tests/auto-capture-import.test.js tests/auto-capture-batch.test.js tests/p2-performance.test.js`: 23 tests, 23 pass, 0 fail
- `npm run lint`: pass
- `node --test tests/*.test.js`: 1799 tests, 1799 pass, 0 fail, 31.88 s

## What Is Solid Now

- P7/P8 runtime hardening is present on `main`: recall concurrency defaults to 1, background queues are bounded, pressure gating is enabled, recall timeout logs carry phase and event-loop-lag context, and soft-budget fallback exists.
- The previous critical local-embedding-cache gap is closed for `LocalTransformersEmbeddingProvider`; it now uses `createEmbeddingCache`.
- Graph traversal/index tests remain healthy. The local benchmark suite reports 10k-edge graph indexing under the 100 ms budget and indexed lookup much faster than array scanning.
- Metrics writes are no longer a normal recall hot-path problem because `metrics-debounce` batches them; direct `atomicJsonUpdate` is still disk-bound but no longer uses synchronous filesystem calls.

## Findings

### P1 - Persistent embedding cache reuses the first agent DB file

Evidence:

- `lib/embedding-cache.js` keeps one `db` and one `dbPath` per cache instance.
- `_ensureDb()` returns the already-open `db` before resolving the current call's scope path.
- A local probe wrote cache rows for `agent-a` and `agent-b`; only `agent-a.db`, `agent-a.db-shm`, and `agent-a.db-wal` were created.

Impact:

- In-memory keys still include `scopeId`, so this is not a key collision.
- Persistent file isolation and per-agent byte accounting are wrong after the first persisted scope wins the connection.
- Long-running multi-agent processes can grow one SQLite file unexpectedly and defeat operational expectations around agent-scoped cache storage.

Recommendation:

- Track SQLite handles by resolved DB path, e.g. `Map<dbPath, DatabaseSync>`, or intentionally use one shared DB and rename the config/docs accordingly.
- Add a regression test that writes two agent scopes through the same cache instance and asserts two DB files when `scope: "agent"`.

### P1 - Local transformer embedding and reranker miss real batch execution

Evidence:

- `lib/providers/embedding-local-transformers.js` exposes `embedBatch`, but `_computeBatch()` loops over each text and awaits the extractor one at a time.
- `lib/providers/reranker-local-transformers.js` loops over documents and awaits `_scorePair()` one at a time.
- Probe with a fake 5 ms model call over 10 items: embedding batch was 57.3 ms, rerank was 57.0 ms, which is linear per item rather than one batch.

Impact:

- The local model path pays one forward pass per candidate/cache miss.
- This hits capture batches, KNOWLEDGE.md re-embedding, and local reranking hardest.
- The existing 5 s reranker budget can still be consumed by local rerank when candidate count grows or CPU is busy.

Recommendation:

- Use array/batch input for the transformers pipeline where supported.
- If a model does not support batching, add a small concurrency limit and mark local rerank as latency-expensive in status/setup text.
- Add performance tests that prove 10-item local embedding/rerank does not scale as 10 sequential awaits when the backend supports batch input.

### P1 - Legacy cron auto-capture path remains sequential and cache-bypassing

Evidence:

- `scripts/auto-capture-lancedb.mjs` defines its own OpenAI-only `createEmbeddings()` with only `embed(text)`.
- In `captureAgent()`, up to 50 candidates are processed with sequential `embed -> table.search -> table.add`.
- The script still reads changed session file slices with `readFileSync(file.path, "utf8")` before slicing by offset.

Impact:

- If this script is still deployed, it does not benefit from the provider factory, embedding cache v2, OpenAI batch embeddings, or local-provider config.
- A 50-item cron batch can mean 50 embedding calls, 50 vector searches, and 50 inserts.

Recommendation:

- Either retire this script if `index.js`/gateway capture is authoritative, or port it to the provider factory and `embedBatch`.
- Stream from the last offset instead of reading whole files, and batch duplicate checks/inserts where LanceDB allows it.

### P2 - `scanActive()` is still an unbounded full-table materialization

Evidence:

- `MemoryDB.scanActive()` runs `.query().where(...).toArray()` without limit or cursor.
- It is used by GC, shared-memory fallback, REM-dream semantic discovery, and manual semantic-link discovery.

Impact:

- Large agent DBs are loaded into JS memory at once.
- Background jobs have timeouts, but they still pay peak memory and event-loop pressure before timing out.

Recommendation:

- Add a chunked `scanActiveBatches({ fields, batchSize, statusFilter })` API.
- Convert GC and semantic discovery first, because they are explicitly batch-style jobs.

### P2 - Overlay recall lookup parses the whole JSONL file for targeted IDs

Evidence:

- `InterpretationOverlayStore.loadAllOverlays(memoryIds)` calls `_loadRaw()` first.
- `_loadRaw()` reads and parses the complete `interpretation-overlays.jsonl`.
- Probe with 50k overlay rows: loading one target took 29.2 ms and loading all took 27.1 ms, because both parse the full file.

Impact:

- Fine at small scale, but targeted recall pays O(total overlays), not O(target memories).
- This gets visible once overlays become long-lived conversation history.

Recommendation:

- Maintain a compact target-memory index or stream/filter line by line without materializing all rows.
- Keep full-file loading for audit commands only.

### P3 - `makeBoundedCache()` eviction sorts the full map

Evidence:

- `lib/bounded-cache.js` builds `entries = [...map.entries()]` and sorts on each eviction.
- Probe results: max 5k / 10k sets = 511.5 ms; max 10k / 20k sets = 2092 ms.

Impact:

- Current defaults are modest, so this is not urgent.
- High churn plus high cache limits can create avoidable CPU spikes.

Recommendation:

- Use Map insertion order or a linked-list LRU instead of sorting the entire map on every eviction.

### P3 - Job locks still use a 10 minute stale default

Evidence:

- `lib/job-lock.js` has `DEFAULT_STALE_MS = 10 * 60 * 1000`.
- Long-running jobs such as daily consolidation, skill-miner, reminder dispatch, and REM dreaming call `acquireJobLock()` without per-job stale overrides.

Impact:

- A legitimate job running longer than 10 minutes can have its lock treated as stale by another invocation.

Recommendation:

- Pass per-job `staleMs` values aligned with each job's timeout or expected max runtime.

### P3 - `atomicJsonUpdate()` still uses synchronous file I/O

Evidence:

- `lib/atomic-json.js` uses `readFileSync`, `writeFileSync`, and `renameSync`.
- Probe: 100 direct `atomicJsonUpdate` writes cost about 26-34 ms, while 100 metrics `accumulate()` calls stay under 2 ms in tests.

Impact:

- Mostly acceptable now because metrics are debounced.
- Still worth changing before putting this helper back on a request hot path.

Recommendation:

- Convert to `fs/promises` behind the existing per-file queue, or keep it explicitly cold-path only.

## Suggested Order

1. Fix persistent embedding-cache DB handle scoping and add the missing per-agent persistence regression.
2. Batch local transformer embedding and reranking, or make the local reranker explicitly conservative/low-candidate by default.
3. Decide whether `scripts/auto-capture-lancedb.mjs` is still live; if yes, port it to provider factory + `embedBatch`.
4. Add chunked scan APIs and move GC/semantic discovery off full-table `scanActive()`.
5. Index or stream overlay JSONL for targeted recall.
6. Replace sorted cache eviction and tune job-lock stale times.

## Bottom Line

`main` is substantially healthier than the 2026-06-16 performance audit baseline, and the follow-ups close the remaining direct findings in this audit file. The current watch item is the normal disk-bound cost for explicit atomic JSON writes.
