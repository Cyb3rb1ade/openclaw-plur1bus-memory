# The PLUR1BUS engine API

**Contract version 1.6.0** · frozen at 1.0.0 on 2026-09-22, amended seven times
under the amendment policy · source of truth: `types/engine.d.ts`

This document explains the contract; `types/engine.d.ts` *is* the contract, and
`types/engine.conformance.ts` fails `npm run typecheck` if the two disagree on
any of the four decisions below.

## Why it is frozen

Phase 0 sketched this API in four places and they disagreed on four points
(`PLUR1BUS-Harness/docs/phase0/review-report.md`, finding S4). Owner decision
**B8** (2026-09-22) settled each one, and the `.d.ts` was frozen **before**
PR-01 so both adapters — the OpenClaw plugin and the harness — are written
against one shape.

| Point | ADR-002 said | `engine-extraction.md` §b.2 said | B8 chose |
|---|---|---|---|
| Principal strength | `proof: "transport"` | `trust: "proved" \| "inferred"` | **`trust`** |
| Turn origin | one `TurnOrigin` object | string union + `AgentContext` | **union + `AgentContext`** |
| Capture | `Promise<CaptureResult>` | non-blocking handle | **`CaptureHandle`** |
| Degradation | `degraded: boolean` | `degraded: { reason, … }` | **structured, `\| null`** |

## Amending the contract

`types/engine.d.ts` states its own amendment policy:

> Amendment policy: "frozen" means 1.0.0 is never edited in place. Any change
> to an exported member's shape that an existing adapter could observe — a new
> required property, a removed or renamed member, a narrowed or widened union,
> a changed parameter or return type — forces a `ContractVersion` bump; only
> additions no adapter can observe (a comment, a new optional property on a
> type the engine alone constructs) may land without one.
> `ContractVersion`, the assertions in `types/engine.conformance.ts` and both
> adapters move together in a single PR, so the contract, its gate and its two
> consumers are never in disagreement at any commit.

Seven amendments have landed since the 1.0.0 freeze, per the `.d.ts` header's
own changelog:

- **1.1.0** — `SecurePathResult.reason` gains `"acl-tool-unavailable"` (Task 5).
- **1.2.0** — `HostServices.workspaceDir` becomes async (Task 6).
- **1.3.0** — `HostServices.configPath()`, `HostServices.routing?`, `HostServices.pathOverrides?` (G1 closure, M1b-1 Task 11).
- **1.4.0** — the `Engine` surface of `createEngine` (M1b-1 Task 13c),
  consumed by `engine/create-engine.js` and the adapter, in one commit:
  `ContextBlock.chars`; `RecallResult.timing` (replaces `timings`) and
  `.deferrals`; `RecallQuery.budget` optional; `JobRun`/`JobRegistry`/
  `JobSpec` per spec §3.3 (`JobOutcome` gains `"abandoned"`);
  `CheckpointReason` gains `"session-end"`; `Engine.close({ budgetMs })`;
  `Engine.channels`; `HostServices.capabilities?`; `EngineEventName` gains
  `recall.block-clipped`/`-dropped`/`recall.completed`; `createEngine`'s
  test-only `testOptions`.
- **1.4.1** — `JobTrigger` gains `"unknown"`: the trigger of a `failed`/`crash`
  row recovered from a corrupt (unreadable) start marker, which carries no
  trustworthy trigger (M1b-1 final review). Consumed by
  `engine/jobs/job-registry.js` and `engine/create-engine.js` in the same
  commit.
- **1.5.0** — typed MemoryOps (engine PR E1): `Engine.memory` with the six
  members `list`/`show`/`forget`/`correct`/`share`/`state`, the types
  `MemoryOps`, `MemoryCard`, `MemoryListQuery`, `MemoryListResult`,
  `MemoryForgetResult`, `MemoryCorrectResult`, `MemoryShareResult`,
  `MemoryState`, `MemoryScope`, `MemoryOpError`/`MemoryOpErrorCode`;
  `MemoryState.tombstones` is `number | null`; the optional host capability
  `HostCapabilities.memoryArchiveDir()`; `runCommand` is deprecated (removed
  in 2.0). The OpenClaw adapter's `/forget`, `/correct` and `/share` run
  their final effect through `Engine.memory` in the same PR. See
  [Typed MemoryOps](#typed-memoryops-enginememory-150) below.
- **1.6.0** — admin ops without a host runtime, shared-copy rules and change
  proposals (engine PR E2, spec decision D31): `AdminOps.share`/`.forget`
  become deprecated aliases of `Engine.memory.share`/`.forget`; `ObsidianOps`
  (`AdminOps.obsidian.{detect,prepare,confirm}`) with explicit paths, no host
  runtime; `AdminOps.migrate` over a store schema marker
  (`EngineStatus.storeSchema`); `MemoryOps.propose`/`.proposals.
  {list,accept,reject}` for changing a shared copy the caller does not own;
  `MemoryCard.sharedBy`/`.sourceId`; `MemoryOpError.detail`; the
  `"memory.proposal"` event. See
  [Shared copies and change proposals](#shared-copies-and-change-proposals-160-d31)
  and [AdminOps in 1.6.0](#adminops-in-160-obsidian-migrate-the-deprecated-aliases)
  below.

## The two halves

**`HostServices`** — what a host gives the engine. ADR-002 calls it `Host`;
they are the same type. Required: `logger`, `stateDir`, `configPath()`,
`workspaceDir(agentId)`, `config()`, `platform`, `runtime`. Optional:
`routing()` (loads the host's routing capability — four session/channel
parsers; absent degrades turn identity to the agent's own context),
`pathOverrides` (raw path overrides `lib/host-paths.js` honours; absent means
`~/.openclaw`), `capabilities` (host-specific construction inputs —
registration mode, path resolver, optional host features — every one with an
inert default), `mutateConfig`, `llm`, `secrets`, `events` (`emit(name,
payload)`, read by every `emitEngineEvent` call in `engine/**`), `clock`
(defaults to `Date.now`). `lib/host-services.js` implements it for OpenClaw
(`createHostServices(api)`) and for tests (`createStubHost()`).

**`Engine`** — what the engine gives a host. Lifecycle (`open`, `close`,
`status`), the turn path (`systemSupplement`, `recall`, `capture`,
`checkpoint`), the memory surface (`memory`, 1.5.0), the model-facing surface
(`tools`, `commands`, and the deprecated `runCommand`), and the background
surface (`jobs`, `embedding`, `admin`, `events`, `channels`). `engine/create-engine.js`'s `createEngine(host, config,
testOptions?)` builds one; `testOptions.internals` overrides members of the
engine's internal object after construction (e.g. a stub embedder) and is
test-only.

## Rules the types encode

- **`recall()` never throws.** A failure comes back as `degraded: { reason, capability }` with whatever blocks were assembled. The turn is never blocked. `degraded.reason` is one of `"invalid-query"` (missing signal, bad principal), `"aborted"` (the caller's signal), `"timeout"` (the scheduler's own budget), `"pressure"` (shed under memory pressure), `"queue-full"` (the recall queue was full or evicted the job), `"error"` (a scheduler error, or the store section failed and only the neo/start blocks came back) or `"engine-closed"` (called after `close()`); `null` means a clean recall, never a failure.
- **`signal` is mandatory** on `RecallQuery` and `TurnRecord`. A missing or already-aborted signal degrades immediately (`degraded.reason` `"invalid-query"`/`"aborted"`) rather than throwing or hanging.
- **`capture()` returns immediately.** The caller gets a `CaptureHandle` with a `done` promise it may await or abandon. `capture()` fails closed on `incognito`: `TurnRecord.incognito` is a required field, and any value other than `false` (including a caller who leaves it unset) resolves `done` to `{ stored: 0, skipped: 1, reason: "incognito" }` without touching a store. `incognito: false` is the host's own classification and is final: the engine does not consult the host routing classifier (`HostServices.routing`) again, so a host without routing still captures a turn that carries a `sessionKey`. (Were that classifier ever consulted from an Engine caller and fail, the turn is not stored and the reason is `"incognito-unclassifiable"`.) `CaptureResult.stored` is the number of records the capture pipeline actually stored for the turn (0 or more; `skipped` is the pipeline's own count of texts it passed over); a turn the pipeline finds nothing worth storing in resolves `{ stored: 0, skipped: 0 }` with no `reason` (a clean capture, not a failure); a turn that is not captured at all resolves `{ stored: 0, skipped: 1, reason }` — `"incognito"`, `"principal-agent-mismatch"`, `"engine-closed"`, or whatever the capture pipeline itself reports.
- **The six blocks are the output shape, and they are data — the host joins them.** `neo`, `start` and `memories` are droppable; `time`, `temporal` and `reminder` are not. `RecallResult.blocks`/`capChars` are plain data; nothing in `engine/**` concatenates them into a prompt string. `adapter/openclaw/join-recall.js`'s `prependContextFromRecall(result)` is the OpenClaw host's own join-and-cap step (`lib/inject-budget.js`'s `applyGlobalInjectBudget`), producing the `{ prependContext }` shape `before_prompt_build` expects; a harness host does its own equivalent joining.
- **`UserPrincipal` stays `user:v1:sha256([channel, accountId, userId])`.** The hash is an on-disk pool directory name; changing it orphans every `user`-scoped row.
- **`trust: "inferred"` degrades to agent-private and never throws.** `engine/identity/principal.js`'s `memoryContextFromPrincipal` gives a `"proved"` principal the same defence-in-depth `lib/memory-request-context.js` already applies to a host hook (user format `/^user:v1:[0-9a-f]{64}$/`, channel must be registered, chat kind normalized, workspace resolved through the canonical resolver with the conflicting-workspace-identity check); when any of that fails, or the principal is `"inferred"`, the memory context falls back to the unclaimed, agent-private base context rather than throwing — the same fail-open-to-degraded behaviour `resolveHostHookMemoryContext`'s `catch` block already had. `AgentContext.origin` from a caller of `Engine.recall`/`capture`/`runCommand` is taken as given; a hook-derived origin resolved inside the adapter (e.g. a background job body) never claims `"cron"` for itself — that origin is reserved for `agentContextFromCommand`, and a background hook turn maps to `"system"`.
- **Every clip or drop the join performs is a `Deferral`, and every `Deferral` is also an L3 event.** `Deferral.reason` is `"global-cap"` (the outer `capChars` budget, `lib/inject-budget.js`'s planner) or `"memories-cap"` (`recall.memoriesMaxChars`'s inner cap via `onTruncate`) — those are the only two values in the union (unchanged since 1.4.0). `engine/recall/assemble-prompt-context.js` emits one `recall.block-clipped` or `recall.block-dropped` host event per deferral, `{ agentId, ...deferral }`, alongside the ones it collects into `RecallResult.deferrals`.
- **The cancellation signal reaches every recall dependency, and abort returns what finished.** `RecallQuery.signal`/`opts.signal` threads into the embedder (`embedQuery`/`embed`), the reranker (`raceAbort(reranker.rerank(...), rerankAbort, ...)`, one timer — see below), and LanceDB's own query path (`db.table` reads). An aborted or timed-out recall does **not** come back empty: it returns the blocks that finished before the cutoff (`completed.neo`/`completed.start`, whichever the prelude produced) with `degraded.reason` set to `"aborted"` (caller-initiated) or `"timeout"` (the scheduler's own budget) — spec §3.2's abort contract, a deliberate behaviour change from M1a (Global Constraint 7c): the seven golden scenarios never time out, so their oracle is unaffected. When the scheduler answers an aborted or timed-out recall from its recall cache, the result still carries `degraded.reason: "aborted"` or `"timeout"`; `Engine.recall` keys that cache by the whole principal (agent, workspace identity, user, channel, account, chat, trust) plus the query, so a cached answer never crosses principals, and every result is a copy of what the cache holds. An aborted recall stops its side effects: due reminders are not marked presented, and a late value is never written to the cache.
- **One rerank timer, not two.** The reranker gets one signal (`rerankSignal(signal, rerankerTimeoutMs)`: the caller's signal plus the single `rerankerTimeoutMs` timer) and is raced against that same signal (`raceAbort(reranker.rerank(...), rerankAbort, "reranker timeout")`) — "one timeout owner" means one timer, not that nothing bounds a provider that ignores its own signal. The embedder and the LanceDB reads have no timer of their own: they are bounded by the caller's signal through `raceAbort` in the providers and in `lib/recall-pipeline.js`.
- **Every job run produces a ledger row, including a skip.** `<baseDbPath>/_jobs/<agentId>/ledger.jsonl` (one `JobRun` per line, append-only) plus `<baseDbPath>/_jobs/<agentId>/running/<runId>.started` marker files that exist exactly while a body runs — a marker with no matching row at the next process start is a crash, logged and recorded as `failed`/`crash`. The root is `<baseDbPath>/_jobs`, not `stateDir` (a deliberate deviation from spec §3.3's literal wording, Task 7: it keeps the ledger inside the same directory tests already isolate per agent via `baseDbPath`, which the harness controls anyway). `incomplete` outcomes retry up to `MAX_ATTEMPTS = 3` total attempts (the original run plus two retries, `engine/jobs/job-registry.js`); the third `incomplete` becomes `outcome: "abandoned"`, `reason: "abandoned_after_retries:<original reason>"`, with a diary line (when the diary is enabled) recording the abandonment. `rem`/`deep` phases share a per-agent, per-UTC-day breaker (`BREAKER_LIMIT = 3` LLM sessions, `sweepKey(ms)` = the UTC calendar day of `startedAt`): a session is any non-pre-skipped `rem`/`deep` run, retries included (a retried run is still a session, since it still spends an LLM call); once the sweep's count reaches the limit, further `rem`/`deep` runs come back `skipped`/`circuit_open` without attempting the body. The count includes sessions still in flight (an in-memory reservation taken before the body and released when the run finishes), so concurrent starts cannot overrun the limit. A `JobSpec.singleton` job, and a `rem`/`deep` job, already running for the same agent is not started twice: the second start comes back `skipped`/`already_running` (recorded like any other skip, never an LLM session). `already_processed` is decided by the body from the ledger: a key counts as processed when any ledger row recorded it as completed (`keys`, via `markCompletedKey`) — whatever that row's outcome, so a `failed` run that had already marked its key counts too — or when the key was abandoned after retries (the skip's reason is then `abandoned`); an `incomplete` row alone never makes a key processed. Historical `run-state.json` REM completions are migrated into the ledger once (`engine/jobs/run-state-migration.js`): each `completed[runKey]` entry becomes a ledger row with `cost: { ms: 0 }`, `migrated: true`, `llmSession: false` (migrated rows never count toward the breaker); the old file is never read again once migration has appended its rows for a given key.
- **`checkpoint(agentId, reason)` and `compactedAt`.** `CheckpointReason` is `"compaction" | "session-end" | "shutdown" | "manual"` (`CHECKPOINT_REASONS`, `engine/checkpoint/checkpoint-store.js`); an unknown reason throws `TypeError` before any write. A `RecallQuery.compactedAt` (or a host event's own `compactedAt`) tells the recall assembler when the transcript was last compacted, for reactivation logic that keys off "time since the last compaction" rather than off wall-clock idle time alone — an explicit value on the query always wins over whatever the checkpoint store itself would infer.

## Typed MemoryOps (`Engine.memory`, 1.5.0)

`Engine.memory` is the typed way to read and edit an agent's memory; it
replaces string commands (`runCommand("plur1bus", "forget …")`) for every host
that is not OpenClaw's own chat surface. Each member takes the caller's
`Principal` and `AgentContext` explicitly and resolves them through the same
`memoryContextFromPrincipal` as `recall`/`capture` (with the engine's
workspace aliases), so ACL, scope and trust behave exactly as on the turn path.
The implementation lives in `engine/memory-ops/` (`context.js`, `errors.js`,
`read.js`, `write.js`).

| Member | Returns | Notes |
|---|---|---|
| `list(q, p, a)` | `MemoryListResult` | exactly one of `q.topic` (vector search, results carry `score`, best first) and `q.since` (epoch ms, optional `q.until` not before it; newest first); `limit` defaults to 20, maximum 100; `truncated` says more matched. Reads the same ACL-filtered access pools `/memory` uses; every pool contributes its best or newest `limit + 1` rows and the merge orders them globally. |
| `show(id, p, a)` | `MemoryCard` | reads the same pools as `list` (agent-private, and the workspace and user pools the principal can reach), with the same ACL and liveness test (`isRecallEntryLive`), so every id `list` returns resolves; superseded, archived, forgotten, invalidated, expired or foreign rows are all `not-found`. |
| `forget(id, p, a)` | `MemoryForgetResult` | archive-first, then a two-phase tombstone (attempted → committed) and a `memory.deleted` audit line. Forgetting one's own already-forgotten card again answers `alreadyForgotten: true` with the same `tombstoneId`. |
| `correct(id, newText, p, a)` | `MemoryCorrectResult` | archive-first, then a version-chain update through `lib/safe-update.js` (new row, old row superseded, summary re-derived from the new text, `updateSource: "user_correction"` and an evidence line naming the stored text, the Neo reconsolidation event, retrieval reinforcement). **`id` is the new, live version's id**; the id passed in is superseded. |
| `share(id, target, p, a, opts?)` | `MemoryShareResult` | copies a card into the `"workspace"` or `"user"` pool; needs a `"proved"` principal that carries that identity. A sensitive card (category, core, `neverForget`, importance ≥ 0.9) is refused with `approval-required` until the caller repeats the call with `{ allowSensitive: true }` after the person confirmed. |
| `state(p, a)` | `MemoryState` | live card counts per scope (`null` when a scope cannot be counted), the tombstone count (`null` when the registry is unreadable, never a false zero) and the archive directory. |

**`forget`, `correct` and `share` act on the caller's own agent-private
cards only** (1.5.0). An id that is a live card in a workspace or user pool
the principal can reach (so `list` and `show` return it) answers `denied`
with the message "shared copies cannot be changed through this call yet",
not `not-found`; an id the principal cannot see anywhere stays `not-found`.
Changing a shared copy is an E2 follow-up; OpenClaw's `/forget` has the same
limit today.

**Failures are typed.** Every member rejects with a `MemoryOpError` (`name:
"MemoryOpError"`, a stable `code`, an English, log-safe `message` that never
carries card text or a raw storage error; `isMemoryOpError` in
`engine/memory-ops/errors.js`):

| `code` | When |
|---|---|
| `not-found` | no such card, or one the caller may not see, or one that is not live — deliberately indistinguishable (anti-oracle) |
| `denied` | a destructive member (`forget`, `correct`, `share`) called with an origin other than `"user"` or with `background` not `false`; a principal whose workspace claim contradicts the agent's workspace; `share` without a proved principal carrying the target identity; `forget`/`correct`/`share` of a card that exists for the caller only as a shared (workspace or user) copy |
| `invalid-input` | a malformed id, principal or agent id, an empty or over-long `newText` (1–8 000 characters after trim), an unknown `share` target, an agent without a workspace directory for a destructive member; for `list` an empty or whitespace-only `topic`, `until` with `topic`, or `until` before `since` |
| `approval-required` | `share` of a sensitive card without `allowSensitive: true` |
| `conflict` | `correct` to a text that matches a forgotten memory in the same scope (tombstone guard), or a share source that changed while it was being copied |
| `storage` | the store, the archive or the audit log failed; nothing is reported as done. Also every member after `engine.close()` ("engine is closed"), before any store is touched |

**Where archives go.** Archive-first backups land in
`<stateDir>/memory/_archive/<agentId>/` unless the host names its own
directory through `HostServices.capabilities.memoryArchiveDir()` (read per
call). The OpenClaw adapter passes the directory `/forget` and `/correct` have
always written to (`~/.openclaw/memory/_archive`, or
`$OPENCLAW_HOME/.openclaw/memory/_archive`), so nothing moves for OpenClaw.

**The OpenClaw adapter as a consumer.** `/forget`, `/correct` and `/share`
keep parsing, LLM input normalisation, candidate disambiguation, the nonce
confirmation store, locale, rendering and `checkAuth` in
`adapter/openclaw/register-commands.js`; only the final effect runs through
`Engine.memory`, under `principalFromMemoryContext(memoryCtx, trust)` and
`agentContextFromCommand(commandCtx)` — or, for a body reached through the
`/plur1bus` router (`Engine.runCommand` included), the router's own
`AgentContext`, so a subagent's command never becomes a `"user"` forget. A context from
`resolveHostCommandMemoryContext` counts as `"proved"` (it throws on any
disagreement between the host's route facts, session and conversation binding
instead of degrading); a context that already carries `trust` keeps it.
`MemoryOpError.code` maps back to the existing reply keys: `not-found` →
`*_not_found`, anything else → `*_failed` (for `/share`:
`not-found`/`conflict` → `share_not_found`, `approval-required` → the
confirmation flow). A `denied` arrives only after the adapter's `checkAuth`
passed (a principal round trip that fails, a non-user origin), so it answers
`*_failed` rather than the whitelist hint of `plur1bus.unauthorized`, and its
reason is logged. Three reply changes are deliberate: at confirmation time
not-found and ACL-denied both answer `*_not_found`; the variable in
`*_failed` is the generic English `MemoryOpError` message instead of the
localized per-case error; and superseded, archived, expired and invalidated
targets are refused as not-found. `/memory` deliberately stays on
`queryMemoryAcrossAccessPools`: its `--explain` flag and filter syntax are not
modelled by `MemoryListQuery`. `/correct trust …` (epistemic-status
transitions) is not a MemoryOps member and keeps its own path.

**`runCommand` is deprecated** (1.5.0) and removed in contract 2.0: string
commands are the OpenClaw adapter's own chat surface, and a host that needs to
read or edit memory uses `Engine.memory`.

## Shared copies and change proposals (1.6.0, D31)

1.5.0 left changing a shared (workspace/user) copy undefined — `forget`,
`correct` and `share` answered `denied` for any id that lived only in a
shared pool. 1.6.0 (spec decision D31, `engine/memory-ops/shared.js`,
`proposal-store.js`, `proposals.js`) fills that in:

- **The sharing agent still owns the copy.** `forget(id, …)` on a shared row
  the caller shared (`card.sourceAgentId === agentId`) **retracts** it:
  archive-first, then the same soft delete `tombstoneCard` writes
  (`status: "deleted"`, `epistemicStatus: "invalidated"`), plus a
  `share-retract` audit line. `MemoryForgetResult.tombstoneId` is always
  `null` for a retraction — the row is deliberately **not** written to
  `lib/tombstone.js`'s registry, because the registry blocks re-capture of
  forgotten content and the sharer's private original stays live and
  capturable. `correct(id, newText, …)` on the same row **refreshes** it, in
  this order: (1) correct the private original through the same
  archive-first path E1's `correct` uses; (2) re-share the corrected
  original to the same scope; (3) retract the old copy. Sharing before
  retracting means a failure leaves at worst two live copies, never none —
  the retract step can always be repeated. A failure after step 1 rejects
  `storage` with `detail: { sourceId, sharedId }` naming the ids left behind
  (`sharedId` is whichever copy is still live: the old one if step 2 failed,
  the new one if step 3 failed), plus `staleSharedId` (the old copy) when
  step 3 is the one that failed. `MemoryOpError.detail` (1.6.0, non-secret
  ids only) exists for exactly this case.
- **Any other agent files a proposal instead of being denied outright.**
  `MemoryOps.propose(sharedId, newText, p, a, opts?)` needs `origin: "user"`,
  `background: false` like every destructive member; it rejects
  `invalid-input` when `sharedId` names one of the caller's own live private
  cards (that is a `correct`, not a proposal) or when the sharer is the
  caller itself (the sharer corrects the original directly), `not-found` for
  a shared id the caller cannot read, `denied` ("this shared copy has no
  recorded sharer") for a legacy shared row without `sourceAgentId` or
  `sourceMemoryId` (before any store write), and `conflict` when the same
  caller already has a pending proposal open against that copy — or is
  filing one concurrently (an in-process claim keyed on sharer, lowercased
  `sharedId` and proposer spans the duplicate check and the write). Filing a
  proposal never changes the shared copy — only the sharer's
  `proposals.accept` does.
- **A proposal belongs to the shared pool of its copy.** `propose` records
  the pool key of the copy it targets (the workspace pool key for a
  workspace copy, the user pool key for a user copy — the same keys
  `lib/shared-memory-pool.js` leases). The key is internal: it is stored in
  the proposal file but stripped from every returned `MemoryProposal`, so
  the contract type is unchanged. `proposals.list`/`.accept`/`.reject` reach
  a proposal only when its pool key is one the caller's principal can reach
  (its workspace pool and, with a user principal, its user pool); otherwise
  `list` omits it and `accept`/`reject` answer `not-found` before any
  `stale` marking. The same sharer agent under another user principal
  therefore neither sees nor resolves the first user's user-scope proposals
  (anti-oracle). A proposal file without a pool key is unreachable.
- **Proposals are a durable, one-file-per-proposal JSON store**
  (`engine/memory-ops/proposal-store.js`), not a LanceDB table: each lives at
  `<dirname(baseDbPath)>/_proposals/<sharerAgentId>/<id>.json` — a sibling of
  the LanceDB root, the same layout `lib/tombstone.js` uses for
  `_tombstones`. Writes are atomic (an exclusive-flag temp file, fsynced,
  then renamed onto the final path); a corrupt neighbor file is counted in
  `MemoryProposalListResult.unreadable` and skipped, never allowed to hide
  the rest of a listing (anti-oracle).
- **`proposals.list(q, p, a)`** shows the caller only proposals it filed or
  received: its own directory (as sharer) in full, plus every other agent's
  directory filtered to proposals this agent filed (as proposer), both
  limited to pools the principal can reach (above). Optional
  `q.status` filters to one of `"pending" | "accepted" | "rejected" |
  "stale"`; `limit` defaults to 20, maximum 100, same as `MemoryListQuery`.
- **`proposals.accept(proposalId, p, a)`** is sharer-only — anyone else's
  `proposalId` (including the proposer's own) answers `not-found`, since
  proposals are looked up under the caller's own agent id. A pending
  proposal whose shared copy is gone, or whose text no longer matches the
  proposal's `oldText` (the sharer refreshed or retracted it since filing),
  is never applied over the new content: it is marked `stale` and the call
  rejects `conflict`. Otherwise it refreshes the shared copy with the
  proposal's `newText` through the same `refreshShare` path the sharer's own
  `correct` uses; any failure there leaves the proposal `pending` (so
  `accept` can be retried) and surfaces the refresh error, `detail` included,
  unchanged. Only a definite absence marks a proposal `stale`: a failed
  shared-copy lookup rejects `storage` and leaves it `pending`. A successful
  accept records `resultId` (the new shared copy's id) and emits
  `memory.proposal` with `status: "accepted"`; if recording the acceptance
  (or its audit line) fails after the copy was refreshed, `accept` rejects
  `storage` with `detail: { proposalId, id, sourceId }` naming the refreshed
  copy and original.
- **`proposals.reject(proposalId, p, a, opts?)`** is sharer-only the same
  way; it only records `status: "rejected"` and an optional `resolutionNote`
  (max 500 characters) — the shared copy is never touched. If the audit line
  fails after the rejection was recorded, `reject` rejects `storage` with
  `detail: { proposalId }`.
- **`memory.proposal` event** (`EngineEventName`, 1.6.0) fires once when a
  proposal is filed (`status: "pending"`) and once when it is resolved
  (`"accepted" | "rejected" | "stale"`), each time with `{ proposalId,
  status, sharerAgentId, proposerAgentId, sharedId }`.
- **`MemoryCard.sharedBy`/`.sourceId`** (1.6.0) appear only on a
  workspace/user copy: the agent that shared it and the id of its private
  original, so a reader can tell a shared card apart from an agent-private
  one and a proposer can name the right `sharedId`.

## AdminOps in 1.6.0: obsidian, migrate, the deprecated aliases

- **`AdminOps.share`/`.forget` are deprecated aliases of `Engine.memory.share`/
  `.forget`** (1.6.0, removed with 2.0) — the same code path, not a second
  implementation; `engine/create-engine.js` wires both `admin.share`/`.forget`
  and `memory.share`/`.forget` to the same `internals.memoryWrite` members.
- **`AdminOps.obsidian`** (`engine/admin/obsidian.js`) is host-neutral vault
  setup with explicit paths and no host runtime — the harness names a vault
  path itself rather than the engine walking a host's own workspace
  discovery:
  - `detect(p, a, opts?)` is read-only. It merges, de-duplicated by
    normalised path: any vaults `discoverObsidianWorkspaces` finds from the
    engine's own `obsidianBridge` config (`source: "config"`), the caller's
    workspace directory (`source: "workspace"`), and up to 20 caller-supplied
    candidate paths (`source: "candidate"`, `invalid-input` beyond that;
    candidates need a `"proved"` principal, `denied` otherwise — the config
    and workspace sources stay available to any caller).
    Every path accepts `~`, `~/…`, a bare relative path (resolved against the
    caller's home directory) or an absolute path (`expandVaultPath`). Each
    candidate reports `isVault` (a `.obsidian/workspace.json` or
    `.obsidian/app.json` marker exists) and `confirmed` (a receipt for this
    agent, workspace and vault already exists).
  - `prepare(vaultPath, p, a)` needs a `"proved"` principal with a user
    (`denied` otherwise, checked before any filesystem probe) and an
    existing directory (`invalid-input` otherwise); it issues a nonce good for **10 minutes**
    (`lib/obsidian-vault-confirmation-flow.js`'s
    `prepareVaultConfirmation`, the same `lib/security.js`
    `createConfirmation` every other confirmation flow uses — no third
    confirmation mechanism) and remembers which vault path that nonce
    prepared, so `confirm` does not need the caller to repeat it.
  - `confirm(nonce, p, a)` consumes the nonce on its first successful call:
    an unknown, expired or already-consumed nonce answers `not-found`; a
    nonce whose stored identity binding does not match the confirming
    principal (a different user or chat) answers `denied`. On success it
    writes a receipt under
    `<baseDbPath>/.plur1bus-authority/obsidian-vaults/` — only after
    `validateConfirmation` inside `confirmVaultConfirmation` actually
    succeeded, never before. `ObsidianConfirmResult.alreadyConfirmed` is
    computed from the pre-confirm state (whether a receipt already existed
    **before** this call), not from the confirmation library's own
    post-write flag, which reads `true` on every successful confirm.
    Identity binding uses `memoryCtx.userPrincipal` mapped onto the shared
    libraries' `userId` field locally in `engine/admin/obsidian.js` (the
    Principal-derived memory context never populates `userId` itself),
    applied identically at `prepare` and `confirm` time.
  - No raw filesystem error leaves `detect`/`prepare`/`confirm`: a failure
    inside the confirmation libraries (vault digest, receipt read or write)
    is logged with `logger.warn` and answers `not-found` ("vault not found",
    no path) when the vault directory has vanished, `storage` ("vault
    confirmation failed") otherwise.
- **`AdminOps.migrate(from, to)`** (`engine/store/schema-version.js`, "variant
  a" of the owner's schema-migration ruling) advances a small on-disk marker,
  not the LanceDB table shape itself: `<baseDbPath>/_schema.json`, `{
  schemaVersion, writtenAt, engineVersion }`, written atomically (temp file,
  then rename). A store with no marker reads as `LEGACY_STORE_SCHEMA_VERSION`
  ("0") — every store this engine build has ever written already has the
  column set contract 1.5.0 needs (LanceDB's own migration in
  `memory-db.js` applies it the first time a table opens), so the one
  registered step, `"0->1"`, is a no-op that only writes the marker once its
  owner confirms the store has that shape. `migrate` rejects `conflict` when
  `from` does not match the store's current version, `invalid-input` for a
  downgrade or an unknown target version, and `storage` when the marker file
  exists but cannot be parsed, or when a migration step or the marker write
  fails ("store migration failed"; the raw error goes to `logger.warn`
  only). `migrate(v, v)` is a same-version no-op:
  `{ from, to, applied: false }` without touching the marker.
  `EngineStatus.storeSchema` (1.6.0) reports `{ current, expected }` so a
  host can tell a legacy store apart from one already on the version this
  engine build expects.

## What is implemented in M1b-1

`createEngine(host, config, testOptions?)` (`engine/create-engine.js`)
constructs the full 1.6.0 `Engine` surface described above from a plain
`HostServices` object with no OpenClaw `api` anywhere in its call graph —
`createEngine(createStubHost(), config)` is exactly how the engine's own
tests build one, and `tests/engine-contract.test.js` proves it end to end.
`index.js` is a 55-line shell: it constructs the engine's context objects via
`createHostServices(api)`, wires OpenClaw's registration order through
`adapter/openclaw/plugin.js`'s `register(api, deps?)`, and re-exports the 19
frozen public names `tests/index-public-exports.test.js` pins.

**The adapter shape.** `adapter/openclaw/plugin.js` is the one place that
turns a real OpenClaw `api` into `HostServices` and registers OpenClaw's own
hooks/commands/tools against the engine's context objects — the nine
`register-*` modules under `adapter/openclaw/` each own one slice of that
registration, in the same order index.js always registered them in
(`adapter/openclaw/README.md`'s module table). `engine/internals.js` is the
one legitimate seam between them: `internalsOf(engine)` reads the
non-enumerable `EngineInternals` a `createEngine()` call attaches to its
`Engine`, and only the adapter is meant to reach through it — the harness
uses the public `Engine` surface exclusively. This seam exists because the
adapter still needs M1a's context-object handlers (the recall assembler, the
capture pipeline, the command/tool bodies) directly, not re-wrapped behind
`Engine.recall`/`capture`/`runCommand`, so it can register them as OpenClaw's
own hooks with OpenClaw's own hook signatures; it is removed at PR-14.

**What does not work yet on a host without the OpenClaw adapter** (i.e. a
bare `createEngine(customHost, config)` with no `adapter/openclaw/**`
involved):

- `runCommand(name, args, principal, agent)` (deprecated since 1.5.0 — use
  `Engine.memory`) answers only `"plur1bus"`; any
  other command name comes back `{ details: { reason: "unknown-command" } }`.
  Even for `"plur1bus"`, the six user-facing command bodies (and their
  auth/locale helpers) are still built by the OpenClaw adapter
  (`register-commands.js`) and handed to the engine as `commandBodies`; on a
  host that never registered that adapter, the dispatcher's guard returns
  `{ details: { reason: "commands-unavailable", capability: "commands" } }`
  instead of throwing.
- `admin.reembedding.rollback` and `admin.reembedding.switch` reject with
  `"<name> is not available in M1b-1"` when the host gave the engine no
  config-mutation capability (`internals.reembeddingSwitchRuntime` unset) —
  the only two `admin.*` members still without a full implementation.
  Everything else under `admin.*` is wired to a real coordinator or store as
  of 1.6.0 (E2): `admin.share`/`.forget` are deprecated aliases of
  `Engine.memory.share`/`.forget`; `admin.obsidian.{detect,prepare,confirm}`
  and `admin.migrate` have their own engine-side implementations (see
  [AdminOps in 1.6.0](#adminops-in-160-obsidian-migrate-the-deprecated-aliases)
  above); `admin.reembedding.{plan,apply,resume,status}` and
  `admin.workspacePolicy.*` were already wired to real coordinators.
- `embedding.probe()` and `embedding.serve()` are placeholders: `probe()`
  always resolves `{ ok: true, cached: false }` without actually exercising
  the provider, and `serve()` returns a no-op `Disposable` without opening any
  IPC address.
- `status()` reports `{ ready: true, degraded: null, agents:
  openedAgents.size, contract: "1.6.0", storeSchema: { current, expected } }`
  — `storeSchema` (1.6.0) is the one part of the status that does probe the
  store (it reads the schema marker), the rest is still static and does not
  probe the embedder or any other dependency for actual health.

Everything else — `recall`, `capture`, `checkpoint`, `memory.*` (1.5.0/1.6.0),
`jobs.run`/`history`, `tools`, `embedding.embed`/`rerank`/`identities`,
`channels`, `admin.reembedding.plan`/`apply`/`resume`/`status`,
`admin.workspacePolicy.*`, `admin.share`/`.forget`/`.obsidian.*`/`.migrate` —
works against a plain `HostServices` with no adapter involved, per
`tests/engine-contract.test.js`.

## Hosting rules

- **One engine per process.** `createEngine` binds process-wide state:
  `bindHostPaths(host.pathOverrides)` (`lib/host-paths.js`),
  `setPluginLogger(host.logger)` (`engine/runtime/debug-log.js`) and the
  channel vocabulary behind `Engine.channels.register`
  (`registerRouteProvider`, `lib/memory-request-context.js`) are module
  globals, so a second engine in the same process silently rebinds them for
  the first. A host runs one engine and routes every agent through it.
- **Never forward a client-supplied origin.** `AgentContext.origin` is taken
  as given, and `"cron"` is the origin the `plur1bus internal …` command path
  trusts without an auth check (`engine/commands/plur1bus-command.js`). A
  host sets `origin` from its own knowledge of where the turn came from; a
  value a client sent over the wire must never reach `runCommand`,
  `recall` or `capture` as `AgentContext.origin`.
- **`close()` never rejects.** A resource that fails to close is logged and
  the engine counts as closed anyway. After `close()`, `recall` resolves
  `degraded.reason: "engine-closed"`, a capture handle's `done` resolves
  `{ stored: 0, skipped: 1, reason: "engine-closed" }`, and `jobs.run`
  rejects with `Error("engine closed")`.
- **`close()` drains in-flight memory operations first (E2 Task 3).** Every
  `Engine.memory`/`admin` member that runs through the shared `MemoryOps`
  context (`memory.*`, `admin.share`/`.forget`/`.obsidian.*`/`.migrate`) is
  tracked while it runs; `close({ budgetMs })` awaits every still-running one
  (`Promise.allSettled`, never rejecting on one of their failures) before it
  tears down the stores, all inside the same `budgetMs` race a slow resource
  close already used — a call already past its guard when `close()` starts
  is never cut off mid-write, and no store closes under a lease. A call that
  arrives after `close()` began is refused immediately (`storage`, "engine is
  closed") rather than joining the drain.

## `RecallQuery` fields the engine ignores

Three `RecallQuery` fields are accepted (the contract keeps them for a future
consumer) but have no effect on M1b-1's recall path: `budget` (the scheduler's
own soft/hard budget and `assemble-prompt-context.js`'s `globalInjectMaxChars`
govern timing and size; a caller-supplied `RecallBudget` is not read),
`validAt` (bi-temporal filtering at query time; not wired into
`runMergedNamespaceRecall`'s parameters), and `previousUserTurnAt` (no
consumer reads it in M1b-1). Passing them is harmless — they are simply not
consulted — and is not the same as passing `signal`, which is mandatory and
does change behaviour.

## The job ledger (spec §3.3)

Covered above under "Rules the types encode"; summarised here for reference:

| Fact | Value |
|---|---|
| Ledger path | `<baseDbPath>/_jobs/<agentId>/ledger.jsonl` |
| Marker path | `<baseDbPath>/_jobs/<agentId>/running/<runId>.started` |
| Retry limit | `MAX_ATTEMPTS = 3` (original + 2 retries) → `abandoned` |
| Breaker | `BREAKER_LIMIT = 3` LLM sessions per agent per UTC day (`sweepKey`), `rem`/`deep` phases only, retries counted |
| Crash row trigger | the marker's trigger; `"unknown"` for a corrupt (unreadable) marker (1.4.1) |
| `already_processed` | any row whose `keys` hold the key (any outcome), or an abandoned key (reason `abandoned`); never an `incomplete` row alone |
| Concurrency | in-flight rem/deep sessions count toward the breaker; a singleton or rem/deep job already running for the agent → `skipped`/`already_running` |
| `Engine.jobs.run` options | only `trigger`, `signal`, `dryRun` reach the registry; `signal` is observed before start only (already aborted → `skipped`/`aborted`; job bodies do not take it yet, M1b-3); `dryRun` → `skipped`/`dry_run_unsupported`, nothing runs, no ledger row |
| Migration source | `run-state.json`'s `completed[runKey]` entries, once, `migrated: true` |

## The L3 events

`EngineEventName`: `dream.completed`, `job.run`, `acl.denied`,
`recall.degraded`, `embedding.identity.changed`, `recall.block-clipped`,
`recall.block-dropped`, `recall.completed`, `memory.proposal`. The five
recall-shaped ones:

- **`recall.block-clipped`** / **`recall.block-dropped`** — one per
  `Deferral` the global-inject-budget join produces, `{ agentId, ...deferral
  }` (`block`, `kind`, `from`, `to`, `reason`).
- **`recall.degraded`** — emitted on every degraded exit from the recall
  assembler, including an invalid query (missing/aborted signal before
  scheduling), a caller abort (also when answered from the cache), a
  scheduler timeout, pressure shedding, a full queue, or a scheduler or store
  error — `{ agentId, degraded }`.
- **`recall.completed`** — emitted exactly once per scheduled recall attempt
  (whether it finished normally, timed out, was aborted, or failed), right
  before the assembler returns: `{ agentId, timing, degraded }`. `timing =
  RecallResult.timing = { phases: phaseTimer.summary(), totalMs:
  phaseTimer.elapsedMs(), namespacePhases }` — `phases`/`totalMs` are the
  outer phase timer's own view (the same one `lib/runtime-scheduler.js`'s
  timeout-warning log line reads), and `namespacePhases` is the fine-grained
  per-namespace phase list (`[{ namespace, phase, ms }]`), collected via
  `runMergedNamespaceRecall(..., { onNamespacePhases })` and never folded
  into the outer timer. `Engine.recall` and the adapter's own registered
  `before_prompt_build` hook both call the same assembler
  (`createPromptContextAssembler`), so this event fires exactly once per
  attempt regardless of which caller triggered it — `Engine.recall` does not
  emit a second copy of its own.
- **`job.run`** — one per job run, carrying the same shape as the ledger row.
- **`memory.proposal`** (1.6.0) — one per proposal lifecycle transition:
  `{ proposalId, status, sharerAgentId, proposerAgentId, sharedId }`, fired
  once when `MemoryOps.propose` files a proposal (`status: "pending"`) and
  once when `proposals.accept`/`.reject` resolves it (`"accepted"` /
  `"rejected"` / `"stale"` — the last when `accept` finds the copy stale).

## Host-neutral `lib/` rules and the lint's residual gaps

`scripts/lint-engine-imports.mjs` enforces seven rules inside `npm run lint`:
(1) `engine/**` never imports `openclaw`, `lib/setup/*-plugin-runtime.js`,
`lib/runtime-shutdown.js`, `lib/host-services.js` or
`lib/providers/openclaw-memory-embedding-adapters.js`; (2) neither
`engine/**` nor `adapter/**` imports `index.js`; (3) no import cycle inside
`engine/** + adapter/**`; (4) `engine/**` never reads `.api` off anything;
(5) `engine/**` never names a bare `api` identifier either — rules 4 and 5
are text rules over the source lines (comments and simple quoted strings
stripped first, template literals not), so an `engine/**` comment may not
spell `api` followed by a dot — write "the host's `registerTool`" instead;
**(6) transitive** — every `lib/**` module reachable from `engine/**` through
relative imports obeys rule 1 too, walked and reported with the chain that
reaches a forbidden module (M1b-1 Task 12); **(7)** no `process.env.OPENCLAW_*`
read and no literal `"openclaw/…"` load specifier (`import()`/`require()`/
`resolve()`) anywhere on that same transitively-walked graph — host paths
come from `HostServices`/`lib/host-paths.js`; host SDK modules from
`lib/host-sdk-loader.js` (M1b-1 Task 12).

Rule 7's env check is deliberately blunt (a per-line textual match, not a
data-flow analysis) and rule 6/7's walk has documented residual gaps, carried
forward rather than chased with more regex:

- An indirection that separates `process.env` and an `OPENCLAW_` token across
  two statements or two lines (`const env = process.env; …;
  env.OPENCLAW_HOME` later) is not caught.
- A string literal that merely *mentions* `process.env.OPENCLAW_HOME` (in a
  log message or an error string) is flagged as a violation too — a loud
  false positive, not a silent miss, matching how rules 4/5 already favour
  noise over blindness.
- `COMPUTED_IMPORT` (a non-literal `import(` specifier) is checked for every
  module the walk reaches, but only for `import()` — a `require(someVar)` or
  a variable-built `openclaw` string passed to something other than
  `import()` is out of scope. `engine/store/lancedb-loader.js`'s four
  computed `import(<path>)` fallbacks are the one file-scoped exception
  (`COMPUTED_IMPORT_ALLOW`, pinned to exactly one file by a test): they are
  package resolution, not host coupling.

Two other gates run inside the same `npm run lint`:
`scripts/lint-no-api-outside-adapter.mjs` (only `index.js`, `adapter/**` and a
short allowlist of host-coupled `lib/` files — `lib/setup/*-plugin-runtime.js`,
`lib/runtime-shutdown.js`, `lib/providers/openclaw-memory-embedding-adapters.js`,
`lib/providers/scoped-embedding-ipc.js`, `lib/host-services.js` itself — may
reference `api.` at all) and `scripts/typecheck.mjs` (`tsc --noEmit` over
`types/`, so `types/engine.conformance.ts` fails the build the moment it and
`types/engine.d.ts` disagree — checked at contract 1.5.0).

## Module layout after M1b-1

| Path | Holds |
|---|---|
| `engine/create-engine.js` | `createEngine(host, config, testOptions?)` — builds every context object, the nine views, and the 1.5.0 `Engine` surface |
| `engine/internals.js` | `ENGINE_INTERNALS`/`internalsOf(engine)` — the adapter-only seam onto `EngineInternals` |
| `engine/events.js` | `emitEngineEvent(host, name, payload)` |
| `engine/lifecycle/close-resources.js` | the shutdown owner `Engine.close({ budgetMs })` calls |
| `engine/recall/assemble-prompt-context.js` | the per-turn recall assembly, the six blocks, `RecallResult.timing`, `recall.completed`/`recall.block-*`/`recall.degraded` |
| `engine/recall/namespace-recall.js` | `runMergedNamespaceRecall` — one pipeline run per leased namespace, merged after every child settles; `onNamespacePhases` |
| `engine/recall/minimal-maintenance.js` | the auto-recall-off branch |
| `engine/recall/recall-result.js` | `recallResult()`/`contextBlock()`/`ABORTED` — the one constructor for `RecallResult` |
| `engine/recall/system-supplement.js` | `Engine.systemSupplement()`'s static prefix |
| `engine/capture/capture-turn.js` | auto-capture, `Engine.capture()`'s body |
| `engine/checkpoint/checkpoint-store.js` | `CHECKPOINT_REASONS`, `Engine.checkpoint()`'s store |
| `engine/memory-ops/context.js` | `createMemoryOpsContext` — `Principal` → memory context, the destructive/share guards, the archive directory |
| `engine/memory-ops/errors.js` | `memoryOpError`, `isMemoryOpError`, the six codes |
| `engine/memory-ops/read.js` | `Engine.memory.list`/`show`/`state` |
| `engine/memory-ops/write.js` | `Engine.memory.forget`/`correct`/`share` |
| `engine/memory-ops/shared.js` | `createSharedMemoryOps` — shared-copy retract/refresh (D31), `isLive`/`isSharer` |
| `engine/memory-ops/proposal-store.js` | `createProposalStore` — the one-file-per-proposal JSON store under `_proposals/<sharerAgentId>/` |
| `engine/memory-ops/proposals.js` | `createMemoryProposals` — `MemoryOps.propose`/`.proposals.{list,accept,reject}`, `memory.proposal` event |
| `engine/admin/obsidian.js` | `createObsidianOps` — `AdminOps.obsidian.{detect,prepare,confirm}` |
| `engine/store/schema-version.js` | `createStoreMigrator` — `AdminOps.migrate`, the `_schema.json` marker |
| `engine/identity/principal.js` | `memoryContextFromPrincipal` — `Principal`/`AgentContext` as explicit inputs, the channel registry |
| `engine/jobs/job-registry.js` | `createJobRegistry` — the 18 engine-owned jobs, retry/abandon/breaker, `MAX_ATTEMPTS`, `BREAKER_LIMIT`, `sweepKey` |
| `engine/jobs/job-ledger.js` | the append-only `ledger.jsonl` + started-markers, crash detection |
| `engine/jobs/job-specs.js` | the `JobSpec` table (name, `needsLlm`, `singleton`, `defaultSchedule`, `phase`) |
| `engine/jobs/internal-job-bodies.js` | the job bodies themselves |
| `engine/jobs/rem-outcome.js` | REM-specific outcome/diary helpers |
| `engine/jobs/run-state-migration.js` | migrates `run-state.json` REM completions into the ledger, once |
| `engine/commands/plur1bus-command.js` | `/plur1bus` dispatch and the internal job runners |
| `engine/commands/command-helpers.js` | shared command-body helpers |
| `engine/tools/memory-tools.js` | the five model-facing tools |
| `engine/store/agent-db-pool.js` | `EngineAgentDbPool` — per-agent `MemoryDB` leasing |
| `engine/store/memory-db.js` | `MemoryDB` — the LanceDB-backed per-agent table |
| `engine/store/lancedb-loader.js` | LanceDB's own dynamic import (the one `COMPUTED_IMPORT_ALLOW` file) |
| `engine/store/control-health.js` | control-health state, read by `Engine.status()`'s callers |
| `engine/providers/runtime-reranker.js` | the reranker wrapper `embedding.rerank` and recall both use |
| `engine/providers/legacy-providers.js` | pre-engine-extraction provider shims (unused, shipped, deletion is an owner call) |
| `engine/runtime/constants.js` | shared numeric/string constants |
| `engine/runtime/env-config.js` | config normalization with no host env reads |
| `engine/runtime/llm-calls.js` | LLM call wrappers used by job bodies and recall |
| `engine/runtime/debug-log.js` | `dbg()` |
| `engine/runtime/semantic-discovery.js` | `semanticDiscovery` link-index building |
| `engine/knowledge/knowledge-pending.js` | pending-knowledge curation helpers |
| `adapter/openclaw/plugin.js` | `register(api, deps?)` — the one place `HostServices` is built from a real `api` and OpenClaw's hooks/commands/tools are registered, in frozen order |
| `adapter/openclaw/host-probes.js` | OpenClaw-specific capability probing used during registration |
| `adapter/openclaw/turn-principal.js` | resolves a `Principal`/`AgentContext` from an OpenClaw hook's own arguments |
| `adapter/openclaw/join-recall.js` | `prependContextFromRecall` — the host's join-and-cap step over `RecallResult` |
| `adapter/openclaw/register-turn-route.js` | `reply_dispatch`, `agent_end` run cleanup |
| `adapter/openclaw/register-recall-hook.js` | `before_prompt_build` (auto-recall on) |
| `adapter/openclaw/register-maintenance-hook.js` | `before_prompt_build` (auto-recall off) |
| `adapter/openclaw/register-capture-hook.js` | `agent_end` auto-capture |
| `adapter/openclaw/register-commands.js` | the `plur1bus_*` commands, `/state`, `/enable`, `/disable`, the control-UI descriptor and control-health pair, the critical-push claiming hooks, and the four `lib/setup/*-plugin-runtime.js` delegations |
| `adapter/openclaw/register-tools.js` | the five model-facing tools |
| `adapter/openclaw/register-prompt-supplements.js` | the static system-prompt supplement and the Neo corpus supplement |
| `adapter/openclaw/register-gateway.js` | a lone `gateway_start` (Neo warm-up) plus two `gateway_start`/`gateway_stop` pairs (Obsidian bridge, Neo service), the shutdown owner and the four after-lifecycle service registrations |
| `adapter/openclaw/register-cron.js` | the unsafe direct feature-cron guard and the deferred feature-cron bootstrap |
| `index.js` | construction (`createHostServices` → `createEngine`), the `plugin.register()` call, the `/wiki` command, and the `export default` plugin factory — 55 lines |

`adapter/openclaw/README.md` records two facts worth repeating here: every
moved range keeps its **original call position** inside `register()` (folding
several ranges into one call site would reorder the host's per-event handler
lists), and `/wiki` stays registered from `index.js` because it goes through
the local `registerPluginCommand` helper rather than the `registerChatCommands`
command table `register-commands.js` owns.
