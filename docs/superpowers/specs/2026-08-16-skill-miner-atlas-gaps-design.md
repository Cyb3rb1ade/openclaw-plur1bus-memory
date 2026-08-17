# Skill-Miner Repair + Atlas Top Gaps

**Date:** 2026-08-16
**Status:** Approved for implementation (review-corrected)
**Stack base:** `origin/main` at `b3dfc16` (v7.3.5)
**Atlas pin:** [neoneye Agent Memory Atlas / PLUR1BUS](https://neoneye.github.io/agent-memory-atlas/systems/plur1bus/) at `b550a2d8` (v7.3.0)

## Problem

Two independent defects share one branch because both are about *what is allowed to become durable, trusted behavior*.

### Skill miner produces nothing

Scan, ownership, and the `corroborated|trusted` gate were repaired in 7.3.0–7.3.1. The remaining hole is admission: the only writer that sets `corroborated` or `trusted` is `/plur1bus correct trust`. Capture stores `""`, which `normalizeEpistemicStatus()` treats as `untrusted`. The weekly job therefore completes with `scanned: 0` / `proposalsCreated: 0` on live agents that have hundreds of in-window skill-category rows.

A three-row verbatim-fingerprint corroboration pass will not fill that hole. A read-only probe of the local snapshot (24 571 rows, 40 agents, 2026-08-16) found one user-role exact fingerprint with ≥3 distinct `sourceTurnId`, zero in skill categories, 45 % empty `sourceTurnId`, 43 % empty `sourceMessageRole` (the two empty sets are identical), 4 038 active skill-category rows with empty role vs 1 368 with `role=user`.

Capture already deduplicates near-exact text. The miner must cluster existing rows, including unreviewed pre-cutoff legacy, and keep SKILL.md behind a human approve.

### Atlas gaps still open on 7.3.5

Live neo store (newest revision): **4 017 `conflict`**, **0 `demoted`**, **0 `promoted`**. `conflict` is machine-set. A 20-row sample was injected context / inter-session / audio, not pairwise contradiction. Hard-filtering `conflict` would hide thousands of records with no resolve path.

Human curation is unused. Skill approve cannot live only as another subcommand.

## Goals

- Give the skill miner a legal evidence set that can produce **proposals** without minting `trusted` or writing SKILL.md without a human.
- Write an explicit epistemic value on every **new** capture so `""` remains a legacy-only sentinel.
- Make approve crash-repairable: SKILL.md first (atomic fsync), then per-id transitions with a retryable partial state.
- Put approve/reject on `/plur1bus skills review` as inline buttons **and** text confirm tokens. Proactive nudge stays text if the host cannot deliver keyboards.
- Hard-filter neo `demoted`. Leave `conflict` as a ranking penalty and record why at the callsite.
- Route every reachable LanceDB card reinsert/replacement through `findBlockingTombstoneForCapture`.

## Non-Goals

- No `system:corroboration` actor, no on-card turn-id set, no cosine-band corroboration.
- No bulk epistemic backfill. No auto-`trusted`.
- No hard filter on neo `conflict`, epistemic `disputed`, or epistemic `untrusted`.
- No Compaction/Conflict → `safeUpdate` + drift-gate wiring.
- No global injection token budget, no scope schema on dreams/episodes, no `postinstall` host-patch removal.
- No retrieval-quality eval and no change to `scoreNeoRecallItem` weights other than the `demoted` withhold.
- No simulated Telegram callback delivery. The OpenClaw plugin SDK has no outbound send API and no `callback_query` hook.

## Design

### 1. Capture writes an explicit epistemic status

Shared helper `decideEpistemicStatusForCapture({ text, sourceMessageRole, origin })`:

- `observed` only when **all** of: `sourceMessageRole === "user"`, not `isInjectedContextText(text)`, not `looksLikePromptInjection(text)`, and origin is not `cron`/`internal`/`dream`.
- Otherwise `untrusted`. Never `""`.

`memory_store` has no real user-role provenance (`sourceMessageRole` is written `""`). It must call the helper and therefore land on `untrusted`. It must not invent `observed`.

Writers that must call the helper (or pass its result):

- `agent_end` capture in `index.js`
- `storeMemoryFromToolParams` / `memory_store` tool
- `scripts/auto-capture-lancedb.mjs` `buildCaptureRow`

`MemoryDB.store` is a last line of defense: if `epistemicStatus` is missing or `""`, persist `untrusted`. `MemoryDB.update` and `normalizeEntryForTable` must **not** rewrite an existing stored `""` (that would be a silent backfill).

Dream narrative and shared-memory copies go through `MemoryDB.store`. Dreams become `untrusted`. Shared copies keep a non-empty source status; empty source becomes `untrusted`.

### 2. Epistemic cutoff marker

Location: sibling of `baseDbPath`, same durability class as the tombstone registry:

```
{dirname(baseDbPath)}/_epistemic/explicit-write-since.json
{dirname(baseDbPath)}/_epistemic/EXPLICIT_WRITES_ENABLED
```

Not inside `lancedb-namespaced`. A snapshot restore of the LanceDB tree must not replace or delete these files.

Protocol:

1. **First boot** (neither file present): atomically write the cutoff as `{ since: now, createdAt: now }` with tmp + `fsync` file + `rename` + directory `fsync`. Earliest valid `since` wins on any later write (monotonic min). Then write `EXPLICIT_WRITES_ENABLED`.
2. **Normal**: read cutoff. If `EXPLICIT_WRITES_ENABLED` is present and the cutoff file is missing or unreadable → **do not create a new cutoff**. Capture writes `untrusted`. Miner legacy path stays closed until an operator restores the cutoff file.
3. **I/O error on read or first write**: Capture writes `untrusted` (never `""`). Miner legacy path disabled. Log via `safeWarn`.
4. Creating a new cutoff is allowed only when both files are absent.

Miner legacy admission (in addition to raw `observed|corroborated|trusted`):

```
raw epistemicStatus is "" or missing
  AND createdAt < since   (BigInt-safe via the same toFiniteMs rule as valid-time)
  AND category ∈ SKILL_EVIDENCE_CATEGORIES
  AND sourceMessageRole ∈ {"user", ""}
  AND legacy path is open
```

Explicit `untrusted`, `disputed`, `invalidated`, and post-cutoff empties are excluded.

The recency lookback (default 30 days) applies only to explicit `observed|corroborated|trusted` rows. Pre-cutoff empty legacy is admitted regardless of lookback — otherwise the first upgrade cannot form proposals from the existing store. The miner calls `ensureEpistemicCutoff` so first boot creates the cutoff before the scan.

**Preflight before any proposal write**, not during paginated scan: one partitioned `LIMIT 1` query for skill-category rows whose raw status is empty/`NULL` and `createdAt >= since`. If the column is missing, treat every row as empty and query `createdAt >= since AND category ∈ … LIMIT 1`. Any hit closes the legacy path for that run. This query must not use the scan cursor or page size.

Live ratio (comment + fixture): empty-role skill rows outnumber `role=user` (~4 038 vs 1 368). Accepted because SKILL.md still requires approve. Labels distinguish the two.

### 3. Miner clustering and labels

- `isAdmissibleSkillEvidence(row, { cutoff, legacyOpen })` — clustering predicate. Uses the **raw** stored status so `""` is not collapsed to `untrusted` before the check.
- `isTrustedSkillEvidence(row)` — unchanged: only `corroborated|trusted` after normalize. Used **only** for the +2 score bonus.
- `aggregateEvidence` default must not require trusted-only. The miner passes the already-filtered admissible set.

`evidenceGrade` of a cluster (weakest member):

- `unreviewed-legacy-norole` — at least one admissible legacy row has empty `sourceMessageRole`
- `unreviewed-legacy` — all legacy members have `sourceMessageRole === "user"`
- else `observed` / `corroborated` / `trusted` (lowest present)

Stored on the proposal as `evidence.grade` plus `evidence.memoryIds` and `aclBindings` (existing ownership tuple). Review list and nudge text render the grade.

ACL / agent / workspace / owner partition is unchanged through scan, proposal (`aclBindings`), and approve (re-read + `checkAccess`).

### 4. Approve / reject

One function pair used by command and confirm token: `activateSkillProposal` / `rejectSkillProposal`.

Statuses:

- `pending_review` — not yet written
- `activation_partial` — SKILL.md durable, some evidence transitions failed or not yet done
- `active` — SKILL.md durable and every cited id is done (ok, no-op, or safely skipped)
- `rejected`

Order:

1. Re-read proposal. Allow `pending_review` or `activation_partial`.
2. If SKILL.md is not yet durable: write via tmp file, `fsync` file, `rename`, `fsync` directory. Persist `activation.skillPath` and set `activation_partial`.
3. For each cited evidence id: load **fresh** from the proposal's stored ACL partition (same agent/workspace/owner bindings). `checkAccess(memoryCtx, record)` must pass. Foreign or missing ids are recorded as `{ ok: false, reason: "acl_or_missing" }` and skipped.
4. Transitions (human actor, authorized):
   - raw `""` / missing → `observed`
   - `observed` → `corroborated`
   - `corroborated` / `trusted` → no-op success
   - `untrusted` / `disputed` / `invalidated` → skip, recorded, not a hard failure
5. Persist per-id results on the proposal. If every id is terminal, set `active`. Otherwise remain `activation_partial`.
6. Re-approve of `activation_partial` is idempotent: does not clobber SKILL.md; retries only unfinished ids.

Reject: only `pending_review`. Does not change epistemic status. Does not delete a SKILL.md that does not exist yet.

Authorization: `isAuthorized(..., { destructive: true })` plus confirmation binding. Evidence ACL is additional, not a substitute.

### 5. Telegram surface

**Host fact:** `api.registerCommand` handlers return `{ text }` (and unused extra fields). There is no `callback_query` hook and no outbound send API. `before_prompt_build` prepends text to the model. `renderSkillProposalNudge` is prependContext only.

Therefore:

- `/plur1bus skills review` returns `{ text, inline_keyboard }`. Text includes `/plur1bus skills confirm <nonce>` lines so approve works even if the host drops the keyboard. Each button is a `createConfirmation` for `skills-approve` or `skills-reject` bound to `userId + chatId + proposalId + nonce + expiry`.
- `/plur1bus skills confirm <nonce>` runs `validateConfirmation`, re-checks destructive auth, then the central activate/reject function. Wrong user/chat, expired, or replayed nonce: no state change.
- Proactive nudge stays **text only** and points at `/plur1bus skills review`. Do not pretend a keyboard was delivered through prependContext.
- Existing `/plur1bus skills approve|reject <id>` remain, same central functions, still destructive-auth gated.

### 6. Neo `demoted` withholds; `conflict` does not

`scoreNeoRecallItem`: `demoted` returns `-Infinity` (with `pruned`/`tombstoned`/`invalidated`). Remove the 0.35 penalty branch for `demoted` because it is unreachable.

`conflict` stays a finite 0.3 penalty. Callsite comment:

> `conflict` is not a hard filter: the detector is an unvalidated LLM, 4 017 newest-revision records on the 2026-08-16 live probe carried `conflict` (2 505 on one agent) with no resolve path that clears the status, and a 20-row sample was not pairwise contradiction. Atlas gap left open on purpose.

No LanceDB SQL on neo status. Prompt supplement stays. `/plur1bus memory demote` help: demote withholds from neo recall and is reversible via `promote`.

### 7. Tombstone choke

Shared helper `assertCardWriteAllowed({ baseDbPath, agentId, text, scope, workspaceIdentity, ownerUserId })` calls `findBlockingTombstoneForCapture` with the canonical fingerprint and full scope bindings. Unreadable/corrupt registry → block (`tombstone_blocked`).

Must run **before** allocating a persisted new id and **before** any destructive delete. Blocked result: `{ action: "tombstone_blocked", reason: "tombstone_blocked" }` (or throw that shape). No `table.add`.

Sites:

| Site | When to check |
|---|---|
| `MemoryDB.store` | always, on entry text/summary |
| `MemoryDB.update` | only if text or summary **content** changes to a new fingerprint |
| `db-adapter.updateCard` | before `randomUUID` / `table.add` |
| `memory-compaction.js` `table.add` | on merged text; on block skip merge, leave both sources, no alias |
| `scripts/auto-capture-lancedb.mjs` batch and single add | skip row, do not add |
| `lib/dreaming/light-dream.js` delete+add fallback | metadata-only (same fingerprint) does **not** check; if text changed, check **before** delete |
| light-dream rollback re-add | same-content restore, no check |
| dream-narrative / shared-memory | covered by `MemoryDB.store` |

`MemoryDB.update` in-place metadata patches (epistemic transition, replay count) do not consult the registry.

## Error handling

- Cutoff I/O failure: write `untrusted`, disable legacy mining.
- Missing cutoff after `EXPLICIT_WRITES_ENABLED`: do not mint a new cutoff; disable legacy mining.
- Post-cutoff empty preflight hit: disable legacy for that run; explicit statuses still cluster.
- Approve step-3 failure: remain `activation_partial`; SKILL.md stays; retry is safe.
- Tombstone registry unreadable: block write.
- Invalid confirmation: deny, no state change.

## Test strategy

DB-free unit tests. No live-store writes.

See implementation plan for the fixture list. Focused files first, then `node --test tests/*.test.js`, plus lint/check, `git diff --check`, `npm audit`.

## Delivery

Branch `fix/skill-miner-atlas` off `origin/main`. Implementation order in the plan. Do not combine with drift-gate/`safeUpdate` work.

## Host limitation (do not paper over)

OpenClaw plugins cannot send proactive Telegram `inline_keyboard` and do not receive callback queries. Review returns a keyboard object *and* text confirm tokens. The nudge remains text. This is recorded here so a later host API can wire the unused keyboard without changing approve semantics.
