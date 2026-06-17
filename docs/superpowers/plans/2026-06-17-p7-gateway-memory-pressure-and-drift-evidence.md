# P7 Gateway Memory Pressure and Drift Evidence

## 1. Current host / repo / branch

- Host: `vmd190201`
- Repo: `/root`
- Date: 2026-06-17T06:14:11Z (reference)
- Branch: `fix/p7-gateway-memory-pressure-and-drift-hygiene-2026-06-17`
- Base HEAD: `3e114f8` fix(runtime): stabilize memory timeout and context overflow handling
- Predecessor: P6 `fix/runtime-memory-pressure-timeout-stability-2026-06-17` (live HEAD `f607388`, #58)

## 2. Post-P6 30-minute error window

Window: 2026-06-17 ~06:25–06:55 CEST (30 min) after P6 fixes were live.

| Signature | Count |
|---|---|
| `MemoryDB.store timed out` | 2 |
| `capture worker timed out after 60000ms` | 1 |
| `recall worker timed out after 45000ms` | 2 |
| Memory pressure warning | 6 |
| `event_loop_delay` liveness warning | 6 |

These counts are markedly lower than the pre-P6 2-hour window (190× store timeout, 23× recall timeout, 19× capture timeout), but they are still residual noise that produces false-positive pressure warnings and occasional background-worker timeouts.

## 3. Gateway process snapshot

Captured at ~2026-06-17 06:56 CEST.

| Metric | Value |
|---|---|
| PID | 1293031 |
| VmRSS | ~2.55 GiB |
| VmHWM | ~2.80 GiB |
| `systemctl MemoryCurrent` | ~5.15 GiB |
| `systemctl MemoryPeak` | ~5.34 GiB |
| Threads | 29 |
| Machine RAM | ~47 GiB |

## 4. Memory pressure threshold analysis

- The memory pressure warning is firing at an RSS threshold of **1.5 GiB**.
- Observed stable loaded baseline is **~2.5 GiB RSS** (process) / **~5.1 GiB `MemoryCurrent`** (cgroup).
- RSS is **not growing** over the observation window; HWM and peak are within a few hundred MiB of current values.
- Machine RAM is ample (~47 GiB), so the process is not resource-constrained at this baseline.

### Stable-baseline conclusion

The pressure warnings are **false positives relative to the actual loaded baseline**. The threshold of 1.5 GiB is too aggressive for a production instance that legitimately holds LanceDB/Arrow buffers, embedding cache, and multiple agent DB handles at ~2.5 GiB RSS. The residual timeouts correlate with background capture/recall bursts rather than a runaway memory leak.

## 5. Plugin version drift

Output of `openclaw gateway status --deep`:

```text
Plugin version drift: 1 active official plugin not on gateway 2026.6.8
- codex: 2026.6.5 (npm) → expected 2026.6.8
Fix: openclaw plugins update <plugin-id> for each drifted plugin, then openclaw gateway restart.
```

This is a metadata/version drift issue only; it does not block memory runtime function, but it is flagged by deploy-integrity checks and should be resolved as part of P7 hygiene.

## 6. Missing deploy-guard reference

`scripts/protect-plur1bus-deploy.sh` references `scripts/cleanup-stores.mjs` in its `FILES` array (line 49), but the file does **not** exist in `/root/scripts/`:

```text
49:  scripts/cleanup-stores.mjs
```

This causes the deploy-integrity guard to attempt drift detection / restore logic against a missing source file. It is operational hygiene only; no memory data should be deleted to satisfy this reference.

## 7. Scheduler structure relevant to P7

- Source: `lib/runtime-scheduler.js` (also mirrored in `.openclaw/extensions/memory-lancedb-namespaced/lib/runtime-scheduler.js`).
- Current behavior:
  - `recallQueue` is unbounded.
  - Per-agent `captureQueues` are unbounded.
  - `maxConcurrentRecall = 1`.
  - `maxConcurrentCapturePerAgent = 1`.
- Plugin main (`index.js`) uses `runtimeScheduler.enqueueCapture` and `runtimeScheduler.runRecall` for auto-capture and auto-recall.

## 8. Initial hypothesis

1. **False-positive pressure threshold**: the 1.5 GiB warning threshold is below the legitimate loaded baseline, producing noisy warnings that mask real pressure.
2. **Queue/backlog pileups**: unbounded background recall/capture queues allow low-priority jobs to accumulate when the event loop or LanceDB is slow, which drives residual worker timeouts even though absolute memory is stable.
3. **Plugin drift is metadata only**: `codex` is an official npm plugin that is simply behind the gateway target version; `openclaw.plugin.json` is not the cause.
4. **Missing cleanup-stores reference is stale hygiene**: the deploy guard references a script that was never created or was removed; the fix is to guard/remove the reference, not to introduce a destructive cleanup routine.

## 9. Watch items

- Confirm RSS stays within ~2.5–3.0 GiB process / ~5.0–5.5 GiB cgroup after threshold tuning.
- Verify residual timeout count drops to zero after bounding background queues.
- Re-run `openclaw gateway status --deep` after resolving `codex` drift.
- Re-run `node scripts/verify-plugin-deploy.mjs` after guarding the `cleanup-stores.mjs` reference.
