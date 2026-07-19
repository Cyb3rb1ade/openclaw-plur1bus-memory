# High- and Medium-Finding Remediation Design

**Date:** 2026-07-18  
**Target:** `plur1bus/main` at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`  
**Integration branch:** `fix/high-mid-audit-findings`  
**Status:** Approved in chat, including the Share scope model and opportunistic-low rule

## Goal

Fix every validated high- and medium-severity bug, feature, and security finding from the repository-wide audit without removing or blanket-disabling any feature. Every change must close the affected boundary, preserve the legitimate positive path, add a regression test that was observed failing first, and pass focused plus repository-wide verification.

## Scope

The authoritative audit snapshot is versioned under:

`docs/superpowers/audits/2026-07-18-codex-security-scan/`

Its original scan provenance was:

`/tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/`

In scope:

- Security: SEC-01 through SEC-05, SEC-10 through SEC-12, and SEC-14 through SEC-16.
- Bugs: BUG-01 through BUG-12 except low BUG-13; BUG-ADD-01 through BUG-ADD-08.
- Features: FA-01 through FA-10 and the preservation requirements FE-ADD-01 through FE-ADD-07.
- A low-severity finding may be fixed only when its vulnerable or defective branch is in the same function or control path already changed for an in-scope high/medium finding and the same regression fixture can prove both closures. It must not create a separate batch, new subsystem, or unrelated refactor.

Explicitly out of scope:

- Standalone low-severity remediation lanes.
- Removal of commands, recall boosters, local inference, Neo, Obsidian, Wiki, Graph, Multi-Namespace, schedulers, or maintenance tools.
- Major dependency or storage redesigns not required to close a validated finding.
- Silent reinterpretation, deletion, or requester-relative ownership inference for legacy data.

## Non-Negotiable Invariants

1. **Strict default isolation:** Agent-private data stays agent-bound; workspace data stays bound to exactly one canonical workspace; user data stays bound to exactly one authenticated owner.
2. **Explicit cross-workspace promotion:** Cross-workspace knowledge exchange is available only through an explicit, owner-bound user-scope promotion.
3. **Authorization before disclosure:** Unauthorized text must not reach previews, ambiguity lists, graph enrichment, rerankers, embedding providers, LLMs, or mutation sinks.
4. **Durable before acknowledgement:** A mutation is not acknowledged, checkpointed, or allowed to free its serialization slot before the durable operation settles successfully.
5. **One control truth:** ACL, lifecycle, confirmation, dry-run, read-only, and apply semantics are normalized once and propagated unchanged to the sink.
6. **Feature-positive remediation:** Every negative security/error regression has a positive test proving the legitimate feature still works.
7. **No silent configuration changes:** Explicit values and opt-outs survive; missing values follow the manifest; invalid input never silently disables a feature or changes semantics.
8. **Additive recall boosters remain additive:** Semantic Lens and CRR continue to run after base recall and preserve base output on timeout or error.

## Architecture

Use a risk-ordered hybrid rather than a single large refactor or one isolated patch per report row:

- Establish the shared identity, mutation, and persistence boundaries first.
- Apply small vertical TDD batches through real public or worker interfaces.
- Keep each batch independently reviewable and commit it only after its focused gates pass.
- Land high-conflict `index.js` batches serially; run independent dependency, cache, operations, and Obsidian work in isolated worktrees when useful.

The core request context is an immutable tuple:

```text
{ agentId, workspaceId, userId, chatId, workspaceDir }
```

Only the fields required by a given boundary are consumed, but no projection may drop ownership fields needed by a downstream ACL check.

## Collaborative Memory and Share Model

Historical compatibility requires three distinct concepts to remain available:

- Public LanceDB scopes: `agent-private`, `workspace`, and `user`.
- Internal Neo/Obsidian scopes: `agent_private`, `workspace_shared`, and `global_user`.
- Multi-Namespace storage routing: an opt-in way to read the same agent across named LanceDB namespaces; it is not an authorization bypass or a substitute for sharing.

### Commands

- `/share <id>` and the German alias `/teile <id>` copy a card into the current workspace's shared pool.
- `/share <id> --user` and `/teile <id> --user` copy a card into the authenticated owner's user pool, making it available to that owner's agents across workspaces.
- Sharing is always copy, never move. The source record remains intact.
- Sensitive, core, never-forget, or high-importance cards require a confirmation bound to `userId + chatId + nonce` before either promotion.
- User-scope sharing requires an authenticated `userId`; chat identity alone is insufficient.

### Storage

- Workspace-shared cards live in a dedicated LanceDB pool keyed by a canonical workspace identifier and a collision-resistant stable hash. Each workspace is physically isolated from every other workspace.
- User-shared cards live in a separate LanceDB pool keyed by the authenticated owner identifier and a collision-resistant stable hash.
- All paths are resolved under the configured database root with repository-native path validation and containment checks.
- Shared copies store a real embedding, public scope, complete ownership tuple, source memory ID, source agent, provenance, created timestamp, and idempotency key.
- A repeat of the same approved promotion returns the existing shared record instead of creating duplicates.

### Recall

- Base recall searches the requesting agent's private database, the current workspace pool, and—only when authenticated—the owner's user pool.
- Candidate ACL and lifecycle filtering occurs before graph enrichment, reranking, or provider document construction.
- Allowed candidates are merged, canonicalized, deduplicated, traced, and budgeted through the existing base recall pipeline.
- Semantic Lens and CRR remain later additive stages and do not gain a second write path.
- Multi-Namespace reads remain opt-in and pass through the same ACL context.

### Compatibility Migration

- Existing public rows with `scope: "workspace_shared"` are never deleted or silently reinterpreted.
- Rows with a validated, unambiguous workspace binding can be copied idempotently into the corresponding workspace pool and marked with migration provenance only after verification.
- Unbound or ambiguous rows remain untouched and appear in a repair report; ownership is never inferred from the current requester.
- Neo/Obsidian retain their internal names. Adapters map `workspace_shared` to public `workspace` and `global_user` to public `user` only at the persistence boundary.

## Remediation Batches

### B1 — Command Reachability

Findings: BUG-01.

Create agent-scoped summarizers in the real `/forget` and `/correct` initiation handlers. Tests must traverse registered commands through candidate lookup and bound confirmation while preserving `/memory`, authorization, and archive-first behavior.

### B2 — Durable Merge

Findings: BUG-02, BUG-09.

Both bridge and model-tool merge paths store and verify the replacement before superseding the original. Serialize by agent plus candidate identity or use an equivalent repository-native atomic boundary. Preserve archives and destructive-operation logs. Pass the correct bridge agent identifier to merge evaluation.

### B3 — Timeout, Admission, and Recall Cache

Findings: BUG-03, BUG-07, BUG-ADD-03.

User-visible timeouts may return promptly, but mutating slots remain occupied until the underlying promise settles. Add phase abort checks where supported and idempotent write keys at durable boundaries. Bound the recall cache with LRU plus absolute TTL and opportunistic expiry sweeps.

### B4 — Auto-Capture Checkpointing

Findings: BUG-ADD-01.

Advance offsets only after the associated embed and insert are durable. Persist partial progress idempotently, detect rotation/truncation, and return counters from valid scope. Embed/insert failure, restart, rotation, and retry tests must prove no skipped or duplicate acknowledgement.

### B5 — Cron Delivery and Provisioning

Findings: BUG-04, BUG-05, FA-08.

Treat peer bindings separately from sender allowlists, honor effective OpenClaw config path/JSON5/default-account inheritance, reject wildcard outbound targets, and report loader errors. Provision only jobs whose owning features are explicitly enabled; keep every documented handler available.

### B6 — Embedding Cache and Dependency Chain

Findings: BUG-06, embedding portion of BUG-08, BUG-10, SEC-10.

Account for incoming serialized bytes before persistent writes, reclaim SQLite/WAL space in bounded batches without deleting the newest entry, preserve explicit zero values, retain absolute persistent expiry when promoting to memory, and retry transient persistence initialization with bounded backoff. Move the optional Local Inference chain to `adm-zip >= 0.6.0` through a compatibility-proven upstream chain or, only if necessary, a tested override. Local embedding and reranking remain functional.

BUG-08 splits across this batch and B7. Treat its finding receipt as closed only once both portions' fix reports are filed together; neither batch alone proves the finding closed.

### B7 — LanceDB Lifecycle and Atomic Updates

Findings: MemoryDB portion of BUG-08, BUG-11, BUG-12.

Clear rejected initialization promises after cleanup, prefer supported in-place updates, surface combined primary and rollback failures, and hold an operation lease until DB use completes so LRU eviction cannot close an active handle.

This batch closes BUG-08 jointly with B6 — see the note there. Do not file a standalone BUG-08 receipt from either batch alone; the receipt is only complete once both fix reports are filed together.

### B8 — Neo Ownership, Embeddings, and Backpressure

Findings: BUG-ADD-04, BUG-ADD-05, SEC-14, FE-ADD-02.

Filter every Neo read/get/recall lane by requester identity before scoring or rendering. Keep `workspace_shared` visible across agents only inside the same workspace and bind `global_user` to an owner. Derive collision-resistant workspace paths, mark embeddings fresh only with a real vector, serialize writers per workspace, and bound worker queue/pending state.

### B9 — Operations and Maintenance

Findings: BUG-ADD-02, BUG-ADD-06, BUG-ADD-07, FE-ADD-06.

Reject negative retention values before planning, propagate child failures, enumerate per-agent migration targets, verify final state, and fail closed when the deploy-integrity checker is unavailable. Keep report-only reindex honest; do not claim apply support until backup, resume, dimension, and rollback contracts exist.

### B10 — Input and Time Configuration

Findings: BUG-ADD-08, FE-ADD-07. Opportunistic low: BUG-ADD-09 only when the same time-window validator is changed and covered by the same fixture.

Invalid wizard input must reprompt or fail without changing the existing feature state. Explicit invalid timezone/hour values fail with the precise config path; absent timezone retains the documented local-time compatibility fallback.

### B11 — Configuration Contract

Findings: FA-01, FA-02, FA-06, FA-09, FA-10, FE-ADD-01.

Make the manifest, effective runtime, profiles, installer-preserve behavior, commands, and documentation agree. Only explicit Recommended selection enables additional features. Safe is schema-valid and genuinely non-mutating. Top-level `enabled: false`, nested opt-outs, legacy backend state, and rollback data survive updates.

### B12 — Recall and Namespaces

Findings: FA-03, FA-07, FE-ADD-05.

Correct multi-namespace dedup arguments and trace merging, validate namespace identifiers and containment, keep write and legacy-read-only roles disjoint, and expose documented query refinement, adaptive budget, compression, candidate limits, and graph-index behavior through real runtime options. Multiple valid namespaces must return multiple results.

### B13 — ACL, Wiki, Share, and Sensitive Reads

Findings: SEC-01 through SEC-05, SEC-12, SEC-16, FA-04, FE-ADD-04. Opportunistic low: SEC-08 when the same Wiki search function and lifecycle fixture are changed.

Preserve ownership through graph hydration, fail closed on missing bindings, filter before external providers, enforce record ACL/lifecycle before Wiki preview or mutation, gate all data-bearing chat reads, preserve the complete identity tuple in safe updates, and implement the approved workspace/user Share model. ACL-denied Wiki lookups are indistinguishable from not-found.

### B14 — Obsidian and Semantic Discovery

Findings: SEC-11, FA-05, FE-ADD-03.

Parse one immutable command plan and mutation policy, authorize effective capabilities before dispatch, reject contradictory dry-run/mutation flags, and make every writer consume the same policy. Semantic Discovery receives a bound confirmation path; no mirror or index write occurs before approval. Review bundle IDs and storage are namespaced and ownership-checked.

### B15 — REM Scope Partitioning

Findings: SEC-15.

Filter candidate memories and graph neighbors by full ACL context before pattern or narrative LLM input. Preserve workspace/user bindings through pattern, dream, echo, memory, and vault output. User-scoped REM processing requires an explicit owner-partitioned run context.

## Batch Sequencing

Nine of the fifteen batches touch `index.js`, a single monolithic file; land those serially, in the order below, so each diff applies against the previous batch's exact lines rather than against the stale audited baseline. Batches with no `index.js` touch have no forced order among themselves and may run in isolated worktrees in parallel with the serial spine.

### Serial spine (touches `index.js`)

1. **B1** — `runForgetCommand`/`runCorrectCommand` initiation (`index.js:3978-4137`). No dependencies; land first.
2. **B2** — durable-merge primitive (`index.js:2623-2734`, `5131-5158`). Establishes the store-before-supersede pattern other durability fixes should follow.
3. **B7** — LanceDB lifecycle and DB lease (`index.js:624`, `736-876`, `1101-1229`; the first two ranges are BUG-08's MemoryDB portion). Ordered before B3/B4 because both assume a stable `getDb()`/lease contract that B7 fixes.
4. **B3** — timeout/admission/recall cache (`index.js:653-657`, `5541-5543`, plus `lib/runtime-scheduler.js`). Depends on B7's lease fix to avoid re-introducing the same slot-release-before-settle bug at a different layer.
5. **B11** — configuration contract (`index.js:2129-2277`, `2385-2549`). Land before B12: both edit the same config-reading block, and B12's namespace validation needs B11's corrected manifest/effective-config agreement.
6. **B12** — recall and namespaces (`index.js:4955-4970`, `5750-5765`, plus FE-ADD-05).
7. **B5** — cron delivery/provisioning (`index.js:2985-3252`). No line overlap with the batches immediately before or after; ordered here because it shares B11's "provision only explicitly enabled features" concern.
8. **B13** — ACL/Wiki/Share (`index.js:3738-3781`, `4193-4227`). These are the command dispatch switch and the registration block for the same handlers B1 fixes (`runForgetCommand`/`runCorrectCommand` are registered at `4212`/`4219`); B13 adds `/share` dispatch and registration into these exact blocks, and its confirmation-flow fixtures exercise `/correct`, which only initiates at all once B1 has landed.
9. **B14** — Obsidian/Semantic Discovery (`index.js:387-405`, `3085-3222`). Land after B13: both establish/consume the same authorize-before-dispatch ACL context.

### Parallel, isolated-worktree batches (no `index.js` touch)

- **B4** (`scripts/auto-capture-lancedb.mjs`) — should adopt the durable-checkpoint pattern B2/B7 establish, but has no file overlap with them; safe to run in parallel with the spine.
- **B6** (`lib/embedding-cache.js`, `lib/providers/*`, dependency bump) — no ordering constraint.
- **B9** (`scripts/maintain-lancedb.mjs`, `scripts/migrate-missing-columns.mjs`, `scripts/repair-installed-plugin.mjs`, `scripts/protect-plur1bus-deploy.sh`) — no ordering constraint.
- **B10** (`scripts/provider-wizard.mjs`, `lib/time-window.js`) — no ordering constraint.
- **B8** (`lib/neo-arch.js`, `lib/neo-worker-runtime.js`) — merge only after B13 lands; it consumes the ACL context B13 fixes.
- **B15** (`lib/dreaming/rem-dream.js`) — merge only after B13 lands, same reason as B8.

Line numbers are the audit's `Fundstellen` references at the 2026-07-18 snapshot commit; re-verify them before starting a batch whose predecessors in the spine have already landed and shifted surrounding lines.

## Error Semantics

- Unsafe or invalid state is rejected explicitly; it is not truncated, guessed, or silently downgraded.
- ACL denial uses non-enumerating responses where object existence is sensitive.
- Catches rethrow, return a structured error, or log with repository helpers; no new silent catch is allowed.
- If a replacement write fails, the original remains active. If a later supersede fails, the repairable duplicate state and both errors are reported rather than losing data.
- True dry-runs produce plans only and leave file content plus modification times unchanged.
- Dependency or optional-provider failure falls back only according to the existing documented provider contract; it never removes Local Inference configuration or code.

## TDD and Verification Contract

Every batch follows this order:

1. Revalidate the source-to-sink path and record the patch contract.
2. Add the smallest realistic negative regression plus a positive legitimate control.
3. Run the focused test and observe failure for the expected missing boundary or defect.
4. Implement the smallest repository-native complete fix.
5. Run the same test to green, then the owning subsystem suite.
6. Re-run the original PoC or strongest exploit trigger.
7. Perform a change-aware bypass review through direct callers and an alternate malicious input class.
8. Verify preserved behavior, syntax/import/build checks, and relevant repository tests.
9. Commit only the reviewed batch and update its finding receipt.

Repository-wide completion requires:

- All focused regressions and legitimate controls pass.
- Full serial Node suite passes with zero failures.
- `npm audit` has no unresolved high/critical finding in the shipped dependency graph.
- Optional Local Inference installs and performs a real small embedding and rerank operation on supported Node versions available to CI.
- Worktree diff contains no unrelated changes or standalone low-remediation work.
- Every in-scope finding has a fix report with changed files, red/green commands, closure proof, positive-path proof, bypass review, and remaining uncertainty. BUG-08 is split across B6 (embedding portion) and B7 (MemoryDB portion); its receipt is complete only when both batches' reports are filed and together prove full closure.
- Original `main` remains unchanged until integration is explicitly chosen.

## Baseline Evidence

The isolated worktree was created from the audited commit and installed with `npm ci --ignore-scripts` to avoid postinstall mutations.

The default sandboxed parallel suite exposed the known child-process artifact in `tests/setup-feature-crons-symlink.test.js`; direct execution passed, and a diagnostic nested-spawn probe returned sandbox `EPERM`. The authoritative serial suite outside that process restriction completed with:

```text
tests 2553
pass 2552
fail 0
skipped 1
duration_ms 375163.789294
```

No product or test file was changed while establishing this baseline.

## Completion Criteria

The remediation is complete only when all high/medium findings listed above are fixed or proven already safe at the final checkout, all required verification gates pass, every affected feature's legitimate path remains functional, compatibility/migration evidence is recorded, and no required work remains. A green partial suite or a smaller safe-looking subset is not completion.
