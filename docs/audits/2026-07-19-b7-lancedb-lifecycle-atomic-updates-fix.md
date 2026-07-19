# B7 LanceDB Lifecycle and Atomic-Update Fix Receipt

Date: 2026-07-19
Batch: B7
Branch: `fix/high-mid-audit-findings`
Fix base: `fc8134747118b46f15760da3c8c8294098fcdaef`
Scan bundle: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z`

Outcome:

- BUG-08: **MemoryDB half of a joint receipt that remains open until B6**.
- BUG-11: fixed at the supported LanceDB update boundary; legacy replacement double failure is explicit.
- BUG-12: fixed for every reachable in-repository production pool consumer.
- The embedding-cache portion of BUG-08 is untouched and open for B6.
- The same-generation `MemoryDB` schema-cache invalidation follow-up is untouched and open.

## Findings, root causes, and reachable paths

### BUG-08 — rejected `MemoryDB` initialization generation

The original path was:

```text
production DB caller
  -> AgentDbPool caches one MemoryDB instance
  -> MemoryDB.init() assigns initPromise once
  -> connect/table/schema initialization rejects
  -> rejected promise and any partial handles remain on the instance
  -> every later init() returns the same rejection, even after the path recovers
```

The root cause was generation state with no failure cleanup. A rejected `initPromise` was retained forever, partial `table`/`db` handles and cached schema state were not closed/reset, and the pool continued returning the poisoned instance.

### BUG-11 — destructive update fallback and hidden rollback failure

The original `MemoryDB.update()` path queried the row, deleted it, added a replacement, and on failure attempted another `add()` to restore the original. If both adds failed, the restore exception was silently caught and only the replacement error reached the caller. The row could therefore be absent while the caller had no signal that recovery also failed. Metadata, reinforcement, reminder, and versioning-related callers all reached this primitive.

### BUG-12 — lookup-scoped rather than operation-scoped DB references

The original `AgentDbPool.getDb()` incremented a cache refcount only around lookup/create and released it before returning. The caller's asynchronous DB operation therefore ran with a zero refcount. Inserting a 51st agent could evict and shut down the oldest handle while its query or write was still pending. Async and synchronous eviction failures were swallowed, and namespace shutdown discarded child failures.

Reachable raw pool consumers existed in registered model tools, Bridge/Control-Room storage, capture and recall hooks, internal jobs and commands, reminder/status/correction paths, semantic discovery, feedback dynamics, shared memory, wiki commands, and the GC job.

## Restored invariants

### Initialization lifecycle

`MemoryDB.init()` still coalesces concurrent callers into one generation and retains the resolved promise after success. On failure it now closes any table and connection handles, collects cleanup errors without hiding the primary error, clears `table`, `db`, and `schemaFieldNames`, and clears `initPromise` only after cleanup finishes. Lifecycle closes await the raw LanceDB close promises rather than a non-abortable operation timeout, so neither the failed generation nor a retry can settle ahead of the actual close. The instance is not marked shut down, so a repaired environment can start a fresh generation on the same object.

`MemoryDB.shutdown()` now clears both handles and schema/init state, attempts both table and connection close even when one fails, aggregates close failures, and remains idempotent after a failed close. It likewise remains pending until the raw close promises settle; ordinary read/write operation timeouts are unchanged.

### Update atomicity and recovery visibility

`MemoryDB.update()` still validates the UUID and confirms that the row exists. When the installed table exposes LanceDB's supported `table.update({ where, values })`, it:

- filters the patch to fields in the cached current schema;
- excludes immutable `id`;
- normalizes vector-like patch values;
- leaves untouched fields unchanged; and
- propagates an operational `table.update` error without entering delete/add compatibility mode.

Replacement remains only for a table implementation where `update` is genuinely unavailable. The original UUID is forced into the replacement. If replacement fails, one restore is attempted. If restore also fails, the DB path and UUID are logged and an `AggregateError` exposes the replacement and restore errors in causal order. Supported LanceDB never enters this compatibility path.

### Operation-scoped leases and observable shutdown

`AgentDbPool.withDb(agentId, fn)` acquires before lookup/create, awaits the complete callback, releases in `finally`, and tracks the entire operation so shutdown waits for settlement. The bounded cache trims soft overflow when an active entry is released. Sync and async eviction failures are retained with their cache keys and surfaced once, after all pending evictions settle.

`MultiNamespacePool.withWriteDb()`, `withReadDbs()`, and `withDb()` preserve the active write namespace, configured recall namespace order, DB identities, and input agent ID. Read leases are nested and unwind in reverse order on success or rejection. Namespace shutdown is terminal and coalesced: it rejects new child creation and leased work, waits for tracked top-level namespace operations, then closes each captured child exactly once. Agent- and namespace-contextual close failures are logged and aggregated at pool shutdown. Gateway shutdown continues isolating sibling resource cleanup while logging the pool aggregate.

`getDb()`, `getWriteDb()`, and `getReadDbs()` remain compatibility accessors, but no reachable lease-capable production consumer in this repository performs DB work through them.

## Production migration and B2 composition

Every DB-dependent asynchronous operation in `index.js` is inside a lease, including direct `db.table` users. This covers registered recall/store/forget/knowledge tools, Bridge storage, auto-capture, auto-recall, GC maintenance, semantic discovery, reminders, `/correct`, status, and internal consolidation/dream/skill/reminder jobs. Fire-and-forget maintenance starts its own tracked lease and attaches a logged rejection handler.

The remaining library consumers prefer `withDb()` and keep a compatibility fallback for older injected test/external pools: feedback dynamics, shared memory, wiki commands, GC, and semantic-link discovery. `runSemanticDiscoveryBatches()` passes its already leased DB into semantic discovery instead of reacquiring a raw handle.

Both B2 merge sources preserve their identities and durable ordering:

- Bridge/Control-Room uses `storeAgentId` and its derived workspace key.
- The registered model tool uses its original `agentId` and workspace key.
- In both paths the lease spans vector work, candidate lookup, the `withDurableMerge()` queue wait, under-lock revalidation, replacement preparation/store/readback, authoritative archive, original deletion, destructive logging, and the final caller-specific response/trace work.

The final raw-callsite review was:

```text
$ rg -n "\.(getDb|getWriteDb|getReadDbs)\(" index.js lib --glob '*.js'
lib/feedback-log.js:89: compatibility fallback
lib/multi-namespace-pool.js:50,57,63: compatibility accessor definitions
lib/wiki-command.js:307: compatibility fallback
lib/shared-memory.js:32: compatibility fallback
lib/obsidian/semantic-link-discoverer.js:159: compatibility fallback
lib/jobs/gc-job.js:56: compatibility fallback
```

There is no raw lookup/use pair in a lease-capable production path.

## TDD evidence

### Owning baseline before production edits

```text
$ node --test tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/p2-performance.test.js tests/multi-namespace-pool.test.js tests/migration-robustness.test.js tests/smoke-migration.test.js tests/memory-store-merge-archive-first.test.js
tests 7; pass 7; fail 0; duration about 32.6s
```

### Causal RED before production edits

```text
$ node --test tests/memory-db-lifecycle-atomic.test.js tests/agent-db-pool-lease.test.js tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/multi-namespace-pool.test.js
tests 5; pass 0; fail 5
```

Running the files directly exposed 31 subtests: 14 passed and 17 failed for the intended causes. The failures showed a retained rejected `initPromise`, update calls shaped as delete/add rather than in-place update, a swallowed second add/restore error, no `AgentDbPool.withDb`, closure of the first DB while its deferred operation was active, shutdown closing before operation settlement, missing namespace lease APIs, and swallowed sync/async eviction and shutdown errors. Existing positive controls, including concurrent successful init coalescing, passed; there were no syntax or fixture failures.

### Initial focused GREEN

```text
$ node --test tests/memory-db-lifecycle-atomic.test.js tests/agent-db-pool-lease.test.js tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/multi-namespace-pool.test.js
tests 5; pass 5; fail 0; duration_ms 1188.626944
```

Direct execution reports 31/31 subtests passing: MemoryDB 6/6, AgentDbPool 3/3, bounded-cache shutdown 6/6, bounded-cache idle/LRU 5/5, and namespace pool 11/11.

### Task-review causal RED and GREEN

The initial task-spec review found two Important lifecycle gaps. Each was reproduced before its production fix:

```text
$ node tests/multi-namespace-pool.test.js
tests 13; pass 11; fail 2
```

The failures proved that a post-shutdown lease could create a new untracked child and that concurrent shutdown closed an active child before its top-level namespace operation settled. After terminal admission, top-level operation tracking, and coalesced shutdown were added, the same command passed 13/13.

```text
$ node tests/memory-db-lifecycle-atomic.test.js
tests 8; pass 6; fail 2
```

The failures proved that the non-abortable `_write` timeout let failed-init cleanup/retry and shutdown settle while raw close promises were still deferred. After lifecycle close moved to raw settlement, the same command passed 8/8.

Final direct PoCs passed MemoryDB 8/8 (`duration_ms 828.184642`), AgentDbPool 3/3 (`duration_ms 157.127554`), and namespace pool 13/13 (`duration_ms 40.273239`). The final combined focused command passed all five file workers with 0 failures (`duration_ms 2018.150589`), representing 35/35 direct subtests.

### Owning and affected-consumer suites

```text
$ node --test tests/migration-robustness.test.js tests/smoke-migration.test.js tests/store-validation.test.js tests/db-adapter-purge-throttle.test.js tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js tests/p2-performance.test.js
tests 7; pass 7; fail 0; duration_ms 33179.919208

$ node --test tests/feedback-dynamics-vector-normalization.test.js tests/shared-memory-conflict-limit.test.js tests/shared-memory-store-guard.test.js tests/smoke-wiki-command.test.js tests/gc-job-timeout.test.js tests/gc-neverforget-guard.test.js tests/smoke-gc-job.test.js tests/smoke-semantic-link-discoverer.test.js tests/runtime-scheduler-recall-timeout-summary.test.js tests/llm-result-cache-lifecycle.test.js
tests 10; pass 10; fail 0; duration_ms 828.059838

$ node --test tests/auto-capture-batch.test.js tests/auto-capture-import.test.js tests/background-capture-skip.test.js tests/auto-recall-contradiction.test.js tests/auto-recall-decision-trace.test.js tests/background-recall-skip.test.js tests/forget-correct-confirm.test.js tests/smoke-correct-recall.test.js tests/reminder-dispatch.test.js tests/reminder-integration.test.js tests/reminder-nudge.test.js tests/memory-store-merge-safety.test.js tests/recall-e2e.test.js tests/dream-memory-recall.test.js
tests 14; pass 14; fail 0; duration_ms 31622.342465
```

## Original PoCs and positive controls

`node tests/memory-db-lifecycle-atomic.test.js` passed 8/8:

- Invalid parent path: first init failed with the expected not-a-directory error; `initPromise`, `table`, `db`, and `schemaFieldNames` were clear afterward. Repairing the path allowed the same instance to initialize, store, and read. A fresh instance reading the same row was the positive control.
- Concurrent successful callers still produced one initialization generation, and a later call reused the resolved generation.
- Supported LanceDB patch recorded `{ update: 1, delete: 0, add: 0 }`, preserved the UUID, vector, untouched text/category, and ignored an unknown field.
- An injected operational `table.update` failure propagated unchanged with zero delete/add calls.
- With `table.update` unavailable, injected replacement and restore failures produced `AggregateError.errors === [replacementError, restoreError]` and a warning containing the DB path and UUID.
- Injected table and connection close failures both appeared in the shutdown aggregate while all handle/schema/init state was cleared.
- Deferred raw table/connection closes kept failed-init cleanup and a same-generation retry pending until close settlement; only then did both callers receive the original init error and a fresh retry succeed.
- A deferred raw table close kept shutdown pending and `isShutdown` false even when the old `_write` boundary was injected to return an early simulated timeout.

`node tests/agent-db-pool-lease.test.js` passed 3/3:

- The deferred operation for agent 00 remained open while agents 01 through 50 filled the 50-entry cache.
- The same cached agent reused the same DB object; different agents had distinct objects and paths.
- Adding agent 50 did not close agent 00 before settlement. After settlement, adding agent 51 resumed normal LRU eviction and closed agent 00.
- Pool shutdown observed zero close attempts while the lease was blocked, then closed after release and logged the injected failure with agent/namespace context.

`node tests/multi-namespace-pool.test.js` passed 13/13, including post-shutdown rejection, no late child creation, active-operation settlement before child close, concurrent-shutdown coalescing, exact-once child shutdown, configured order, identity, rejection unwind, and contextual aggregation.

## Isolation, feature-gate, and bypass/concurrency review

- Success and rejection both release exactly once through `finally`; bounded-cache release clamps at zero and trims only when the last ref is gone.
- Nested same-agent leases increment independent refs and do not close the shared DB until both callbacks settle. Auto-recall exercises the write-plus-read nesting where the active write namespace also appears in recall order.
- Multiple recall namespaces are acquired in configured order and released in reverse order on success and error.
- Agent and namespace shutdown reject new leases. Namespace shutdown also rejects direct child creation, shares concurrent shutdown work, waits for already tracked top-level operations, and closes each child once. Agent shutdown then attempts every cached close, drains pending eviction work, clears the cache, and aggregates failures.
- A caller-visible scheduler/timeout result does not manually release the lease: the operation promise remains tracked until its underlying DB callback actually settles. Cancellation/admission semantics themselves remain B3 scope.
- B2 queued merges remain under the same lease across predecessor wait and all durable mutation steps. The B2 archive-first regression and cache-scope guard remain green.
- Fire-and-forget GC, interference, and semantic work starts a separate lease and logs rejection; it never captures a raw handle after an outer callback returns.
- Operational `table.update` failure cannot bypass into destructive replacement. Only genuine API absence selects compatibility mode.
- Active write namespace, recall namespace order, agent IDs, workspace IDs/keys, scope/owner ACL fields, and all feature gates are unchanged. No config default or enablement branch changed.

## Syntax, diff, and repository gates

```text
$ node --check index.js
$ node --check lib/jobs/gc-job.js
$ node --check lib/obsidian/semantic-link-discoverer.js
$ node --check lib/multi-namespace-pool.js
all exit 0

$ npm run lint
exit 0

$ git diff --check
exit 0

$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
initial implementation before task-review amendments: tests 2578; suites 502; pass 2577; fail 0; skipped 1; duration_ms 362832.137756
```

Controller final verification against the committed review-fix range:

```text
$ npm run lint
fresh lint and syntax checks: pass

$ node --test tests/memory-db-lifecycle-atomic.test.js tests/agent-db-pool-lease.test.js tests/multi-namespace-pool.test.js
tests 3; pass 3; fail 0; duration_ms 1466.690041

$ git diff --check fc8134747118b46f15760da3c8c8294098fcdaef..B7_HEAD
exit 0

$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2582; suites 502; pass 2581; fail 0; cancelled 0; skipped 1; todo 0; duration_ms 363114.48298
```

The known nested-spawn `EPERM` sandbox artifact did not occur in the final authoritative serial run.

## Independent reviews

- Initial task-spec review: two Important findings, both resolved with causal RED/GREEN evidence above.
- Independent task re-review: **PASS**, with no Critical, Important, or Minor findings.
- Independent final broad code-quality/security review: **APPROVED / PASS**, with no Critical, Important, or Minor findings. It confirmed the documented scope/isolation boundary—B7 remains limited to the `MemoryDB` half of BUG-08 plus BUG-11/BUG-12, with the listed non-scope unchanged—and found B7 ready to stop as-is.
- Controller final verification: **PASS** for fresh lint/syntax, the three-file PoC gate, committed-range diff hygiene, and the authoritative serial suite recorded above.
- B7 remains one implementation commit; reviewer fixes and final evidence are amended into that same commit. No reviewer finding is waived.

## Exact changed files

Production:

- `index.js`
- `lib/bounded-cache.js`
- `lib/multi-namespace-pool.js`
- `lib/feedback-log.js`
- `lib/shared-memory.js`
- `lib/wiki-command.js`
- `lib/jobs/gc-job.js`
- `lib/obsidian/semantic-link-discoverer.js`

Tests:

- `tests/memory-db-lifecycle-atomic.test.js` (new)
- `tests/agent-db-pool-lease.test.js` (new)
- `tests/bounded-cache-shutdown.test.js`
- `tests/bounded-cache.test.js`
- `tests/multi-namespace-pool.test.js`

Documentation:

- `docs/superpowers/plans/2026-07-19-b7-lancedb-lifecycle-atomic-updates.md` (new)
- `docs/audits/2026-07-19-b7-lancedb-lifecycle-atomic-updates-fix.md` (new)
- `docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/fix_report.md`

## Remaining uncertainty and explicit non-claims

- BUG-08 is not globally closed: its embedding-cache half remains open for B6. B7 does not change `lib/embedding-cache.js`.
- The same-generation raw `MemoryDB` schema-cache invalidation issue remains open. B7 filters in-place patches by the current cached schema but adds no refresh/invalidation trigger.
- The legacy no-`table.update` replacement path cannot guarantee row survival when both replacement and restore writes fail. That state is repairable data loss by definition, but it is now explicit, contextual, and causally aggregated. Supported LanceDB uses in-place update and cannot enter it.
- LanceDB timeout promises are not abortable. B7 keeps pool leases until callback settlement, but timeout cancellation/admission and late-write semantics remain B3.
- Lifecycle close deliberately has no operation-timeout escape: a driver close that never settles can keep failed-init cleanup or shutdown pending. This prevents retry/teardown from racing a still-live raw handle; an outer gateway timeout may report the wait, but the underlying lifecycle remains tracked.
- `getDb()` compatibility access remains available to external/legacy callers and cannot protect work performed after it returns. All reachable production consumers in this repository use leases.
- No production lease callback calls `pool.shutdown()`. A callback that awaited shutdown of its own pool would be a re-entrant lifecycle misuse and could self-wait; this unsupported external pattern is not introduced or exercised by repository callsites.
- In-process leases do not serialize independent mutations and are not cross-process DB transactions.
- B3, B6, BUG-13, the embedding cache, and other scan batches are unchanged.

## Integrity and main-checkout proof

- B7 worktree base remained `fc8134747118b46f15760da3c8c8294098fcdaef` on `fix/high-mid-audit-findings` while the receipt was drafted.
- `/root/openclaw-plur1bus-memory` remained clean at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`.
- No push, merge, destructive data operation, B3, B6, BUG-13, or another batch was performed.
