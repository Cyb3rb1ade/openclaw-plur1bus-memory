# B2 Durable Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and review this single serial-spine batch. Follow every checkbox in order and retain RED/GREEN output in the finding receipt.

**Goal:** Close BUG-02 and BUG-09 without disabling merging: both the Obsidian/Control-Room bridge helper and the public model-tool path must serialize a merge by agent plus candidate identity, preserve a complete archive, durably store and read back the replacement before deleting the original, retain the destructive-operation log, and scope bridge merge evaluation to `storeAgentId`.

**Architecture:** Add one register-local keyed Promise queue and one shared durable candidate wrapper inside `plugin.register()`. Each caller selects a candidate as today, then enters the shared boundary before LLM evaluation. The wrapper re-reads and ACL-checks the authoritative active candidate, runs the caller's existing merge preparation callback, archives the full row, stores and verifies the replacement, and only then deletes the original and writes the existing destructive log. Both callers retain their existing safety guards, emotion handling, curation, pending promotion, traces, fallbacks, and public response shapes.

**Tech Stack:** Node.js ESM, `node:test`, LanceDB through the real `MemoryDB`, OpenClaw plugin tool/bridge integration, repository archive and destructive-log helpers.

## Global constraints

- Work only in `/root/openclaw-plur1bus-memory/.worktrees/fix-high-mid-audit-findings` on `fix/high-mid-audit-findings`; keep `/root/openclaw-plur1bus-memory` on `main` untouched.
- Implement only B2 / BUG-02 and BUG-09, then stop after one reviewed B2 commit.
- Do not change `MemoryDB.update()`, DB lifecycle/leases, or the same-generation schema-cache issue in `docs/superpowers/followups/2026-07-19-same-generation-schema-cache.md`; those belong to B7 at most.
- Preserve merging, duplicate handling, ACL filtering, meaningful-difference rejection, fact-preservation rejection, Bridge/Control-Room writes, archives, destructive logs, curation, emotional metadata, and normal separate stores.
- Do not use the B7-risky `MemoryDB.update()` path to supersede a merge candidate. Keep the current physical delete, but move it behind a verified replacement.
- No new public export is required. If an export changes, add focused JSDoc per `AGENTS.md`.
- Follow strict TDD. No production edit is allowed before the focused tests fail for the current delete-before-store order and the undefined bridge agent name.

## Patch contract

### Revalidated vulnerable paths

1. Bridge and Control Room call register-local `storeMemoryFromToolParams()` with a concrete agent in `storeCtx.agentId`.
2. That helper derives `storeAgentId`, uses it for DB, embedding, ACL, persisted ownership, archive, and audit, but currently calls `callMergeCheck(..., agentId)`. Because `agentId` is not bound in this scope, ESM throws `ReferenceError`; the local catch silently falls through to a separate store. This is BUG-09.
3. On a valid merge, the bridge helper currently archives and deletes the candidate, logs the deletion, and only then calls `storeDb.store(mergedEntry)`.
4. The public `memory_store` model tool follows the same archive/delete/log/store order. Its local `agentId` is valid.
5. Therefore a replacement store failure removes the only active row. The existing `tests/memory-store-merge-archive-first.test.js` explicitly expects this defective outcome and must be corrected, not removed.
6. Two concurrent calls can both select the same active snapshot and create divergent replacement UUIDs because neither path serializes or revalidates the candidate.

### Required invariant and error semantics

- The serialization key is collision-safe and contains exactly the effective agent identity plus candidate UUID, for example `JSON.stringify([agentId, candidateId])`. Independent candidates remain independent.
- The keyed queue is shared by both merge callers within the registered plugin generation, is FIFO, survives a predecessor error, releases in `finally`, and removes only its own current tail.
- Under the lock, re-read the candidate with `db.getById()`. It must exist, be active (empty legacy status is active), retain the selected ID/text identity, and still pass `candidateVisibleForStore()` for the original access context. Stale, missing, inactive, or newly unauthorized state is rejected explicitly before LLM or mutation.
- The caller's existing merge evaluation, fact-preservation check, embedding, and entry construction run under that same candidate lock.
- Archive the full authoritative row before any destructive operation. This intentionally preserves the existing archive-first recovery property, including on a subsequent store failure.
- Call `db.store(mergedEntry)`, then `db.getById(mergedEntry.id)`. Verification requires the expected UUID, exact text, and active/legacy-active status.
- Only after successful readback may `db.delete(originalId)` run. Only after successful delete may the existing `memory.deleted` / `memory_store_merge` destructive log be appended.
- Store or readback failure leaves the original active and emits no destructive log. A possibly written replacement after readback failure is a visible, repairable fork and must not be riskily deleted.
- Archive failure leaves the original active and performs no replacement store. Delete failure leaves verified replacement plus original as a repairable fork, emits no false deletion log, and returns/rethrows a visible failure instead of merge success.
- On success, curation, knowledge-pending tracking, decision trace, and response happen exactly once after the shared durable boundary.
- In the bridge helper, pass `storeAgentId` to `callMergeCheck()`. The public model tool continues to pass its correct local `agentId`.

---

### Task 1: Implement and verify B2 as one atomic batch

**Files:**

- Modify: `index.js` near `candidateVisibleForStore()`, `storeMemoryFromToolParams()`, and the `memory_store` merge branch.
- Modify, do not delete: `tests/memory-store-merge-archive-first.test.js`.
- Modify: `tests/llm-result-cache-integration.test.js` for the exact agent-scoped merge-call guard and the two shared durable-boundary callsites.
- Create only if needed for a realistic registered bridge/control integration: `tests/memory-store-bridge-merge.test.js`.
- Create: `docs/audits/2026-07-19-bug-02-bug-09-durable-merge-fix.md`.
- Update: `docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/fix_report.md` with a distinct B2 section while preserving B1 evidence.

- [ ] **Step 1: Record baseline and add the smallest realistic regressions plus positive control**

Record the clean pre-B2 base SHA and the existing passing-but-bug-codifying baseline:

```bash
git status --short --branch
node --test tests/memory-store-merge-archive-first.test.js
```

Update the existing real-plugin/LanceDB fixture rather than replacing it with a mock-only test. At minimum prove:

1. **Original BUG-02 trigger:** make the replacement `MemoryDB.store()` throw. The result must not claim merge success; the original must remain active; the full original archive must still exist exactly once; no `memory_store_merge` destructive log may exist.
2. **Readback verification:** let replacement store resolve but make its `getById(replacementId)` return `null` or mismatched content. The original must remain active and no delete log may be written.
3. **Positive durable merge:** a legitimate merge returns `details.action === "merged"`; the returned replacement ID exists with expected text and active status; the original is absent only afterwards; the archive contains the original; exactly one destructive log line has `event: "memory.deleted"`, `source: "memory_store_merge"`, effective agent, original ID, and archive path.
4. **Same-candidate serialization:** use a deterministic barrier so two concurrent public stores select the same candidate before entering the boundary. Exactly one may commit a replacement referencing the original; the stale waiter must be explicitly rejected, not create a second divergent replacement. Then prove a later merge can still run so an error did not poison the queue.
5. **Both production callers and BUG-09:** extend the existing source-integrity/cache test so it expects one exact `callMergeCheck(..., storeAgentId)` in the bridge helper, one exact `callMergeCheck(..., agentId)` in the model tool, and two calls into the shared durable candidate boundary with their respective effective agent IDs. If a small registered Control-Room/Bridge fixture can traverse the helper without changing unrelated Obsidian policy, also assert that a non-default bridge agent reaches the LLM and merges in that agent's DB. Do not modify B14 approval/config behavior merely to create this test.

Keep the existing embedding-failure preservation test as a positive non-destructive control. Existing meaningful-difference and fact-loss safety tests remain owning controls.

- [ ] **Step 2: Run focused RED before editing production code**

Run:

```bash
node --test tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js
```

If a dedicated bridge/control test was added, include it. Required RED:

- the corrected store-failure assertion sees the original missing under current code;
- the successful ordering/readback or serialization assertion fails because no durable boundary exists; and
- the callsite guard sees `agentId` rather than `storeAgentId` in the bridge helper.

Fixture, syntax, import, schema-cache, or unrelated Obsidian-policy failures are not acceptable RED. Correct the test harness until failure is caused by BUG-02/BUG-09 only. Preserve the exact command/output in the receipt.

- [ ] **Step 3: Implement the smallest complete shared durable boundary**

Inside `plugin.register()` near the existing store-access helpers:

1. Add a register-local `Map` keyed by effective agent plus candidate UUID and a small Promise-queue runner modeled on `lib/atomic-json.js`. It must continue after predecessor rejection and clean its tail on success/failure.
2. Add a local wrapper that acquires the key before merge evaluation, re-reads and validates the authoritative candidate and ACL, calls a caller-supplied preparation function, archives the authoritative row, stores and readback-verifies the replacement, deletes the original, and appends the existing destructive log.
3. Use that wrapper from both merge branches. Keep caller-specific entry construction—especially model-tool emotional fields—and all existing guards/results intact.
4. Replace only the bridge merge-check identity argument with `storeAgentId`.
5. Log and rethrow store, verification, archive, and delete failures with candidate/replacement/archive context. Do not acknowledge a merge unless the durable boundary completed.

Do not refactor unrelated store, update, recall, bridge approval, cache lifecycle, or DB pool code.

- [ ] **Step 4: Run focused GREEN and the owning subsystem suite**

First rerun exactly the RED command. Then run:

```bash
node --test tests/memory-store-merge-archive-first.test.js tests/memory-store-merge-safety.test.js tests/memory-store-dedup-safety.test.js tests/memory-store-decision-trace.test.js tests/memory-store-input-validation.test.js tests/llm-result-cache-integration.test.js tests/obsidian-smoke.test.js tests/smoke-obsidian-apply.test.js
```

Include a dedicated bridge/control test if created. Expected: exit 0, no false merge success, and all legitimate merge, separate-store, duplicate, trace, input, agent-cache, and Obsidian controls preserved.

- [ ] **Step 5: Re-run the original PoC and perform the bypass review**

Re-run the corrected original store-failure case by name:

```bash
node --test --test-name-pattern='merged store fails|replacement store fails|store failure' tests/memory-store-merge-archive-first.test.js
```

Inspect every direct merge and destructive sink:

```bash
rg -n 'findMergeCandidate|callMergeCheck|withDurableMerge|archiveCard\(|memory_store_merge|\.delete\(mergeCandidate|\.store\(mergedEntry' index.js
```

Confirm:

- bridge, Control Room, and model tool converge on the shared boundary;
- no remaining merge path deletes/logs before store plus readback;
- `storeAgentId` is the bridge LLM-cache scope;
- stale same-candidate state cannot bypass revalidation;
- different candidate/agent keys do not collide;
- duplicate, meaningful-difference, fact-loss, embedding-failure, archive-failure, and normal separate-store branches stay non-destructive;
- the alternate readback-null/mismatch class leaves the original active and emits no deletion log.

- [ ] **Step 6: Run preservation, syntax, and authoritative gates**

Run:

```bash
npm run lint
git diff --check
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
```

The serial suite is authoritative. If and only if the known sandbox nested-spawn `EPERM` appears in `tests/setup-feature-crons-symlink.test.js`, run:

```bash
node --test tests/setup-feature-crons-symlink.test.js
```

Record both results and do not classify that harness artifact as a B2 regression. Run the full serial command outside the sandbox if needed for the final authoritative zero-failure gate.

- [ ] **Step 7: Write the receipt, obtain review, and commit only B2**

The B2 receipt and versioned scan fix report must include: source-to-sink, root cause, invariant, exact changed files, baseline, RED, GREEN, owning suite, original PoC, positive merge proof, archive/log proof, serialization proof, BUG-09 agent-scope proof, bypass review, lint/serial results, remaining uncertainty, and confirmation that B7/schema-cache/main were untouched.

Review only the B2 range from pre-B2 base to final head. Resolve every Critical/Important finding through the focused tests, re-review, then stage only B2 files and commit once:

```bash
git add index.js tests/memory-store-merge-archive-first.test.js tests/llm-result-cache-integration.test.js docs/superpowers/plans/2026-07-19-b2-durable-merge.md docs/audits/2026-07-19-bug-02-bug-09-durable-merge-fix.md docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/fix_report.md
git commit -m "fix(memory): make merge replacement durable"
```

Add the dedicated bridge/control regression path to `git add` only if it was created. Finally verify the fix worktree is clean, its branch is correct, and the main checkout still points at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`. Stop; do not begin B7.
