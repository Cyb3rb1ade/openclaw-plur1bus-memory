# BUG-02 / BUG-09 Durable Merge Fix Receipt

Date: 2026-07-19
Batch: B2
Branch: `fix/high-mid-audit-findings`
Fix base: `b9ec3c824f68a454e6dce5c3081f29363fd00aad`
Outcome: **fixed at the B2 boundary; all focused, owning, review, and repository-wide serial gates pass**

## Findings and reachable paths

BUG-02 was reachable through both production merge callers:

```text
Obsidian Bridge / Control Room
  -> storeMemoryFromToolParams(storeCtx, params)
  -> findMergeCandidate()
  -> archive reduced candidate snapshot
  -> delete original
  -> append memory_store_merge deletion log
  -> store replacement (may fail after data loss)

registered public memory_store
  -> findMergeCandidate()
  -> same delete/log-before-store sequence
```

The existing real-plugin/LanceDB test deliberately asserted that a replacement-store failure left the original absent. There was also no replacement readback and no candidate-level serialization, so two callers could act on one stale snapshot and commit divergent replacement UUIDs.

BUG-09 was reachable in the bridge helper after candidate selection. The helper bound the effective identity as `storeAgentId`, but called `callMergeCheck(..., agentId)`. That unbound name threw `ReferenceError`; the local merge-check catch logged it as a skipped merge and continued with a separate store. The public model tool's local `agentId` was valid.

## Restored invariant and patch

One register-local `durableMergeQueues` map and shared `withDurableMerge()` boundary now protect both callers. The collision-safe key is `JSON.stringify([effectiveAgentId, candidateUuid])`. The FIFO Promise queue:

- waits for the predecessor;
- continues after predecessor rejection while logging the continuation;
- removes only its own current tail on success or failure; and
- leaves different agents or candidate UUIDs on independent keys.

Under the keyed lock, the shared boundary now:

1. validates the candidate UUID and re-reads it with `MemoryDB.getById()`;
2. requires exact selected ID/text identity, active or legacy-active status, and a fresh `candidateVisibleForStore()` ACL pass;
3. runs the caller's existing meaningful-difference, merge-LLM, fact-preservation, embedding, and entry construction callback;
4. archives the complete authoritative row;
5. stores the replacement;
6. reads the replacement back and requires exact UUID, exact text, and active/legacy-active status;
7. deletes the original only after verified replacement durability; and
8. appends the existing `memory.deleted` / `memory_store_merge` destructive log only after successful delete.

Archive, store, verification-read/mismatch, stale revalidation, and delete failures carry agent, candidate, replacement, and archive context where applicable and remain visible to the caller. Store/readback failure leaves the original active and writes no deletion log. A replacement that was written but failed readback remains as a visible repairable fork. A delete rejection emits no success response or deletion log, and the verified replacement plus archive prevent the original BUG-02 loss mode. `MemoryDB.delete()` timeouts are not abortable, however, so a timed-out underlying delete may still complete later; this receipt does not guarantee that both rows remain after every caller-visible delete error, and the destructive log can be absent in that timeout case.

Caller-specific behavior remains outside the shared persistence primitive and runs once after it succeeds: curation, pending-knowledge promotion, trace, response shape, and the public model tool's emotional fields. The bridge merge LLM now receives `storeAgentId`; the model tool continues to receive `agentId`.

## TDD evidence

### Baseline

Before correcting the test, the bug-codifying fixture passed:

```text
$ node --test tests/memory-store-merge-archive-first.test.js
tests 1; pass 1; fail 0; duration_ms 31107.693904
```

### RED — observed before editing `index.js`

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js
✖ tests/llm-result-cache-integration.test.js (30213.939713ms)
✖ tests/memory-store-merge-archive-first.test.js (31915.142694ms)
tests 2; pass 0; fail 2; duration_ms 31939.923877
```

Direct diagnostic output proved the intended causes:

- replacement store failure: the original was absent (`actual false`, expected present);
- readback-null case: current code returned `details.action === "merged"` because it did no readback;
- positive merge: the archive lacked the full authoritative row and contained only the reduced candidate fields;
- synchronized same-candidate calls: two replacements committed instead of one;
- bridge source/cache guard: exact `callMergeCheck(..., storeAgentId)` count was `0`, expected `1`.

The existing merged-embedding failure preservation control remained green during RED.

### Focused GREEN

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js
✔ tests/llm-result-cache-integration.test.js (30203.080414ms)
✔ tests/memory-store-merge-archive-first.test.js (32722.594661ms)
tests 2; pass 2; fail 0; duration_ms 32754.248958
```

After independent review added the registered Control-Room consumer regression, the controller independently reran the final focused command:

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js tests/obsidian-control-room-store-failure.test.js
tests 3; pass 3; fail 0; duration_ms 32584.649292
```

### Owning suite

```text
$ node --test tests/memory-store-merge-archive-first.test.js tests/memory-store-merge-safety.test.js tests/memory-store-dedup-safety.test.js tests/memory-store-decision-trace.test.js tests/memory-store-input-validation.test.js tests/llm-result-cache-integration.test.js tests/obsidian-smoke.test.js tests/smoke-obsidian-apply.test.js
✔ 8 files
tests 8; pass 8; fail 0; duration_ms 33652.833059
```

The controller's final owning suite includes the new Control-Room file and passes 9/9 files (`duration_ms 32973.588463`).

This preserves legitimate merge, duplicate rejection, meaningful-difference/fact-loss fallback, decision traces, input rejection, deterministic agent cache scope, and Obsidian smoke behavior.

## Original trigger and positive proof

The corrected original store-failure trigger passes:

```text
$ node --test --test-name-pattern='merged store fails|replacement store fails|store failure' tests/memory-store-merge-archive-first.test.js
tests 1; pass 1; fail 0; duration_ms 30852.790577
```

The real registered-tool/LanceDB fixture proves:

- replacement-store failure returns failure, leaves the full active original, retains exactly one complete archive, and emits no merge deletion log;
- readback-null leaves both the original and written replacement as a repairable fork, with no deletion log;
- successful merge returns `details.action === "merged"`, returns an existing active replacement with exact expected text and `mergedFrom`, removes the original only afterwards, archives the complete original, and writes exactly one deletion event with source, agent, original ID, and archive path;
- three callers deterministically select the same candidate before the boundary: the first replacement store fails visibly, the second proves the same keyed queue continues and commits exactly one replacement, and the final stale waiter is rejected before a third merge-LLM evaluation; one and only one destructive deletion log is emitted.

## BUG-09 and bridge/control coverage

The existing source-integrity/cache test now requires:

- one bridge-helper `callMergeCheck(authoritativeCandidate.text, params.text, mergingLlmCfg, storeAgentId)`;
- one model-tool call with its valid local `agentId`;
- one bridge-helper call into the shared boundary with `db: storeDb` and `agentId: storeAgentId`; and
- one model-tool call into the same boundary with `db` and `agentId`.

Independent review found one additional consumer-contract gap: the registered Control-Room adapter passed a `Memory store failed: ...` helper result through as a fulfilled Promise, while `applyApprovedReviewBundle()` treats any fulfilled callback as success. The adapter now rejects both helper failure shapes (`result.error` and `Memory store failed: ...`) before returning to the bundle consumer. No B14 approval/config policy changed and `lib/obsidian-control-room.js` remains untouched.

The live registered regression uses the production bundle preparation and approval APIs, the real `/plur1bus obsidian review apply` handler, real LanceDB state, and only patches the local embedding boundary plus the explicit failing `MemoryDB.store()` call. Against the old adapter, the real-store positive control passed while the failure case persisted `status: applied`; after the fix, success persists `status: applied` with a real `appliedMemoryId`, while failure remains `approved` and the command reports `Memory store failed: ...`.

## Change-aware bypass review

Command:

```text
$ rg -n 'findMergeCandidate|callMergeCheck|withDurableMerge|archiveCard\(|memory_store_merge|\.delete\(mergeCandidate|\.store\(mergedEntry' index.js
```

Review result:

- exactly the bridge/control helper and public model tool perform auto-merge candidate selection;
- both converge on `withDurableMerge()` before LLM evaluation or mutation;
- only the shared boundary archives, stores, readback-verifies, deletes, and logs a merge;
- no direct merge path deletes or logs before verified store/readback;
- stale/missing/inactive/text-changed/newly unauthorized candidate state is rejected under the keyed lock;
- agent and candidate form a structured JSON key, so different identities cannot concatenate-collide;
- readback null is the tested alternate failure class and leaves the original active with no false log;
- embedding, duplicate, meaningful-difference, fact-loss, and normal separate-store controls remain non-destructive;
- archive failure exits before replacement store; a caller-visible delete rejection exits after verified store and before any deletion log, subject to the non-abortable timeout caveat above.

## Gates

- `node --check index.js` — exit 0.
- `npm run lint` — exit 0.
- `git diff --check` — exit 0.
- Final focused GREEN (3 files), final owning suite (9 files), registered Control-Room positive/failure controls, and original trigger — exit 0 as recorded above.
- Same-reviewer re-review after the Control-Room amendment — no open Critical or Important findings; the earlier Important finding is closed.
- Authoritative outside-sandbox serial integration gate:

```text
$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2561; pass 2560; fail 0; skipped 1; duration_ms 386112.403401
```

The known `tests/setup-feature-crons-symlink.test.js` nested-spawn sandbox artifact did not occur outside the sandbox; that test passed directly inside the authoritative serial run.

## Changed files

- `index.js`
- `tests/memory-store-merge-archive-first.test.js`
- `tests/llm-result-cache-integration.test.js`
- `tests/obsidian-control-room-store-failure.test.js`
- `docs/superpowers/plans/2026-07-19-b2-durable-merge.md`
- `docs/audits/2026-07-19-bug-02-bug-09-durable-merge-fix.md`
- `docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/fix_report.md`

No B7 code, `MemoryDB.update()`, DB lease/lifecycle work, same-generation schema-cache follow-up, B14 policy, or `main` checkout was changed.

## Remaining uncertainty

- The queue is intentionally register-generation-local, as specified; it is not a cross-process database transaction and does not serialize `/forget`, `/correct`, GC, other mutation classes, other plugin registrations, or other processes. Such a mutation can still race after merge revalidation while LLM/embedding preparation is in flight.
- Store failure, readback-null, and concurrent predecessor/stale paths are dynamically injected. Delete and archive failure ordering is enforced by the shared linear boundary and reviewed statically, but those two failures still have no B2-specific dynamic injection cases.
- `MemoryDB.store()` timeouts are also non-abortable. A timeout can reject the queued merge while the underlying LanceDB add later commits; queue cleanup then permits a retry to overlap that late write and can leave more than one replacement as repairable duplicate state. B2 still preserves the original until a replacement is synchronously verified, but cancellation/settlement semantics belong to B3 (`BUG-ADD-03`).
- A non-abortable `MemoryDB.delete()` timeout can report failure before the underlying delete settles. Replacement verification and the archive prevent BUG-02 data loss, but the original may later disappear and the destructive log can be missing.
