# B4 Auto-Capture Checkpoint Fix Receipt

Date: 2026-07-19
Batch: B4
Finding: BUG-ADD-01
Branch: `fix/high-mid-b4-auto-capture`
Fix base: `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2`
Outcome: **fixed at the auto-capture boundary; focused, owning, and repository-wide serial gates pass**

## Reachable failure and root cause

The production path was:

```text
cron main()
  -> captureAgent(agentId, embeddings)
  -> readSessionLinesSinceOffset(file, state.files[name])
  -> stage state.files[name] = nextOffset before persistence
  -> embedBatch / per-item embed
  -> semantic and in-batch duplicate filtering
  -> table.add(batch) / table.add(row) fallback
  -> saveState() with the staged EOF even after failures
  -> return items.length after `items` left block scope
```

The state therefore represented scan progress rather than durable acknowledgement. Any embedding or insert failure could still checkpoint the failed input at EOF, permanently skipping it on restart. Random row UUIDs and no exact readback also made the store-success/checkpoint-crash boundary non-idempotent. Filename plus numeric size could not distinguish a replacement or truncation, and the success return referenced a file-loop variable outside its scope.

## Restored invariant and implementation

Each complete JSONL record now has its ending byte offset and an acknowledgement bit. A selected candidate remains unacknowledged until one of these conditions holds:

- an exact deterministic row ID already resolves to one active row with the expected text, agent, and a finite vector of the configured dimensions;
- the existing semantic duplicate policy proves the content is already represented; or
- the candidate is inserted and an exact ID readback verifies ID, text, agent, active status, and vector content.

The state writer persists only the greatest contiguous acknowledged record boundary. It runs after durable milestones, uses a versioned per-file entry, and replaces its state file through a same-directory temporary file plus rename. Legacy numeric and `lastFile`/`lastSize` states remain readable.

The per-file checkpoint is now:

```json
{
  "offset": 123,
  "identity": "device:inode",
  "fingerprint": "sha256-of-boundary-windows"
}
```

Identity change, size regression, or acknowledged-prefix fingerprint mismatch restarts the filename at byte zero. A file that changes while a capture run is active is invalidated and left at a zero checkpoint for the next run. Normal append preserves identity and resumes from the prior boundary.

Each candidate UUID is deterministically derived from the safe agent ID, source filename, file identity, complete-record end offset, and captured text. Restart checks that ID before embedding. Batch embeddings, the per-item embedding fallback, ANN/in-batch deduplication, batch insert, per-row insert recovery, the 50-item selection cap, URL priority, group/sender attribution, schema fields, and per-agent DB/state separation remain in place. Invalid/non-finite/wrong-dimension vectors and unresolved duplicate checks remain unacknowledged.

If a batch add throws after a partial write, exact readback recognizes rows already present and the fallback inserts only absent rows. Every inserted row is read back before acknowledgement. The fixed return uses function-scoped `stored` and `toCapture.length` counters.

## TDD evidence

### Baseline

Before production edits:

```text
$ node --test tests/auto-capture-import.test.js tests/auto-capture-batch.test.js
tests 2; pass 2; fail 0
```

### Causal RED

The new restartable CLI fixture uses a temporary OpenClaw home, real session JSONL files, persistent fake LanceDB storage, and separate Node processes:

```text
$ node tests/auto-capture-checkpoint.test.js
tests 9; pass 1; fail 8
```

The normal positive control exposed `items is not defined` and reported `stored=0, candidates=0, errors=1` after writing rows/state. Total and partial embedding failures and total and partial insert failures advanced the offset to EOF. A post-add process crash left a row but no checkpoint and could generate a second random row on retry when semantic dedup was disabled. Smaller replacement and in-place truncation files remained skipped. Only the unchanged-restart control passed.

Three additional durability assertions were first observed RED and then fixed:

```text
$ node --test --test-name-pattern='store-before-checkpoint crash' tests/auto-capture-checkpoint.test.js
RED: retry called an empty embedding batch
GREEN: 1/1 matching test passed

$ node --test --test-name-pattern='vector is not durable' tests/auto-capture-checkpoint.test.js
RED: a crash row with an empty vector was acknowledged
GREEN: 1/1 matching test passed

$ node --test --test-name-pattern='wrong dimensions' tests/auto-capture-checkpoint.test.js
RED: an invalid provider vector was stored and acknowledged
GREEN: 1/1 matching test passed
```

### Final focused and owning GREEN

```text
$ node --test tests/auto-capture-import.test.js tests/auto-capture-batch.test.js tests/auto-capture-checkpoint.test.js
tests 29; pass 29; fail 0; duration_ms 3389.791547
```

The original 14 realistic checkpoint cases prove normal counters, total/partial embedding failure, wrong dimensions, duplicate-query failure, total/partial insert failure, deterministic post-store crash retry, missing-vector and hidden-readback rejection, smaller replacement rotation, in-place truncation, unchanged restart, and normal append.

The two existing owning files preserve stream/import helpers, provider batch behavior and fallback, semantic and in-batch deduplication, and exported source contracts.

### Independent-review fix wave: live stat/open rotation

Independent review found that the initial pathname `statSync()` and later pathname `createReadStream()` were not bound to the same open file. An atomic replacement after identity capture but before stream open therefore let replacement bytes inherit the predecessor identity. The later checkpoint invalidation reset the replacement to offset zero but did not abort those already-collected writes, so retry derived a second deterministic ID from the replacement's real identity.

The regression preloads the production CLI child only for this case and performs a real atomic rename immediately after the target session's `stat`/`fstat` identity capture. It supports both the reviewed implementation and the descriptor-bound fix, so the same scheduling trigger remains causal across RED and GREEN.

Before the production fix:

```text
$ node tests/auto-capture-checkpoint.test.js
tests 15; pass 14; fail 1
binds live-rotation bytes to their opened file identity:
actual first-run row:   User: Live replacement memory must be captured exactly once.
expected first-run row: User: Opened predecessor memory must retain its own source identity.
```

The production fix opens each session once, derives device/inode and the prior-prefix fingerprint with `fstat`/positioned reads on that descriptor, and passes the same caller-owned descriptor to the stream with `autoClose: false`. The capture boundary closes it in `finally`. Checkpoint snapshots likewise open once and derive identity plus fingerprint from that one descriptor. If the pathname rotates after the capture descriptor is opened, the run reads and tags only predecessor bytes; the path recheck invalidates to the replacement's identity at offset zero, and the next run captures the replacement exactly once.

Fresh focused/owning GREEN after the fix:

```text
$ node tests/auto-capture-checkpoint.test.js
tests 15; pass 15; fail 0; duration_ms 3249.684126

$ node --test tests/auto-capture-import.test.js tests/auto-capture-batch.test.js
tests 15; suites 2; pass 15; fail 0; duration_ms 2078.182767

$ node --check scripts/auto-capture-lancedb.mjs
$ node --check tests/auto-capture-checkpoint.test.js
$ node -e 'import("./scripts/auto-capture-lancedb.mjs").then(() => console.log("import ok"))'
$ npm run lint
$ git diff --check
all exit 0
```

After the coordinator granted and B6 released the exclusive serial lane, the exact post-review authoritative command passed and the lane was released immediately:

```text
$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2597; suites 503; pass 2596; fail 0; cancelled 0; skipped 1; todo 0
duration_ms 397051.231501
```

## Original trigger and restart proof

The final realistic checkpoint file is the strongest original BUG-ADD-01 trigger. Its failure injections show:

- an unresolved first record pins the checkpoint before it while a durable prefix advances exactly to its final newline;
- restart stores only the failed suffix and does not add the durable prefix again;
- a process exit immediately after `table.add()` leaves offset zero, then retry finds the same deterministic row without embedding or another add;
- an insert hidden from readback is not acknowledged; a later visible retry reuses that row;
- replacement inode and in-place size regression both restart at byte zero; and
- unchanged restart stores nothing, while normal append stores exactly the appended record.

## Bypass, alternate-failure, and preservation review

`captureAgent()` has one direct production caller, `main()`. No second insert/checkpoint path exists in the script. State writes converge on `saveState()`, and capture inserts converge on the exact readback/acknowledgement loop. The exported stream and batch-dedup helpers remain covered by their original tests.

Reviewed restart boundaries include failure before embedding, partial embedding, duplicate-query failure, batch failure before any write, ambiguous partial batch write, per-row fallback failure, successful write before readback, successful readback before checkpoint, process crash after store, state rollback/loss, replacement, truncation, unchanged restart, and append. In every unresolved case the contiguous offset stays before the record; replay uses the same row identity.

Non-candidate, filtered, unparsable, and selection-cap records retain the old policy of being skipped and acknowledged. This avoids changing capture selection behavior while ensuring a selected unresolved candidate blocks advancement across its record.

No feature gates, plugin config, `index.js`, aggregate `fix_report.md`, or another batch were changed.

## Verification gates

```text
$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2596; suites 503; pass 2595; fail 0; cancelled 0; skipped 1; todo 0
duration_ms 374072.779819
```

The original authoritative suite ran outside the nested-spawn sandbox restriction in its coordinated exclusive serial lane. The independent-review fix wave reran the same exact serial command in a newly granted exclusive lane; its fresh 2,597-test result is recorded above.

Final static and scope gates:

```text
$ node --check scripts/auto-capture-lancedb.mjs
exit 0

$ node --check tests/auto-capture-checkpoint.test.js
exit 0

$ node -e 'import("./scripts/auto-capture-lancedb.mjs").then(() => console.log("import ok"))'
import ok; exit 0

$ npm run lint
exit 0

$ git diff --check
exit 0
```

The direct-caller review found only `main() -> captureAgent()`, one `saveState()` definition called by the checkpoint writer, and the intended batch/per-row `table.add()` sites. The original `main` checkout remained clean at its pin.

## Changed files

- `scripts/auto-capture-lancedb.mjs`
- `tests/auto-capture-checkpoint.test.js` (new)
- `docs/audits/2026-07-19-b4-auto-capture-checkpoint-fix.md` (new)

## Remaining uncertainty and non-claims

- Atomic rename prevents a torn JSON state file, but the script does not fsync the state file and parent directory. A power-loss rollback can replay records; deterministic IDs plus exact readback keep that replay idempotent.
- The checkpoint fingerprint hashes the first and final 2 KiB of the acknowledged prefix, not every byte of a potentially large session. Identity, size regression, and boundary windows cover normal replacement/truncation; a same-inode, same-size rewrite that also preserves both sampled windows is not claimed detectable.
- Deterministic IDs and readback make sequential crash/restart idempotent. There is no new cross-process lock or LanceDB uniqueness transaction in B4, so two independently overlapping auto-capture processes could race between the same absent-ID check and insert. Cron admission/concurrency is outside BUG-ADD-01's sequential checkpoint scope.
- Exact readback assumes LanceDB's normal read-after-write visibility. A row not yet visible remains safely unacknowledged and is retried later.

## Integrity

- Work began on the pinned B4 base `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2` in the required isolated worktree.
- Original `main` remained at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e` while B4 was developed.
- No push, merge, destructive data operation, shared aggregate receipt edit, or other batch work was performed.
