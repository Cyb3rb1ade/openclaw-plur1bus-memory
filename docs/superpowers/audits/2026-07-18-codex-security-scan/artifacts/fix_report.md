# Fix Report — BUG-01 Registered Forget/Correct Initiation

Date: 2026-07-19
Scan bundle: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z`
Outcome: **fixed**

## Finding and broken path

The reliability audit reported BUG-01 as high severity: registered `/forget` and `/correct` initiation always failed with `summarizer is not defined`.

The concrete path was:

```text
plugin.register(api)
  -> registered forget/correct handler (or /plur1bus alias)
  -> authorized initiation
  -> normalizeCommandInput(..., summarizer, ...)
  -> ReferenceError before resolveCandidates/createConfirmation
  -> localized failed response
```

`runMemoryCommand` worked because it declared an agent-scoped summarizer locally. The two destructive handlers referenced that name outside its lexical scope.

## Fix and invariant

Each affected handler now creates:

```js
const summarizer = makeQuerySummarizer(mergingLlmCfg, api.logger, agentId);
```

immediately after resolving its invocation-specific `agentId`. This is the narrowest repository-native fix: two production lines, no public interface change, and no movement of length validation, authorization, confirmation, candidate selection, archive, correction, registration, or alias logic.

Invariant restored: every registered memory-query normalization path receives an agent-scoped `Function|null` summarizer before initiation normalizes input.

## Proof

### RED

Before changing `index.js`, the real-plugin regression produced:

```text
tests 3; pass 1; fail 2
/memory passed
/forget: ❌ /forget failed: summarizer is not defined
/correct: ❌ /correct failed: summarizer is not defined
```

The fixture used real plugin registration, the real `memory_store` factory, real temporary LanceDB state, and patched only the optional local embedding-model boundary.

### GREEN and original trigger

- `node --test tests/command-reachability.test.js` — exit 0.
- `node tests/command-reachability.test.js` — 3/3 tests passed.
- `node --test --test-name-pattern='registered /forget|registered /correct' tests/command-reachability.test.js` — exit 0; both formerly broken initiations reached confirmation without the ReferenceError.
- Owning command/input suite — 5/5 files passed, including real registered correct owner-confirm, archive verification, corrected recall, and the existing helper control.

### Bypass and preservation review

- Top-level commands and `/plur1bus*` aliases converge on the same fixed handlers.
- Both callsites pass the invocation's `agentId`; the deterministic cache guard now recognizes all five exact scoped callsites and passes.
- Confirm branches do not invoke query normalization or the summarizer.
- Unauthorized forget remains denied before candidate lookup.
- Wrong-user tokens remain rejected with `security.wrong_user`.
- Oversized input remains rejected before normalization (`p1-robustness` plus Telegram smoke: 2/2 files passed).
- `/memory` positive control still recalls a seeded memory.
- Forget still archives before deletion. Correct is now proven through a fresh real registered handler from initiation through owner-confirm, archive creation, and corrected recall; helper coverage remains an additional control.

## Repository gates

- `npm run lint` — exit 0 after final changes.
- First serial run identified only a stale deterministic callsite-count guard (`5 !== 3`); this was retained as RED evidence and minimally updated to 5.
- `node --test tests/llm-result-cache-integration.test.js` — exit 0 after that guard update.
- Sandboxed `node --test --test-concurrency=1 tests/*.test.js test/*.test.js` diagnostic — 259 files passed; only the known nested-spawn `setup-feature-crons-symlink.test.js` file-level harness artifact failed.
- Required direct control `node --test tests/setup-feature-crons-symlink.test.js` — 1/1 passed, exit 0.
- Authoritative outside-sandbox `node --test --test-concurrency=1 tests/*.test.js test/*.test.js` — 2,556 tests; 2,555 passed; 0 failed; 1 skipped; exit 0.

## Changed files

- `index.js`
- `tests/command-reachability.test.js`
- `tests/llm-result-cache-integration.test.js`
- `docs/superpowers/plans/2026-07-19-b1-command-reachability.md`
- `docs/audits/2026-07-19-bug-01-command-reachability-fix.md`

## Test-harness adjustments and remaining uncertainty

During GREEN, the planned forget assertion was corrected to tolerate the expected query echo in the semantic not-found response. Review then required the real correct owner-confirm proof. Adding those assertions to the original single-generation fixture produced the focused RED: 2/3 tests passed, Lance reported `Column 'remindAt' is declared as non-nullable but contains null values`, and the handler returned an internal update error.

Tracing showed that the first raw `MemoryDB` had cached the create-table schema before the adapter added reminder columns. The final test uses a product-realistic migrated lifecycle without a production hook: one real API generation seeds the row and runs registered `/memory` to migrate the table, shuts down its adapter and pool, then a fresh API/pool generation on the same path performs correct initiation, wrong-user rejection, owner-confirm, archive verification, and corrected recall. The fresh `MemoryDB.init()` observes the complete schema and preserves all non-null defaults. The focused test then passed 3/3.

The separate same-generation raw-schema-cache problem remains unresolved and requires its own scope; B1 changes no DB production code and does not claim to fix it.

The sandbox-only nested-spawn symlink artifact remains environment-specific and unrelated to B1; its direct test and the authoritative outside-sandbox serial suite both pass.

## Integrity

- Fix base: `1735d8e625d9582e39ef9d04c43052d442bba703`.
- Main checkout remained unchanged at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`.
- No B2 work was included.

---

# B2 Fix Report — BUG-02 Durable Merge / BUG-09 Bridge Agent Scope

Date: 2026-07-19  
Fix base: `b9ec3c824f68a454e6dce5c3081f29363fd00aad`  
Outcome: **fixed at the B2 boundary; all focused, owning, review, and repository-wide serial gates pass**

## Finding, root cause, and source-to-sink

Both registered merge paths selected a candidate, archived only the reduced search projection, deleted the active original, wrote the destructive log, and only then attempted `MemoryDB.store(mergedEntry)`. Store failure therefore removed the only active copy. There was no readback verification, keyed serialization, or under-lock revalidation, so concurrent calls could commit multiple replacements from one stale snapshot.

The Bridge/Control-Room helper additionally used unbound `agentId` in `callMergeCheck()` even though its effective identity was named `storeAgentId`. Its catch converted the `ReferenceError` into a silent merge skip and separate store.

## Fix and invariant

One register-local FIFO Promise queue now keys work with `JSON.stringify([effectiveAgentId, candidateUuid])`. Both callers enter the same `withDurableMerge()` boundary before merge LLM evaluation. Under that lock the boundary re-reads the complete candidate, requires exact ID/text identity, active or legacy-active status, and fresh ACL visibility, then runs caller-specific preparation.

The durable order is now:

```text
full authoritative archive
  -> replacement store
  -> exact replacement getById verification (UUID + text + active status)
  -> original delete
  -> memory_store_merge destructive log
  -> caller-specific curation/pending/trace/response
```

Store/readback failure leaves the original active and emits no deletion log. A written but unverifiable replacement remains visible as a repairable fork. A delete rejection emits no success or false deletion log; the verified replacement and archive prevent BUG-02 data loss. Because `MemoryDB.delete()` timeouts are non-abortable, the underlying delete can still finish after the caller sees an error, so both rows are not guaranteed to remain and the destructive log can be missing. The queue continues after predecessor rejection and removes only its own tail. The bridge merge call now passes `storeAgentId`; the model tool retains `agentId` and its emotional entry fields.

## RED / GREEN proof

Before `index.js` changed:

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js
tests 2; pass 0; fail 2; duration_ms 31939.923877
```

Direct diagnostics showed the original absent after replacement-store failure, no readback check, an incomplete archive projection, two same-candidate commits, and zero exact bridge `storeAgentId` merge calls.

After the fix:

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js
tests 2; pass 2; fail 0; duration_ms 32754.248958
```

Independent review then added a real registered Control-Room consumer regression. Against the old adapter, its normal-store positive control passed and only the injected store-failure case failed because the bundle item was persisted as `applied` instead of remaining `approved`. The controller independently reran the final focused command and passed all three files:

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js tests/obsidian-control-room-store-failure.test.js
tests 3; pass 3; fail 0; duration_ms 32584.649292
```

Owning suite:

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/memory-store-merge-safety.test.js tests/memory-store-dedup-safety.test.js tests/memory-store-decision-trace.test.js tests/memory-store-input-validation.test.js tests/llm-result-cache-integration.test.js tests/obsidian-smoke.test.js tests/smoke-obsidian-apply.test.js
tests 8; pass 8; fail 0; duration_ms 33652.833059
```

The controller's final owning suite includes the Control-Room regression and passes 9/9 files (`duration_ms 32973.588463`).

Original corrected trigger:

```text
$ node --test --test-name-pattern='merged store fails|replacement store fails|store failure' tests/memory-store-merge-archive-first.test.js
tests 1; pass 1; fail 0; duration_ms 30852.790577
```

The registered-tool/LanceDB regressions prove the positive merge, complete archive and exact audit record, store-failure preservation, readback-null repairable fork, and same-candidate FIFO continuation/stale rejection. The embedding-failure preservation control, meaningful-difference/fact-loss safety, duplicate handling, trace, input, cache-scope, and Obsidian controls remain green.

## BUG-09 and bypass review

The source/cache guard requires one bridge call with `storeAgentId`, one model call with `agentId`, and one shared-boundary callsite for each. Independent review additionally found that the registered Control-Room callback returned `storeMemoryFromToolParams()` failure results as fulfilled Promises, allowing `applyApprovedReviewBundle()` to record false success. The adapter now throws for both helper failure forms (`result.error` and `Memory store failed: ...`) and returns only successful results. `lib/obsidian-control-room.js` and B14 policy remain unchanged.

The new registered-command fixture proves a successful real store becomes `applied`, persists the real `appliedMemoryId`, and reports `Applied: 1`; an injected real DB store failure remains `approved` and is reported as an error. It traverses the real plugin command and bundle consumer rather than a source regex.

The sink scan found no direct merge delete/store path outside `withDurableMerge()`. Different agent/candidate keys cannot concatenate-collide; stale/missing/inactive/text-changed/ACL-denied candidates fail before LLM or mutation; no log precedes verified replacement plus successful delete. Readback-null is the alternate injected bypass class.

## Gates, files, and uncertainty

- `node --check index.js` — exit 0.
- `npm run lint` — exit 0.
- `git diff --check` — exit 0.
- Same-reviewer re-review after the Control-Room amendment — no open Critical or Important findings; the earlier Important finding is closed.
- Authoritative outside-sandbox serial integration gate:

```text
$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2561; pass 2560; fail 0; skipped 1; duration_ms 386112.403401
```

The known `tests/setup-feature-crons-symlink.test.js` nested-spawn sandbox artifact did not occur outside the sandbox; that test passed directly inside the authoritative serial run.

Changed B2 files:

- `index.js`
- `tests/memory-store-merge-archive-first.test.js`
- `tests/llm-result-cache-integration.test.js`
- `tests/obsidian-control-room-store-failure.test.js`
- `docs/superpowers/plans/2026-07-19-b2-durable-merge.md`
- `docs/audits/2026-07-19-bug-02-bug-09-durable-merge-fix.md`
- this fix report

Remaining uncertainty: the specified queue is process/register-generation-local rather than a cross-process DB transaction and does not lock `/forget`, `/correct`, GC, other mutation classes, other registrations, or other processes; those can still race after merge revalidation during LLM/embedding work. Dynamic injections cover store, readback, predecessor error, and stale state, while archive/delete failure ordering is enforced by the single reviewed boundary but still has no B2-specific dynamic injection. `MemoryDB.store()` timeouts are non-abortable: a caller-visible timeout can release the queue before the underlying add settles, so a retry can overlap the late write and leave multiple replacement rows as repairable duplicate state; cancellation/settlement is assigned to B3 (`BUG-ADD-03`). A non-abortable delete timeout can later remove the original without a destructive log, although the verified replacement and archive prevent the BUG-02 loss mode. B7, `MemoryDB.update()`, DB lifecycle/leases, the same-generation schema-cache follow-up, B14 policy, and `main` were untouched.

---

# B7 Fix Report — BUG-08 MemoryDB Half / BUG-11 / BUG-12

Date: 2026-07-19  
Fix base: `fc8134747118b46f15760da3c8c8294098fcdaef`  
Outcome: **BUG-11 and BUG-12 fixed; BUG-08 is the MemoryDB half of a joint receipt that remains open until B6**

The embedding-cache half of BUG-08 and the separate same-generation schema-cache invalidation follow-up are explicitly untouched and open.

## Source-to-sink, root causes, and invariants

BUG-08's `MemoryDB` path cached one rejected initialization promise and any partial DB/table/schema state on a pool-cached object. Later callers returned that same rejection after an invalid path or transient DB failure had been repaired. The fix retains one promise per generation, but a failed generation closes partial handles, aggregates cleanup failure with the primary cause, nulls `table`, `db`, and `schemaFieldNames`, then clears `initPromise` only after cleanup. Lifecycle close awaits the raw table/connection promises rather than a non-abortable operation timeout, so cleanup, retry, and shutdown cannot settle ahead of a still-live handle. Successful generations remain coalesced and cached; failed generations do not permanently shut down the instance.

BUG-11's `MemoryDB.update()` deleted the row before adding its replacement and silently caught a failed restore. The supported path now validates and finds the UUID as before, filters patch keys to the cached current schema, excludes `id`, normalizes vector values, and calls LanceDB `table.update({ where, values })` without deleting the row. Operational update failures propagate and never downgrade to replacement. Only genuine API absence uses delete/add; a failed replacement triggers one restore, and a failed restore logs DB path/UUID and throws both causes in an `AggregateError`.

BUG-12's pool refcount ended at `getDb()` return, before the caller's async work. The 51st agent could therefore evict and close an active oldest handle, while cache, agent-pool, and namespace shutdown errors were swallowed. `AgentDbPool.withDb()` now holds the ref until callback settlement and tracks active operations for shutdown. `MultiNamespacePool` composes write and ordered read leases, rejects new child/work admission once terminal shutdown starts, tracks top-level namespace operations, and coalesces concurrent shutdown before closing each child once. Bounded-cache release trims soft overflow, and sync/async eviction failures retain their keys and surface after all pending evictions settle. Agent and namespace shutdown failures are logged with identity context and aggregated.

The production migration covers model recall/store/forget/knowledge tools, Bridge storage, B2 merge paths, capture/recall hooks, GC maintenance, semantic discovery, reminders, `/correct`, status, internal jobs, feedback dynamics, shared memory, wiki, and the GC job. Direct `db.table` users are inside the same operation lease. Fire-and-forget work starts a separately tracked lease and logs rejection.

## B2 composition and isolation proof

The Bridge path passes `storeAgentId`; the registered model tool passes its existing `agentId`. Their workspace IDs/keys, owner/scope ACL fields, active write namespace, configured recall namespace order, and feature gates are unchanged. Each B2 lease covers candidate lookup, `withDurableMerge()` predecessor wait, under-lock revalidation, replacement preparation/store/readback, archive, original delete, destructive logging, and response/trace work. `tests/memory-store-merge-archive-first.test.js` and the deterministic cache-scope guard remain green.

Final raw lookup review:

```text
$ rg -n "\.(getDb|getWriteDb|getReadDbs)\(" index.js lib --glob '*.js'
lib/feedback-log.js:89                         compatibility fallback
lib/multi-namespace-pool.js:50,57,63          compatibility definitions
lib/wiki-command.js:307                       compatibility fallback
lib/shared-memory.js:32                       compatibility fallback
lib/obsidian/semantic-link-discoverer.js:159  compatibility fallback
lib/jobs/gc-job.js:56                         compatibility fallback
```

No reachable lease-capable repository production consumer uses a raw accessor for DB work.

## Baseline, RED, GREEN, and owning suites

Before production edits, the seven-file owning baseline passed 7/7 in about 32.6 seconds:

```text
$ node --test tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/p2-performance.test.js tests/multi-namespace-pool.test.js tests/migration-robustness.test.js tests/smoke-migration.test.js tests/memory-store-merge-archive-first.test.js
tests 7; pass 7; fail 0
```

Causal RED, before production edits:

```text
$ node --test tests/memory-db-lifecycle-atomic.test.js tests/agent-db-pool-lease.test.js tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/multi-namespace-pool.test.js
tests 5; pass 0; fail 5
```

Direct files contained 31 subtests: 14 passed and 17 failed for the retained rejected generation, delete/add update, suppressed restore/eviction failures, missing lease APIs, premature oldest-handle close, and shutdown-before-settlement. The existing concurrent-init positive control passed; no failure was caused by syntax or a broken fixture.

Focused GREEN:

```text
$ node --test tests/memory-db-lifecycle-atomic.test.js tests/agent-db-pool-lease.test.js tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/multi-namespace-pool.test.js
tests 5; pass 5; fail 0; duration_ms 1188.626944
```

Direct execution passed all 31 subtests (MemoryDB 6, AgentDbPool 3, bounded-cache 11, namespace 11).

The initial task-spec review then produced two causal REDs. Namespace terminal/concurrent-shutdown coverage failed 2 of 13 direct subtests (11 passed) because late work could create a child and shutdown closed an active child too early; after the fix it passed 13/13. Deferred raw-close coverage failed 2 of 8 direct MemoryDB subtests (6 passed) because `_write` timeout settlement preceded the underlying close; after the fix it passed 8/8.

Post-review-fix focused verification passed 5/5 file workers, 0 failures, `duration_ms 2018.150589`, representing 35/35 direct subtests. Required migration/store/cache/performance owners passed 7/7 (`duration_ms 33179.919208`). Direct feedback/shared/wiki/GC/semantic/runtime/lifecycle consumers passed 10/10 (`duration_ms 828.059838`). Index capture/recall/correct/reminder/merge consumers passed 14/14 (`duration_ms 31622.342465`). There were no failures.

## Original PoCs, positive controls, and bypass review

- Invalid parent then repair: first init rejected, all partial generation state cleared, and the same instance stored/read after repair; a fresh instance reading the row was the control.
- Concurrent successful init: one refresh/generation served both callers and the resolved generation remained cached.
- Supported update: `{ update: 1, delete: 0, add: 0 }`, with UUID, vector, text, category, and unknown-field behavior verified.
- Operational update failure: original error propagated with no delete/add fallback.
- Legacy double failure: `AggregateError.errors === [replacementError, restoreError]`; DB path and UUID were present in the recovery warning. Repairable data loss remains possible only by definition on that unsupported double-write-failure path.
- Shutdown double failure: table and connection close errors were both exposed while handle/schema/init state cleared; repeated shutdown remained safe.
- Deferred close settlement: failed-init cleanup, a coalesced retry, and shutdown remained pending through raw close settlement even when the old `_write` boundary was injected to return an early simulated timeout.
- Deterministic 51-agent case: agent 00 stayed open through the deferred operation while agents 01–50 populated the cache; same agent reused one object/path, different agents remained distinct; agent 51 evicted agent 00 only after release.
- External shutdown waited with zero early close attempts, then closed and logged contextual failure after the operation settled.
- Namespace shutdown rejected post-terminal child/work creation, waited for an active top-level lease, shared concurrent shutdown calls, and closed the child exactly once.

Success/rejection release in `finally`; repeated release clamps at zero; nested same-agent refs compose; read namespaces preserve configured order and unwind on every exit; shutdown rejects new work and child creation, waits for active work, coalesces concurrent calls, closes all cached handles, and drains eviction failures. Timeout wrappers do not force a lease release: the tracked callback retains it until actual settlement, while cancellation/admission remains B3. Lifecycle close is intentionally outside the ordinary operation timeout so raw settlement remains authoritative. B2 queue waiting and all durable steps remain leased. Fire-and-forget branches create a new lease and logged catch. No feature gate or identity route was changed.

## Exact files and gates

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

- `tests/memory-db-lifecycle-atomic.test.js`
- `tests/agent-db-pool-lease.test.js`
- `tests/bounded-cache-shutdown.test.js`
- `tests/bounded-cache.test.js`
- `tests/multi-namespace-pool.test.js`

Documentation:

- `docs/superpowers/plans/2026-07-19-b7-lancedb-lifecycle-atomic-updates.md`
- `docs/audits/2026-07-19-b7-lancedb-lifecycle-atomic-updates-fix.md`
- this fix report

Verification:

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

The known nested-spawn `EPERM` artifact did not occur in the final authoritative serial run.

## Review status, uncertainty, and integrity

The initial task-spec review reported two Important findings: terminal/coalesced namespace shutdown and raw lifecycle-close settlement. Both are resolved with the causal RED/GREEN evidence above. Independent task re-review of the amended one-commit range returned **PASS** with no Critical, Important, or Minor findings. Independent final broad code-quality/security review returned **APPROVED / PASS** with no Critical, Important, or Minor findings; it confirmed the documented scope/isolation boundary—B7 remains limited to the `MemoryDB` half of BUG-08 plus BUG-11/BUG-12, with the listed non-scope unchanged—and found B7 ready to stop as-is. Controller final verification also returned **PASS** for fresh lint/syntax, the three-file PoC gate, committed-range diff hygiene, and the authoritative serial suite. No reviewer finding is waived.

Remaining uncertainty and non-claims:

- BUG-08 remains jointly open until B6 closes the untouched embedding-cache half.
- Same-generation schema-cache refresh/invalidation remains open and untouched.
- If both writes in the legacy no-update compatibility path fail, the row may be absent; B7 makes that state explicit and causal, while supported LanceDB uses in-place update.
- LanceDB timeout operations are non-abortable; B3 owns cancellation, admission, and late-write semantics.
- Lifecycle close deliberately has no operation-timeout escape. A driver close that never settles can keep cleanup/shutdown pending; this prevents a retry or teardown from racing the live handle, and outer gateway reporting does not release the tracked lifecycle.
- Compatibility raw accessors remain available for external callers, but in-repository production consumers are leased.
- A lease callback awaiting shutdown of its own pool is unsupported re-entrant lifecycle misuse and can self-wait; no repository callback does this.
- Leases are in-process lifecycle protection, not mutation serialization or a cross-process DB transaction.
- B3, B6, BUG-13, and all other batches are untouched.

Main-checkout proof: `/root/openclaw-plur1bus-memory` remained clean at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`. The B7 worktree remained on `fix/high-mid-audit-findings` with a one-commit range from `fc8134747118b46f15760da3c8c8294098fcdaef` while this amendment report was written. No push or merge occurred.
