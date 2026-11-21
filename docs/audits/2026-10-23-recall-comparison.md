# Recall comparison — 2026-10-23

Historical 7.18.27 measurement. This run called the recall pipeline directly and did not exercise the namespace merge. The corrected measurement using the production wrapper, after the upstream ordering backport, is in [7.18.28 follow-up](2026-10-23-recall-upstream-followup.md). Use that report for the current decision.

Measured on the existing OpenClaw 2026.10.4 installation using the three private agent stores (main, bernhardine, heisenberg). Production selection remains **40 ANN candidates, direct Cohere reranking, at most 15 prompt memories**. Jev recall filtering remains an operator benchmark adapter; it is not installed in the production recall route.

| Variant | Known source anchors | Mean | Median | p95 | Cohere billed search units |
|---|---:|---:|---:|---:|---:|
| 40 → Cohere | 23/27 | 1028 ms | 923 ms | 1840 ms | 30 |
| 50 → Cohere | 23/27 | 1004 ms | 855 ms | 2485 ms | 30 |
| 100 → Cohere | 23/27 | 1041 ms | 911 ms | 1904 ms | 31 |
| 100 → Jev → Cohere | 23/27 | 1354 ms | 1226 ms | 2176 ms | 31 |

Thirty questions: ten per agent, including continuations, indirect references and three intentionally unmatched questions. The 27 positive questions have a known stored source as an anchor. Variants found exactly the same anchors. No provider failures, pipeline fallbacks or Jev fallbacks occurred. The table reports the final instrumented run; the preceding run of the same 30 questions found the same source anchors. Jev removed 455 candidates in total, using 824,223 input and 127,635 output tokens. Monetary totals are not asserted: actual billed units and tokens are recorded, while account-specific prices were unavailable. Jev did not reduce the billed Cohere units relative to direct100.

The largest ANN pool adds little observed latency in this sample, but provides no measured anchor-coverage benefit. Differences between the direct variants should not be interpreted as significant speed gains from one pass of 30 queries. The decision rule therefore retains the existing 40-candidate default. Jev adds about 0.33 seconds on average without an anchor-coverage or billing benefit.

## Method and limits

- Same frozen ANN top-100 snapshot and embedding per question; smaller variants take prefixes. Provider evaluation order rotates across questions. Query embedding and measured native ANN time are included in the reported totals.
- Real recall lifecycle/ACL, strength ordering, deduplication, final selection and Cohere model `rerank-v3.5`; Jev `jev-latest` is separate from the capture chunking decision.
- ACL filters candidates before both external providers. No memory/card updates, retrieval-ledger writes, schema migrations or production query traces occur.
- Canonical-file and graph boosters are excluded to isolate ANN candidate selection. The comparison is not an end-to-end test of every recall path. It uses only the private namespace for the tested agent, with matching workspace identity; it does not impersonate user principals for user-scoped memories.
- Anchor coverage is a lower-bound relevance test, not exhaustive annotation of every useful memory or an answer-quality evaluation. Historical memory contents are retrieval targets, not validated factual or clinical guidance. Unmatched questions are probes, not a guarantee of zero potentially related memories.
- Complete inputs that do not fit the bounded Jev state are retained without classification. Only explicit `irrelevant` with numeric confidence >=0.95 and <=1 removes a candidate. Missing, malformed and uncertain answers retain it; transport errors retain all.
- Existing 12-second soft budget, 2.5-second Cohere timeout and prompt-memory cap remain unchanged in production. The isolated comparison gives Jev its own bounded stage.

Private reproducibility artifacts (queries, IDs, usage, provider inventories, configuration backup and deployment report) are stored under `/root/.openclaw/backup/plur1bus-7.18.27-20261023/`, outside the repository. Do not commit personal memory data or credentials. See the runbook for repeat measurements.
