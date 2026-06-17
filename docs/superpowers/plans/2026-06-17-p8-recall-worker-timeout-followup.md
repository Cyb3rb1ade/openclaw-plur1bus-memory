# P8 Followup — Recall Worker Timeout and Event-Loop Correlation

Date: 2026-06-17
Host: vmd190201
Repo: /root
Branch: fix/p8-recall-worker-timeout-and-event-loop-correlation-2026-06-17
Base HEAD: c0fb549 (P7)

## Summary

P7 eliminated store/capture timeouts and bounded scheduler queues, but recall worker hard timeouts persisted and correlated with event-loop delay warnings. P8 adds lightweight phase timing, a soft-budget fallback, and event-loop lag snapshots to the recall critical path so that:

- Timeouts are observable (active phase, elapsed ms, completed phases).
- Event-loop starvation is visible in timeout logs.
- A recall call that exceeds its soft budget returns a safe partial result instead of losing everything at the 45 s hard timeout.

## Evidence

- Post-P7 30-min window (2026-06-17 ~10:50–11:20):
  - 0 store timeouts
  - 0 capture timeouts
  - 1 recall worker timeout
  - 0 queue_full
  - 0 pressure_skip
  - 4 event_loop_delay warnings
  - 1 memory pressure warning
- Post-P7 60-min window:
  - 2 recall worker timeouts
  - 5 event_loop_delay warnings
- LanceDB `vectorSearch` and `countRows` timed out during the same event-loop starvation windows.
- Memory stable at ~2 GiB RSS; no queue backlog.

## Root-cause classification

1. **Hard timeout discards partial results** — the recall worker has a 45 s hard ceiling and no internal budget check, so even when embedding/vector search/scoring have produced usable hits, the timeout fires and returns nothing.
2. **No phase visibility** — the existing timeout log line names only the worker and duration, not which phase was active or how time was distributed.
3. **Event-loop starvation correlation** — `event_loop_delay` warnings and LanceDB timeouts cluster with recall timeouts, while memory and queues are calm.

## Files changed

- `lib/recall-phase-timer.js` (new)
- `lib/event-loop-lag-snapshot.js` (new)
- `lib/recall-pipeline.js`
- `index.js`
- `lib/runtime-scheduler.js`
- `openclaw.plugin.json`
- `tests/recall-phase-timer.test.js` (new)
- `tests/event-loop-lag-snapshot.test.js` (new)
- `tests/recall-pipeline-soft-budget.test.js` (new, or extended existing)
- `tests/runtime-scheduler-recall-timeout-summary.test.js` (new, if feasible)
- `docs/superpowers/plans/2026-06-17-p8-recall-worker-timeout-evidence.md`
- `docs/superpowers/plans/2026-06-17-p8-recall-worker-timeout-and-event-loop-correlation.md`
- `docs/superpowers/plans/2026-06-17-p8-recall-worker-timeout-followup.md`

## Fixes implemented

- **Recall phase timer** (`lib/recall-phase-timer.js`): tracks start/end for each recall phase, enforces a bounded completed-phase list (max 32), and exposes `isSoftBudgetExceeded()`, `activePhase()`, and `summary()`. Does not retain memory text, query text, prompts, or vectors.
- **Event-loop lag snapshot** (`lib/event-loop-lag-snapshot.js`): wraps `perf_hooks.monitorEventLoopDelay` with `enable()` / `disable()` / `snapshot()` and returns cheap histogram stats (`meanMs`, `maxMs`, `p99Ms`, `count`).
- **Recall pipeline soft budget** (`lib/recall-pipeline.js`): accepts an optional `phaseTimer`, marks phase boundaries, and short-circuits to a safe partial result when the soft budget is exceeded. Skips rerank, graph expansion, and graph hydration as appropriate while preserving canonical hits, direct/vector results, and safety/correction memories.
- **Index plumbing** (`index.js`): creates one phase timer per recall call and passes it to `runRecallPipeline` and the scheduler's `runRecall`.
- **Scheduler timeout summary** (`lib/runtime-scheduler.js`): recall worker timeout handler now logs active phase, elapsed ms, completed phases, queue depth, and event-loop lag p99 in a compact single line.
- **Config schema** (`openclaw.plugin.json`): adds `recall.softBudgetMs` (35000), `recall.softBudgetFallback` (true), `recall.eventLoopLagSnapshot` (true), and `runtime.eventLoopLagResolutionMs` (10).

## How to read phase logs

### Soft-budget fallback

When a recall call exceeds its soft budget, the trace will contain:

```json
{
  "reason": "soft_budget_fallback",
  "phaseSummary": {
    "elapsedMs": 35120,
    "softBudgetMs": 35000,
    "hardTimeoutMs": 45000,
    "activePhase": "rerank",
    "completed": [
      { "phase": "embedding", "ms": 120 },
      { "phase": "vector_search", "ms": 800 },
      { "phase": "scoring", "ms": 240 },
      { "phase": "dedup", "ms": 45 }
    ],
    "exceededBudget": true
  }
}
```

This means rerank was started but the soft budget was already gone, so the pipeline returned the scored/deduped topN without reranking.

### Timeout summary

A hard timeout now looks like:

```text
[plugins] memory-lancedb-namespaced: recall worker timed out after 45000ms (background) phase=rerank elapsedMs=45012 completed=embedding:120,vector_search:800,graph:350 queueDepth=0 eventLoopLagP99Ms=842
```

Fields:

- `phase` — phase active when the timeout fired.
- `elapsedMs` — total elapsed since recall start.
- `completed` — comma-separated `phase:ms` list.
- `queueDepth` — recall queue depth at timeout.
- `eventLoopLagP99Ms` — 99th-percentile event-loop lag over the monitoring window (large values indicate loop starvation).

A high `eventLoopLagP99Ms` together with a late active phase (e.g., `rerank`, `graph_hydration`) strongly suggests event-loop starvation rather than a slow single operation.

## Tests

- `node --test tests/recall-phase-timer.test.js` — pass
- `node --test tests/event-loop-lag-snapshot.test.js` — pass
- `node --test tests/recall-pipeline-soft-budget.test.js` — pass
- `node --test tests/runtime-scheduler-recall-timeout-summary.test.js` — pass (if added)
- `npm run lint` — pass
- `npm test` — pass

## Operational rollout

- Branch pushed to origin; not auto-merged to `main`.
- Live extension not hot-deployed without approval.
- A controlled gateway restart is required to load the new modules and config defaults.

## Rollback

- Revert the P8 commits and force-sync the live extension back to `main` (`c0fb549`), then restart the gateway.
- Or switch back to `main` and run `node scripts/verify-plugin-deploy.mjs --repair` followed by a controlled restart.
- No schema/embedding changes are involved.

## Criteria for deciding P9

P9 should be considered if **any** of the following remain true after P8 is live and observed for at least one production cycle:

1. Recall worker hard timeouts continue at a non-zero rate **and** the new logs show the active phase is still `embedding` or `vector_search` with low event-loop lag — this would indicate a LanceDB-level slowness that phase timing cannot fix.
2. Event-loop lag p99 stays elevated (>500 ms) even when recall is idle — this points to a non-memory plugin starving the event loop (e.g., a long-running synchronous computation, a tight loop in another plugin, or excessive logging).
3. Memory begins growing again despite stable queues — this would reopen the P6/P7 native-memory investigation.
4. Soft-budget fallback fires frequently (>1% of recall calls) — this would indicate the 35 s budget is too aggressive or that a specific phase is consistently slow.
5. Safety/correction memory quality degrades because fallback skips rerank/graph too often — this would require a richer fallback strategy.

Do **not** start P9 until P8 has been deployed and the new logs provide evidence for the next failure class.

## Remaining risks

- Soft-budget fallback makes timeouts less severe but does not eliminate event-loop starvation; if another module is starving the loop, recall will still degrade.
- `monitorEventLoopDelay` adds a small per-process overhead; keep `runtime.eventLoopLagResolutionMs` at 10 ms unless profiling shows otherwise.
- The fallback preserves safety/correction memories by retaining already-selected direct/vector results, but skipping rerank may change ranking for non-safety memories.
- Gateway restart is required to load the new modules; until then the live extension still uses the P7-only behavior.
