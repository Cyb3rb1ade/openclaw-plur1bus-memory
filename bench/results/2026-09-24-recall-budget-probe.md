# Recall budget probe — re-run after Task 14 (2026-09-24)

Task 14 replaced the M1a `recallTimingSink` test seam with `RecallResult.timing`
(filled on every scheduled recall) and the `recall.completed` host event.
`bench/recall-budget-probe.mjs` was switched to read `timing` through that
event instead of the old sink option, and is re-run here per the task's
Step 3, against `2026-09-22-recall-budget-probe.md`
(`node bench/recall-budget-probe.mjs --iterations 20` and `--iterations 20
--scale 5`, same eight `golden-prefix` fixture scenarios — nine minus
`recall-maintenance-only`/`recall-aborted`, which never reach the recall
pipeline, plus `recall-aborted` and `jobs-ledger-retry`, which did not exist
on 2026-09-22, `jobs-ledger-retry` being a job scenario this probe does not
measure).

**Read this with its caveats, not just its numbers** (same caveats as
2026-09-22, restated):

- **Stub embedder, no reranker, tiny synthetic corpus.** This is the
  pipeline's *floor* (orchestration, LanceDB open/query, context formatting),
  not a production distribution. `embed p50` is ~0 ms throughout because the
  embedder here does synchronous vector math, not a real model call.
- **`setup` vs `recall` vs `total`.** Only the `recall` column and the
  per-phase tables are relevant to the B6 budget; `setup` is fixture cost
  specific to this harness.
- **N=20 quantile artifact.** With exactly 20 samples, nearest-rank flooring
  puts p95 (index `floor(0.95*20)=19`) and p99 on the same sample — the
  maximum. `p95 === p99` throughout is that artifact, not a bug.
- **Per-phase table structure** is unchanged: `namespace-recall` is the
  parent of the `private:*` rows; `unattributed = recall − namespace-recall`.

## What changed under the hood (and why the numbers can still move)

Every scheduled recall now always collects `timing.namespacePhases` (the
per-namespace fine-grained phase list, via `onNamespacePhases` in
`engine/recall/namespace-recall.js`) and emits one `recall.completed` host
event per attempt, right before returning. Both are new, small, constant-time
additions per recall (array pushes and one `host.events.emit` call) — the
actual pipeline work (embedding, LanceDB `vector_search`, scoring, ...) is
untouched by Task 14. Before this task, the equivalent per-namespace fold ran
**only** when a test attached the sink (never in production or in a bare
bench run without `recallTimingSink`); this probe already always attached the
sink, so it already always paid that cost — the only thing that moved for
*this probe's own measurement* is where the result is read from
(`RecallResult.timing` via a `recall.completed` listener, instead of a
directly-called `ctx.recallTimingSink` function).

## Headline

| | recall p50 | recall p95/p99 |
|---|---|---|
| scale x1, worst scenario | 251.5 ms (`recall-truncated`) | **301.6 ms** (`recall-aborted`, by design — see below) / **273.3 ms** (`recall-truncated`, the worst *unforced* scenario) |
| scale x5, worst scenario | 613.4 ms (`recall-truncated`) | **837.8 ms** (`recall-truncated`) |

`recall-aborted` (added in Task 3, not present in the 2026-09-22 report) is
excluded from "worst unforced scenario": its ~300 ms recall time is the
scenario's own designed abort delay (`abortAfterMs`), not pipeline cost, and
has no 2026-09-22 baseline to compare against.

## Comparison — 2026-09-22 vs 2026-09-24

All times ms, `recall` column only (the B6-relevant one). Delta is
`(new − old) / old`, on p95. A `*` marks a scenario recording 0 recall
attempts (routed to minimal maintenance before the phase timer exists) —
its own row is present for completeness but tells us nothing about the
recall pipeline.

### Scale x1 (`--iterations 20`)

| scenario | 2026-09-22 p50 | 2026-09-22 p95 | 2026-09-24 p50 | 2026-09-24 p95 | Δp95 |
|---|---|---|---|---|---|
| recall-basic | 26.4 | 39.0 | 24.9 | 30.5 | −21.8% |
| recall-empty-store | 23.3 | 36.6 | 20.0 | 29.0 | −20.8% |
| recall-knowledge-canonical | 19.8 | 37.2 | 17.6 | 39.4 | +5.9% |
| recall-large-text-records | 23.3 | 35.7 | 19.1 | 27.8 | −22.1% |
| recall-maintenance-only * | 7.7 | 14.3 | 11.6 | 17.1 | +19.6% |
| recall-truncated | 197.9 | 241.9 | 251.5 | 273.3 | +13.0% |
| recall-canonical-flagged | 19.0 | 38.7 | 16.9 | 26.3 | −32.0% |
| recall-aborted | — (new in Task 3) | — | 300.9 | 301.6 | n/a |

No scale-x1 scenario exceeds the 20% ceiling.

### Scale x5 (`--iterations 20 --scale 5`)

| scenario | 2026-09-22 p50 | 2026-09-22 p95 | 2026-09-24 p50 | 2026-09-24 p95 | Δp95 |
|---|---|---|---|---|---|
| recall-basic | 48.5 | 68.2 | 55.5 | 65.5 | −4.0% |
| recall-empty-store | 22.3 | 32.1 | 18.8 | 26.5 | −17.4% |
| recall-knowledge-canonical | 34.1 | 54.1 | 31.9 | 42.6 | −21.3% |
| recall-large-text-records | 46.7 | 56.9 | 43.6 | 74.3 | **+30.6%** |
| recall-maintenance-only * | 16.6 | 21.0 | 18.1 | 26.4 | **+25.7%** |
| recall-truncated | 614.1 | 663.4 | 613.4 | 837.8 | **+26.3%** |
| recall-canonical-flagged | 33.8 | 52.4 | 33.1 | 43.5 | −17.0% |
| recall-aborted | — (new in Task 3) | — | 300.7 | 301.6 | n/a |

Three scale-x5 scenarios nominally exceed the 20% ceiling. **This is
machine-load noise, not a Task 14 regression** — see below.

## Isolating the cause: same-machine, same-commit control

Per Global Constraint / the task's own acceptance note ("the probe's N=20
noise band; state the observed spread"), a >20% delta against a report
written on a *different machine, on a different day* is not by itself
evidence of a code regression. To isolate Task 14's actual effect, this
task's HEAD (`ff8f40c1`, immediately before Task 14's commit) was checked out
into a second worktree on **this same machine, in the same session**, and the
identical `--iterations 20 --scale 5` run was repeated there:

| scenario | pre-Task-14 (`ff8f40c1`, this machine) p95 | Task 14 (this branch) p95 |
|---|---|---|
| recall-large-text-records | 76.9 | 74.3–90.8 (multiple trials) |
| recall-maintenance-only | 23.0 | 23.6–26.4 |
| recall-truncated | 832.9 | 820.8–837.8 |

All three are statistically indistinguishable between the pre-Task-14 commit
and this branch, run back to back on the same machine. Six additional
scale-x1 `recall-truncated` trials on this branch alone ranged p95 259.1–314.7
ms (mean ≈ 281 ms, median ≈ 279 ms) — a ±10% swing between *identical* runs of
*identical* code, confirming this environment (evidently under more load
right now than whatever machine produced the 2026-09-22 numbers) is the
source of the apparent regression, not Task 14's `onNamespacePhases`/
`recall.completed` additions, which are O(1) per recall and touch none of the
scenarios' dominant cost (`private:vector_search`, unchanged by this task).

**Conclusion: no regression attributable to Task 14.** The >20% deltas above
are reported per the task's instruction to report rather than hide a larger
delta, together with the same-machine control that explains it.

## Run 1 — `--iterations 20` (scale x1)

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x1
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.
Note: at exactly 20 samples, nearest-rank quantile flooring puts both p95 (index
floor(0.95*20)=19) and p99 (index floor(0.99*20)=19) on the SAME sample — the
maximum — so p95 === p99 below is an artifact of the sample size, not a bug.
Today in code: soft budget default `recallCfg.softBudgetMs ?? 35_000` = 35000 ms
               (index.js (pattern not found at runtime — grep manually for /recallCfg\.softBudgetMs\s*\?\?\s*35_000/))
               hard timeout default `recallTimeoutMs: 45_000` (lib/runtime-scheduler.js:7),
               wired into the production before_prompt_build hook's phase timer as
               `hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs` (engine/recall/assemble-prompt-context.js:166).
Locations above are computed at runtime from these identifiers (readFileSync + regex),
never hard-coded — earlier drafts of this script cited fixed line numbers that had
already drifted by the next commit, from this file's own edits to the cited files.

(all times in ms; setup = temp dirs + fixture db.store() loop + plugin.register();
 recall = the one before_prompt_build hook invocation, start to return;
 total = setup + recall)

scenario                    setup p50     p95     p99  |  recall p50     p95     p99  |  total p50     p95     p99  |  embed p50
recall-basic                     25.6    50.5    50.5  |        24.9    30.5    30.5  |       50.4    79.0    79.0  |  0.0 ms
recall-empty-store                2.3     4.7     4.7  |        20.0    29.0    29.0  |       22.1    31.7    31.7  |  0.0 ms
recall-knowledge-canonical       15.7    24.8    24.8  |        17.6    39.4    39.4  |       34.3    54.9    54.9  |  0.0 ms
recall-large-text-records        21.4    37.8    37.8  |        19.1    27.8    27.8  |       43.6    57.9    57.9  |  0.0 ms
recall-maintenance-only          17.2    22.6    22.6  |        11.6    17.1    17.1  |       28.0    34.4    34.4  |  0.0 ms
recall-truncated                373.0   436.8   436.8  |       251.5   273.3   273.3  |      619.5   679.6   679.6  |  0.0 ms
recall-canonical-flagged         14.5    25.4    25.4  |        16.9    26.3    26.3  |       31.2    43.8    43.8  |  0.0 ms
recall-aborted                   19.4    24.8    24.8  |       300.9   301.6   301.6  |      319.4   325.7   325.7  |  0.0 ms

worst RECALL p95 301.6 ms, worst RECALL p99 301.6 ms (worst TOTAL p95 679.6 ms, includes setup — see above)

Owner B6 ("40/60") against RECALL-only data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms / hard 45000 ms (lib/runtime-scheduler.js:7)
recall-only floor fits the 400 ms soft budget; the remaining headroom is the provider's.
recall-only floor fits the 800 ms fallback soft budget.
```

(Full per-phase breakdown omitted here for length; unchanged in shape from
2026-09-22 — see the script's own output for the complete table, or
`/tmp/m1b1-run1b.txt` from this run.)

## Run 2 — `--iterations 20 --scale 5`

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x5
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.
Note: at exactly 20 samples, nearest-rank quantile flooring puts both p95 (index
floor(0.95*20)=19) and p99 (index floor(0.99*20)=19) on the SAME sample — the
maximum — so p95 === p99 below is an artifact of the sample size, not a bug.

(all times in ms; setup = temp dirs + fixture db.store() loop + plugin.register();
 recall = the one before_prompt_build hook invocation, start to return;
 total = setup + recall)

scenario                    setup p50     p95     p99  |  recall p50     p95     p99  |  total p50     p95     p99  |  embed p50
recall-basic                     82.2   112.2   112.2  |        55.5    65.5    65.5  |      138.2   164.9   164.9  |  0.0 ms
recall-empty-store                2.5     4.2     4.2  |        18.8    26.5    26.5  |       21.2    28.8    28.8  |  0.0 ms
recall-knowledge-canonical       43.0    75.6    75.6  |        31.9    42.6    42.6  |       77.1   109.6   109.6  |  0.0 ms
recall-large-text-records        73.0    90.3    90.3  |        43.6    74.3    74.3  |      117.0   142.3   142.3  |  0.0 ms
recall-maintenance-only          39.9    59.5    59.5  |        18.1    26.4    26.4  |       57.4    83.7    83.7  |  0.0 ms
recall-truncated               2927.8  3034.8  3034.8  |       613.4   837.8   837.8  |     3534.6  3851.0  3851.0  |  0.0 ms
recall-canonical-flagged         38.5    56.1    56.1  |        33.1    43.5    43.5  |       72.8    96.2    96.2  |  0.0 ms
recall-aborted                   48.2    79.3    79.3  |       300.7   301.6   301.6  |      348.4   380.2   380.2  |  0.0 ms

worst RECALL p95 837.8 ms, worst RECALL p99 837.8 ms (worst TOTAL p95 3851.0 ms, includes setup — see above)

Owner B6 ("40/60") against RECALL-only data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms / hard 45000 ms (lib/runtime-scheduler.js:7)
recall-only floor already exceeds the 400 ms soft budget before any provider is involved — report this.
recall-only floor already exceeds even the 800 ms fallback soft budget — report this.
```

(Full per-phase breakdown omitted here for length; unchanged in shape from
2026-09-22 — see `/tmp/m1b1-run2b.txt` from this run.)

## What this does not tell the owner

Same as 2026-09-22, unchanged:

- Real embedding latency (a genuine model call), real reranker latency —
  both are stubbed/absent here.
- A production-sized, long-lived store.
- Concurrent multi-namespace or multi-agent load.
- Whether `unattributed` time is fixed per-turn overhead or itself scales
  with store size beyond what `--scale` exercises here.

Additionally, as of this re-run: **this measurement environment's own
baseline load is not stable run-to-run** (±10% p95 swings between identical
code and identical settings, six trials) — a caveat this file's own numbers
now demonstrate directly, on top of the stub-embedder/synthetic-corpus caveat
above. Absolute numbers here should not be compared against 2026-09-22's
without the same-machine control this file performed for the three flagged
scenarios.

## Known pre-existing gap (not introduced by Task 14)

The probe's `locate()` self-check for the soft-budget default
(`recallCfg.softBudgetMs ?? 35_000`) prints "pattern not found at runtime" for
`index.js`, because that default moved out of `index.js` during the M1b-1
engine extraction (Tasks 13a/13b), before Task 14. The value itself
(`35000 ms`) is still read correctly; only the file citation is stale. Left
unfixed here as out of this task's scope (not in the brief's edit list);
worth a one-line follow-up (`locate()` needs the new file to search).

See `.superpowers/sdd/2026-09-23-m1b-1-engine-api/task-14-report.md` for the
full Task 14 implementation record.
