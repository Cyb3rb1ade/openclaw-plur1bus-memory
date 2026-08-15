# Skill-Miner Epistemic Evidence Gate

**Date:** 2026-08-14
**Status:** Approved for implementation
**Stack base:** `fix/rem-dream-schema-drift` (PR #108)

## Problem

The skill miner currently admits evidence only when a LanceDB memory has either
`origin === "user_confirmation"` or a top-level `trustLevel` of `validated` or
`curated`. Neither condition can be satisfied by the real LanceDB memory model:

- LanceDB `origin` is limited to `dm`, `group`, `cron`, and `internal`.
- `trustLevel` belongs to NEO provenance (`origin.trustLevel`), not to LanceDB
  memory rows.

As a result, the weekly job scans real rows but filters every one of them before
evidence aggregation and LLM extraction. This is a model mismatch, not a schema
migration failure.

## Goals

- Make the skill miner consume the explicit trust state that LanceDB actually
  stores: `epistemicStatus`.
- Preserve the existing security boundary: unreviewed memory text must not
  become durable skill behavior merely because it repeats often.
- Keep evidence admission and evidence scoring semantically consistent.
- Add regression coverage that fails on the current implementation and proves
  both the positive and negative trust cases.

## Non-Goals

- No LanceDB schema changes or data migration.
- No changes to skill proposal approval, rendering, persistence, rate limiting,
  clustering, or LLM prompting.
- No inference of trust from category, origin, retrieval count, or legacy data.
- No live data writes or backfills.

## Design

### Evidence admission

`isTrustedSkillEvidence(row)` will normalize `row.epistemicStatus` with the
existing `normalizeEpistemicStatus()` helper and return true only for:

- `corroborated`
- `trusted`

All other values are rejected: `untrusted`, `observed`, `disputed`,
`invalidated`, unknown values, empty strings, and missing values. In particular,
legacy rows remain fail-closed instead of receiving inferred trust.

The allowlist replaces both the impossible `user_confirmation` origin check and
the foreign `trustLevel` check. It also subsumes the existing separate
`disputed`/`invalidated` exclusion in the load pipeline, avoiding two competing
definitions of acceptable evidence.

### Evidence representation and scoring

`evidence-aggregator.js` will export the documented pure helper
`isTrustedSkillEvidence(row)`. Both `loadMemories()` and
`aggregateEvidence()` will call that helper, so admission and scoring cannot
drift into separate trust definitions.

`loadMemories()` will pass `epistemicStatus` into the normalized evidence object
instead of synthesizing a top-level `trustLevel`.

`aggregateEvidence()` will use the same `corroborated`/`trusted` allowlist for
its trust bonus. The aggregator remains usable as an independent pure function,
but its score can no longer depend on fields that do not exist in the source
model. Category, retrieval-count, and contradiction adjustments remain
unchanged.

### Data flow

1. Load recent active LanceDB memories using the existing bounded query.
2. Apply category and lookback filters.
3. Normalize `epistemicStatus` and retain only `corroborated` or `trusted` rows.
4. Map the admitted rows into evidence objects carrying `epistemicStatus`.
5. Cluster and score the evidence using the same trust semantics.
6. Send only admitted groups to the existing injection-hardened LLM extractor.
7. Keep the existing human-reviewed proposal write path unchanged.

### Error and legacy behavior

Missing or malformed epistemic status is normalized to `untrusted` and excluded.
No new exceptions, fallback reads, or warning paths are introduced. Database,
lock, LLM, report, and proposal-write error handling stays as it is today.

## Test Strategy

Tests will be written before production changes and observed failing for the
model mismatch.

1. Extend the trust-boundary regression test so real-shape LanceDB rows with
   `epistemicStatus: "corroborated"` and `"trusted"` reach aggregation/LLM
   extraction without any `trustLevel` field.
2. Verify `untrusted`, `observed`, missing/legacy, `disputed`, and `invalidated`
   rows never reach the LLM.
3. Update evidence-aggregator tests to prove the trust bonus comes from
   `epistemicStatus`, not `origin` or `trustLevel`.
4. Run the focused skill-miner tests, then the complete unit suite required by
   the repository.

## Delivery

The implementation will remain a small, stacked fix on top of PR #108. The
production change is limited to the skill-miner loader and evidence aggregator;
unrelated audit findings and query-window improvements remain out of scope.
