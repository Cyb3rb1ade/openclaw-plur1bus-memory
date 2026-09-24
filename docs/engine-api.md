# The PLUR1BUS engine API

**Contract version 1.4.1** · frozen at 1.0.0 on 2026-09-22, amended five times
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

Five amendments have landed since the 1.0.0 freeze, per the `.d.ts` header's
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
`checkpoint`), the model-facing surface (`tools`, `commands`, `runCommand`),
and the background surface (`jobs`, `embedding`, `admin`, `events`,
`channels`). `engine/create-engine.js`'s `createEngine(host, config,
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

## What is implemented in M1b-1

`createEngine(host, config, testOptions?)` (`engine/create-engine.js`)
constructs the full 1.4.1 `Engine` surface described above from a plain
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

- `runCommand(name, args, principal, agent)` answers only `"plur1bus"`; any
  other command name comes back `{ details: { reason: "unknown-command" } }`.
  Even for `"plur1bus"`, the six user-facing command bodies (and their
  auth/locale helpers) are still built by the OpenClaw adapter
  (`register-commands.js`) and handed to the engine as `commandBodies`; on a
  host that never registered that adapter, the dispatcher's guard returns
  `{ details: { reason: "commands-unavailable", capability: "commands" } }`
  instead of throwing.
- `admin.share`, `admin.forget`, `admin.obsidian.{detect,prepare,confirm}`
  and `admin.migrate` all reject with `"<name> is not available in M1b-1"` —
  they have no engine-side implementation yet (only `admin.reembedding.*` and
  `admin.workspacePolicy.*` are wired to real coordinators).
- `embedding.probe()` and `embedding.serve()` are placeholders: `probe()`
  always resolves `{ ok: true, cached: false }` without actually exercising
  the provider, and `serve()` returns a no-op `Disposable` without opening any
  IPC address.
- `status()` is static: it reports `{ ready: true, degraded: null, agents:
  openedAgents.size, contract: "1.4.1" }` unconditionally — it does not probe
  the store, the embedder or any other dependency for actual health.

Everything else — `recall`, `capture`, `checkpoint`, `jobs.run`/`history`,
`tools`, `embedding.embed`/`rerank`/`identities`, `channels`,
`admin.reembedding.*`, `admin.workspacePolicy.*` — works against a plain
`HostServices` with no adapter involved, per `tests/engine-contract.test.js`.

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
`recall.block-dropped`, `recall.completed`. The five recall-shaped ones:

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
`types/engine.d.ts` disagree — checked at contract 1.4.1).

## Module layout after M1b-1

| Path | Holds |
|---|---|
| `engine/create-engine.js` | `createEngine(host, config, testOptions?)` — builds every context object, the nine views, and the 1.4.1 `Engine` surface |
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
