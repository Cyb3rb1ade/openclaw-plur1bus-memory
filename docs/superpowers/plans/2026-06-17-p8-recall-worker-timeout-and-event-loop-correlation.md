# P8 Recall Worker Timeout and Event-Loop Correlation Plan

## 1. Goal

Reduce recall-worker hard timeouts on `vmd190201` by making the recall critical path observable, budget-aware, and resilient to event-loop starvation:

- Add lightweight per-phase timing inside `runRecallPipeline` so we know where the 45 s budget is spent.
- Introduce a recall soft budget (default 35 s) with a safe fallback that returns already-scored topN results instead of losing everything to the 45 s hard timeout.
- Capture event-loop lag snapshots so timeout logs correlate recall delay with loop starvation.
- Keep the hard timeout at 45 s unchanged.
- Preserve all P7 queue/pressure behavior.

## 2. Non-goals

- No LanceDB schema change.
- No embedding model or vector dimension change.
- No DB migration or re-embedding.
- No deletion of existing memory data.
- No cronjob or service topology changes.
- No queue rework or weakening of P7 bounded queues / pressure gate.
- No weakening of safety guards #49–#58.
- No automatic merge to `main` or unapproved gateway restart.

## 3. Current production evidence

- Host: `vmd190201`, repo `/root`, branch `fix/p8-recall-worker-timeout-and-event-loop-correlation-2026-06-17`, base HEAD `c0fb549` (P7).
- Post-P7 30-min window (2026-06-17 ~10:50–11:20):
  - 0× `MemoryDB.store timed out`
  - 0× `capture worker timed out after 60000ms`
  - 1× `recall worker timed out after 45000ms`
  - 0× `queue_full`
  - 0× `pressure_skip`
  - 4× `event_loop_delay` liveness warning
  - 1× memory pressure warning
- Post-P7 60-min window:
  - 2× `recall worker timed out after 45000ms`
  - 5× `event_loop_delay` liveness warning
- LanceDB `vectorSearch` and `countRows` also timed out during event-loop starvation windows.
- Memory stable at ~2 GiB RSS, no queue backlog.

## 4. Failure class and root cause

### Recall critical path blocked by event-loop starvation

- P7 eliminated store/capture timeouts and bounded the scheduler queues.
- Recall still has a 45 s hard worker timeout and no internal budget check.
- When the event loop is starved, LanceDB promises miss their deadlines and expensive phases (rerank, graph expansion/hydration) extend the critical path.
- At 45 s the worker timeout fires and **discards all results**, even if embedding + vector search + scoring already produced safe, ranked candidates.
- Current timeout logs contain no phase or event-loop context, making root-cause diagnosis impossible from the log line alone.

## 5. Proposed minimal fixes

### 5.1 Recall phase timer (`lib/recall-phase-timer.js`)

- Export `createRecallPhaseTimer({ softBudgetMs = 35000, hardTimeoutMs = 45000, logger })`.
- Phases: `embedding`, `vector_search`, `query_refinement`, `temporal`, `canonical`, `scoring`, `graph`, `graph_hydration`, `budget`, `rerank`, `dedup`, `acl`, `finalize`.
- API:
  - `start(phase)` / `end(phase)` — record phase elapsed time.
  - `fail(phase, error)` — record phase failure with safe message.
  - `elapsedMs()` — total elapsed since first start.
  - `isSoftBudgetExceeded()` — true if elapsed > `softBudgetMs`.
  - `activePhase()` — current open phase or `null`.
  - `summary()` — compact summary object.
- Completed phase list bounded to 32 entries; drop oldest on overflow.
- Do **not** retain memory text, query text, prompts, or vectors.

### 5.2 Event-loop lag snapshot (`lib/event-loop-lag-snapshot.js`)

- Export `createEventLoopLagSnapshot({ enabled = true, resolutionMs = 10 } = {})`.
- Use `perf_hooks.monitorEventLoopDelay({ resolution })` when enabled.
- API: `enable()`, `disable()`, `snapshot()`.
- `snapshot()` returns `{ available: true, meanMs, maxMs, p99Ms, count }` or `{ available: false }`.
- Cheap and safe: only read the histogram, no heavy sampling.

### 5.3 Recall pipeline integration (`lib/recall-pipeline.js`)

- Accept a new optional argument `phaseTimer`.
- At every major phase boundary call `phaseTimer.start(phase)` before async work and `phaseTimer.end(phase)` after.
- If `phaseTimer.isSoftBudgetExceeded()` after a phase:
  - Skip rerank and return boosted/deduped topN so far.
  - Skip graph expansion if not yet done.
  - Skip graph hydration if soft budget hit after graph.
  - Preserve `canonicalHits` and any already-selected direct/vector results.
  - Add trace reason `soft_budget_fallback` and compact `phaseSummary` if a `decisionTrace` is present.
- Do **not** change successful-recall semantics when the soft budget is not hit.
- Keep hard timeout 45000 ms unchanged.

### 5.4 Index entry point (`index.js`)

- Create one `phaseTimer` per recall call.
- Pass it to `runRecallPipeline`.
- Pass it to the scheduler's `runRecall` so the timeout handler can read the summary.

### 5.5 Scheduler timeout logging (`lib/runtime-scheduler.js`)

- Import `createRecallPhaseTimer` and `createEventLoopLagSnapshot`.
- In the recall worker timeout handler, log a compact summary:
  ```text
  recall worker timed out after 45000ms (background) phase=rerank elapsedMs=45012 completed=embedding:120,vector_search:800,graph:350 queueDepth=... eventLoopLagP99Ms=...
  ```
- Include event-loop lag snapshot if available.
- Preserve existing P7 queue/pressure behavior.

### 5.6 Config schema (`openclaw.plugin.json`)

- Add `recall.softBudgetMs` (default 35000).
- Add `recall.softBudgetFallback` (default true).
- Add `recall.eventLoopLagSnapshot` (default true).
- Add `runtime.eventLoopLagResolutionMs` (default 10) if needed.

## 6. Code surfaces

- `lib/recall-phase-timer.js` — new.
- `lib/event-loop-lag-snapshot.js` — new.
- `lib/recall-pipeline.js` — phase boundaries and soft-budget fallback.
- `index.js` — per-recall timer creation and plumbing.
- `lib/runtime-scheduler.js` — compact timeout summary, event-loop lag inclusion.
- `openclaw.plugin.json` — new config keys.

## 7. Test plan

Add the following tests and run targeted suites:

- `tests/recall-phase-timer.test.js`
  - Start/end records phase elapsed time.
  - `isSoftBudgetExceeded()` is true after elapsed > `softBudgetMs`.
  - Summary contains expected fields and bounded completed list.
  - No raw memory/query/prompt data is retained.
- `tests/event-loop-lag-snapshot.test.js`
  - Enabled snapshot returns histogram stats.
  - Disabled snapshot returns `{ available: false }`.
  - `enable()` / `disable()` toggle correctly.
- `tests/recall-pipeline-soft-budget.test.js` (or extend `tests/recall-pipeline-timeout.test.js`)
  - Slow rerank triggers soft-budget fallback and returns topN.
  - Slow graph expansion is skipped; graph hydration is skipped if budget hit after graph.
  - Safety/correction memories are retained.
  - `soft_budget_fallback` appears in trace and `phaseSummary` is present.
- `tests/runtime-scheduler-recall-timeout-summary.test.js` (if feasible)
  - Timeout log includes active phase, elapsed ms, completed phases, queue depth, and event-loop lag.

Existing tests:

- `npm test`
- `npm run lint`

If any existing test fails due to the new optional `phaseTimer` argument, fix it without weakening P6/P7 guards.

## 8. Production rollout plan

1. Open PR from `fix/p8-recall-worker-timeout-and-event-loop-correlation-2026-06-17` to `main`.
2. Do **not** auto-merge; wait for review and approval.
3. On approval, sync `/root` to the merged `main` HEAD.
4. Run verification:
   - `npm run lint`
   - `npm test`
5. Sync live extension via `scripts/verify-plugin-deploy.mjs --repair` or equivalent.
6. **Gateway restart**: only after explicit approval. Restart must be controlled (one restart, watch logs for 5 min).
7. Post-restart read-only verification:
   - Watch for recall worker timeouts.
   - Confirm new timeout logs include phase, elapsed, and event-loop lag.
   - Confirm soft-budget fallback does not return lower-quality safety/correction results.
   - Verify `queue_full` / `pressure_skip` remain at zero under normal load.

## 9. Rollback

- Revert the P8 commit(s) on the branch, or switch `/root` back to `main` HEAD `c0fb549`.
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
- P6/P7 caps, queues, and timeouts remain in force.
- Recall hard timeout remains 45000 ms.

## 11. Risks

- Soft-budget fallback may skip rerank/graph expansion during legitimate slow queries; the fallback still returns scored direct/vector topN and records the reason, so the result is safe but potentially less rich.
- Event-loop lag snapshot uses `monitorEventLoopDelay`, which has a small per-process overhead; resolution is set to 10 ms by default to keep cost negligible.
- If event-loop starvation is caused by a module outside the memory plugin, P8 will log it but cannot fix the root cause; that may require a P9 focused on the offending module.
- Adding `phaseTimer` plumbing touches `index.js`, `lib/recall-pipeline.js`, and `lib/runtime-scheduler.js`; regression tests must cover the non-timer path (existing callers) as well as the new path.
