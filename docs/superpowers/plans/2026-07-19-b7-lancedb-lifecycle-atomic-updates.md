# B7 LanceDB Lifecycle and Atomic Updates Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan as one reviewable task. Use `superpowers:systematic-debugging`, `superpowers:test-driven-development`, `superpowers:verification-before-completion`, and `codex-security:fix-finding` exactly as requested by the user.

**Goal:** Close only BUG-08's `MemoryDB` initialization half, BUG-11, and BUG-12 without changing agent/workspace routing, disabling features, or entering B3/B6/other batches.

**Architecture:** Keep `MemoryDB` initialization coalesced, but make a failed generation clean up its partial handles before atomically clearing the cached promise. Use LanceDB's supported `table.update({ where, values })` for ordinary patches, retaining a compatibility replacement path whose double failure is explicit. Add callback-scoped DB leases to `AgentDbPool` and namespace-preserving lease composition to `MultiNamespacePool`; migrate every production pool consumer so the lease covers the complete async DB use, including B2's durable-merge queue. Make bounded-cache and pool shutdown failures observable and wait for active operations before closing handles.

**Tech Stack:** Node.js ESM, Node test runner, LanceDB `@lancedb/lancedb` 0.26.2, existing `makeBoundedCache`, existing B2 `withDurableMerge` queue.

**Recorded base:** `fc8134747118b46f15760da3c8c8294098fcdaef` on `fix/high-mid-audit-findings`. Review ranges must use this hash, never `HEAD~1`.

**Scope guardrails:**

- Do not change the embedding-cache half of BUG-08 (B6), timeout settlement/admission (B3), BUG-13, or any other finding/batch.
- Preserve the active write namespace, recall namespace order, agent ID, workspace ID/key, and all feature branches.
- The same-generation schema-cache follow-up remains open. In-place update removes one observed trigger, but full cache invalidation would require an additional schema-refresh path and a separate fixture; that fails the opportunistic rule.
- One implementation commit only, containing B7 code, regressions, plan, dedicated receipt, and the B7/joint-receipt section in the versioned scan fix report.

---

### Task 1: Close B7 lifecycle, atomic-update, and lease paths

**Files:**

- Modify: `index.js`
- Modify: `lib/bounded-cache.js`
- Modify: `lib/multi-namespace-pool.js`
- Modify only as required to remove raw production pool use: `lib/feedback-log.js`, `lib/shared-memory.js`, `lib/wiki-command.js`
- Add: `tests/memory-db-lifecycle-atomic.test.js`
- Add: `tests/agent-db-pool-lease.test.js`
- Modify: `tests/bounded-cache-shutdown.test.js`
- Modify: `tests/bounded-cache.test.js`
- Modify: `tests/multi-namespace-pool.test.js`
- Preserve/verify: `tests/memory-store-merge-archive-first.test.js`
- Add: `docs/audits/2026-07-19-b7-lancedb-lifecycle-atomic-updates-fix.md`
- Modify: `docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/fix_report.md`

**Step 1: Revalidate source-to-sink and record baseline**

- Confirm `MemoryDB.init()` retains a rejected `initPromise` and partial handles.
- Confirm `MemoryDB.update()` performs query -> delete -> add -> best-effort add and suppresses a failed restore.
- Confirm `AgentDbPool.getDb()` releases the ref before the caller's promise begins; enumerate every `getDb`/`getWriteDb`/`getReadDbs` consumer, including B2 bridge and model-tool merge paths.
- Record the already-green owning baseline:

```bash
node --test tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/p2-performance.test.js tests/multi-namespace-pool.test.js tests/migration-robustness.test.js tests/smoke-migration.test.js tests/memory-store-merge-archive-first.test.js
```

**Step 2: Write the smallest realistic failing regressions and positive controls**

In `tests/memory-db-lifecycle-atomic.test.js`, add real temporary LanceDB cases that prove:

- an invalid DB path fails, the path is repaired, and the same `MemoryDB` instance retries successfully only after partial handle cleanup; a fresh instance remains a positive control;
- concurrent callers still share one initialization generation;
- a supported patch uses `table.update`, preserves the UUID/vector/untouched fields, and never calls delete/add;
- a compatibility replacement whose replacement and restore both fail throws an `AggregateError` containing both causal errors (and logs the recovery failure); a successful in-place update is the positive feature path.

In `tests/agent-db-pool-lease.test.js`, add a deterministic 51-agent fixture that proves:

- the oldest agent's async operation remains leased until its deferred promise settles;
- adding the 51st agent does not shut that handle while active;
- after settlement, normal eviction resumes;
- different agent IDs map to different DB instances/paths, and the same agent reuses its DB while cached;
- pool shutdown waits for active work and surfaces contextual shutdown/eviction failures.

Update bounded-cache tests so async and synchronous eviction failures are collected and surfaced by the drain/await boundary rather than silently swallowed. Update namespace tests so `withWriteDb` and `withReadDbs` hold exactly the correct namespace leases, preserve read order, release on success and error, and aggregate shutdown failures.

**Step 3: Demonstrate causal RED before production edits**

Run only the new/changed regressions. Preserve the output showing failures caused by the retained rejected promise, delete-before-add behavior, missing lease API/premature close, and swallowed eviction failure—not syntax or fixture errors.

```bash
node --test tests/memory-db-lifecycle-atomic.test.js tests/agent-db-pool-lease.test.js tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/multi-namespace-pool.test.js
```

**Step 4: Implement failed-init cleanup and retry**

- Keep one promise per initialization generation.
- On failure, close any table and connection handles, collect cleanup errors without hiding the primary error, null `table`, `db`, and `schemaFieldNames`, then clear `initPromise` only after cleanup finishes.
- Do not mark the instance permanently shut down; the next call must create a fresh generation.
- Keep a successful resolved promise cached so repeated/concurrent successful calls remain idempotent.
- Make `shutdown()` idempotent but surface combined table/connection close failures after clearing state.

**Step 5: Implement atomic update preference and explicit fallback failure**

- Validate the UUID and confirm the row exists as today.
- When `table.update` is supported, update only patch keys present in the current schema (normalizing vector-like patch values), exclude immutable `id`, and do not delete the row.
- Do not downgrade an operational `table.update` failure into delete/add.
- Retain replace compatibility only when the API is genuinely unavailable. If replacement fails, restore the original. If restore also fails, log the DB path/UUID and throw an `AggregateError` containing both failures; never silently catch it.
- Do not implement the separate same-generation schema-cache invalidation path.

**Step 6: Implement operation-scoped leases and observable eviction**

- Add documented `AgentDbPool.withDb(agentId, fn)` that acquires before lookup/create, awaits the callback's settlement, and releases in `finally`.
- Track active operations so shutdown waits for settlement before closing cached handles.
- Keep `getDb()` only as a compatibility accessor; production code in this repository must use the lease API for actual DB work.
- Add `MultiNamespacePool.withWriteDb`, `withReadDbs`, and backward-compatible `withDb`; acquire each configured read namespace without changing order or identity and release all on every exit.
- Refactor the bounded cache so release trims soft overflow, sync/async eviction errors are retained with keys, and `awaitPendingEvictions()` surfaces an aggregate once all pending evictions settle.
- Log eviction/shutdown failures with agent and namespace context and aggregate them at gateway/pool shutdown.

**Step 7: Migrate every reachable production source-to-sink path**

- Replace raw pool lookup/use pairs in `index.js`, `lib/feedback-log.js`, `lib/shared-memory.js`, and `lib/wiki-command.js` with callback-scoped leases.
- Lease the whole DB-dependent async operation, including helpers that access `db.table` directly.
- For fire-and-forget maintenance, attach a logged rejection handler while returning the lease promise to the lifecycle tracker.
- In both B2 merge paths, keep the lease alive across `withDurableMerge` queue wait, revalidation, replacement store/readback, archive, delete, and logging. Preserve `storeAgentId` on the bridge and `agentId` on model tools.
- Re-run `rg` to ensure no reachable raw pool consumer remains outside compatibility definitions/tests.

**Step 8: Get focused tests and every owning suite green**

```bash
node --test tests/memory-db-lifecycle-atomic.test.js tests/agent-db-pool-lease.test.js tests/bounded-cache-shutdown.test.js tests/bounded-cache.test.js tests/multi-namespace-pool.test.js
node --test tests/migration-robustness.test.js tests/smoke-migration.test.js tests/store-validation.test.js tests/db-adapter-purge-throttle.test.js tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js tests/p2-performance.test.js
```

Also run each directly affected consumer suite discovered from the final diff. Do not omit a suite merely because the focused regressions pass.

**Step 9: Re-run the original PoCs and bypass/concurrency review**

- Re-run the invalid-parent/repaired-path same-instance PoC; expect same-instance recovery and `initPromise` no longer retained after failure.
- Re-run double replacement/restore injection; expect both errors and no silent rollback failure. The legacy double-failure state may remain repairable data loss by definition, but it must be explicit; supported LanceDB must never enter this path.
- Re-run the deterministic 51-agent deferred-operation PoC; expect no close before settlement and eviction after release.
- Review success, rejection, timeout, shutdown, repeated release, nested same-agent lease, multiple namespaces, B2 queued merge, and fire-and-forget branches.
- Verify strict agent/workspace identity is passed unchanged and that no feature gate was disabled.

**Step 10: Document the finding receipts**

The dedicated receipt and scan fix report must include source-to-sink, root cause, invariant, exact changed files, baseline, RED, GREEN, owning suites, each original PoC, positive controls, B2 composition, isolation proof, bypass/concurrency review, syntax/lint/serial results, reviewer results, remaining uncertainty, and main-branch proof.

Label BUG-08 exactly as the **MemoryDB half of a joint receipt that remains open until B6**. Explicitly state that the embedding-cache portion and same-generation schema-cache follow-up remain untouched/open.

**Step 11: Verify syntax, diff, and authoritative serial suite**

```bash
npm run lint
git diff --check
git diff --stat fc8134747118b46f15760da3c8c8294098fcdaef...HEAD
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
```

If the known nested-spawn `EPERM` appears only in the sandboxed parallel harness, run `node --test tests/setup-feature-crons-symlink.test.js` directly; the serial suite remains authoritative.

**Step 12: Independent reviews, final evidence, and one commit**

- Obtain an independent task-spec review against this plan and the authoritative design/audit; fix every Critical/Important issue with the same implementer, then re-review.
- Run final verification fresh after review fixes.
- Obtain an independent final code-quality/security review over exact range `fc8134747118b46f15760da3c8c8294098fcdaef..B7_HEAD`; resolve every Critical/Important issue and re-run affected gates.
- Stage only B7 files and commit once with a finding receipt, for example:

```bash
git commit -m "fix: harden LanceDB lifecycle and atomic updates"
```

- Verify the B7 worktree is clean and on the requested branch; verify `/root/openclaw-plur1bus-memory` remains clean at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`.
- Stop. Do not push, merge, or begin B3/B6/another batch.
