# Skill miner learning corrections implementation plan

> **For agentic workers:** Use superpowers:executing-plans in the existing isolated plugin worktree. Preserve the live release until all checks pass.

**Goal:** Correct negative caching and same-workflow matching, with versioned extensions and a read-only check of Bernd's municipal-work evidence.
**Architecture:** Keep the per-agent/partition scan and Workshop lifecycle. Add small pure helpers for decision fingerprints and conservative candidate matching. Targeted topic cohorts supplement broad connected components; the same configured extraction model classifies new versus existing workflows. Existing content is preserved in version-bound update proposals, never rewritten by a model.
**Tech stack:** Existing Node ESM, node:test, LanceDB read queries and public OpenClaw Workshop RPCs; no new dependencies or host upgrade.
**Spec:** User request of2026-10-23 and preceding read-only audit; existing skills and explicit model overrides must remain intact.

## Constraints and decisions

- Technical/invalid extraction failures are never negative-cached. Semantic validation guards both stored responses and new writes in the existing transport result cache. Genuine low confidence expires after seven days; fingerprints version evidence content/trust, prompt, effective agent model/policy and the same-owner skill catalogue. Legacy memo entries are ignored, not destructively cleared.
- Semantic matching is conservative and ownership-bound. Evidence overlap alone cannot suppress a distinct workflow. Existing user rejections remain binding. Same evidence/workflow is skipped; new evidence for the same workflow produces a Workshop update proposal.
- Keep original skill content when drafting an extension; append only the new material. The host may normalize frontmatter/newlines at activation. Confirm the host proposal's bound base hash matches the read source. Apply continues through existing revision checks and activation policy; old ledger versions remain as history. Never overwrite handwritten or other-agent skills.
- A small number of distinctive repeated terms can form focused cohorts from otherwise mixed/singleton evidence. Keep trust gates; no special municipal-law bypass. Bound extraction attempts and evidence prompt size to existing cron limits.
- Historical legal conversations are evidence for workflows, not proof of current law. Instructions must call for current authoritative sources where needed; no invented legal facts.
- Preserve all explicit model assignments, permissions, caching separation, schedules and existing active skill files during release. No manual live mining/activation without a scoped reason.

## Review focus

- Invalid/timeout decisions must retry next eligible run; stale genuine decisions must expire and content/model changes must invalidate them.
- One broad evidence set can contain unrelated workflows; matching must not merge them merely because IDs overlap.
- Rejected names, partition separation, changed/manual skill files and pending Workshop revisions must fail safely.
- A bounded attempt budget must not permanently memoize work it never attempted.
- Updates must preserve old content and use the current Workshop base/revision; direct file overwrites are forbidden.

## Tasks

### 1. Negative-cache corrections

Files: `lib/jobs/skill-miner.js`, `lib/jobs/skill-miner/llm-extractor.js`, new cache regression tests.
- [x] Write RED regressions for technical/malformed errors, expiry, model/content/policy invalidation and genuine low-confidence reuse.
- [x] Implement versioned fingerprints, validity checks and reason-aware counters without changing the success rate limit.
- [x] Run focused tests and retain state backups.

### 2. Workflow matching and focused evidence

Files: new `lib/jobs/skill-miner/candidate-matching.js`, evidence helper, extractor and orchestrator; focused regression tests.
- [x] Write RED tests for same-workflow renamed duplicates, distinct-workflow shared evidence, cross-owner isolation, rejection retention and municipal-work cohorts from mixed input.
- [x] Add bounded same-owner catalogue context and extraction metadata for existing-workflow targets. Validate returned targets locally; bounded attempts and excerpts.
- [x] Re-run the read-only main-agent candidate check; record whether municipal-work cohorts reach extraction, without changing trust grades.

### 3. Versioned extensions

Files: `lib/setup/skill-workshop-plugin-runtime.js`, proposal writer, skill commands, miner; Workshop and activation regressions.
- [x] Write RED tests for append-preserving update proposals, base-hash races, superseded history, rejected targets and original file preservation.
- [x] Add public Workshop update adapter and strict update persistence/activation semantics; retain existing auto-apply rule under the user-confirmed existing approval rules.
- [x] Verify old skills and overrides remain unchanged.

### 4. Verification and release

- [x] Run focused tests, full `npm test`, lint and whitespace checks; obtain one independent branch review.
- [x] Bump patch release, commit/tag locally, update existing release pins and deploy through the verifier. Native hot reload only.
- [ ] Verify active plugin, preserved config/models and old skill-file hashes; archive evidence and leave worktrees clean.

## Verification before release

- Final full suite:5,435 tests,5,432 passed,0failed,3expected skips;932suites,674.6s.
- Lint and whitespace checks passed. Independent follow-up review found no remaining Critical or Important issue.
- Read-only main-agent probe:2,432 admitted records,30municipal-law records. Focused Lachendorf(9of11municipal) and Samtgemeinde(10of10) cohorts both reached the first five groups; no live mining or activation was forced.
- All52 pre-existing active skill files and complete OpenClaw configuration matched the private pre-change backup. Nine explicit Sonnet task overrides remained unchanged.
- Release evidence and the post-reload preservation check are retained privately under the operator's existing backup directory.
