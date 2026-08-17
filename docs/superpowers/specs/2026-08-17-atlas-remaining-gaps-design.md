# Remaining Atlas Gaps

**Date:** 2026-08-17
**Status:** Approved for planning (post PR #114)
**Stack base:** `origin/main` at `3e5586d` (merge of `fix/skill-miner-atlas`)
**Atlas pin:** [PLUR1BUS](https://neoneye.github.io/agent-memory-atlas/systems/plur1bus/) at `b550a2d8` (v7.3.0)

## Closed on #114 (do not reopen)

- Skill-miner empty because nothing was `corroborated|trusted`
- Tombstone bypass on MemoryDB.store/update, updateCard, compaction merge, auto-capture, light-dream content rewrite
- Neo `demoted` ranked instead of withholding

## Remaining items (independent workstreams)

Ship one workstream per branch off current `main`. Do not combine drift-gate writers with scope schema or host-patch removal.

### WS1 — Tombstone e2e on remaining writers (tests only)

**Goal:** Prove the #114 guards, do not add new writers.

Cover: compaction merge `table.add`, auto-capture batch/single add, light-dream delete+add when text would change. Replay-only light-dream add (same fingerprint) stays unguarded. Forgotten text → 0 adds, compaction keeps both sources.

### WS2 — Prompt-field mapper consistency (render only)

**Goal:** One render helper for `status` / `epistemicStatus` / created-age so neo, relevant-memory, CRR, and lens labels agree.

Do **not** change `projectRecallEntry` scoring: missing epistemic stays `""` (neutral boost). Unify only at XML/prompt emit: missing status → omit or `"active"` consistently; missing epistemic **label** → `untrusted`; `createdAt` via `parseMemoryTimestamp`.

### WS3 — Global injection budget

**Goal:** One char cap across the `before_prompt_build` join at `index.js` prepend.

Keep per-feature caps. Trim `fullMemoriesContext` first (recall+lens+CRR+neo), never drop `timeContext` / `temporalContinuityContext` / `reminderNudge`. Default cap = existing recall `maxTotalChars` (12_000) + neo `maxTotalChars` (5_000). Config key under `recall.globalInjectMaxChars`. Fail-open: on error, emit uncapped current join.

### WS4 — Drift-gate live caller (conflict apply only)

**Goal:** `apply_via_safe_reconsolidation` calls `safeUpdate` **without** `skipDriftGate`. `/correct` stays skip.

Human confirm required. Drift > 0.45 → `review_only`, no write. Compaction merge stays `table.add` (out of this stream). Gate throws today — catch at the apply adapter and convert to review_only.

### WS5 — Derived-record scope (schema first)

**Goal:** Stamp `visibility.scope` + ownership on new dreams/episodes/edges/patterns. Then thread `requester` through `readDreams` / `readEpisodes` / `readGraphEdges` / `readPatterns`.

Never pass `requester` before the field exists (neo-arch comment: that zeros the set). Legacy rows without scope: fail-closed for private requester, readable only to the owning agent via `agentId`/`workspaceKey` fallback. No backfill.

### WS6 — Conflict resolve, not hard filter

**Goal:** `/plur1bus curation resolve <id> keep|drop` (destructive, authorized) appends a neo status transition. `conflict` stays a 0.3 penalty.

Do not add `conflict` to `-Infinity`. The 4017-row herd is still unvalidated. Resolve is the missing human exit.

### WS7 — Retrieval golden eval (no weight change)

**Goal:** Frozen query/fixture file + `node --test tests/recall-golden.test.js` that scores a fixed set through `scoreNeoRecallItem` and `runRecallPipeline`. Commit expected ranks. Do not retune weights.

### WS8 — postinstall host patch (do not remove)

**Goal:** Document the Atlas objection at the patch callsite. Add `PLUR1BUS_SKIP_HOST_PATCH=1` to skip apply. Keep `|| true` and the gateway re-apply. No removal until OpenClaw has a native dispatcher.

## Non-goals

- Auto-corroboration / `system:corroboration`
- Hard-filter `conflict` or epistemic `disputed`/`untrusted`
- Compaction → `safeUpdate`
- Upstreaming the host patch in this repo
- Weight search or published benchmark numbers

## Order

WS1 → WS2 → WS3 → WS7 (read/test, low risk), then WS6 → WS4 (human mutation), then WS5 (schema), then WS8 (docs/flag).
