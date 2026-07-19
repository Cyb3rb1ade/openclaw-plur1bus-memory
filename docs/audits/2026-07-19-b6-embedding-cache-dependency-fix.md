# B6 Embedding Cache and Dependency-Chain Fix Receipt

Date: 2026-07-19
Batch: B6
Branch: `fix/high-mid-b6-embedding-cache`
Fix base: `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2`
Scan bundle: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z`

Outcome:

- BUG-06: fixed for persistent byte accounting/cleanup and explicit zero provider values.
- BUG-08: the embedding-cache half is fixed. Full BUG-08 closure is a joint result with B7 commit `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2` and [its lifecycle receipt](./2026-07-19-b7-lancedb-lifecycle-atomic-updates-fix.md); neither batch alone is claimed as full closure.
- BUG-10: fixed by preserving the persistent row's absolute expiry during memory promotion.
- SEC-10: fixed with a narrow, compatibility-tested `adm-zip@0.6.0` override under the optional Transformers/ONNX Runtime chain. Local Inference remains enabled and operational.
- `index.js`, the same-generation schema-cache follow-up, and the shared aggregate fix report are untouched.

## Patch contract and revalidated paths

The reachable embedding path is:

```text
normalized provider config
  -> OpenAIEmbeddingProvider or LocalTransformersEmbeddingProvider
  -> createEmbeddingCache({ maxEntries, ttlMs, persistence metadata })
  -> memory LRU/absolute TTL lookup
  -> optional SQLite lookup and memory promotion
  -> provider batch computation for misses
  -> memory insert and optional SQLite UPSERT
```

The original BUG-06 persistent-write path measured the existing SQLite database, WAL, and SHM files before an insert but did not account for the serialized incoming row. It then deleted one LRU row at a time while remeasuring files that SQLite had not physically reclaimed, which could empty the table without restoring capacity. The provider constructors separately used `||`, converting schema-valid zero values into defaults.

The original embedding half of BUG-08 put a failed SQLite path in a permanent set. Every later operation on the same cache instance bypassed persistence even after the path was repaired. The volatile cache continued working, making this a silent persistence outage.

The original BUG-10 path read `expires_at` to reject an expired persistent row but returned only its vector. `getMany()` then promoted the vector with `now + ttlMs`, extending an almost-expired row.

The SEC-10 dependency path was:

```text
optional @huggingface/transformers@4.2.0
  -> onnxruntime-node@1.24.3 install/extraction path
  -> adm-zip@0.5.17
  -> advisory-range archive allocation behavior
```

Registry inspection found no released Transformers version beyond 4.2.0 and no released ONNX Runtime version whose manifest had yet moved off `adm-zip ^0.5.x`. Therefore an upstream-chain-only upgrade was not available. The patch uses the narrowest override boundary: only `onnxruntime-node` below `@huggingface/transformers` resolves `adm-zip@0.6.0`; the existing ONNX Web override is unchanged.

The restored contract is:

- serialize and count the incoming vector, optional debug text, key fields, and a conservative row/index metadata allowance before writing;
- never count a rejected or rolled-back row as `persistWrites`;
- delete expired/LRU rows in bounded sets, checkpoint WAL with supported `TRUNCATE` behavior, run incremental vacuum, and stop after 256 removed rows per write;
- preserve at least the newest existing row before a write and protect the just-written timestamp cohort during post-write cleanup;
- atomically restore replaced rows and remove new rows if physical post-write measurement still exceeds the hard limit;
- preserve explicit `0` with nullish configuration fallback;
- carry `expires_at` through persistent lookup and use it unchanged in memory;
- coalesce SQLite opens, close a partially opened handle on failure, retry with bounded exponential backoff (100 ms to 1 s after the immediate recovery retry), and clear failure state after success or `close()`;
- retain Local Inference and prove the patched archive APIs plus real embedding/reranking execution.

## TDD evidence

### Owning baseline before edits

```text
$ node --test tests/embedding-cache.test.js tests/local-transformers-batch.test.js tests/provider-factory.test.js tests/smoke-reranker-pipeline.test.js
tests 4; pass 4; fail 0
```

### Causal RED before production/dependency edits

```text
$ node --test tests/embedding-cache.test.js tests/local-inference-dependency.test.js
tests 2; pass 0; fail 2
```

Direct execution of the cache file produced 40 subtests: 34 positive controls passed and six intended regressions failed. They proved that provider zero values were replaced, persistent promotion restarted TTL, a repaired path stayed poisoned on the same instance, repeated failures had no bounded retry, an oversized entry was written while the seed was erased, and cleanup could not reclaim capacity while retaining the new row. The dependency regression failed because both the lockfile and installed runtime resolved `adm-zip@0.5.17`. There were no fixture, syntax, or unrelated positive-control failures.

### Focused GREEN

```text
$ node --test tests/embedding-cache.test.js tests/embedding-openai-batch.test.js tests/local-transformers-batch.test.js tests/provider-factory.test.js tests/smoke-reranker-pipeline.test.js
tests 5; pass 5; fail 0

$ node --test tests/embedding-cache.test.js
tests 1; pass 1; fail 0
```

The direct cache file now passes all 40 subtests, including the six causal regressions.

### Final owning and optional-provider gate

```text
$ node --test tests/embedding-cache.test.js tests/embedding-openai-batch.test.js tests/local-transformers-batch.test.js tests/local-inference-dependency.test.js tests/provider-factory.test.js tests/chained-reranker-null-fallback.test.js tests/smoke-reranker-pipeline.test.js tests/runtime-reranker-config.test.js
tests 8; pass 8; fail 0; duration_ms 5338.244657
```

This covers cache/provider configuration, local batching and per-item fallback, patched dependency APIs, provider factory wiring, chained-reranker null fallback, reranker pipeline smoke behavior, and runtime reranker configuration.

## Original cache PoCs and bypass review

The audit's preserved `repro-embedding-cache-gaps.mjs` was pointed at this worktree without editing the artifact. Its four cases now report:

```text
pre-insert: beforeBytes 94576; maxBytes 194576; afterBytes 94576;
            persistWrites 1; persistWriteSkipped 1
soft cleanup: rowsAfterCleanup 1; a later persist succeeds;
              persistWrites 2; persistWriteSkipped 1
explicit zero: direct computes 2; provider computes 2; provider cache size 0
failed path: sameRecovered true; freshRecovered true;
             samePersistWrites 1; freshPersistWrites 1
```

The pre-insert case retains only the seed and does not claim the oversized row as written. The cleanup case evicts old content in bounded batches, physically reclaims capacity, retains the new row, and permits a later write. Provider and primitive zero semantics now agree. A repaired path recovers on the same object as well as on the fresh-instance positive control.

Additional bypass probes and regressions established:

- a 200,000-character `persistDebug` value plus vector is included in incoming-byte accounting and cannot bypass the limit through plaintext metadata;
- a deliberately tight post-write limit exercises physical-size rollback: the old row is restored, the new row is absent, size returns to the prior footprint, `persistWrites` remains zero, and `persistWriteSkipped` increments;
- the LRU boundary removes the oldest row, deletes a bounded subset rather than the table, keeps the just-written `newest` row, and ends within the hard bound;
- a persistent row whose expiry is shortened directly in SQLite is first returned as a persistent hit and then expires from memory at that exact absolute timestamp;
- the first transient open fails with a warning, the repaired same-instance retry succeeds, repeated failures enter bounded backoff, and a later retry is attempted;
- both OpenAI and Local Transformers providers preserve `cacheMaxEntries: 0` and `cacheTtlMs: 0`;
- optional reranker absence/null behavior remains fail-open through the chained-reranker test; no Local Inference feature gate or fallback branch changed.

## Dependency and real Local Inference proof

The dependency installation and advisory gate were run from a clean install state:

```text
$ npm ci --ignore-scripts
added 129 packages; audited 130 packages; found 0 vulnerabilities

$ npm ls @huggingface/transformers onnxruntime-node adm-zip --all
@huggingface/transformers@4.2.0
└─ onnxruntime-node@1.24.3
   └─ adm-zip@0.6.0 overridden

$ npm audit --json
vulnerabilities: {}; total 0; high 0; critical 0
```

`tests/local-inference-dependency.test.js` also constructs an `adm-zip@0.6.0` archive and exercises the exact ONNX Runtime-compatible constructor, `getEntry`, `getData`, and `extractEntryTo(entry, target, false, true)` surface.

A real provider-level operation ran on the available supported runtime, Node `v24.15.0`, using the actual Transformers pipelines (not mocks or import-only checks):

```json
{
  "node": "v24.15.0",
  "embedding": {
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384,
    "head": [0.09614725410938263, 0.07666721940040588, 0.014536559581756592]
  },
  "rerank": {
    "model": "Xenova/ms-marco-MiniLM-L-6-v2",
    "ranked": [
      { "index": 0, "relevance_score": 1 },
      { "index": 1, "relevance_score": 1 }
    ]
  }
}
```

The embedding was a finite 384-element vector. The reranker accepted two real query/document pairs and returned two finite, correctly shaped ranked records. These one-label model outputs saturate at `1` through the existing text-classification pipeline, so this proof establishes loading/execution/API compatibility, not score calibration; B6 does not change reranker scoring semantics.

## Syntax, diff, and repository gates

```text
$ npm run lint
exit 0

$ git diff --check
exit 0

$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2589; suites 502; pass 2588; fail 0; cancelled 0; skipped 1; todo 0;
duration_ms 363520.824841
```

The authoritative serial suite was coordinated with B3 and B4: both confirmed that no full suite, dependency install, or model operation was active, held the shared lane, and were notified immediately after B6 released it.

The final callsite review found only the two provider constructors and direct unit/performance consumers of `createEmbeddingCache`. Both provider constructors receive normalized values and now preserve zero. No alternate production persistent-write, persistent-promotion, or SQLite-initialization bypass exists.

## Exact changed files

Production and dependency graph:

- `lib/embedding-cache.js`
- `lib/providers/embedding-local-transformers.js`
- `lib/providers/embedding-openai.js`
- `package.json`
- `package-lock.json`

Tests:

- `tests/embedding-cache.test.js`
- `tests/local-inference-dependency.test.js` (new)

Documentation:

- `docs/audits/2026-07-19-b6-embedding-cache-dependency-fix.md` (this receipt)

## Joint BUG-08 closure

B7 commit `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2` and its receipt prove the `MemoryDB` half: rejected initialization generations clean partial handles/state and permit a fresh generation on the same instance. This B6 receipt proves the embedding half: failed SQLite opens are no longer permanent path poison, partial handles are closed, opens are coalesced, failures warn, and bounded retry permits same-instance recovery.

Only the two receipts together prove complete BUG-08 closure. B6 does not claim that result from its patch alone. The separately documented same-generation `MemoryDB` schema-cache invalidation follow-up remains open and is not part of BUG-08 closure here.

## Remaining uncertainty and explicit non-claims

- The pre-write byte estimate is deliberately conservative but cannot predict SQLite page/WAL allocation exactly. Physical size is therefore measured after the transaction and an overshooting write is restored/removed atomically before metrics are credited.
- Cleanup work is bounded to 256 expired/LRU rows per write. If that bounded work cannot recover enough capacity, persistence skips the incoming rows and leaves volatile caching functional; a later write retries cleanup.
- The newest existing row is preserved during pre-write cleanup. This can prefer availability of one recent row over accepting a new row when a configured limit is below SQLite's irreducible file/SHM footprint.
- SQLite's synchronous API cannot cancel a currently executing open/pragma call. Concurrent callers share that generation; later calls retry after its failure according to the bounded backoff.
- `adm-zip@0.6.0` is a narrow transitive override because no compatibility-proven released upstream chain currently removes the advisory-range version. The exact archive APIs used by ONNX Runtime and real Local Transformers execution pass, but future ONNX/Transformers upgrades should remove the override when their manifests adopt a patched range.
- The real reranker operation proves runtime compatibility but does not alter or validate semantic score calibration for the existing one-label model/pipeline combination.
- No push, merge, Local Inference removal, feature disablement, schema-cache change, `index.js` change, shared aggregate report edit, or destructive memory/database operation was performed.

## Integrity and isolation proof

- The B6 worktree began and remained based on `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2` on `fix/high-mid-b6-embedding-cache` while this receipt was drafted.
- Original `main` remained clean and pinned at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`.
- The package-lock diff is limited to `adm-zip` 0.5.17 -> 0.6.0 metadata; unrelated lockfile normalization was not retained.
- Batch B6 owns every changed file listed above; `index.js`, B3/B4 files, the schema-cache follow-up, and the shared aggregate fix report are absent from the diff.
