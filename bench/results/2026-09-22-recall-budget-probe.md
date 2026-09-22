# Recall budget probe — B6 evidence (2026-09-22)

Owner decision B6 (`phase0/decisions-for-owner.md`) reads *"40/60"*, and
ADR-002 Q2 asks the recall budget be set from a measured p50/p95/p99
distribution, not from taste. This file is that measurement, produced by
`node bench/recall-budget-probe.mjs --iterations 20` (and `--scale 5`) against
the seven `golden-prefix` fixture scenarios (`tests/fixtures/golden-prefix/scenarios.js`).

**Read this with its caveats, not just its numbers:**

- **Stub embedder, no reranker, tiny synthetic corpus.** This is the
  pipeline's *floor* (orchestration, LanceDB open/query, context formatting),
  not a production distribution. `embed p50` is ~0 ms throughout because the
  embedder here does synchronous vector math, not a real model call.
- **`setup` vs `recall` vs `total`.** `setup` is fixture cost specific to this
  test harness (temp dirs, a sequential `db.store()` per fixture memory,
  `plugin.register()` cold start) — a real long-lived host process pays most
  of this once per process lifetime, not once per turn. `recall` is the one
  thing B6 is actually about: the `before_prompt_build` hook invocation,
  start to return. `total = setup + recall`. **Only the `recall` column and
  the per-phase tables below are relevant to the B6 budget.**
- **N=20 quantile artifact.** With exactly 20 samples, nearest-rank flooring
  puts p95 (index `floor(0.95*20)=19`) and p99 (index `floor(0.99*20)=19`) on
  the same sample — the maximum. `p95 === p99` throughout this file is that
  artifact, not a bug.
- **Per-phase table structure.** `namespace-recall` is the parent of the
  `private:*` rows below it — they are a further breakdown of *its own*
  share, not additional time on top of it. `unattributed` = `recall −
  namespace-recall`: everything else the `before_prompt_build` hook does
  (context formatting, budget trimming, dedup at the outer level, the Neo
  prelude, ...) that this probe cannot attribute to a named pipeline phase.
  So, at the top level, `namespace-recall share + unattributed share ≈ 100%`
  of recall (exact at p50, approximate at the tails since p95/p99 subtraction
  of two independently-computed quantiles isn't exact).
- **Line citations below are computed at runtime** by the probe itself
  (`readFileSync` + a regex over the actual current source), not hard-coded —
  so, unlike earlier drafts of this report, they cannot go stale.

## Headline

| | recall p50 | recall p95/p99 |
|---|---|---|
| scale x1, worst scenario | 26.4 ms (`recall-basic`) / 197.9 ms (`recall-truncated`) | **241.9 ms** (`recall-truncated`) |
| scale x5, worst scenario | 614.1 ms (`recall-truncated`) | **663.4 ms** (`recall-truncated`) |

Against the three B6 readings (soft/hard): this task's "400/600", the owner
doc's literal "400/1200", and the owner doc's own "800/2500" fallback — the
recall-only floor **fits comfortably at scale x1** (241.9 ms worst p95, under
all three soft budgets) and **exceeds the tightest "400 ms" reading but still
fits the "800 ms" fallback at scale x5** (663.4 ms worst p95), driven entirely
by `recall-truncated`'s many-record `vector_search` cost. Every other scenario
stays under ~70 ms recall p95 even at scale x5.

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
               (index.js:4565)
               hard timeout default `recallTimeoutMs: 45_000` (lib/runtime-scheduler.js:7),
               wired into the production before_prompt_build hook's phase timer as
               `hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs` (engine/recall/assemble-prompt-context.js:152).
Locations above are computed at runtime from these identifiers (readFileSync + regex),
never hard-coded — earlier drafts of this script cited fixed line numbers that had
already drifted by the next commit, from this file's own edits to the cited files.

(all times in ms; setup = temp dirs + fixture db.store() loop + plugin.register();
 recall = the one before_prompt_build hook invocation, start to return;
 total = setup + recall)

scenario                    setup p50     p95     p99  |  recall p50     p95     p99  |  total p50     p95     p99  |  embed p50
recall-basic                     29.5    44.7    44.7  |        26.4    39.0    39.0  |       55.0    83.7    83.7  |  0.0 ms
recall-empty-store                2.4     7.1     7.1  |        23.3    36.6    36.6  |       25.9    38.8    38.8  |  0.1 ms
recall-knowledge-canonical       18.6    27.8    27.8  |        19.8    37.2    37.2  |       40.0    56.7    56.7  |  0.1 ms
recall-over-budget               23.9    50.0    50.0  |        23.3    35.7    35.7  |       51.7    82.5    82.5  |  0.0 ms
recall-maintenance-only          17.5    22.5    22.5  |         7.7    14.3    14.3  |       26.0    33.2    33.2  |  0.0 ms
recall-truncated                389.5   515.2   515.2  |       197.9   241.9   241.9  |      591.0   721.4   721.4  |  0.0 ms
recall-canonical-flagged         16.8    29.0    29.0  |        19.0    38.7    38.7  |       36.9    57.3    57.3  |  0.1 ms

recall-basic — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)     9.0 ms    14.0 ms    14.0 ms                   34.1%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                                8.0 ms    13.0 ms    13.0 ms                   30.3%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 17.4 ms    25.0 ms    25.0 ms                   65.9%

recall-empty-store — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)     4.0 ms     6.0 ms     6.0 ms                   17.1%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                                2.0 ms     3.0 ms     3.0 ms                    8.6%
    private:query_refinement                                                             2.0 ms     2.0 ms     2.0 ms                    8.6%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 19.3 ms    30.6 ms    30.6 ms                   82.9%

recall-knowledge-canonical — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)     5.0 ms    22.0 ms    22.0 ms                   25.2%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                                5.0 ms    19.0 ms    19.0 ms                   25.2%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     2.0 ms     2.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 14.8 ms    15.2 ms    15.2 ms                   74.8%

recall-over-budget — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)     8.0 ms    17.0 ms    17.0 ms                   34.3%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                                7.0 ms    16.0 ms    16.0 ms                   30.0%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 15.3 ms    18.7 ms    18.7 ms                   65.7%

recall-maintenance-only — per-phase breakdown (from the pipeline's own phase timer, 0/20 recall attempt(s) observed; share is of RECALL, not total):
  (no recall attempted for this scenario — workspace-policy declined or the turn was routed to minimal maintenance before the phase timer was created)

recall-truncated — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)   106.0 ms   119.0 ms   119.0 ms                   53.6%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                              105.0 ms   118.0 ms   118.0 ms                   53.1%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 91.9 ms   122.9 ms   122.9 ms                   46.4%

recall-canonical-flagged — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)     6.0 ms     8.0 ms     8.0 ms                   31.6%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                                5.0 ms     6.0 ms     6.0 ms                   26.3%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    1.0 ms     1.0 ms     1.0 ms                    5.3%
    private:scoring                                                                      0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 13.0 ms    30.7 ms    30.7 ms                   68.4%

worst RECALL p95 241.9 ms, worst RECALL p99 241.9 ms (worst TOTAL p95 721.4 ms, includes setup — see above)

Owner B6 ("40/60") against RECALL-only data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms (index.js:4565) / hard 45000 ms (lib/runtime-scheduler.js:7)
recall-only floor fits the 400 ms soft budget; the remaining headroom is the provider's.
recall-only floor fits the 800 ms fallback soft budget.
```

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
Today in code: soft budget default `recallCfg.softBudgetMs ?? 35_000` = 35000 ms
               (index.js:4565)
               hard timeout default `recallTimeoutMs: 45_000` (lib/runtime-scheduler.js:7),
               wired into the production before_prompt_build hook's phase timer as
               `hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs` (engine/recall/assemble-prompt-context.js:152).
Locations above are computed at runtime from these identifiers (readFileSync + regex),
never hard-coded — earlier drafts of this script cited fixed line numbers that had
already drifted by the next commit, from this file's own edits to the cited files.

(all times in ms; setup = temp dirs + fixture db.store() loop + plugin.register();
 recall = the one before_prompt_build hook invocation, start to return;
 total = setup + recall)

scenario                    setup p50     p95     p99  |  recall p50     p95     p99  |  total p50     p95     p99  |  embed p50
recall-basic                     84.8   115.8   115.8  |        48.5    68.2    68.2  |      131.4   181.0   181.0  |  0.0 ms
recall-empty-store                2.5     3.7     3.7  |        22.3    32.1    32.1  |       25.1    35.0    35.0  |  0.1 ms
recall-knowledge-canonical       48.1    76.1    76.1  |        34.1    54.1    54.1  |       84.1   109.1   109.1  |  0.1 ms
recall-over-budget               75.3   102.9   102.9  |        46.7    56.9    56.9  |      124.0   156.0   156.0  |  0.0 ms
recall-maintenance-only          39.6    50.0    50.0  |        16.6    21.0    21.0  |       56.1    66.6    66.6  |  0.0 ms
recall-truncated               3160.7  3700.1  3700.1  |       614.1   663.4   663.4  |     3767.0  4363.5  4363.5  |  0.0 ms
recall-canonical-flagged         44.4    94.7    94.7  |        33.8    52.4    52.4  |       77.2   137.5   137.5  |  0.1 ms

recall-basic — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)    23.0 ms    36.0 ms    36.0 ms                   47.5%
    private:embedding                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:vector_search                                                               21.0 ms    34.0 ms    34.0 ms                   43.3%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     2.0 ms     2.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 25.5 ms    32.2 ms    32.2 ms                   52.5%

recall-empty-store — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)     4.0 ms     7.0 ms     7.0 ms                   17.9%
    private:embedding                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:vector_search                                                                2.0 ms     2.0 ms     2.0 ms                    9.0%
    private:query_refinement                                                             2.0 ms     4.0 ms     4.0 ms                    9.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:acl                                                                          0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 18.3 ms    25.1 ms    25.1 ms                   82.1%

recall-knowledge-canonical — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)    14.0 ms    21.0 ms    21.0 ms                   41.0%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                               13.0 ms    20.0 ms    20.0 ms                   38.1%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    1.0 ms     1.0 ms     1.0 ms                    2.9%
    private:scoring                                                                      0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 20.1 ms    33.1 ms    33.1 ms                   59.0%

recall-over-budget — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)    21.0 ms    28.0 ms    28.0 ms                   45.0%
    private:embedding                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:vector_search                                                               20.0 ms    23.0 ms    23.0 ms                   42.8%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 25.7 ms    28.9 ms    28.9 ms                   55.0%

recall-maintenance-only — per-phase breakdown (from the pipeline's own phase timer, 0/20 recall attempt(s) observed; share is of RECALL, not total):
  (no recall attempted for this scenario — workspace-policy declined or the turn was routed to minimal maintenance before the phase timer was created)

recall-truncated — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)   212.0 ms   238.0 ms   238.0 ms                   34.5%
    private:embedding                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:vector_search                                                              210.0 ms   236.0 ms   236.0 ms                   34.2%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:scoring                                                                      0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     2.0 ms     2.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                402.1 ms   425.4 ms   425.4 ms                   65.5%

recall-canonical-flagged — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed; share is of RECALL, not total):
  phase                                                                                     p50        p95        p99   share of recall (p50)
  namespace-recall (parent of the rows below — a further breakdown of its own share)    14.0 ms    30.0 ms    30.0 ms                   41.5%
    private:embedding                                                                    0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:vector_search                                                               12.0 ms    24.0 ms    24.0 ms                   35.5%
    private:query_refinement                                                             0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:temporal                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:canonical                                                                    1.0 ms     4.0 ms     4.0 ms                    3.0%
    private:scoring                                                                      0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:graph_hydration                                                              0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:rerank                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:budget                                                                       0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:dedup                                                                        0.0 ms     0.0 ms     0.0 ms                    0.0%
    private:acl                                                                          0.0 ms     1.0 ms     1.0 ms                    0.0%
    private:finalize                                                                     0.0 ms     0.0 ms     0.0 ms                    0.0%
  unattributed (recall − namespace-recall; everything else in the hook)                 19.8 ms    22.4 ms    22.4 ms                   58.5%

worst RECALL p95 663.4 ms, worst RECALL p99 663.4 ms (worst TOTAL p95 4363.5 ms, includes setup — see above)

Owner B6 ("40/60") against RECALL-only data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms (index.js:4565) / hard 45000 ms (lib/runtime-scheduler.js:7)
recall-only floor already exceeds the 400 ms soft budget before any provider is involved — report this.
recall-only floor fits the 800 ms fallback soft budget.
```

## What this does not tell the owner

- Real embedding latency (a genuine model call), real reranker latency —
  both are stubbed/absent here.
- A production-sized, long-lived store (this harness creates a fresh store
  per iteration; a real LanceDB table stays open across turns).
- Concurrent multi-namespace or multi-agent load.
- Whether `unattributed` time (46–83% of recall depending on scenario/scale)
  is fixed per-turn overhead or itself scales with store size beyond what
  `--scale` exercises here — worth instrumenting further before PR-04 if it
  turns out to dominate against a real store too.

See `.superpowers/sdd/2026-09-22-m1a-engine-extraction/task-19-report.md` for
the full implementation history (three fix rounds) and interpretation.
