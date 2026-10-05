# The PLUR1BUS engine API

**Contract version 1.10.0** · frozen at 1.0.0 on 2026-09-22, amended eleven times
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
- **1.7.0** — `EmbeddingService.probe()` and `.serve()` real (engine PR E3):
  `probe(opts?)` exercises the configured provider once (identity, readiness,
  a memoized successful result), returning `EmbeddingProbeResult`;
  `serve(address?: IpcAddress | null)` starts the engine's scoped-embedding
  IPC server on `address` (or the platform default) as the in-process owner,
  without the loopback claim listener (ADR-001 C1), returning
  `EmbeddingServeResult`; `null` stops serving. `admin.obsidian.detect`
  reports a vault that vanishes mid-check as unconfirmed instead of failing
  the whole call (R11). `HostCapabilities.pushCriticalButtons` is typed. See
  [EmbeddingService in 1.7.0](#embeddingservice-in-170-probe-and-serve)
  below.
- **1.8.0** — `Engine.status()` real, `Engine.models`, journal backlog, a
  turn-replay guard, and typed `unsupported` for shared memory on a platform
  with no mode (engine PR E4): `EngineStatus` gains `jobs` (ledger-derived
  job health), `models` (embedder/reranker readiness), `journal` (a host's
  own backlog, capped at 50 ms), `sharedMemory` (support and mode), and a
  real `degraded` derivation instead of always `null`; `Engine.models` with
  `status()` and `warm({ signal })`; `HostCapabilities.journalBacklog?()`;
  `CaptureResult.reason` gains `"aborted"`, `"capture-failed"` and
  `"capture-incomplete"`, and a replayed turn (same `agentId`, `runId`,
  `sessionKey` and `messages` within 7 days) is recognised before the
  capture pipeline runs and answers `"duplicate-turn"` without a second
  summary, row or session count; `MemoryOpErrorCode` gains `"unsupported"`,
  answered by `Engine.memory.share`/`.proposals.accept` (and the OpenClaw
  `/share` reply) on a platform whose shared-memory mode is `"unavailable"`,
  before any row, archive or `.plur1bus-shared` directory is touched. See
  [Status, models and shared memory in 1.8.0](#status-models-and-shared-memory-in-180)
  below.
- **1.9.0** — a host-neutral engine config schema, warm-only recall, honest
  recall timing, bounded fragment compaction and a neo worker that lets the
  process exit (engine PR E5): `engine/config/engine-config.schema.json`
  describes every engine config key with its type, default, description,
  `readAt` (`"construction"` or `"live"`), `x-tier` and `x-sensitive`, loaded
  through `loadEngineConfigSchema`/`engineConfigKeys`/`readAtOf`/`livePaths`/
  `sensitivePaths`/`secretInputPaths`, with `redactSensitiveConfig` to mask
  the `x-sensitive` values (`engine/config/engine-config-schema.js`);
  `openclaw.plugin.json`'s `configSchema` and `secretInputs.paths` are
  generated from it (`npm run gen:config-schema`, `--check` for CI); all
  `recall.*` keys are construction-time. `RecallQuery.warmOnly` runs the
  read-only heavy recall path (neo prelude, query embedding, a read-only
  store open, vector search, rerank) with no writes (no store, file or
  persistent embedding-cache row), no event, no recall-cache use and no LLM
  call, at background priority. `RecallTiming.totalMs` now covers
  the queue wait and the prelude honestly, `phases.completed` beginning with
  `entry`/`queue`/`prelude`. `runtime.lancedbCompaction` bounds LanceDB
  fragment growth between `dailyConsolidation`'s own nightly optimize runs,
  on by default on every host. `close()` now releases the shared neo worker
  so a process with neo enabled can exit. See
  [Engine configuration schema in 1.9.0](#engine-configuration-schema-in-190)
  below.
- **1.10.0** — additive engine-config keys from the 7.18.5–7.18.20 port onto
  `main` (`runtime.deferPostTurnLlm` default false, plus diary/chunking/full-text
  keys) and `JobName` `"post-turn-refine"`. Adapter-only keys
  (`runtime.traceRegistrations`, `groupReasoningFilter`) live on the OpenClaw
  manifest. Existing callers keep working: new keys are optional with defaults,
  and the job name is an additive union member.

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
test-only. `testOptions.sharedMemoryMode` (test-only, untyped, not part of
the contract) forces the `SharedMemoryPool` routing mode — `"fd-capability"`,
`"verified-path"` or `"unavailable"` — so Linux CI can drive the
verified-path mode end to end; the pool is captured by local bindings in
`createEngine`, so an `internals` override would not reach every user of it.

## Rules the types encode

- **`recall()` never throws.** A failure comes back as `degraded: { reason, capability }` with whatever blocks were assembled. The turn is never blocked. `degraded.reason` is one of `"invalid-query"` (missing signal, bad principal), `"aborted"` (the caller's signal), `"timeout"` (the scheduler's own budget), `"pressure"` (shed under memory pressure), `"queue-full"` (the recall queue was full or evicted the job), `"error"` (a scheduler error, or the store section failed and only the neo/start blocks came back) or `"engine-closed"` (called after `close()`); `null` means a clean recall, never a failure.
- **`signal` is mandatory** on `RecallQuery` and `TurnRecord`. A missing or already-aborted signal degrades immediately (`degraded.reason` `"invalid-query"`/`"aborted"`) rather than throwing or hanging.
- **`capture()` returns immediately.** The caller gets a `CaptureHandle` with a `done` promise it may await or abandon. `capture()` fails closed on `incognito`: `TurnRecord.incognito` is a required field, and any value other than `false` (including a caller who leaves it unset) resolves `done` to `{ stored: 0, skipped: 1, reason: "incognito" }` without touching a store. `incognito: false` is the host's own classification and is final: the engine does not consult the host routing classifier (`HostServices.routing`) again, so a host without routing still captures a turn that carries a `sessionKey`. (Were that classifier ever consulted from an Engine caller and fail, the turn is not stored and the reason is `"incognito-unclassifiable"`.) `CaptureResult.stored` is the number of records the capture pipeline actually stored for the turn (0 or more; `skipped` is the pipeline's own count of texts it passed over); a turn the pipeline finds nothing worth storing in, with every item cleanly considered and none of them failing, resolves `{ stored: 0, skipped: 0 }` with no `reason` — a clean capture, not a failure. `{ stored: 0, skipped: 0 }` is **not** a blanket "nothing went wrong" signal, though: as of 1.8.0 a turn whose items all failed (embedder down, dedup or write failure) resolves with `reason: "capture-incomplete"` instead, `"aborted"` for a cancellation before any row settled, or `"capture-failed"` for any other pipeline error on the typed path — see [Turn replay (Q3)](#turn-replay-q3-a-replayed-capture-does-not-run-twice) below for these and for `"duplicate-turn"`. A turn that is not captured at all resolves `{ stored: 0, skipped: 1, reason }` — `"incognito"`, `"principal-agent-mismatch"`, `"engine-closed"`, `"duplicate-turn"`, or whatever the capture pipeline itself reports.
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

## EmbeddingService in 1.7.0: probe and serve

- **`probe(opts?)`** (`engine/providers/embedding-service.js`,
  `createEmbeddingProbe`) answers whether the configured embedding provider
  is actually loaded and producing usable vectors — it never throws on a
  provider failure; the result says `ok: false` instead, and the raw
  provider error goes only to `logger.warn`.
  - Each provider call embeds a fixed text — `` `plur1bus embedding probe
    ${nonce}:${attempt}` `` — where `nonce` is a random id generated once per
    engine and `attempt` increments on every real call, so the text never
    repeats and can never be answered from a persisted embedding cache.
  - A successful probe (a finite vector of exactly `identity.dimensions`) is
    memoized; a later call answers the memoized result with `cached: true`
    and makes no provider call, until `opts.refresh === true` forces a new
    one. A **failed** probe is never memoized, so a retry always exercises
    the provider again.
  - `opts.refresh === true` always gets a provider call of its own: when a
    call is already in flight, the refreshed call is queued to start after
    it settles (refreshes queued behind the same call share that one new
    call) — it is never answered by the older call's result.
  - `probe()` has no timeout of its own; callers should pass `opts.signal`
    (or an `AbortSignal.timeout(...)`) so a hung provider cannot stall them —
    the harness warm-up does.
  - Concurrent calls without `refresh` share one in-flight provider call.
    Each caller's own `opts.signal` aborting only that caller's wait answers
    that caller `{ ok: false, error: "aborted", cached: false, identity,
    durationMs, checkedAt }` — it never cancels the shared call or the other
    callers waiting on it.
  - `error` is one of `EmbeddingProbeError`: `"provider-failed"` (the
    provider call threw), `"invalid-vector"` (not an array/typed array, or a
    non-finite element), `"dimension-mismatch"` (a finite vector of the
    wrong length), `"aborted"` (this caller's own signal fired first).
  - The harness uses `probe()` as its embedding warm-up primitive; E4 reads
    model-readiness status without making a provider call of its own from
    two extra methods on the object `createEmbeddingProbe` returns
    (`internals.embeddingProbe`; not part of the `Engine` surface):
    `lastResult()` — the most recent **successful** probe, or `null` (a
    later failure does not clear it); `lastAttempt()` — the most recent
    **completed** probe, `ok` or failed, or `null` (an `"aborted"` answer is
    never recorded: an abort ends only one caller's wait, the provider call
    still completes and becomes the last attempt).
- **`serve(address?)`** (`createEmbeddingServing`) starts the engine's
  scoped-embedding IPC server (`lib/providers/scoped-embedding-ipc.js`) as
  the **in-process owner** — `claim: false`, so unlike the legacy OpenClaw
  path it never opens the loopback claim listener (ADR-001 C1).
  - **Default address per platform** (omitted `address`, i.e. `undefined`;
    `host.platform.ipcAddress(resolveScopedEmbeddingIpcPaths(baseDbPath).
    directory)`): Linux — an abstract socket (no filesystem entry, released
    on process death); macOS and other POSIX — a filesystem socket at
    `<baseDbPath>/control/embedding-ipc/owner.sock`; Windows — a named pipe
    `\\.\pipe\plur1bus-embedding-<32 hex>` (the SHA-256 of the embedding-ipc
    directory path `<baseDbPath>/control/embedding-ipc`, truncated to 32 hex
    characters; the Linux abstract-socket name uses the same digest). No
    claim listener is opened for any of these.
  - The token always lives at
    `<baseDbPath>/control/embedding-ipc/owner.token`, for every address kind
    — including an abstract socket or named pipe, neither of which has a
    filesystem entry of its own. `EmbeddingServeResult.tokenPath` is this
    path; the token itself is never in a result, a log line or an error.
  - **Idempotency:** calling `serve` again with the address already being
    served (same `kind`/`address`) resolves the same result object without
    restarting anything. A **different** address while one is already
    served rejects `conflict` ("embedding IPC is already served on another
    address") — one engine serves at most one address at a time.
  - **`null`** stops serving and resolves `EmbeddingServeResult` with
    `address: null`, `tokenPath: null`, `identity: null` (in-process only;
    `null` is never forwarded to the transport — it is handled before any
    address validation or `createServer` call). `null` when nothing is
    being served is a no-op that resolves the same shape.
  - **`dispose()`** (on the resolved `EmbeddingServeResult`, part of
    `Disposable`) stops that server, but only while it is still the
    currently-served one (checked both when called and again inside the
    serialized queue) — fire-and-forget, it does not reject.
  - **`close()`** stops serving as part of engine shutdown
    (`engine/lifecycle/close-resources.js`), before the embedding provider
    itself is closed.
  - **Error table** (`MemoryOpError`):
    - `invalid-input` — a malformed `address` (not an `IpcAddress`-shaped
      object), a kind the current platform does not use (e.g. a named pipe
      off Windows), or, for a `unix-socket` address, an unsafe socket
      directory: missing, a symlink, not a directory, or not private
      (POSIX mode with any group/other bit set) — checked before anything
      listens or any token is written.
    - `conflict` — another address is already served; the requested address
      is in use (a live foreign listener, or another in-process owner on
      the same address answers `scoped_embedding_owner_already_active`,
      surfaced here as "embedding IPC address is in use" — this is also
      what a second **in-process** `serve()` on a different address gets,
      via the transport's single in-process-owner-per-`stateRoot` guard);
      the host lifecycle already owns this stateRoot's IPC (`hostOwned`);
      this engine's own embedding provider is itself an IPC client, not an
      owner.
    - `storage` — the engine is closed or closing; the listener failed to
      start for any other reason ("embedding IPC server failed to start",
      raw error to `logger.warn` only); `serve(null)` failed to stop the
      running server ("embedding IPC server failed to stop", raw error to
      `logger.warn` only) — the served state is still cleared either way.

### Security model

- **POSIX filesystem sockets** (macOS/BSD `unix-socket` default, or any
  caller-supplied `unix-socket` address): the socket's parent directory must
  already be private (`0700`, not a symlink) before `serve` will use it, and
  the socket file itself is secured to `0600` after the listener binds. The
  token file is `0600` inside a `0700` directory.
- **Abstract sockets (Linux) and named pipes (Windows) have no filesystem
  permissions at all** — there is nothing to `chmod`. The guard for both is
  the same as for a filesystem socket: every request's envelope token is
  compared with `timingSafeEqual` against the private token file, plus the
  model/dimensions/fingerprint identity binding baked into the envelope
  (`{dimensions, fingerprintId, model, request, token}`) — a client with the
  right token but the wrong model or fingerprint still gets an error frame,
  never vectors. The address itself is not treated as a secret barrier, only
  as a rendezvous point; the token is the actual credential.
- **Windows pipe ACLs are out of scope for 1.7.0** (PR-11): Node's `net`
  module cannot set a DACL on a named pipe, so an engine serving a named pipe
  today relies on the default pipe security descriptor rather than a
  user-SID-scoped ACL. Windows system tests for the pipe transport are
  deferred to the same PR-11.
- **The token authenticates clients to the server, not the server to
  clients.** Nothing lets a client verify that whoever listens on the address
  is the real owner. Abstract-socket and named-pipe names are predictable
  (derived from the SHA-256 of the embedding-ipc directory path, see above),
  and after a crash a stale `owner.token` stays on disk (only a clean
  shutdown removes it). A local user who binds the then-free abstract or pipe
  name first therefore receives the tokens clients send and can answer with
  forged vectors — or simply holds the name so the real owner's `serve()`
  answers `conflict`. The legacy OpenClaw owner endpoint (no `address`) is
  stronger on that point, per platform:
  - **POSIX**: `owner.sock` inside the `0700` embedding-ipc directory; only
    the owning user can bind or reach it.
  - **Windows**: libuv cannot listen on a filesystem socket path there, so
    the legacy owner listens on the named pipe
    `\\.\pipe\plur1bus-embedding-owner-v2-<40 hex>`, the SHA-256 of the
    embedding-ipc directory's canonical path (`realpathSync.native`,
    lower-cased) and a 256-bit random nonce. The nonce is created once
    (exclusive create) in `owner-pipe.nonce` inside the embedding-ipc
    directory, which carries an owner-only ACL (`icacls /inheritance:r`,
    the user only; the file too), and is kept across restarts; owner and
    clients read it from there. Another local user cannot read the nonce and
    so cannot predict or pre-bind the name (ruling EW-R1). The pipe itself
    still has Node's default security descriptor (no DACL can be set from
    `net`), so the name, not an ACL, keeps other users out; the token still
    authenticates every request. A missing, non-regular or malformed nonce
    file fails closed with `scoped_embedding_pipe_nonce_unavailable`: the
    owner does not start (checked before any listener or token exists) and a
    client request fails. An unclaimed `serve()` probing for a legacy owner
    treats a missing nonce as "no legacy owner" and any other nonce error as
    that failure. The nonce is published atomically (written, fsynced and
    secured in a temp file, then hard-linked into place; a concurrent reader
    sees no file or the whole nonce). If `icacls` is missing, the nonce file
    keeps the directory's inherited ACL and a one-time warning is logged.
  - **The `stateRoot` must be private to the user (both platforms).** The
    nonce and `owner.token` are only as trustworthy as the embedding-ipc
    directory: an existing `owner-pipe.nonce` or token is used as found, and
    the directory's owner is not verified on Windows (that check would collide
    with `engine-windows:elevated-owner`). The default `stateRoot` under the
    user profile (`~/.openclaw/memory/lancedb-namespaced`, i.e. below
    `%USERPROFILE%` on Windows) is safe. A `stateRoot` that other users can
    write (a shared or world-writable directory) is **unsupported**: another
    user could plant the nonce and pre-bind the pipe, or replace the token.
  Server authentication (a challenge on the token, or peer-credential checks)
  is a follow-up for PR-11, alongside the Windows pipe ACL.
- **One serving engine per `stateRoot`, across processes, is the operator's
  responsibility.** The transport's single-owner guard
  (`scoped_embedding_owner_already_active`) is in-process only, and the
  claim listener that would additionally exclude other *processes* is
  intentionally not opened on this path (ADR-001 C1). What is caught across
  processes: two engine processes serving the **same** address (a
  live-socket connect probe, or `EADDRINUSE`, answers `conflict`), and a
  claimed legacy OpenClaw owner of the same `stateRoot` — before listening,
  an unclaimed server connect-probes the claim address and the legacy
  `owner.sock` (connecting opens no listener) and answers `conflict` while
  either accepts. Two engine processes on the same `stateRoot` serving
  **different** addresses are not prevented, nor a legacy owner that starts
  *after* an unclaimed one: the later owner overwrites the shared
  `owner.token`, so the earlier owner's clients fail auth or see an
  unannounced owner change. Each server unlinks `owner.token` on shutdown
  (or after a failed start) only while the file still holds its own token,
  so the earlier owner no longer deletes the later owner's token.

## Status, models and shared memory in 1.8.0

`Engine.status()` (`engine/status/status-reporter.js`, `createStatusReporter`)
stopped being a static object in 1.8.0: it now assembles `EngineStatus` from
the engine's own live sub-systems, stays **read-only and cheap** (never
creates a directory, opens LanceDB, loads a model or calls a provider), and
**never rejects** — every piece below is wrapped so one broken dependency
degrades only its own field, not the whole call.

### `EngineStatus.jobs` — ledger-derived job health

`jobs.health()` (`engine/jobs/job-registry.js`) reads each agent's
`ledger.jsonl` through a **stat-keyed cache**: a `${size}:${mtimeMs}` of the
ledger file is checked before re-reading it, so a poll that finds nothing
changed re-parses nothing — a months-old ledger does not cost a full re-read
on every call. A missing ledger file is not an error (`rows: []`); any other
stat/read failure marks that agent's ledger unreadable and flips the
top-level `ledger` to `"unavailable"` without throwing. `unreadableLines`
counts, per agent, the ledger lines that failed to parse as JSON or parsed to
something other than a plain object (the same warn-once torn-line handling
`job-ledger.js` already had). `lastRuns[job]` is the row with the greatest
`finishedAt` for that job. `running` lists the job names with a run **in
flight in this process** — it is not read from the ledger and does not
reflect another process's in-flight runs. `breaker` (`{ sweep, sessions,
limit, open }`) is scoped to `sweepKey(clock())`, the **current UTC calendar
day** at call time; `sessions` counts that sweep's `rem`/`deep` ledger rows
with `llmSession: true` plus any such session still in flight, so a call near
midnight UTC can see the count reset between two polls a moment apart.

### `EngineStatus.degraded` — precedence

`degraded` is `null` on a clean status, otherwise `{ reason, capability }`.
The checks run in a fixed order and the first match wins:

1. the embedder has `state: "failed"` → `{ reason: "model-failed",
   capability: "embedding" }`;
2. the embedder has `state: "loading"` (no attempt has completed yet — this
   is where a fresh, never-warmed engine starts, and stays, until
   `Engine.models.warm()` runs at least once; it does **not** mean a probe
   is currently in flight, see below) → `{ reason: "models-warming",
   capability: "embedding" }`;
3. the reranker has `state: "failed"` → `{ reason: "model-failed",
   capability: "reranker" }`;
4. the reranker has `state: "loading"` (same meaning as step 2) → `{
   reason: "models-warming", capability: "reranker" }`;
5. otherwise `null`.

**A fresh, never-warmed engine therefore reports `degraded: { reason:
"models-warming", capability: "embedding" }` from the moment it opens until
a host's first `warm()` call completes** — `tests/engine-contract.test.js`
pins exactly this. A host that wants a clean `degraded: null` on startup
calls `Engine.models.warm()` in the background right after `open`/`ready`.

A **disabled** reranker (no reranker configured) is neither `"failed"` nor
`"loading"`, so it never degrades the status. `jobs.health().ledger ===
"unavailable"` and a `null` `journal` do **not** feed into `degraded` — an
unreadable ledger or a missing/timed-out journal capability are visible in
their own fields, not folded into this derivation.

### `EngineStatus.models` — embedder and reranker readiness

`Engine.models.status()` reports `ModelState` (`"loading" | "ready" |
"failed" | "disabled"`) for the embedder and, when a reranker is configured,
the reranker, each with `checkedAt` and, on `"failed"`, `error`.

- **`"loading"` always has `checkedAt: null`, and means "no attempt has
  completed yet"** (controller ruling C1) — this is the state before the
  very first probe for that model finishes, whether or not one is currently
  running. `readinessOf` (`engine/providers/model-readiness.js`) derives
  `checkedAt` only from the last **completed** attempt: with no completed
  attempt yet, `checkedAt` is `null` regardless of the model's `warming`
  flag. `"loading"` is not a fifth state and, by itself, does not tell you
  whether a probe is in flight — read `warming` for that (below).
- **There is no "loading with a `checkedAt`" state.** Once any attempt for a
  model has completed, its state becomes `"ready"` or `"failed"` and **stays**
  one of those two from then on — a later re-probe (`Engine.models.warm({
  signal })` called again, e.g. `opts.refresh` on the underlying probe) never
  reverts the state back to `"loading"`. While that re-probe runs, `warming:
  true` is set on top of the model's current `"ready"`/`"failed"` state and
  `checkedAt` still reflects the previous completed attempt, not the one in
  progress.
- **`Engine.models.warm({ signal })`** is the explicit way to run a probe. A
  host normally calls it once in the background right after `open`/`ready`;
  that first call is what turns a fresh embedder from `"loading"`
  (`checkedAt: null`) into `"ready"` or `"failed"`, and is how a host clears
  a `"models-warming"` `degraded` reason (see above). Calling `status()`
  alone never triggers a probe.
- **`"ready"`** is the most recent completed attempt succeeding;
  **`"failed"`** is the most recent completed attempt failing, with `error`
  set to the raw `EmbeddingProbeError`/`RerankerProbeError` code. An aborted
  attempt (the caller's own `signal`) is never recorded as the last
  completed attempt, so it cannot turn a model `"failed"` or change
  `checkedAt`; only a real completed attempt can. An aborted `warm()`
  therefore leaves the model exactly where it was before the call —
  `"loading"` if nothing had completed yet, `"ready"`/`"failed"` (with the
  same `checkedAt`) if a prior attempt had. A failed reranker never marks
  the embedder failed, and vice versa: the two are independent probes.
- **`"disabled"`** is the reranker's state when the host configured no
  reranker at all; it is not a failure and does not degrade the status.
- `status()` still resolves normally after `close()`.

### `EngineStatus.journal` — a host's own backlog, on a budget

`HostCapabilities.journalBacklog?()` (optional) lets a host report its own
outstanding journal work — for example, lines a harness has written but not
yet handed to `Engine.capture`. `status()` calls it, when present, with a
**50 ms cap** (`JOURNAL_BACKLOG_TIMEOUT_MS`): a capability that throws
synchronously or asynchronously, or that has not settled after 50 ms,
resolves `journal: null` rather than delaying or failing `status()`. The
cap uses a real (`ref`'d) timer, not `AbortSignal.timeout()`, so a hung
capability cannot leave the call pending past its deadline even when nothing
else keeps the event loop alive.

`journal` is `null` when the host provides no capability, when the call
times out or throws, and — a valid answer, not an error — when the host's
own capability literally returns `null` ("nothing outstanding to report");
none of these log more than once per distinct failure reason. A valid,
in-time result is normalized to exactly `{ entries, oldestAt }` (`entries` a
non-negative integer, `oldestAt` a finite number or `null`); any other shape
also becomes `null`, logged once.

### `EngineStatus.sharedMemory` and the `unsupported` `MemoryOpError`

`sharedMemoryPool.support()` reports `{ supported, mode }` (mode
`"fd-capability"`, `"verified-path"` or `"unavailable"`), plus a `reason`
when unsupported — a pure, filesystem-free read of the mode `SharedMemoryPool`
selected at construction (`defaultSharedMemoryMode()`) and of its taint,
never a live probe. **Linux is unchanged**: the descriptor-alias routing in
`lib/directory-capability.js` (`fd-capability`) stays the only Linux mode.
**macOS and Windows** use the verified-path mode of
[ADR 0001](adr/0001-shared-memory-on-macos-and-windows.md) (accepted
2026-09-27; see "Shared memory on macOS and Windows (verified-path)" below)
and report `{ supported: true, mode: "verified-path" }` until a check fails;
then `{ supported: false, mode: "verified-path", reason }` with `reason`
`"unsafe-root"`, `"acl-tool-unavailable"` or `"identity-changed"`. Any other
platform reports `{ supported: false, mode: "unavailable", reason:
"platform" }`.

Where a platform has no shared-memory mode, or a verified-path pool is
tainted, `Engine.memory.share` and `proposals.accept` reject with a typed
`MemoryOpError` — `code: "unsupported"`, `detail: { capability:
"shared-memory", reason }` (the `support().reason`: `"platform"`, or the
verified-path taint) — **before** any row, archive or `.plur1bus-shared`
directory is touched.
The two members order this check differently against their own lookups:
**`share`** treats it as a platform property, not data-dependent, and checks
it ahead of every anti-oracle lookup (`getCard`), so a nonexistent source id
on an unsupported platform still answers `"unsupported"`, never
`"not-found"`. **`proposals.accept`** resolves and authorises the proposal
first (`loadPending`) and only then checks `sharedMemoryPool.support()` — a
proposal id that does not exist, or belongs to another sharer, answers
`"not-found"` exactly as it would on a supported platform; only a proposal
that does resolve then hits `"unsupported"` before its shared copy is
touched. Shared reads (`withUserReadDb`/`withWorkspaceReadDb`) are
unaffected by this error path: they already answered empty/`null` on an
unsupported platform, and still do. The OpenClaw `/share` reply says why
(`plur1bus.share_unsupported`) instead of the generic `share_failed` text
when the outcome is `"unsupported"`.

### Shared memory on macOS and Windows (verified-path)

ADR 0001 Option B, accepted by the owner on 2026-09-27 and shipped as E4.2
(contract stays 1.8.0 — every value below was already in the 1.8.0 unions).
`SharedMemoryPool` picks its mode once, in the constructor:
`defaultSharedMemoryMode()` answers `"fd-capability"` where descriptor
aliases work (Linux), `"verified-path"` on darwin and win32, `"unavailable"`
elsewhere. In verified-path mode the pool opens directories with
`openVerifiedPathDirectory` (`lib/verified-path-directory.js`) where the fd
mode uses `openDirectoryCapability`, and compares the pinned `{dev, ino}` of a
freshly walked directory where the fd mode uses
`pathMatchesDirectoryCapability`. The child `AgentDbPool`s receive the
`VerifiedPathDirectory` as `parentDirectoryCapability` unchanged; on that
parent-routed path they only call `openChild`, `childMatches`, `assertOpen`,
`path` and `close`, and `MemoryDB` hands LanceDB the held directory's
canonical `path` after `assertOpen()`.

What is checked, and when:

- **Every open** walks the canonical path from the filesystem root with
  `lstat`: no symlink, junction or reparse point; on POSIX every segment is
  owned by root or the current user and not group/other-writable unless
  sticky. A symlink already in the configured base path (e.g. macOS
  `/var -> /private/var`) is resolved once by `realpathSync.native` and the
  policy then applies to the resolved chain (ruling E4-R10).
- **From the first write lease on** (read-only use never runs these two
  checks — on POSIX every walked segment still passes the ancestor policy,
  on Windows a read-only pool checks reparse points only):
- **First write lease per pool, before the root is created**: the base must
  belong to the current user (POSIX owner = uid and `(mode & 0o022) ===
  0`, so a sticky world-writable base is refused too; win32 owner SID = user
  SID). Nothing is created under a base that fails this.
- **First write lease per pool, root**: a `.plur1bus-shared` the pool just
  created is restricted with `secureDirectoryOwnerOnly` (POSIX `fchmod
  0o700`; win32 `icacls <root> /inheritance:r /grant:r <user>:(OI)(CI)(F)`);
  then `assertOwnerOnlyDirectory` checks the root (POSIX owner = uid and
  `(mode & 0o077) === 0`; win32 owner SID = user SID and every Allow ACE is
  the user, SYSTEM or Administrators, read through `powershell.exe`). A
  pre-existing root with looser permissions is refused, never silently
  tightened.
- **Every LanceDB operation**: the pool's path guard (`assertSharedRoot`)
  re-walks the shared root's full canonical path from `/` (`lstat` + `open`
  + `fstat` per segment on POSIX, `lstat` on Windows, plus a realpath) and
  `childMatches` re-opens each child; then `MemoryDB` calls `assertOpen()`
  on the held directory (`lstat` identity, plus the POSIX anchor descriptor).
  The guard is reached several times per step (`AgentDbPool._assertBasePath`
  twice, `MemoryDB` via `_assertSecureAgentCapability`, the read route's
  key-path walk, `_openBase`/`_openSharedRoot`).
- **After every lease** (awaited `finally` in `_lease`): one more full walk
  re-verifies the root, also when the callback threw (the identity error
  then replaces the callback's error) and on read leases.
- **Measured POSIX cost** (final review, steady state; one "walk" = one full
  `openVerifiedPathDirectory` from `/`): about 6 walks per LanceDB
  operation, about 15 per empty write lease (21 with one `store`), 27 for a
  read lease with one `getById` (66 on the first read lease). One walk at
  path depth 8 costs about 97 µs on Linux, so a shared read lease spends
  roughly 2.6 ms verifying paths — more on macOS. Accepted (E4-R16);
  de-duplicating the guard is a possible follow-up.
- **Cost on Windows**: the first write lease per pool runs `icacls` (when it
  created the root) and two ACL reads (root and base). The fast path is
  `%SystemRoot%\System32\cscript.exe` (constant WMI script) plus
  `%SystemRoot%\System32\whoami.exe` (~0.4 s cold on windows-11-arm, probe
  37123429626). PowerShell 5.1 is the fallback (15–45 s cold on that image).
  All are synchronous `execFileSync` calls; the ACL read is capped at 30 s
  for the whole operation (fast path plus fallback) and blocks the event
  loop — recall budgets and the `status()` cap included — while it runs.

**Known limitation — elevated Windows gateway** (`engine-windows:elevated-owner`,
ruling EW-R4). A process running elevated (a member of Administrators with a
full token, e.g. an OpenClaw gateway started "as administrator", or GitHub's
Windows runners) creates every new directory with owner `BUILTIN\Administrators`
(`S-1-5-32-544`), not the user's SID. The base check (owner SID = user SID)
and `assertOwnerOnlyDirectory` refuse such a base or root with `unsafe-root`,
so on an elevated gateway every workspace/user share and proposal accept
answers `storage` ("memory write failed") on the first attempt and
`unsupported` (taint) afterwards; private memory is unaffected. The owner
checks are deliberately **not** loosened to accept Administrators ownership.
Workarounds: run the gateway unelevated, or hand the shared base and a
pre-created `.plur1bus-shared` to the user (`icacls <dir> /setowner <user>`,
root owner-only) — what `tests/helpers/win32-shared-owner.js` does for the
test suite.

A failure **taints** the pool until restart: `support()` answers `{
supported: false, mode: "verified-path", reason }` with the error's reason
(`unsafe-root`, `acl-tool-unavailable`; a moved identity or a failed
after-lease check is `identity-changed`; an error without a reason, such as
`ENOSYS` for missing `O_NOFOLLOW`, counts as `unsafe-root` — fail-closed; so
does any reason outside that set, and `EACCES`/`EPERM`). **Transient resource
errors** (`EMFILE`, `ENFILE`, `EIO`, `EAGAIN`, `EBUSY`, `ENOMEM`) do not taint:
the call rejects (the caller sees `storage`) and the next lease retries. The
call that hit the failure rejects with its own (log-safe) error, which
`Engine.memory` maps to `storage`; later shares and accepts answer
`unsupported`, later write leases throw `SHARED_MEMORY_UNSUPPORTED` with the
taint as `.reason`, and shared reads answer empty, exactly as on a platform
without shared memory. The taint is logged once through `safeWarn`, naming
the reason only.

The **legacy shared migration** (`plur1bus migrate-legacy-shared`) and
**explicit named namespaces** stay fd-only: in verified-path mode the
migration answers `sharedMemoryUnsupportedError("platform")` before it reads
or writes anything.

**Residual risks** (ADR 0001): the check-to-use window between the last
`lstat` and LanceDB's own open remains by construction and is exploitable
only by the current user, root or Administrators; Windows ancestors above
the base are checked for reparse points only, and of the base itself only
the owner SID is checked, and a read-only pool checks no ACL at all until the
first write lease (a root planted under such a base would be read into
recall until then) — a foreign Allow ACE with `FILE_DELETE_CHILD` or an
inheritable foreign ACE on the base is not detected (the full base ACE
policy is not implemented); a umask of 002 makes engine-created directories
group-writable, which the walk refuses; network and virtual
filesystems with unstable inode numbers fail closed with
`identity-changed`; the Windows ACL read needs `powershell.exe` (missing →
`acl-tool-unavailable`). **Elevated Windows shells** (ruling E4-R12): a
directory created by an elevated Administrator is usually owned by
Administrators (`S-1-5-32-544`), not the user, so the shared root or base
answers `unsafe-root`.

**Troubleshooting** — `status().sharedMemory.reason`:

- `unsafe-root` after the engine created the directories itself: the process
  runs with umask 002, so `mkdirSync` made them group-writable (`0775`). Use
  umask 022, or `chmod g-w` the base and its engine-created parents.
- `unsafe-root` on a macOS external volume: volumes mounted with "Ignore
  ownership on this volume" report every file as owned by uid 99, which the
  walk refuses as a foreign owner. Keep the base on the system volume, or
  untick that option in the volume's Get Info.
- `unsafe-root` on Windows after a crash during the first share: the root was
  created but `icacls` never ran, so it still carries inherited ACEs (e.g.
  Users) and every start refuses it. Delete the empty `.plur1bus-shared` and
  restart.
- `unsafe-root` right after `EACCES` in the log: a directory on the path was
  unreadable; `EACCES`/`EPERM` taint like a policy failure. Transient
  resource errors (`EMFILE`, `EIO`, …) never taint — they fail only that call.
- `unsafe-root` on macOS: a directory on the path is group/other-writable or
  owned by someone else, or `.plur1bus-shared` is not `0700`. Fix the mode
  (`chmod 700 <base>/.plur1bus-shared`, `chmod go-w <base>`) and restart.
- `unsafe-root` on Windows: most often an elevated (Run as administrator)
  process created the base or root. Run unelevated, or hand the directory to
  the user (`icacls <dir> /setowner <user>`) and remove foreign Allow ACEs;
  then restart.
- `acl-tool-unavailable`: `powershell.exe` (or `icacls`) could not run —
  restore it on `PATH` and restart.
- `identity-changed`: the base or `.plur1bus-shared` was renamed, replaced or
  is on a filesystem without stable inode numbers. Move the base to a local
  disk, check nothing else rewrites it, and restart.

### Turn replay (Q3): a replayed capture does not run twice

Before the capture pipeline runs, `Engine.capture` checks a per-agent replay
guard (`engine/capture/turn-replay-guard.js`) keyed on `sha256(agentId, runId
?? null, sessionKey ?? null, messages)` — the same turn, replayed (for
example after a journal replay following a process restart), is recognised
and answers `{ stored: 0, skipped: 1, reason: "duplicate-turn" }` without a
second summary, a second row, or a second session count. Keys are persisted
per agent (surviving a restart) for **7 days**, capped at the **512** most
recent per agent (oldest dropped first).

**When a turn is recorded (E4.1).** The key is written as soon as the
capture's rows have settled successfully — at least one row stored and no
item failed — right after the store loop and **before** the post-store steps
(speaker pipeline, meta-cognition, graph build, the neo embedding drain,
scheduler settling). A process killed during those steps therefore has the
turn recorded already, and the host's journal replay answers
`"duplicate-turn"` instead of storing the row again. The post-store steps are best-effort: if
one of them fails afterwards, or the capture's result still ends up carrying
a `reason`, the turn **stays recorded**. A capture that settles with nothing
stored (every item cleanly skipped) is recorded, as before, once it
completes without a `reason`.

**The commit-to-record window (E4.3).** Between a row's LanceDB commit and
the guard's write of the key there is still a short window (tens of
milliseconds under load; the harness kill soak hit it). It is closed by a
**pending** entry: right before the first row is written, the pipeline fixes
the ids of every row it is about to store — the whole text and each chunk
part alike — and the guard persists the turn as pending with those ids
(fsync, then atomic rename) before the loop starts. A pending entry is not a
recorded turn: a replay of it runs the capture again, but first removes
whichever of the announced rows exist (physical delete, one
`destructive-ops.jsonl` line per row with `source: "capture_replay_rollback"`)
and only then stores the turn — exactly once, whether the earlier process
died before its first row, in the middle of the loop or after the last
commit. Marking the turn done replaces the pending entry, so a later replay
answers `"duplicate-turn"` as before. If removing a row fails, the replay
fails with `"capture-failed"` and the turn stays pending for the next
replay. A pending entry is bounded like every other entry (7 days, 512 per
agent); one that is never replayed simply expires, and the rows it
announced, if any were written, stay as the turn's only copy. A capture that
**returns** with its rows only partly stored drops its pending entry (those
rows have already been through the post-store steps), so the partial-failure
behaviour below is unchanged.

A capture that **fails or is only partly completed is not recorded** as a
replay key, so replaying it runs the capture pipeline again — this is a
deliberate trade-off: a turn that stored one summarised item and then failed
partway can, on replay, store a second row for the part that already
succeeded, rather than silently losing the failure. `CaptureResult.reason`
reflects this on the typed path: `"aborted"` (the capture was cancelled
before its rows settled), `"capture-failed"` (any other pipeline error), or
`"capture-incomplete"` (at least one item failed text prep, embedding, the
dedup check or its write, but the turn was not aborted or fully failed) —
alongside the existing `"duplicate-turn"`. A `{ stored: 0, skipped: 0 }`
result with **no** `reason` is a clean capture that genuinely found nothing
worth storing, not a failure.

**A turn without `runId` is keyed on `agentId`, `sessionKey` and `messages`
alone.** An identical message replayed in the same session within the 7-day
window would then read as a false `"duplicate-turn"` even without a real
replay. Hosts should give every journal line a stable `runId` (the harness's
own journal does, per 2a-H3) so the key is unambiguous; a host that cannot
should expect this caveat.

## Engine configuration schema in 1.9.0

### Where the schema lives, and how to read it

`engine/config/engine-config.schema.json` ships inside the package and is the
host-neutral description of every engine config key: JSON Schema 2020-12
(`$schema`, `$id: "plur1bus-engine-config"`, `x-contract`, `$defs`, `type`,
`additionalProperties`, `properties`) plus three annotations on every node.
It is the same shape as `openclaw.plugin.json`'s `configSchema` — indeed it
*is* that shape, annotated (see "The manifest is generated" below) — with the
same 55 top-level keys.

`engine/config/engine-config-schema.js` is the loader, and the only supported
way to read the schema:

- **`loadEngineConfigSchema()`** parses the file once, deep-freezes it and
  caches it; every caller shares the same frozen object.
- **`engineConfigKeys()`** returns one `EngineConfigKey` per top-level key, in
  schema order: `key`, `type` (or `"enum"` when the node has no `type`, or
  `null`), `default` (only when the node declares one), `description`,
  `readAt`, `liveOverrides` (paths below the key whose resolved `readAt`
  differs from the key's own — empty in 1.9.0, see below), `tier`, and
  `sensitive` (true when the key or anything below it is `x-sensitive`).
- **`readAtOf(path)`** resolves a dotted path (e.g. `"recall.softBudgetMs"`)
  to the `readAt` of the nearest node on that path that declares one —
  `null` for an unknown path. Only `properties` chains form paths; `$defs`,
  `items` and similar are schema plumbing, not config paths.
- **`livePaths()`** — every path whose resolved `readAt` is `"live"`, sorted.
- **`sensitivePaths()`** — every `x-sensitive` path, in depth-first schema
  order: the eight credential keys plus `reminders.webhookUrl` and the four
  `*.headers` maps (thirteen paths).
- **`secretInputPaths()`** — every path whose node is `$ref:
  "#/$defs/secretInput"` (`SECRET_INPUT_REF`), in depth-first schema order;
  this is exactly the manifest's `configContracts.secretInputs.paths` list
  (the eight credential keys, unchanged by E5). Every secret input is
  `x-sensitive`; the reverse does not hold.
- **`redactSensitiveConfig(config)`** — a deep copy of an engine config with
  the value at every `x-sensitive` path that is set (not absent, `null` or
  `""`) replaced whole by `REDACTED_CONFIG_VALUE` (`"[REDACTED]"`): a string,
  a SecretRef object and a headers map alike. The input is not modified. The
  engine itself never logs its config; this is the one helper a host or
  harness surface uses before showing or logging config values.

### `readAt`, `x-tier`, `x-sensitive` — and what "live" means

- **`readAt`** is `"construction"` or `"live"`. `"construction"` (every key,
  as of 1.9.0) means the engine reads the value once, from `createEngine`'s
  `config` argument; changing it takes a new engine. `"live"` would mean the
  engine re-reads the value per operation through `HostServices.config()` —
  no key is declared live in 1.9.0 (`livePaths()` is `[]`); see the note on
  `reembedding.activeGeneration` below.
- **`x-tier`** is `"basic"` or `"advanced"`. Every key is `"advanced"` in
  1.9.0 (D29) — the harness/host UI has no `"basic"` tier to show yet.
- **`x-sensitive`** means *mask and redact*: every surface that shows or
  logs config must hide the value (`redactSensitiveConfig`, the manifest's
  `uiHints[path].sensitive`). It marks the eight credential nodes, and — by
  the owner's ruling on E5-R24 — `merging.headers`, `schicht15.headers`,
  `skillMiner.headers`, `criticalPush.headers` (an `Authorization` header is
  possible) and `reminders.webhookUrl` (may carry a token).
- **Secret input (SecretRef) is a separate property**, not an annotation:
  a node accepts an OpenClaw SecretRef exactly when its `$ref` is
  `#/$defs/secretInput`. Only those eight nodes feed the manifest's
  `configContracts.secretInputs.paths`. The five paths above stay
  plain-value only, because declaring them would change what existing
  plaintext configs mean on OpenClaw 2026.8.2: the host turns a secret-input
  string of the form `${NAME}` or `$NAME` into an env SecretRef and
  resolves it itself (the engine's `resolveEnvVars` resolves
  `reminders.webhookUrl`'s `${…}` against its own allow-list today), a
  SecretRef at `*.headers` would have to resolve to a string although the
  value is a map (`headers.*` would be the only workable shape), and no engine
  code resolves a SecretRef in a header value or the webhook URL — the map is
  passed through as HTTP headers as is. OpenClaw's own masking comes from the
  `uiHints` `sensitive` flag, which handles an object value (the whole map is
  replaced by the redaction sentinel and restored on write), so all five are
  masked there without becoming SecretRef surfaces.
- **What "live" would mean depends on what a host's `config()` returns.** An
  OpenClaw-style host's `config()` (or its fresher `runtime.config.current()`)
  returns the *whole* host config, with the engine's own config nested under
  `plugins.entries["memory-lancedb-namespaced"].config`; a harness-style host
  with no `runtime` has `config()` return the engine config directly. A live
  key's value would be read through that same host-neutral indirection
  (`engine/config/live-config.js`'s `livePluginConfig(host)`), so a "live"
  annotation means the same thing regardless of which shape the host's
  `config()` returns.
- **One path is re-read without being live.** The re-embedding switch probe
  re-reads `reembedding.activeGeneration` to confirm the host has actually
  switched generations — a verification read, not a live config value. It
  stays `readAt: "construction"` in the schema; `engine/config/live-config.js`
  lists it separately, in `HOST_REREAD_PATHS`, and `readLiveConfigValue(host,
  path)` throws `TypeError` for any path not on that list. A re-read is
  deliberately not the same thing as declaring a key live.

### `recall.*` keys are construction-time

Every key under `recall.*` — `softBudgetMs`, `hardBudgetMs`, `capChars`,
`memoriesMaxChars`, `rerankerTimeoutMs` and the rest — is `readAt:
"construction"`. A host that wants a different recall budget or cap must
build a new engine; changing the host's own config file has no effect on an
engine already running, and no `recall.*` value is re-read per call.

### The manifest is generated

`openclaw.plugin.json`'s `configSchema` and `configContracts.secretInputs
.paths` are no longer hand-maintained: they are generated from
`engine/config/engine-config.schema.json` by `adapter/openclaw/
config-schema.js` (`deriveOpenClawConfigSchema`, `deriveSecretInputPaths` —
the `secretInputPaths()` nodes, not every `x-sensitive` one —
`applyEngineSchemaToManifest`, which strips `readAt`/`x-tier`/`x-sensitive`
and the engine-only root keys/keywords, and touches nothing else in the
manifest). `npm run gen:config-schema` writes the file only when its content
would change; `npm run gen:config-schema -- --check` writes nothing and
exits 1 with "openclaw.plugin.json is out of date: run npm run
gen:config-schema" on drift — this is the CI gate against hand-editing the
generated parts. The manifest's top-level `configSchema.properties` count
stays 55; nothing else in the manifest is touched by generation. `uiHints`
stays hand-maintained; a test pins its `sensitive: true` entries to
`sensitivePaths()`, in order.

### `warmOnly` — the read-only heavy recall path

`RecallQuery.warmOnly` (1.9.0) runs the expensive part of recall — the neo
prelude, the query embedding, a read-only store open, the vector search and
rerank — and answers `{ blocks: [], degraded: null, timing }` on success.

**Other answers.** Always `blocks: []`; `degraded` is not null when the warm
recall did not run to the end:

| `degraded.reason` | When |
|---|---|
| `"warm-failed"` | the warm path threw (for example a store read error), or no warm path is wired; logged at debug |
| `"aborted"` | the caller's signal aborted, before or during the recall |
| `"timeout"` | the scheduler's hard recall timeout |
| `"queue-full"` / `"pressure"` | shed or evicted by the scheduler — warm recalls run at background (low) priority, the first to go |
| `"engine-closed"` | the engine is closing or closed |
| `"invalid-query"` | no `signal`, or a bad principal (as for any recall) |

A workspace whose policy disables automatic memory answers an empty success
(`degraded: null`) without reading anything.

**What runs:** a read-only workspace-policy check; if neo is enabled, a
worker warm-up (`warmUp()`) and, for a prompt of five characters or more, the
neo prelude against a read-only peek of the neo store (no session-map write,
no `onNeoStore` event, no stale-temp-file cleanup); read-only leases on every
recall namespace (`withAccessReadDbs(..., { readOnly: true })`, a read-only
`MemoryDB.init()` that never creates a directory or table and never caches a
miss as a negative); the merged namespace recall itself, with
`emotionalState`, `decisionTrace`, `querySummarizer` and `retrievalLogger`
all `null`.

**The no-write guarantee, in short:**

| What a normal recall can do | What `warmOnly` does instead |
|---|---|
| cache the result | `cacheKey: ""` — the scheduler never reads or writes it |
| run at the caller's priority | `background` forced `true` → scheduler priority `"low"` |
| emit `recall.degraded`/`.block-*`/`.completed` | all twelve emit sites become no-ops |
| apply queued reply-outcome updates | `replyOutcomeDynamics.kick` is skipped |
| open the private/shared stores for writing | every store is opened read-only |
| write the start notice, mood/emotion files, fast-bernd, overlays, contradictions, the retrieval ledger, presentation/activity/reminder state, the knowledge cache, graph-recall metrics, or call the query summarizer | none of these code paths are reached |
| note a fragment-compactor write, or run `optimizeTable` | never referenced |

A warm recall never touches the persistent (SQLite) embedding
cache (`runtime.embeddingCachePersist`): every warm embed carries the
embedding cache's per-call memory-only flag (`persist: false`), which skips
both the persistent lookup (whose hit would refresh access times, and whose
first open creates the database) and the persistent write. The local,
OpenAI and scoped-IPC providers pass the flag through; across the IPC it
reaches the owner process's cache. Only in-memory state is warmed: the
provider's in-memory embedding cache, loaded models, the neo worker thread,
OS page caches. **One exception to "writes nothing":** a cold local model
cache downloads model artifacts on first use, exactly as the first real
recall or `models.warm()` would — call `models.warm()` first.

**Background priority; not cached.** `background: true` puts a warm recall
behind foreground recalls in the scheduler. `cacheKey: ""` means a warm
answer is never served back to a later real recall — a real recall right
after a warm one is not served from the recall cache; its query embedding
is usually a warm memory-cache hit, since the warm recall already filled
the provider's in-memory embedding cache.

**Hosts should warm with it after `models.warm()`.** Call `Engine.recall`
with `warmOnly: true` once per agent after `Engine.models.warm()` resolves,
to bring the neo worker, the read-only store connections and the rerank
pipeline hot before the first real turn — without touching that agent's
data, its recall cache, or emitting any event.

### Timing phases and the soft-budget consequence

`RecallTiming.totalMs` is honest as of 1.9.0: it runs from `Engine.recall`
entry (or, on the OpenClaw hook path, from the assembler's own entry — the
hook calls the assembler directly, so there is no `entry` phase there).
`phases.completed` begins with the named phases, in order:

- **`entry`** — `Engine.recall` up to the assembler: `safeAgentId`,
  `host.workspaceDir(agentId)`, `memoryContextFromPrincipal`. Present only
  when `Engine.recall` was the caller.
- **`queue`** — the wait for a scheduler recall slot.
- **`prelude`** — principal resolution and, with neo enabled, the neo
  prelude (worker warm-up, the hook record, the candidate-window read, the
  query embedding up to `neo.recall.global.embedTimeoutMs`, the global
  search, lanes).

**Segments that are not a named phase, but now count against the soft
budget** — the gap between the sum of the phases above and `totalMs`:

- the start-notice consume
- the write-db lease (`pool.withWriteDb`, `db.init()`)
- the read-db leases (`withAccessReadDbs`)
- the GC kick
- the emotion-inference LLM call
- fast-bernd

**Consequence:** with a small `recall.softBudgetMs` (the harness), a
soft-budget fallback can trigger earlier than it used to, because queue
wait, principal resolution, the neo embed and emotion inference now all
spend the budget before the store read even begins. At OpenClaw's default
budget (35 s) the effect is marginal. **The scheduler's hard timeout is
unaffected** — it still counts from enqueue, its own separate clock.

### Fragment compaction (`runtime.lancedbCompaction`)

Every `add()`/`update()` writes a new LanceDB fragment; only
`dailyConsolidation`'s own nightly `lancedbOptimize` job ran `optimize()`
before E5, and it is off by default, so an install that never schedules it
never compacted — capture and recall latency grew with every turn.
`engine/store/fragment-compactor.js` now counts per-agent table writes and,
every `checkEveryWrites` writes or `checkIntervalMs`, checks the agent's
fragment count; once it reaches `fragmentThreshold` it runs the db-adapter's
`optimizeTable`, keeping the table's last `keepVersionsHours` (from
`dailyConsolidation.lancedbOptimize`) of versions.

Defaults (`DEFAULT_LANCEDB_COMPACTION`): `enabled: true`, `fragmentThreshold:
64`, `checkEveryWrites: 16`, `checkIntervalMs: 600000` (10 min), `timeoutMs:
60000`. **`runtime.lancedbCompaction.enabled: false` is the only off
switch** — `dailyConsolidation.lancedbOptimize.enabled` governs the nightly
job only and does **not** disable this compaction; the two run
independently, and both hosts can have one, both, or neither enabled.
**Compaction is on by default for every host, including OpenClaw** (owner
decision, 2026-09-27).

**Fallback without stats.** When `table.stats()` is unavailable (no table
yet, a failed or timed-out stats read), the compactor falls back to the
number of writes since its last compaction as a stand-in for the fragment
count, so it still checks and still compacts on a host whose LanceDB build
does not expose fragment stats.

**Shared pools and explicit extra namespaces are not compacted by it** — the
compactor only reaches the per-agent authoritative `memories` table, the
same table `dailyConsolidation`'s own optimize already covered; it does not
newly cover anything `dailyConsolidation` did not already reach, and
`dailyConsolidation` still runs against the agent table on its own schedule
regardless of whether the compactor is enabled.

**Concurrency.** A process-wide optimize lock, one per resolved table path,
serializes every caller of `optimizeTable` — the compactor, other engines in
the same process, `dailyConsolidation` and the dashboard runner. The
compactor asks to skip rather than wait when a table is already being
optimized; `dailyConsolidation` and the dashboard wait for the lock in FIFO
order instead, so a long compactor optimize can delay them by up to its own
bound.

**A known, pre-existing risk, not introduced or fixed by E5.** A
timer-driven cleanup — this compactor's `cleanupOlderThan`, and
`dailyConsolidation`'s own optimize — can delete versions older than the
retention window while a long-running reader still has one of them open.
This is the same risk `dailyConsolidation`'s optimize already carried before
E5.

**A lingering native optimize can outlive `close()`.** `Engine.close()`
resolves once its own `budgetMs` elapses, race or no race, but a LanceDB
`optimize()` call that is still running natively when the compactor's
`timeoutMs` fires keeps running in the background — the compactor's timeout
only stops *waiting* on it, it does not cancel the underlying work. That
lingering optimize can keep the Node.js process alive after `close()`
returns, for as long as it takes LanceDB to finish (bounded by the
compactor's own `timeoutMs`, not by `close()`'s `budgetMs`). This does not
break the neo worker's "the process can exit" guarantee, which is scoped to
the neo worker lease above, not to LanceDB's native calls.

### The neo worker lease

`createEngine` now takes a lease on the shared neo worker
(`acquireSharedNeoWorkerRuntime`, `lib/neo-worker-runtime.js`) instead of
holding a bare reference to it, and releases that lease in `close()`. The
worker's own process ends only when the last lease releases it (or the
OpenClaw adapter's `gateway_stop` closes it directly). For a single engine —
a harness host, or the last OpenClaw plugin instance to close — the worker
ends at that `close()` and respawns in about 600 ms the next time an engine
needs it. Multiple engines sharing one process (OpenClaw's per-run plugin
instances) keep the worker alive until every one of them has closed.

## What is implemented in M1b-1

`createEngine(host, config, testOptions?)` (`engine/create-engine.js`)
constructs the full 1.9.0 `Engine` surface described above from a plain
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
- `status()` reports `{ ready: true, degraded, agents: openedAgents.size,
  contract: "1.9.0", storeSchema: { current, expected }, jobs, models,
  journal, sharedMemory }` — as of 1.8.0 (E4) `jobs`, `models`, `journal`,
  `sharedMemory` and `degraded` are real, derived from the ledger, the model
  probes, the host's own journal capability and the shared-memory pool's
  mode; see
  [Status, models and shared memory in 1.8.0](#status-models-and-shared-memory-in-180)
  above. `storeSchema` (1.6.0) is unchanged: the one part of the status that
  does probe the store, reading the schema marker.

Everything else — `recall`, `capture`, `checkpoint`, `memory.*` (1.5.0/1.6.0),
`jobs.run`/`history`, `jobs.health` (1.8.0), `tools`, `embedding.embed`/
`rerank`/`identities`/`probe`/`serve` (1.7.0), `models.status`/`.warm`
(1.8.0), `channels`, `admin.reembedding.plan`/`apply`/`resume`/`status`,
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
- **`HostCapabilities.pushCriticalButtons?` is typed but optional (1.7.0).**
  `engine/jobs/internal-job-bodies.js`'s classify-recent job calls it only
  from a cron-internal run, only when the host provides it, and only when
  the job actually pushed at least one card; a host without it, one that
  throws, or one whose call resolves `null` or a result with `sent === 0`,
  leaves the job on the plain cron text delivery unchanged — a missing or
  failing capability degrades to text, it never fails the job.
- **`HostCapabilities.journalBacklog?` is optional and capped (1.8.0).**
  `status()` calls it, when the host provides it, with a 50 ms budget; a
  host whose capability is slow, throws, or answers an invalid shape costs
  `status()` nothing beyond that cap — `EngineStatus.journal` simply comes
  back `null`. A host with no journal of its own (or no need to report a
  backlog) can leave the capability unset entirely; `journal: null` then
  means "not reported", not "empty".
- **A platform without a shared-memory mode, or a tainted verified-path
  pool, answers `unsupported`, not `storage` (1.8.0).** `Engine.memory.share` and `proposals.accept` check
  `sharedMemoryPool.support()` before touching anything, and reject with
  `MemoryOpError` `code: "unsupported"`, `detail: { capability:
  "shared-memory", reason }` when it is unsupported — a host should route
  this to a distinct user-facing message (the OpenClaw adapter's
  `plur1bus.share_unsupported`) rather than the generic failure text, since
  retrying never helps on that platform. `EngineStatus.sharedMemory` reports
  the same fact ahead of time, so a host can grey out sharing UI without
  waiting for a failed call.
- **A live config path is read through `readAtOf`/`readLiveConfigValue`, not
  by re-reading the host's config file directly (1.9.0).** No key is
  `readAt: "live"` in 1.9.0 — `livePaths()` is `[]` — and the one exception,
  the re-embedding switch probe's re-read of `reembedding.activeGeneration`,
  goes through `engine/config/live-config.js`'s `readLiveConfigValue(host,
  path)`, which only accepts a path on its own `HOST_REREAD_PATHS` list and
  reads it through `livePluginConfig(host)`, the same host-neutral
  indirection regardless of whether `host.config()` returns the whole host
  config (OpenClaw) or the engine config directly (a harness-style host with
  no `runtime`). A host should never assume a config value it changes at
  run time reaches a running engine; every key is read once, at
  `createEngine`.
- **A host should warm with `warmOnly`, after `models.warm()` (1.9.0).**
  `RecallQuery.warmOnly` runs the heavy recall path read-only, in the
  background, uncached, and with no event — it is meant to be called once
  per agent right after `Engine.models.warm()` resolves, to bring the neo
  worker and the read-only store connections hot before the first real
  turn, not as a substitute for a real recall a user is waiting on.
- **Fragment compaction runs by default, on every host (1.9.0).**
  `runtime.lancedbCompaction.enabled: false` is the only way to turn it off;
  `dailyConsolidation.lancedbOptimize.enabled` does not affect it either way.
  A host that already schedules `dailyConsolidation`'s nightly optimize gets
  both: the compactor keeps fragment counts bounded between runs, and the
  nightly job still runs on its own schedule. See [Fragment compaction
  (`runtime.lancedbCompaction`)](#fragment-compaction-runtimelancedbcompaction)
  above.

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
  emit a second copy of its own. As of 1.9.0, `phases`' completed list begins
  with `entry`/`queue`/`prelude` (see [Timing phases and the soft-budget
  consequence](#timing-phases-and-the-soft-budget-consequence) above) and
  `totalMs` honestly includes the queue wait and the prelude. **None of the
  five recall-shaped events fire for a `warmOnly` recall** — the assembler's
  local `emit` wrapper is a no-op for the whole warm path, including its
  degraded exits.
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
| `engine/recall/assemble-prompt-context.js` | the per-turn recall assembly, the six blocks, `RecallResult.timing`, `recall.completed`/`recall.block-*`/`recall.degraded`, the `entry`/`queue`/`prelude` phases and the `warmOnly` branch (1.9.0) |
| `engine/recall/namespace-recall.js` | `runMergedNamespaceRecall` — one pipeline run per leased namespace, merged after every child settles; `onNamespacePhases` |
| `engine/recall/neo-prelude.js` | `readNeoPrelude` — the neo window read, embed-with-timeout, global search and lane routing (1.9.0, factored out of the assembler) |
| `engine/recall/recall-params.js` | `autoRecallParams` — the merged-namespace-recall call params, including `readOnly` (1.9.0) |
| `engine/recall/warm-recall-path.js` | `createWarmRecallPath` — the `warmOnly` read-only recall path (1.9.0) |
| `engine/recall/minimal-maintenance.js` | the auto-recall-off branch |
| `engine/config/engine-config-schema.js` | `loadEngineConfigSchema`/`engineConfigKeys`/`readAtOf`/`livePaths`/`sensitivePaths`/`secretInputPaths`/`redactSensitiveConfig` (1.9.0) |
| `engine/config/live-config.js` | `HOST_REREAD_PATHS`, `livePluginConfig`, `readLiveConfigValue` — the one host-neutral live re-read (1.9.0) |
| `engine/store/fragment-compactor.js` | `createFragmentCompactor` — bounded LanceDB fragment compaction, `runtime.lancedbCompaction` (1.9.0) |
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
| `engine/jobs/job-registry.js` | `createJobRegistry` — the 19 engine-owned jobs, retry/abandon/breaker, `MAX_ATTEMPTS`, `BREAKER_LIMIT`, `sweepKey` |
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
| `adapter/openclaw/config-schema.js` | `deriveOpenClawConfigSchema`/`deriveSecretInputPaths`/`applyEngineSchemaToManifest` — generates the manifest's `configSchema`/`secretInputs.paths` from the engine schema (1.9.0) |
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
