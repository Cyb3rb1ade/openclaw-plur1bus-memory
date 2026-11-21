# Recall upstream follow-up — 2026-10-23

Release 7.18.28 selectively incorporates upstream `432313664242fc6c29c0b9bf3bcea8b9e5ad93c0` from `origin/fix/rerank-order-namespace` into the existing OpenClaw plugin development branch. The fetched `origin/main` (`98dfe2f0`) contains the standalone engine and was not merged. This follows the user's request to account for recent changes.

## Changes

- Preserve reranker order through namespace merging and tier-budget selection. Tier quotas still choose survivors; the reranker orders those survivors. Equal or inconsistent provider scores preserve returned order instead of restoring old vector order.
- Enforce explicit reranker input caps, with at least the requested output count. When the raw configuration omits a cap, retain the configured recall candidate pool (currently 40), rather than the provider normalizer's unrelated default of 20. Explicit caps remain authoritative.
- Retry partially failed KNOWLEDGE embedding batches instead of caching an incomplete batch. A failed graph-only relevance check drops that unverified candidate.
- Preserve existing ACL filtering before external providers, intentional empty Jev shortlists, model assignments, plugin permissions, prompt-cache separation and the final memory cap.

Other recently fetched branches concern provider adapters, Persona evolution, jobs or harness features. They were inspected for scope and were not installed implicitly. The active Cohere implementation already bounds full response-body reads. The local schicht15 recommendation of eight promotions is already present in the live configuration.

## Repeated comparison

The same 30 questions (ten per agent; 27 known source anchors plus three unmatched probes) now pass through the exported production namespace wrapper and global recall budget, using one private namespace and the same frozen ANN snapshot per question. Canonical-file and graph boosters remain excluded. This replaces the earlier direct-pipeline comparison for the current decision.

| Variant | Known anchors | Mean | Median | p95 | Reranker timeouts / fallbacks | Reported Cohere units |
|---|---:|---:|---:|---:|---:|---:|
| 40 → Cohere | 23/27 | 1267 ms | 1100 ms | 2777 ms | 0 | 30 |
| 50 → Cohere | 23/27 | 1361 ms | 1061 ms | 3051 ms | 1 | 29 |
| 100 → Cohere | 23/27 | 1296 ms | 1087 ms | 2732 ms | 0 | 31 |
| 100 → Jev → Cohere | 23/27 | 1732 ms | 1451 ms | 3466 ms | 1 | 30 |

All variants found the same anchors and selected at most 15 memories. Jev removed 439 candidates, using 824,223 input and 127,635 output tokens, with no Jev transport fallback. The two Cohere timeouts used the pipeline's existing fallback and remain included in latency and coverage totals. Units are those returned by successful responses; a timed-out call may still be billed, so lower reported units are not evidence of savings. Account-specific monetary costs are unavailable.

Keep the direct 40-candidate default. Larger pools added no measured anchor coverage; Jev added about 436 ms on average compared with direct100 and did not demonstrate a cost benefit. One pass of 30 questions does not establish statistically significant speed differences between the direct variants. Anchor coverage is a lower-bound retrieval check, not exhaustive relevance annotation or an answer-quality evaluation. This comparison exercises the production merge but not every namespace/graph/canonical path. Existing production timeouts and prompt budgets remain unchanged.

## Verification and deployment evidence

Registered-runtime regressions reproduce the omitted-cap reduction before the correction and verify the corrected 40 default alongside explicit 8/20 caps. Ordering tests cover single and multiple namespaces, tier survivor ordering, score ties, input bounds and partial embedding retries. Existing agent separation, Jev fallback, model-selector and cache tests remain part of the full suite. An independent reviewer confirmed the two identified issues were resolved. Final full suite: 5,380 tests, 5,377 passed, zero failed, three skipped, 932 suites. The 32 focused recall tests, lint and whitespace checks also passed.

Private reproducibility artifacts, full test output, configuration backup and deployment receipt are under `/root/.openclaw/backup/plur1bus-7.18.28-20261023/`. Queries, memory IDs and credentials are excluded from this report and the repository.
