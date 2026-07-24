# B3 Timeout, Admission, and Recall Cache Fix

Date: 2026-07-19
Branch: `fix/high-mid-audit-findings`
Required base: `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2`
Findings: BUG-03, BUG-07, BUG-ADD-03 only

## Integrity and scope

The B3 worktree was clean at the required base before edits. The original main checkout remained clean at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`. B3 did not change namespace routing, same-generation schema caching, read-only recall fallback, unrelated jobs, or feature gates.

## Source-to-sink closure

### BUG-03

The registered `agent_end` hook enters `runtimeScheduler.enqueueCapture()`. Previously, the scheduler released the same-agent slot in the public `Promise.race()` completion path. A timeout therefore decremented `state.active` while `job.fn()` was still running, and `drainCapture()` admitted a second callback for the same agent.

The public result still resolves promptly on timeout, but `state.active` and global active accounting now release only from the underlying callback promise's fulfillment or rejection. The real auto-capture callback checks the scheduler AbortSignal before and after supported preparation, embedding, deduplication, durable-write, speaker, reminder, watermark, and graph phase boundaries. An ignored AbortSignal cannot bypass admission; a supported phase stops before its next side-effect boundary.

Independent task review found two mutation catches inside the real callback that could still fulfill the callback before the raw mutation settled: normal capture storage and reminder storage. Both catches now follow `TimeoutError.settlement` before returning to the callback, including nested settlement errors. The scheduler still returns its timeout result promptly, while a measured same-agent regression keeps the next capture queued and raw mutation `maxActive` at one. The queued capture then completes normally after release.

### BUG-07

Successful recalls previously inserted every agent/session/prompt key into an unbounded module-local `Map`, while expiry was removed only on an exact-key lookup. The scheduler now has configurable `recallCacheMaxEntries` (default 128), opportunistic full expiry sweeps on insert and status, LRU promotion on a live hit, oldest-entry eviction over the hard bound, and absolute expiry that access does not extend. Cached timeout fallback and exclusion of `undefined` values are unchanged.

### BUG-ADD-03

`MemoryDB._write()` calls `withTimeout()` around a raw LanceDB mutation. Previously, the public `TimeoutError` lost the raw mutation's lifecycle, so B2's same-candidate durable-merge queue and B7's agent DB lease unwound while an add/delete remained live.

`TimeoutError` now carries the already-running settlement promise. The existing B7 lease observes that settlement without delaying the public rejection, and the existing B2 queue retains its candidate key through nested late settlement. No second serialization layer was added.

Durable merge derives a deterministic replacement UUID and SHA-256 idempotency key from agent, candidate, workspace, incoming text, effective category/origin/importance/TTL, provenance, scope, and owner. It checks for an existing replacement before store and explicitly rejects a collision. A late successful store resumes replacement verification and original deletion. A late successful delete appends the destructive-operation record with the same idempotency key exactly once in the live continuation.

Independent task review also traced the two direct `memory_forget` delete callers. Both now use the same narrow delete/audit continuation as durable merge: a timeout is rethrown immediately, its settlement retains the B7 lease, and a late successful delete appends one log record with a deterministic SHA-256 operation key. Late-commit and normal positive controls cover both memory-ID and query deletion. The deterministic replacement equivalence check additionally compares stable ownership and provenance (`storedBy`, `workspaceKey`, `scope`, `ownerUserId`, `sourceUrl`, and `evidenceQuote`) before a retry may delete the original.

## Causal TDD evidence

Pre-edit focused baseline:

```text
$ node --test tests/runtime-scheduler-pressure.test.js tests/runtime-scheduler-recall-timeout-summary.test.js tests/with-timeout.test.js tests/memory-store-merge-archive-first.test.js
tests 4; pass 4; fail 0; duration_ms 34037.476826
```

The causal REDs were recorded before their corresponding production edits:

```text
$ node tests/runtime-scheduler-b3.test.js
tests 3; pass 0; fail 3
same-agent starts were [first, second], cache size was 200 instead of 3, and the non-promoted key was not evicted

$ node tests/with-timeout.test.js
tests 6; pass 5; fail 1
TimeoutError.settlement was undefined

$ node tests/agent-db-pool-lease.test.js
tests 4; pass 3; fail 1
shutdown closed the DB before the raw timeout settlement

$ node tests/config-audit.test.js
tests 127; pass 126; fail 1
runtime.recallCacheMaxEntries was absent

$ node tests/auto-capture-batch.test.js
tests 3; pass 2; fail 1
the late embed path reached MemoryDB.store once instead of zero times

$ node --test-name-pattern='timed-out replacement store|timed-out delete' tests/memory-store-merge-archive-first.test.js
tests 2; pass 0; fail 2
the retry entered a second replacement write, and a late delete lost the required completion behavior
```

Self-review found that the initial deterministic key omitted provenance and retention inputs. Its amendment RED proved two different inputs reused the same UUID:

```text
$ node tests/memory-store-merge-archive-first.test.js
tests 8; pass 7; fail 1
actual and expected replacement IDs were both 923facd7-b82d-5c46-a58b-be48dddd0cc5
```

After adding the missing inputs, the same direct file passed 8/8 (`duration_ms 33149.374964`). Earlier focused GREEN evidence passed the scheduler 3/3, timeout primitive 6/6, config 127/127, DB lease 4/4, auto-capture 3/3, and both deferred merge cases 2/2. The combined nine-file focused gate passed 9/9 file workers (`duration_ms 33462.65748`).

Independent task-review regressions were developed as a separate strict-TDD fix wave. The capture/reminder and direct-forget negative tests were already causally red before their production edits. The provenance regression was corrected to inject a mismatched persisted-row shape at the real `MemoryDB.getById()` equivalence boundary; against the pre-fix predicate it returned an unsafe successful merge (tests 1, pass 0, fail 1; `duration_ms 30924.760658`). After the ownership/provenance comparison, that same test passed (tests 1, pass 1, fail 0; `duration_ms 30868.995096`).

The three-file task-review gate passed all three workers (`duration_ms 35851.375218`): `tests/auto-capture-batch.test.js`, `tests/memory-forget-late-delete.test.js`, and `tests/memory-store-merge-archive-first.test.js`. A 21-file covering owning gate passed 21/21 with no failures (`duration_ms 35414.594434`), including scheduler, timeout, DB lease/namespace, capture, reminder, forget/auth, durable-merge/store, bridge, config, and cache consumers.

The initial owning gate passed 19/19 file workers with no failures (`duration_ms 33587.901413`). It covered scheduler pressure/summary, timeout and DB adapter behavior, B7 leases/namespaces, real capture, B2 merge safety/dedup/validation/trace, cache integration, bridge/Obsidian consumers, and config. Final owning and serial evidence is recorded below after the amendment.

## Bypass, alternate-input, concurrency, and isolation review

- Both production merge entry points call the single B2 `withDurableMerge()` boundary and supply the complete deterministic input key.
- The existing queue key remains agent plus candidate; the replacement identity additionally includes workspace and all material caller inputs. A candidate cannot mix data across agents or workspaces.
- A second request may select a candidate while the first raw write is live, but it cannot enter B2 revalidation or mutation until the first mutation and continuation settle.
- Late store continuation can reach a nested delete timeout; settlement tracking follows nested `TimeoutError.settlement` promises before releasing the queue and B7 lease.
- Read-only timeout fallback remains prompt and is not serialized behind mutation settlement.
- Repository raw DB accessors remain compatibility surfaces; the in-repository production consumers identified by review use B7 leased wrappers. B3 did not remove compatibility APIs.
- LRU hits preserve the original absolute expiry. High-cardinality agent/session/prompt shapes are swept and bounded.
- Same-agent capture remains FIFO and capped even if the callback ignores abort; successful capture after a timed-out predecessor remains functional.

## Changed files

Production:

- `index.js`
- `lib/runtime-scheduler.js`
- `lib/with-timeout.js`
- `openclaw.plugin.json`

Tests:

- `tests/runtime-scheduler-b3.test.js`
- `tests/with-timeout.test.js`
- `tests/agent-db-pool-lease.test.js`
- `tests/auto-capture-batch.test.js`
- `tests/config-audit.test.js`
- `tests/memory-store-merge-archive-first.test.js`
- `tests/memory-forget-late-delete.test.js`

Documentation:

- this receipt
- `docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/fix_report.md`

## Final gates

Post-amendment verification:

```text
$ node tests/runtime-scheduler-b3.test.js
tests 3; pass 3; fail 0; duration_ms 270.50136

$ node tests/with-timeout.test.js
tests 6; pass 6; fail 0; duration_ms 227.741459

$ node tests/agent-db-pool-lease.test.js
tests 4; pass 4; fail 0; duration_ms 174.833272

$ node tests/auto-capture-batch.test.js
tests 3; pass 3; fail 0; duration_ms 1147.823501

$ node tests/memory-store-merge-archive-first.test.js
tests 8; pass 8; fail 0; duration_ms 33794.250003

$ node --test <nine focused B3/owner files>
tests 9; pass 9; fail 0; duration_ms 34194.281414

$ node --test <nineteen owning files>
tests 19; pass 19; fail 0; duration_ms 34115.249535

$ node --check index.js
$ node --check lib/runtime-scheduler.js
$ node --check lib/with-timeout.js
$ npm run lint
$ git diff --check
all exit 0

$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2592; suites 503; pass 2591; fail 0; cancelled 0; skipped 1; todo 0; duration_ms 360090.901414
```

The skipped workspace-writer permission case is the repository's existing environment-dependent skip. `tests/setup-feature-crons-symlink.test.js` passed inside the authoritative run, so no isolated EPERM fallback was required. The original main checkout remained clean and fixed at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`. No push or merge occurred. The original receipt shipped in the initial focused B3 commit; the independent-review evidence below belongs to its focused follow-up fix wave.

Independent task-review post-fix gates (run after the original commit's authoritative serial evidence):

```text
$ node --test tests/auto-capture-batch.test.js tests/memory-forget-late-delete.test.js tests/memory-store-merge-archive-first.test.js
file workers 3; pass 3; fail 0; duration_ms 35851.375218

$ node --test <21 covering B3 review-wave owning files>
file workers 21; pass 21; fail 0; duration_ms 35414.594434
```

Fresh authoritative serial verification on the final post-review B3 code:

```text
$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2599; suites 504; pass 2598; fail 0; cancelled 0; skipped 1; todo 0
duration_ms 378428.7499
exit 0
```

This run includes the independent-review fixes and therefore supersedes the
earlier pre-review serial result as B3's completion gate. The runner summary
reports exactly one skip, but the retained streamed output does not identify
which test was skipped or expose the symlink-test result line. No isolated
fallback was invoked. The suite emitted LanceDB diagnostic messages and the
speaker-mapping fallback warning, but no test failed.

## Remaining uncertainty and non-claims

- A raw driver mutation that never settles intentionally retains its queue slot and DB lease indefinitely. This trades liveness for the required no-overlap safety; LanceDB does not expose mutation cancellation here.
- The continuation and exactly-once guard are in-process. A process crash after a late delete commits but before its synchronous audit append can still leave an audit gap; the existing audit helper makes write failure visible but deliberately does not block the memory operation.
- Deterministic SHA-256 UUID collision is cryptographically negligible; an observed row mismatch is rejected instead of overwritten.
- Compatibility callers that bypass B7 leases can inspect `TimeoutError.settlement`, but B3 does not add a new global queue for them.
- Same-generation schema-cache refresh/invalidation is untouched.
