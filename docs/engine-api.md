# The PLUR1BUS engine API

**Contract version 1.3.0** · frozen at 1.0.0 on 2026-09-22, amended three times
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

`types/engine.d.ts` states its own amendment policy (lines 20-28):

> Amendment policy: "frozen" means 1.0.0 is never edited in place. Any change
> to an exported member's shape that an existing adapter could observe — a new
> required property, a removed or renamed member, a narrowed or widened union,
> a changed parameter or return type — forces a `ContractVersion` bump; only
> additions no adapter can observe (a comment, a new optional property on a
> type the engine alone constructs) may land without one.
> `ContractVersion`, the assertions in `types/engine.conformance.ts` and both
> adapters move together in a single PR, so the contract, its gate and its two
> consumers are never in disagreement at any commit.

Two amendments have landed since the 1.0.0 freeze, per the `.d.ts` header's own
changelog:

- **1.1.0** — `SecurePathResult.reason` gains `"acl-tool-unavailable"` (Task 5).
- **1.2.0** — `HostServices.workspaceDir` becomes async (Task 6).
- **1.3.0** — `HostServices.configPath()`, `HostServices.routing?`, `HostServices.pathOverrides?` (G1 closure, M1b-1 Task 11).

## The two halves

**`HostServices`** — what a host gives the engine. ADR-002 calls it `Host`;
they are the same type. `logger`, `stateDir`, `workspaceDir(agentId)`,
`config()`, `platform`, `runtime`, and the optional `mutateConfig`, `llm`,
`secrets`, `events`, `clock`. `lib/host-services.js` implements it for
OpenClaw (`createHostServices(api)`) and for tests (`createStubHost()`).

**`Engine`** — what the engine gives a host. Lifecycle (`open`, `close`,
`status`), the turn path (`systemSupplement`, `recall`, `capture`,
`checkpoint`), the model-facing surface (`tools`, `commands`, `runCommand`),
and the background surface (`jobs`, `embedding`, `admin`, `events`).

## Rules the types encode

- **`recall()` never throws.** A failure comes back as `degraded: { reason, capability }` with whatever blocks were assembled. The turn is never blocked.
- **`signal` is mandatory** on `RecallQuery` and `TurnRecord`. Today's memory-slot path accepts the host's signal and deliberately drops it (`lib/setup/memory-host-runtime.js`, the `recall({ …, signal: opts?.signal ?? null })` call — the comment directly above it says the recall pipeline has no cancellation input); PR-05 threads it through.
- **`capture()` returns immediately.** The caller gets a `CaptureHandle` with a `done` promise it may await or abandon.
- **The six blocks are the output shape.** `neo`, `start` and `memories` are droppable; `time`, `temporal` and `reminder` are not. The join and the cap live in `lib/inject-budget.js`, unchanged.
- **`UserPrincipal` stays `user:v1:sha256([channel, accountId, userId])`.** The hash is an on-disk pool directory name; changing it orphans every `user`-scoped row.
- **`trust: "inferred"` degrades to agent-private and never throws.** `lib/memory-request-context.js`'s `resolveHostHookMemoryContext` already has this shape: when session-ticket claiming fails, its `catch` block logs a warning and falls back to the unclaimed base context rather than throwing — the same fail-open-to-degraded behaviour `trust: "inferred"` names.

## What is implemented in M1a, and what is not

M1a implements `PlatformCapabilities` (`lib/platform.js`: `securePath`,
`ipcAddress`, `isUnsafeLink`, `canonicalIdentityPath`) and the runtime half of
`HostServices` (`lib/host-services.js`):

- `createHostServices(api)` and `createStubHost()`.
- `logger` is normalised to exactly four total methods (`info`, `warn`,
  `error`, `debug`); a partial or missing host logger no-ops instead of
  throwing.
- `runtime` is a lazy getter — `runtimeIfUsable(api)` runs on every read, not
  once at construction, because the underlying `api.runtime` can be a proxy
  that throws outside "full" registration and can become usable only after
  registration completes — and it returns `HostRuntime | null`.
- `workspaceDir(agentId)` is `async` (contract 1.2.0): every real
  `resolveAgentWorkspaceDir` in this repo is itself async, so a sync
  `workspaceDir` would hand callers a `Promise` instead of a path against any
  real host.
- A transitional `api` escape hatch exists on the object `createHostServices`
  and `createStubHost` return, for the adapter shell's own use only; it is
  removed at PR-14.
- `recallTimingSink` is an optional, test-internal context key on
  `engine/recall/assemble-prompt-context.js`'s recall assembly: when given, it
  is called once per attempted recall with per-phase timings. `index.js` only
  ever supplies it via the test-only `api.__recallTimingSinkForTests`
  property, so for every real OpenClaw host it is `null` and the sink is a
  no-op in production.

`engine/**` (`assemble-prompt-context.js`, `minimal-maintenance.js`,
`capture-turn.js`, `plur1bus-command.js`, `memory-tools.js`) holds the recall,
capture, command and tool bodies behind explicit context objects, moved out of
`index.js`. This does not make `engine/**` host-neutral yet on its own: two of
those modules (`assemble-prompt-context.js`, `plur1bus-command.js`) still read
`OPENCLAW_HOME`/`OPENCLAW_CONFIG_PATH` from `process.env` directly at eight
call sites — a faithful move of existing behaviour, not new coupling. No
`createEngine()` exists yet: it is declared in the contract
(`types/engine.d.ts:421`), not implemented — `Engine` is the target PR-04…PR-15
build toward.

## Module layout after PR-03

| Path | Holds |
|---|---|
| `engine/recall/assemble-prompt-context.js` | the per-turn recall assembly and the six blocks |
| `engine/recall/minimal-maintenance.js` | the auto-recall-off branch |
| `engine/capture/capture-turn.js` | auto-capture |
| `engine/commands/plur1bus-command.js` | `/plur1bus` and the internal job runners |
| `engine/tools/memory-tools.js` | the five model-facing tools |
| `adapter/openclaw/register-turn-route.js` | `reply_dispatch`, `agent_end` run cleanup |
| `adapter/openclaw/register-recall-hook.js` | `before_prompt_build` (auto-recall on) |
| `adapter/openclaw/register-maintenance-hook.js` | `before_prompt_build` (auto-recall off) |
| `adapter/openclaw/register-capture-hook.js` | `agent_end` auto-capture |
| `adapter/openclaw/register-commands.js` | the `plur1bus_*` commands, `/state`, `/enable`, `/disable`, the control-UI descriptor and control-health pair, the critical-push claiming hooks, and the four `lib/setup/*-plugin-runtime.js` delegations |
| `adapter/openclaw/register-tools.js` | the five model-facing tools |
| `adapter/openclaw/register-prompt-supplements.js` | the static system-prompt supplement and the Neo corpus supplement |
| `adapter/openclaw/register-gateway.js` | a lone `gateway_start` (Neo warm-up) plus two `gateway_start`/`gateway_stop` pairs (Obsidian bridge, Neo service), the shutdown owner and the four after-lifecycle service registrations |
| `adapter/openclaw/register-cron.js` | the unsafe direct feature-cron guard and the deferred feature-cron bootstrap |
| `index.js` | construction, the registration calls, the `/wiki` command, and the `export default` plugin factory |

`adapter/openclaw/README.md` records two facts worth repeating here: every
moved range keeps its **original call position** inside `register()` (folding
several ranges into one call site would reorder the host's per-event handler
lists), and `/wiki` stays registered from `index.js` because it goes through
the local `registerPluginCommand` helper rather than the `registerChatCommands`
command table `register-commands.js` owns.

`index.js` also still holds, ahead of `register()`: the five host-coupled
functions that take their own `api` parameter rather than reading a closure —
`inspectCronNativeCapabilities`, `reconcileUnsafeDirectCronsWithService`,
`runDeferredFeatureCronBootstrap`, `makeReactionsCapabilityChecker`,
`resolveNeoHooksConfig` (exempted from the host-logger rule below in
`tests/index-host-logger.test.js`, slated for PR-14).

`scripts/lint-engine-imports.mjs` enforces five rules inside `npm run lint`:
(1) `engine/**` never imports `openclaw`, `index.js`'s sibling host modules
`lib/setup/*-plugin-runtime.js`, `lib/runtime-shutdown.js`,
`lib/host-services.js` or `lib/providers/openclaw-memory-embedding-adapters.js`;
(2) neither `engine/**` nor `adapter/**` imports `index.js`; (3) no import
cycle inside `engine/** + adapter/**`; (4) `engine/**` never reads `.api` off
anything; (5) `engine/**` never names a bare `api` identifier either — rules 4
and 5 are text rules over the source lines (comments and simple quoted strings
stripped first, template literals not), so an `engine/**` comment may not
spell `api` followed by a dot — write "the host's `registerTool`" instead.

Two other gates run inside the same `npm run lint`: `scripts/lint-no-api-outside-adapter.mjs`
(only `index.js`, `adapter/**` and a short allowlist of host-coupled `lib/`
files — `lib/setup/*-plugin-runtime.js`, `lib/runtime-shutdown.js`,
`lib/providers/openclaw-memory-embedding-adapters.js`,
`lib/providers/scoped-embedding-ipc.js`, `lib/host-services.js` itself — may
reference `api.` at all) and `scripts/typecheck.mjs` (`tsc --noEmit` over
`types/`, so `types/engine.conformance.ts` fails the build the moment it and
`types/engine.d.ts` disagree).
