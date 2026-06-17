# P8 Recall Worker Timeout and Event-Loop Correlation Evidence

## 1. Current host / repo / branch

- Host: `vmd190201`
- Repo: `/root`
- Date: 2026-06-17T11:20:25Z (reference)
- Branch: `fix/p8-recall-worker-timeout-and-event-loop-correlation-2026-06-17`
- Base HEAD: `c0fb549` fix(runtime): add gateway pressure backpressure and deploy hygiene (P7)
- Predecessor: P7 `fix/p7-gateway-memory-pressure-and-drift-hygiene-2026-06-17`

## 2. Post-P7 30-minute error window

Window: 2026-06-17 ~10:50–11:20 CEST (30 min) after P7 fixes were live.

| Signature | Count |
|---|---|
| `MemoryDB.store timed out` | 0 |
| `capture worker timed out after 60000ms` | 0 |
| `recall worker timed out after 45000ms` | 1 |
| `queue_full` | 0 |
| `pressure_skip` | 0 |
| `event_loop_delay` liveness warning | 4 |
| Memory pressure warning | 1 |

Store and capture timeouts are fully suppressed by P7 queue/pressure hygiene. The only remaining runtime failure is the recall worker hard timeout.

## 3. Post-P7 60-minute error window

Window: 2026-06-17 ~09:50–10:50 CEST (60 min).

| Signature | Count |
|---|---|
| `recall worker timed out after 45000ms` | 2 |
| `event_loop_delay` liveness warning | 5 |

Recall timeouts correlate with event-loop delay warnings: both windows show recall timeouts appearing shortly after or alongside `event_loop_delay` spikes.

## 4. Gateway process snapshot

Captured at ~2026-06-17 11:18 CEST.

| Metric | Value |
|---|---|
| PID | (stable) |
| VmRSS | ~2.0 GiB |
| `systemctl MemoryCurrent` | stable |
| Threads | stable |
| Machine RAM | ~47 GiB |

Memory is stable and well below P7 critical thresholds. There is no queue backlog (`queue_full=0`, `pressure_skip=0`). The recall worker is still hitting its 45 s hard limit, which points to event-loop starvation rather than memory pressure or queue pileup.

## 5. LanceDB timeouts during event-loop starvation

During the same windows:

| Signature | Count |
|---|---|
| `MemoryDB.vectorSearch timed out` | present |
| `MemoryDB.search.countRows timed out` | present |

These LanceDB calls time out while the event loop is reported as delayed. This suggests that when the event loop is starved, in-flight LanceDB promises also miss their internal deadlines, even though the underlying DB operation may eventually complete. The hard 45 s recall worker timeout then discards whatever partial results were available.

## 6. Current recall worker timeout log

```text
[plugins] memory-lancedb-namespaced: recall worker timed out after 45000ms (background)
```

This log line gives no indication of:

- which recall phase was active when the timeout fired,
- how much time was spent in each phase,
- whether the event loop was delayed,
- whether a partial, safe result could have been returned instead of failing entirely.

## 7. Scheduler structure relevant to P8

- Source: `lib/runtime-scheduler.js`.
- `recallQueue` and per-agent `captureQueues` are now bounded (P7).
- `maxConcurrentRecall = 1`, recall worker hard timeout = 45000 ms.
- `runRecallPipeline` is in `lib/recall-pipeline.js`.
- Callers are in `index.js`.

## 8. Initial hypothesis

1. **Recall hard timeout loses partial results**: the 45 s worker timeout discards the entire recall result even when embedding, vector search, and scoring have already produced usable hits.
2. **No phase visibility**: without per-phase timing, we cannot tell whether timeouts are spent in rerank, graph expansion/hydration, vector search, or elsewhere.
3. **Event-loop starvation is the common correlate**: `event_loop_delay` warnings and LanceDB timeouts cluster with recall timeouts, while memory and queue depth are calm.
4. **A soft budget can make the failure safe**: if a recall call is running out of budget before rerank/graph expansion, it should return the already-scored topN with a trace reason instead of waiting for the hard timeout.

## 9. Watch items

- Confirm memory stays stable (~2 GiB RSS) after P8 instrumentation.
- Verify recall timeout count drops to zero after soft-budget fallback and event-loop correlation are live.
- Check that timeout logs now include active phase, elapsed ms, completed phases, and event-loop lag.
- Ensure no `queue_full` or `pressure_skip` regressions.
