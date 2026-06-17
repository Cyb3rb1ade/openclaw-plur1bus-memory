# P7 Gateway Memory Pressure and Drift Hygiene Plan

## 1. Goal

Reduce residual timeout pressure and memory warnings on `vmd190201` after P6 without hiding real problems:

- Stop false-positive memory pressure warnings caused by a threshold below the legitimate loaded baseline.
- Eliminate residual capture/recall worker timeouts driven by unbounded background queues.
- Resolve the `codex` plugin version drift flagged by `openclaw gateway status --deep`.
- Fix the stale `scripts/cleanup-stores.mjs` reference in the deploy-integrity guard.

## 2. Non-goals

- No LanceDB schema change.
- No embedding model or vector dimension change.
- No DB migration or re-embedding.
- No deletion of existing memory data.
- No cronjob or service topology changes.
- No weakening of P6 safety guards #49–#58.
- No breaking of P6 caps/timeouts.
- No automatic merge to `main` or unapproved gateway restart.

## 3. Current production evidence

- Host: `vmd190201`, repo `/root`, branch `fix/p7-gateway-memory-pressure-and-drift-hygiene-2026-06-17`, base HEAD `3e114f8`.
- Post-P6 30-min window (2026-06-17 ~06:25–06:55):
  - 2× `MemoryDB.store timed out`
  - 1× `capture worker timed out after 60000ms`
  - 2× `recall worker timed out after 45000ms`
  - 6× memory pressure warning
  - 6× `event_loop_delay` liveness warning
- Gateway snapshot at ~06:56:
  - PID 1293031, VmRSS ~2.55 GiB, VmHWM ~2.80 GiB
  - `systemctl MemoryCurrent` ~5.15 GiB, `MemoryPeak` ~5.34 GiB
  - 29 threads, machine RAM ~47 GiB
- Memory pressure warnings fire at RSS 1.5 GiB; stable loaded baseline is ~2.5 GiB RSS and not growing.
- Plugin drift: `codex 2026.6.5 (npm) → expected 2026.6.8`.
- Missing file: `scripts/protect-plur1bus-deploy.sh` references `scripts/cleanup-stores.mjs` (line 49), which does not exist.

## 4. Failure classes and root causes

### A. False-positive pressure threshold
- The pressure gate currently warns at 1.5 GiB RSS, which is below the observed stable loaded baseline of ~2.5 GiB.
- Result: repeated warnings that do not indicate a real problem and desensitize operators to actual pressure.

### B. Unbounded background queues
- `lib/runtime-scheduler.js` maintains an unbounded `recallQueue` and per-agent `captureQueues`.
- Under event-loop or LanceDB pressure, low-priority auto-capture/auto-recall jobs back up and eventually exceed their worker timeouts (60 s capture, 45 s recall).
- Explicit user operations share the same queue and are also at risk of being delayed or dropped.

### C. Plugin version drift
- `codex` is installed from npm at `2026.6.5` while the gateway target is `2026.6.8`.
- This is a version-metadata mismatch flagged by deploy-integrity checks; it is not known to affect memory runtime function.

### D. Stale deploy-guard reference
- `scripts/protect-plur1bus-deploy.sh` expects `scripts/cleanup-stores.mjs` to exist for drift/restore comparison.
- The file is missing, so the guard generates false-positive drift/restore attempts.

## 5. Proposed minimal fixes

### 5.1 Runtime pressure gate (`lib/runtime-pressure-gate.js`)
- Export `checkRuntimePressure(opts)` returning `{level, reason, rssBytes, thresholdBytes}`.
- Use `process.memoryUsage().rss` and `process.memoryUsage().heapUsed`.
- Defaults:
  - `warning` at 3.0 GiB (`3221225472` bytes)
  - `critical` at 4.5 GiB (`4831838208` bytes)
- Levels: `none` < `warning` < `critical`.

### 5.2 Bounded operation queue (`lib/bounded-operation-queue.js`)
- Export `makeBoundedQueue({maxDepth, onEvict})` (or equivalent queue-cap helper).
- Track depth and, when full, drop the oldest low-priority job and invoke `onEvict` with structured metadata.
- Preserve explicit/user operations; only background/low-priority jobs are eligible for eviction.

### 5.3 Scheduler integration (`lib/runtime-scheduler.js`)
- Import and use `runtime-pressure-gate`.
- Add config keys with defaults:
  - `maxQueueDepthRecall = 20`
  - `maxQueueDepthCapturePerAgent = 10`
  - `pressureGateEnabled = true`
  - `rssWarningBytes = 3221225472`
  - `rssCriticalBytes = 4831838208`
- Before enqueuing a background/low-priority job:
  - If pressure level is `critical`, skip it.
  - If pressure level is `warning`, skip low-priority jobs only.
  - Log structured skip event with `operation`, `reason`, `pressureLevel`, `rss`.
- Cap `recallQueue` and per-agent `captureQueues` depth:
  - When full, drop the oldest low-priority job.
  - Log `queueDepth`, `activeCount`, `operation`, `durationMs`, `timeoutMs`.
- Ensure explicit user operations are **never** silently dropped; they may be delayed but must return an explicit error if they cannot be accepted.
- Preserve existing timeout/abort behavior and all P6 recall/capture timeouts.
- Update `status()` to expose `queueDepth`, `pressureLevel`, `rssBytes`, and `thresholdBytes`.

### 5.4 Threshold tuning evidence/document
- Record the observed stable baseline (~2.5 GiB RSS / ~5.1 GiB cgroup) and the chosen thresholds (3.0 GiB warning, 4.5 GiB critical) in this plan and the evidence doc.
- Rationale: thresholds are set above the stable baseline but well below machine RAM and the existing P6 safety boundaries, so real growth will still be caught.

### 5.5 Plugin drift resolution (`codex`)
- Run `openclaw plugins update codex`.
- Re-run `openclaw gateway status --deep` to confirm drift is gone.
- If the update requires a gateway restart, **stop and request approval** before restarting.
- Do not modify `openclaw.plugin.json`; the drift is in the npm-installed plugin version, not the repo metadata.

### 5.6 Deploy-guard hygiene (`scripts/protect-plur1bus-deploy.sh`)
- Remove `scripts/cleanup-stores.mjs` from the `FILES` array (or make its comparison conditional with a guard so a missing source does not cause drift/restore attempts).
- Add a comment explaining why the reference was removed/guarded.
- Do **not** create a destructive cleanup script.
- Validate with `bash -n scripts/protect-plur1bus-deploy.sh` and `node scripts/verify-plugin-deploy.mjs`.

## 6. Code surfaces

- `lib/runtime-pressure-gate.js` — new.
- `lib/bounded-operation-queue.js` — new.
- `lib/runtime-scheduler.js` — pressure gate, queue caps, structured logging, status object.
- `index.js` — unchanged in interface; relies on scheduler behavior.
- `scripts/protect-plur1bus-deploy.sh` — missing-file guard.
- `openclaw plugin` CLI — for codex update only.

## 7. Test plan

Add the following tests and run targeted suites:

- `tests/runtime-pressure-gate.test.js`
  - Returns `none` when RSS is below warning.
  - Returns `warning` between thresholds.
  - Returns `critical` above critical threshold.
  - Configurable thresholds override defaults.
- `tests/bounded-operation-queue.test.js`
  - Enqueue up to `maxDepth` succeeds.
  - Enqueue beyond `maxDepth` evicts oldest low-priority job and calls `onEvict`.
  - High-priority/explicit jobs are not evicted when low-priority jobs exist.
- `tests/runtime-scheduler-pressure.test.js` (or extend existing scheduler tests)
  - Background job is skipped under `critical` pressure.
  - Explicit/user job is still accepted under `critical` pressure (or returns an explicit error if rejected, not silently dropped).
  - Queue cap drops oldest low-priority job and logs required fields.
  - `status()` includes `queueDepth`, `pressureLevel`, `rssBytes`, `thresholdBytes`.

Existing tests:

- `npm test` (or targeted `node --test` commands for the files above).
- `npm run lint`.
- `bash -n scripts/protect-plur1bus-deploy.sh`.
- `node scripts/verify-plugin-deploy.mjs`.

If any existing test fails due to the scheduler changes, fix it without weakening P6 guards.

## 8. Production rollout plan

1. Open PR from `fix/p7-gateway-memory-pressure-and-drift-hygiene-2026-06-17` to `main`.
2. Do **not** auto-merge; wait for review and approval.
3. On approval, sync `/root` to the merged `main` HEAD.
4. Run verification:
   - `npm run lint`
   - `npm test`
   - `bash -n scripts/protect-plur1bus-deploy.sh`
   - `node scripts/verify-plugin-deploy.mjs`
5. If `codex` drift was not already resolved, run `openclaw plugins update codex` and re-verify with `openclaw gateway status --deep`.
6. **Gateway restart**: only after explicit approval and verified deploy. Restart must be controlled (one restart, watch logs for 5 min).
7. Post-restart read-only verification:
   - Watch for memory pressure warnings at or above the new warning threshold.
   - Watch for capture/recall worker timeouts.
   - Confirm `openclaw gateway status --deep` shows no plugin drift.

## 9. Rollback

- Revert the P7 commit(s) on the branch, or switch `/root` back to `main` HEAD `3e114f8`.
- If the gateway was restarted, a second controlled restart on the reverted code may be required; treat it as an explicit approval step.
- No schema/embedding changes are involved, so rollback does not require data migration.

## 10. Invariants

- Embedding model: unchanged.
- Vector dimensions: unchanged.
- LanceDB schema: unchanged.
- No migrations; no re-embedding.
- No deletion of existing memory records.
- No cronjob or service topology changes.
- Safety guards #49–#58 remain intact.
- P6 recall/capture timeouts remain in force.

## 11. Risks

- Raising the pressure threshold removes false positives but requires discipline: if real RSS growth resumes, the 4.5 GiB critical threshold is still well below machine RAM and will catch it.
- Dropping background jobs may reduce auto-capture/auto-recall coverage during high-pressure bursts; explicit user operations are protected.
- `codex` update may require a gateway restart; this must be approved and done in a controlled window.
- If LanceDB or native memory growth resumes independent of queue pressure, further native-memory investigation may be needed.
