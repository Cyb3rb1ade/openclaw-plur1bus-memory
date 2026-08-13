# Epistemic and Valid-Time Review Findings Fix Plan

> **For Codex:** Use `superpowers:executing-plans` to implement this plan task by task with test-first checkpoints.

**Goal:** Fix the five confirmed review findings without broadening recall behavior or changing unrelated authorization and ACL semantics.

**Architecture:** Preserve epistemic metadata at every projection and durable-merge boundary, reject invalidated memories in additive boosters, treat exact-text rows as duplicates only when their validity windows are equivalent, and prevent compaction from auto-archiving records with different trust evidence. Each fix is guarded by a regression test that fails against the reviewed commit before the production change is made.

**Tech Stack:** Node.js built-in test runner, JavaScript ES modules, OpenClaw plugin hooks, LanceDB-compatible test doubles.

---

### Task 1: Preserve epistemic status in auto-recall prompt projections

**Files:**
- Modify: `tests/auto-recall-decision-trace.test.js`
- Modify: `index.js`

- [ ] Add a primary-recall integration test whose recalled row has `epistemicStatus: "disputed"` and assert that the rendered `<relevant-memories>` entry is labeled `epistemic="disputed"`.
- [ ] Add a Semantic Lens integration test whose indexed memory has an explicit epistemic status and assert that the rendered lens entry keeps that status.
- [ ] Run `node --test tests/auto-recall-decision-trace.test.js` and confirm the new assertions fail because the mapping drops `epistemicStatus`.
- [ ] Include `epistemicStatus` in both mappings passed to `buildRelevantMemoryContext`.
- [ ] Re-run the focused test file and confirm it passes.

### Task 2: Preserve and revalidate epistemic state during durable merges

**Files:**
- Modify: `tests/memory-store-merge-archive-first.test.js`
- Modify: `index.js`

- [ ] Add a regression test proving that merging into a disputed candidate yields a disputed replacement with explicit merge provenance.
- [ ] Add a race regression test that mutates the selected candidate's epistemic metadata while the replacement embedding is prepared and asserts that no replacement is inserted and no source is archived.
- [ ] Run `node --test tests/memory-store-merge-archive-first.test.js` and confirm both new cases fail.
- [ ] Project all epistemic fields from `MemoryDB.findMergeCandidate`.
- [ ] Derive replacement trust with `combineEpistemicStatusForMerge`, recording `system:merge`, a merge reason, the previous status, and an update timestamp.
- [ ] Include stable epistemic fields in replacement idempotency checks and all epistemic fields in candidate revalidation so trust-only races abort safely.
- [ ] Apply the same replacement construction in both durable merge paths.
- [ ] Re-run the focused test file and confirm it passes.

### Task 3: Keep invalidated memories out of additive boosters

**Files:**
- Modify: `tests/semantic-lens-status-filter.test.js`
- Modify: `tests/conversation-reactivation-recall.test.js`
- Modify: `lib/semantic-lens-index.js`
- Modify: `lib/conversation-reactivation-recall.js`

- [ ] Add Semantic Lens and CRR regression cases containing active rows with `epistemicStatus: "invalidated"`; assert neither booster appends them.
- [ ] Run both focused test files and confirm the new cases fail.
- [ ] Normalize epistemic status at the booster boundary and filter invalidated rows before ranking or appending.
- [ ] Preserve the normalized epistemic status on CRR entries for downstream rendering.
- [ ] Re-run both focused test files and confirm they pass.

### Task 4: Preserve overlapping but different valid-time records

**Files:**
- Modify: `tests/valid-time.test.js`
- Modify: `index.js`

- [ ] Add an integration test with identical text, an existing `[2020, 2025)` record, and an incoming `[2024, 2030)` record; assert the incoming record is stored and remains available for 2027 recall.
- [ ] Run `node --test tests/valid-time.test.js` and confirm the case fails as an incorrect duplicate.
- [ ] Change safe exact-text duplicate suppression to require equivalent normalized validity windows. Disjoint and overlapping-but-different intervals must remain separate records.
- [ ] Re-run the focused test file and confirm it passes.

### Task 5: Prevent compaction from auto-archiving trust conflicts

**Files:**
- Modify: `tests/epistemic-status.test.js`
- Modify: `lib/jobs/memory-compaction.js`

- [ ] Add a compaction regression test with identical text and compatible validity, but a newer trusted row and an older disputed row; assert the disputed row is not auto-archived.
- [ ] Run `node --test tests/epistemic-status.test.js` and confirm the case fails.
- [ ] Retain epistemic actor, reason, previous status, and update timestamp in compaction candidates.
- [ ] Classify identical-text candidates as low-risk duplicates only when all raw epistemic state and provenance fields are equivalent.
- [ ] Re-run the focused test file and confirm it passes.

### Task 6: Verify the combined change set

**Files:**
- Review: all files modified by Tasks 1-5

- [ ] Run the five focused test files together.
- [ ] Run `node --test tests/*.test.js`.
- [ ] Inspect `git diff --check`, `git diff --stat`, and `git status --short`.
- [ ] Confirm no unrelated files, especially `.claude/worktrees/`, are staged or modified.
- [ ] Report verification evidence and any remaining risk; do not push or merge without a separate request.

## Execution Record — 2026-08-13

- Red phase: every added regression failed against `f38f0ee` for the intended reason.
- Green phase: the five focused files excluding Valid-Time pass together (129 tests), and `tests/valid-time.test.js` passes with `--test-isolation=none` (82 tests).
- `npm run lint` passes, and `node --test test/*.test.js` passes (13 tests).
- A sandboxed `node --test tests/*.test.js` run reported seven opaque file-worker exits. Exit instrumentation and out-of-sandbox reproduction proved that all seven were sandbox false negatives, not test or repository failures.
- The official isolated suite outside the sandbox passes: 3,435 tests total, 3,434 passed, 1 skipped, 0 failed (`node --test tests/*.test.js`). Representative direct checks also pass with normal isolation: auto-capture 15/15 and Valid-Time 82/82.
- Release, tag creation, and pull-request creation are explicitly out of scope; `.claude/worktrees/` remains untouched.
