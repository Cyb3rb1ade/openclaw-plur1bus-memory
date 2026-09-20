# Hermes 7.12.69 delta review

Package version advanced at the owner's request to **7.12.70-hermes.0** (Python
7.12.70): this delta plus PR #165. An as-yet-unpublished .70 upstream tag is
not claimed as an ancestor; reconcile it when available before final delivery.

Base: upstream 039329d0c74525448190b0bd2ec3ef3551ed168f; Hermes 100dfa660dfd828d6baa1eb3a35806599b200145.
Target: 784e900541fddb1d13a75104b6570e52051fd82c (v7.12.69).
All 76 changed paths are inventoried below; source merge alone is not native parity.

## Native adaptation

- New captures use neutral importance 0.5/pending. Explicit values remain final; >=0.95 marks core. Missing/unknown legacy status is final. Native JSON metadata avoids another physical memories-column migration.
- The owner-scoped hourly job combines significance and sparse eight-dimension emotion in one call. 1500 output tokens by default, independent of emotion tier-3 activation. No LLM route means an explicit deferred result, not invented judgments.
- The job scans bounded candidate pages, persists its cursor, validates the live canonical card before/after inference and uses metadata CAS under the existing writer lease. Network inference holds no writer lease. Legacy/pending_backfill rows are not an automatic migration.
- Half-lives: incidental 30, useful 180, significant 600, explicit core 36500 days. Flashbulb 3650 days is opt-in through memoryDynamics.flashbulbEncoding, not automatically activated by installation.
- Spaced retrieval extends half-life 1.15x after a day, capped at 600 without lowering longer values. Strength +0.15 after decay, non-core ceiling 0.99. Native absorbing-zero protection intentionally remains stronger than upstream.
- Reinforcement is bounded/background, only for returned current-owner cards, never foreign authorized pools. A full executor does not delay recall.
- Reranking already preceded native candidate capping; now dedup/group cap (two per chunkGroupId/sourceTurnId) also precedes the final cap. No keyword importance bonus exists in native recall; the old capture heuristic is removed.
- Python string truncation is codepoint-safe and sanitizes orphan surrogates before transport.
- Existing UI, profile switching, installers, retrieval-provider selection, model/dimension migrations and immediate compaction/writer coordination are retained.

## Reviewed boundaries, not hidden parity claims

The new upstream memory-chunking module has no production capture caller at this tag.
It remains in the merged JS distribution; Hermes does not pretend to run an automatic
split that upstream itself does not run. No existing records are split or truncated.

The five new/updated migration/diagnostic scripts are OpenClaw store/operator tools.
They are retained verbatim in the JS payload but are NOT automatically run against
Hermes metadataJson stores. Phase-1 reset, backfill, duplicate-ID deletion and core
backfill require explicit store-specific migration/snapshot review; the installer
does not reset legacy importance. Native bounded pagination is retained instead of
adopting a one-million-row in-memory scan. Benchmark scripts/results are research
evidence, not Hermes measurements, and are excluded from distributable payloads.

Shared JavaScript fixes are in upstream PR #165: ordinary encoding must not erase
elapsed decay by resetting its clock, and opt-in flashbulb must not override the
agent-band core classification. Both regressions failed on upstream; 40 focused JS
tests passed with the fix. Same protections implemented in native encoding.

## Complete upstream inventory

- `.gitignore`
- `CHANGELOG.md`
- `bench/.gitignore`
- `bench/README.md`
- `bench/analysis/deepseek-compare/REPORT.md`
- `bench/analysis/deepseek-compare/results.json`
- `bench/analysis/deepseek-compare/run.mjs`
- `bench/analysis/emotion-format/ANALYSE.txt`
- `bench/analysis/emotion-format/REPORT.md`
- `bench/analysis/emotion-format/analyze.mjs`
- `bench/analysis/emotion-format/live-check.mjs`
- `bench/analysis/emotion-format/run-ab.mjs`
- `bench/analysis/emotion-format/sample.mjs`
- `bench/findings/2026-09-20-harness-defer-final-cap.md`
- `bench/ingest-capture.mjs`
- `bench/ingest.mjs`
- `bench/lib/common.mjs`
- `bench/report.mjs`
- `bench/results/lme-g56-fix.jsonl`
- `bench/results/locomo-g56-fix.jsonl`
- `bench/results/locomo-nach-umbau-7.12.66.jsonl`
- `bench/results/locomo-topn15-prod.jsonl`
- `bench/results/locomo-topn30.jsonl`
- `bench/run.mjs`
- `docs/configuration.md`
- `index.js`
- `lib/encoding-llm.js`
- `lib/importance-status.js`
- `lib/memory-chunking.js`
- `lib/memory-dynamics.js`
- `lib/memory-fact-quality.js`
- `lib/recall-pipeline.js`
- `lib/safe-update.js`
- `lib/store-limits.js`
- `openclaw.plugin.json`
- `package-lock.json`
- `package.json`
- `scripts/backfill-manual-core-markers.mjs`
- `scripts/dedupe-memory-ids.mjs`
- `scripts/importance-backfill.mjs`
- `scripts/importance-metrics.mjs`
- `scripts/importance-phase1-reset.mjs`
- `scripts/lib/deploy-integrity.mjs`
- `tests/auto-recall-decision-trace.test.js`
- `tests/capture-neutral-importance.test.js`
- `tests/config-audit.test.js`
- `tests/config-contract.test.js`
- `tests/dedupe-memory-ids.test.js`
- `tests/emotion-refine-cron.test.js`
- `tests/emotion-refine-encoding-maxtokens.test.js`
- `tests/emotion-refine-importance.test.js`
- `tests/encoding-llm.test.js`
- `tests/fact-quality-marker-word-boundary.test.js`
- `tests/flashbulb-wiring.test.js`
- `tests/halflife-from-encoding.test.js`
- `tests/importance-automatic-cap.test.js`
- `tests/importance-backfill.test.js`
- `tests/importance-metrics.test.js`
- `tests/importance-phase1-reset.test.js`
- `tests/importance-status.test.js`
- `tests/importance-usage-recall-weighting.test.js`
- `tests/manual-core-backfill.test.js`
- `tests/manual-core-marker.test.js`
- `tests/memory-behaviour-scenarios.test.js`
- `tests/memory-chunking.test.js`
- `tests/memory-dynamics-halflife.test.js`
- `tests/recall-cap-after-rerank.test.js`
- `tests/recall-chunk-group-cap.test.js`
- `tests/recall-golden-set-pipeline.test.js`
- `tests/recall-pipeline-soft-budget.test.js`
- `tests/recall-without-importance-boost.test.js`
- `tests/release-750-compat.test.js`
- `tests/retrieval-halflife-extension.test.js`
- `tests/safe-update-dataloss.test.js`
- `tests/smoke-migration.test.js`
- `tests/store-scan-limit.test.js`

## Build boundary

Candidate build only. No release publication, npm publication, productive installation,
model change or legacy data rewrite is implied. Final measured gates and platform
artifact receipts belong in the verification report.
