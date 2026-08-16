# Skill-Miner Repair + Atlas Top Gaps

**Date:** 2026-08-16
**Status:** Awaiting user review
**Stack base:** `origin/main` at `b3dfc16` (v7.3.5)
**Atlas pin:** [neoneye Agent Memory Atlas / PLUR1BUS](https://neoneye.github.io/agent-memory-atlas/systems/plur1bus/) at `b550a2d8` (v7.3.0)

## Problem

Two independent defects share one branch because both are about *what is allowed to become durable, trusted behavior*.

### Skill miner produces nothing

Scan, ownership, and the `corroborated|trusted` gate were repaired in 7.3.0–7.3.1. The remaining hole is admission: the only writer that sets `corroborated` or `trusted` is `/plur1bus correct trust`. Capture stores `""`, which `normalizeEpistemicStatus()` treats as `untrusted`. The weekly job therefore completes with `scanned: 0` / `proposalsCreated: 0` on live agents that have hundreds of in-window skill-category rows.

A three-row verbatim-fingerprint corroboration pass will not fill that hole. A read-only probe of `/Users/cyberblade/Downloads/.openclaw/memory/lancedb-namespaced` (24 571 rows, 40 agents, 2026-08-16) found:

| Signal | Count |
|---|---|
| User-role exact fingerprint with ≥3 distinct `sourceTurnId` | **1** |
| Same, restricted to skill categories | **0** |
| Empty `sourceTurnId` | 10 980 (45 %) |
| Empty `sourceMessageRole` | 10 599 (43 %) |
| Empty role ∧ empty turn | 10 599 (identity) |
| Active skill-category rows with empty role | 4 038 |
| Skill-category rows with `role=user` | 1 368 |

Capture already deduplicates near-exact text (`duplicateThreshold` ≈ 0.95). Three physical copies of the same claim almost never exist. The miner must therefore cluster *existing* rows, including unreviewed legacy, and keep SKILL.md behind a human approve.

### Atlas gaps still open on 7.3.5

7.3.1–7.3.5 did not close the atlas critique. This cut addresses two of the top gaps; the rest are explicit non-goals.

Live neo store (newest revision per id, same probe root):

| Newest neo `status` | Count |
|---|---|
| `conflict` | **4 017** (2 505 on bernhardine alone) |
| `demoted` | **0** |
| `promoted` | **0** |

`conflict` is machine-set (contradiction detector / text-contradiction / overlay path). 2 961 of the 4 017 flipped in 2026-06; 3 049 are `workflow_preference`. A 20-record sample had no pair id, no reason, and was injected context, inter-session noise, or raw audio — not pairwise contradictions. Hard-filtering `conflict` would hide thousands of records overnight with no resolve path (`/plur1bus curation conflicts` only lists; `conflict-resolver` writes a recommendation log and does not clear status).

Human curation (`promote` / `demote`) is unused on this corpus. Skill approve therefore cannot live only as another `/plur1bus` subcommand.

## Goals

- Give the skill miner a legal evidence set that can produce **proposals** from live data without minting `trusted` or writing SKILL.md without a human.
- Write an explicit epistemic value on every **new** capture so `""` remains a legacy-only sentinel.
- Make approve the only writer that moves cited legacy/observed evidence up the ladder, and put that approve on Telegram inline buttons bound by `createConfirmation`.
- Hard-filter neo `demoted` on the neo read path. Leave `conflict` as a ranking penalty and record why at the callsite.
- Route every LanceDB card write through `findBlockingTombstoneForCapture`.

## Non-Goals

- No `system:corroboration` actor, no on-card turn-id set, no cosine-band corroboration. That is a later commit if §1 still needs it after proposals exist.
- No bulk epistemic backfill. No auto-`trusted`.
- No hard filter on neo `conflict`, epistemic `disputed`, or epistemic `untrusted`.
- No Compaction/Conflict → `safeUpdate` + drift-gate wiring. Separate branch: the gate throws, and those writers can lose data.
- No global injection token budget, no scope schema on dreams/episodes, no `postinstall` host-patch removal.
- No retrieval-quality eval and no change to `scoreNeoRecallItem` weights.

## Design

### 1. Capture writes an explicit epistemic status

New LanceDB rows from `agent_end` capture and `memory_store`:

- `sourceMessageRole === "user"` **and** not `isInjectedContextText(text)` **and** not `looksLikePromptInjection(text)` → `epistemicStatus: "observed"`.
  (`promptInjectionSuspected` is a neo-turn field and is not stored on LanceDB cards. Capture already splices injected context; the injection regex must also deny `observed`.)
- Every other new write → `epistemicStatus: "untrusted"` (the string, never `""`).

`""` is reserved for rows that never received an explicit write (pre-cutoff legacy). Assistant, cron, internal, injected, and injection-suspected turns cannot land on `""` after this ships.

No inference from category, origin, retrieval count, or recency.

### 2. Legacy cutoff, write order, fail-closed

Persist `epistemicExplicitWriteSince` once, under `baseDbPath`, **before** the first post-upgrade capture that writes `observed`/`untrusted`. First start of this version: if the marker is absent, write `Date.now()` and fsync; only then accept writes.

Miner legacy admission (in addition to `observed|corroborated|trusted`):

```
epistemicStatus === ""
  AND createdAt < epistemicExplicitWriteSince
  AND category ∈ SKILL_EVIDENCE_CATEGORIES
  AND sourceMessageRole ∈ {"user", ""}
```

Assistant-origin legacy stays out. New denials cannot enter this window because they are `untrusted`, not `""`.

On each miner run, if any scanned `""` row has `createdAt >= epistemicExplicitWriteSince`, the legacy path **closes** for that agent (fail-closed: restore, clock jump, or a writer still emitting `""`). `observed|corroborated|trusted` admission is unaffected.

Live ratio to record in the miner comment and a unit fixture: empty-role skill rows outnumber `role=user` skill rows (~4 038 vs 1 368 on the probed store). The review queue will be mostly unknown-origin material. That is accepted because SKILL.md still requires approve.

### 3. Miner clustering and labels

Replace the current `isTrustedSkillEvidence` allowlist used for **proposal clustering** with:

- `observed`, `corroborated`, `trusted`
- plus the legacy predicate in §2

Still excluded: explicit `untrusted`, `disputed`, `invalidated`, and post-cutoff `""`.

Each proposal carries `evidenceGrade` equal to the **weakest** member of the cluster:

- `unreviewed-legacy-norole` — at least one cited row has `sourceMessageRole === ""`
- `unreviewed-legacy` — all cited legacy rows have `sourceMessageRole === "user"`
- `observed` / `corroborated` / `trusted` — no legacy members

The Telegram review list and the nudge render that grade. Scoring bonuses for `corroborated`/`trusted` stay as they are; legacy/observed add no trust bonus.

`isTrustedSkillEvidence` as a name becomes misleading. Rename the clustering predicate (e.g. `isAdmissibleSkillEvidence`) and keep a separate helper for the trust bonus so scoring cannot silently treat legacy as corroborated.

### 4. Approve: SKILL.md first, then status

`/plur1bus skills approve` and the new inline confirm call the same function.

Order (same crash rationale as `safeUpdate`: store the durable artifact first):

1. Write `skills/<slug>/SKILL.md` and fsync.
2. Mark the proposal `active`.
3. For each cited evidence id, authorized human `transitionEpistemicStatus`:
   - `""` → `observed` (enter the axis; logged; per id)
   - `observed` → `corroborated`
   - already `corroborated`/`trusted` → no-op
   - `disputed`/`invalidated`/`untrusted` → skip that id, do not fail the approve

A crash between (1) and (3) can re-propose the same cluster. That is visible and deduped by existing skill-name blocking. The reverse order would remove rows from the legacy path with no SKILL.md — silent loss.

Reject does not change epistemic status.

Approve/reject remain behind `isAuthorized(..., { destructive: true })`.

### 5. Telegram inline + existing nudge

`renderSkillProposalNudge` already injects a text reminder. Extend that payload (and the `skills review` list) with Approve / Reject buttons:

- `createConfirmation({ command: "skills-approve" | "skills-reject", targetId: proposal.id, userId, chatId })`
- `validateConfirmation` on the callback; wrong user/chat/nonce/expiry fail closed
- Buttons do not bypass authorization

No new channel (no Obsidian approve in this cut). `/plur1bus skills review|approve|reject` stay as the non-inline path.

### 6. Neo `demoted` withholds; `conflict` does not

`conflict` and `demoted` live on neo JSONL records, not on LanceDB cards. There is no SQL clause to add in `db-adapter.js` — a `status = 'demoted'` predicate would hit the **card** lifecycle column (`active|superseded|archived|deleted`) and would be wrong.

Hard withhold, newest revision only, same places `pruned`/`tombstoned` already return `-Infinity`:

- `scoreNeoRecallItem` in `lib/neo-arch.js`
- any neo formatter/router that already drops `-Infinity`

Do **not** filter LanceDB recall on neo status.

`conflict` stays a 0.3 penalty and stays in the payload. At `scoreNeoRecallItem`, next to the penalty, a comment (not a commit message) must state:

> `conflict` is not a hard filter: the detector is an unvalidated LLM, 4 017 newest-revision records on the 2026-08-16 live probe carried `conflict` (2 505 on one agent) with no resolve path that clears the status, and a 20-row sample was not pairwise contradiction. Atlas gap left open on purpose.

Prompt supplement that says “prefer active/promoted over conflicting” remains valid because `conflict` still arrives.

`/plur1bus memory demote` help text must say that demote now **withholds** from neo recall (reversible via `promote`), unlike the old “ranks down” meaning.

Epistemic `disputed` stays a −0.4 rank penalty. No system actor in this cut may set `disputed` or `conflict`.

### 7. Tombstone choke on every card write

`findBlockingTombstoneForCapture` today runs only at the two `memory_store`/capture sites. Compaction `table.add` and `MemoryDB.store` / `MemoryDB.update` / `db-adapter.updateCard` can resurrect a forgotten fingerprint.

One shared helper (same fingerprint, same scope bindings, same fail-closed unread-registry behavior) is called **before** any of:

- `MemoryDB.store`
- `MemoryDB.update` when text/summary changes
- `db-adapter.updateCard` when it `table.add`s a replacement
- `memory-compaction.js` `table.add`

Dream narrative uses `db.store` and is covered by the adapter. Skill-miner does not write cards.

Blocked write returns a structured `tombstone_blocked` result and must not allocate a new id. Compaction treats a blocked merge as skip (leave both sources), never as delete.

## Error handling

- Cutoff marker I/O failure: do not write `observed`/`untrusted` yet; skip the miner legacy path; log via `safeWarn`. Fail closed, not open.
- Legacy-path fail-closed (post-cutoff `""` seen): log once per run, cluster only explicit statuses.
- Approve step 3 failure after SKILL.md exists: return success for the skill file plus a list of evidence ids that did not transition; do not delete the skill.
- Tombstone registry unreadable: block the write (existing fail-closed).
- Inline confirmation invalid: deny, no state change.

## Test strategy

DB-free unit tests first (the repo default). No live-store writes.

1. **New assistant row with missing `sourceMessageRole`** lands on `untrusted` and is **absent** from miner clustering.
2. **Legacy `""` row** with `createdAt` one day before the cutoff **is** clustered; same row one day after the cutoff is not; if any `""` is after the cutoff, the whole legacy path closes.
3. **Empty-role vs user-role** clusters emit `unreviewed-legacy-norole` vs `unreviewed-legacy`.
4. **Approve order:** mocked filesystem — if the status writer throws, SKILL.md still exists; if SKILL.md write throws, no status transition ran.
5. **Approve transitions:** cited `""` → `observed`; cited `observed` → `corroborated`; `invalidated` citation skipped.
6. **Inline confirm:** `createConfirmation` / `validateConfirmation` for `skills-approve` — wrong user denied; matching user calls the same approve function.
7. **`demoted`** newest revision scores `-Infinity` and is absent from neo recall formatting.
8. **`conflict` still admitted** with a finite score below an otherwise identical `active` record (negative control so a later refactor cannot silently harden it).
9. **Tombstone:** forgotten fingerprint blocked from `MemoryDB.store`, from `update` text change, and from compaction `add`. Call counts 0.

Then the focused files plus `node --test tests/*.test.js`.

## Delivery

One branch off `origin/main`: `fix/skill-miner-atlas`.

Implementation order:

1. Capture status + cutoff marker + miner admission/labels (miner can propose).
2. Approve transitions + SKILL.md-first order + inline buttons.
3. `demoted` withhold + callsite comment + demote help text.
4. Tombstone helper at the four write sites.

Do not combine (4) with drift-gate/`safeUpdate` work.

## Live probes (throwaway, not shipped)

Recorded 2026-08-16 against `Downloads/.openclaw/memory/lancedb-namespaced`. Scripts were not committed. Re-run before calling the miner “fixed” on a newer snapshot; do not treat these counts as invariants in tests.
