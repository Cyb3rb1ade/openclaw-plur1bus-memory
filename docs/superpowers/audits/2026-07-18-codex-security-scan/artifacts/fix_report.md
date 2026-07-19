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
