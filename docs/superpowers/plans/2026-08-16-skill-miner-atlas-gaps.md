# Skill-Miner Repair + Atlas Top Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skill miner can propose from observed + pre-cutoff legacy; approve is crash-repairable; demoted withholds; every card reinsert consults the tombstone registry.

**Architecture:** Pure helpers for cutoff, capture status, admission, and write-guard. Wire existing capture/store/job/command paths. No new host Telegram transport.

**Tech Stack:** Node ≥ 22.5, existing `node:fs`/`node:crypto`, LanceDB via current adapters, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-16-skill-miner-atlas-gaps-design.md`

## Global Constraints

- Never persist `epistemicStatus=""` on a new write.
- Cutoff lives at `{dirname(baseDbPath)}/_epistemic/`, not inside the LanceDB tree.
- `trusted` is human-only; approve never writes `trusted`.
- OpenClaw has no callback_query / outbound keyboard API; do not fake one.
- Tombstone check uses `findBlockingTombstoneForCapture` with full scope bindings.
- No live-store writes in tests.
- Compaction/Conflict → `safeUpdate` is out of scope.

## File map

- Create: `lib/fsync-atomic.js`, `lib/epistemic-cutoff.js`, `lib/epistemic-capture.js`, `lib/tombstone-write-guard.js`
- Modify: `lib/jobs/skill-miner/evidence-aggregator.js`, `lib/jobs/skill-miner.js`, `lib/jobs/skill-miner/proposal-writer.js`, `lib/telegram-commands/skill-commands.js`, `lib/jobs/skill-miner/nudge-renderer.js`, `lib/neo-arch.js`, `lib/db-adapter.js`, `lib/jobs/memory-compaction.js`, `lib/dreaming/light-dream.js`, `scripts/auto-capture-lancedb.mjs`, `index.js`, `lib/i18n-dictionary.js`
- Test: `tests/epistemic-cutoff.test.js`, `tests/epistemic-capture.test.js`, `tests/skill-miner-admission.test.js`, `tests/skill-approve-activation.test.js`, `tests/skill-confirm-inline.test.js`, `tests/neo-demoted-withhold.test.js`, `tests/tombstone-write-guard.test.js`, plus updates to existing skill-miner trust tests

---

### Task 1: Atomic fsync + cutoff marker

**Files:** Create `lib/fsync-atomic.js`, `lib/epistemic-cutoff.js`, `tests/epistemic-cutoff.test.js`

**Interfaces:**
- Produces: `writeTextFsync(path, text)`, `readEpistemicCutoff(baseDbPath)`, `ensureEpistemicCutoff(baseDbPath, now)`, `legacyMiningAllowed(cutoffState)`, `isCreatedAtBeforeCutoff(createdAt, since)`
- `ensureEpistemicCutoff` returns `{ ok, since, legacyOpen, reason }`

- [x] Write failing tests then implement (this session executes inline)

### Task 2: Capture status helper + writers

**Files:** Create `lib/epistemic-capture.js`, `tests/epistemic-capture.test.js`; modify `index.js` capture/`memory_store`, `scripts/auto-capture-lancedb.mjs`, `MemoryDB.store`

**Interfaces:**
- Produces: `decideEpistemicStatusForCapture({ text, sourceMessageRole, origin })` → `"observed"|"untrusted"`

### Task 3: Miner admission + grades + preflight

**Files:** Modify `evidence-aggregator.js`, `skill-miner.js`; test `tests/skill-miner-admission.test.js` + update existing trust tests

**Interfaces:**
- Produces: `isAdmissibleSkillEvidence(row, opts)`, `skillEvidenceGrade(memories)`, keep `isTrustedSkillEvidence`

### Task 4: Approve/reject activation + confirm tokens

**Files:** Modify `skill-commands.js`, `proposal-writer.js`, `index.js` skills handler, `i18n-dictionary.js`, `nudge-renderer.js`

**Interfaces:**
- Produces: `activateSkillProposal(workspaceDir, id, ctx)`, `rejectSkillProposal(...)`, `buildSkillReviewPayload(...)`

### Task 5: Neo demoted withhold

**Files:** Modify `lib/neo-arch.js`; test `tests/neo-demoted-withhold.test.js`

### Task 6: Tombstone write guard at every add path

**Files:** Create `lib/tombstone-write-guard.js`; modify MemoryDB, db-adapter, compaction, auto-capture, light-dream

**Interfaces:**
- Produces: `assertCardWriteAllowed(opts)` → `{ allowed, action, reason, blocking }`
- Compaction: skip merge on block

### Task 7: Full suite, lint, audit, commits
