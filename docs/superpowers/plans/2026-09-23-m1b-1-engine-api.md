# M1b-1 — Engine API: `createEngine()`, recall contract, job ledger, principal, host-neutral `lib/` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the engine extraction M1a started: one construction path `createEngine(host, config)` that the OpenClaw adapter consumes exactly as the M1b-2 harness will, a recall contract that returns blocks as data and honours a mandatory `AbortSignal`, a job registry with an append-only run ledger and retry semantics, explicit `Principal`/`AgentContext` inputs, and an engine import graph that reaches neither `openclaw` nor `process.env.OPENCLAW_*` — with the golden-prefix corpus byte-identical at every step.

**Architecture:** Sixteen sequential tasks on one branch of the PLUR1BUS plugin repo, following the spec's ten steps in order. Steps 1–8 (Tasks 1–12) keep M1a's context objects and only change what they carry: `RecallResult` instead of `{ prependContext }`, a threaded signal, one rerank timer, a checkpoint store, a `JobRegistry` whose bodies are the 17 internal runners lifted out of `engine/commands/plur1bus-command.js`, a JSONL run ledger, a `Principal` constructor, and a host-path/routing injection that makes the engine graph host-neutral, proven by a transitive lint. Step 9 (Tasks 13a–13c) then moves index.js's ~4 000 lines of module-level declarations into `engine/**`, moves the 3 400-line `register()` construction body into `engine/create-engine.js` behind one non-exported `EngineInternals` object, and reduces `index.js` to a re-export shell over `adapter/openclaw/plugin.js`. Step 10 (Task 14) documents contract 1.4.0 and re-runs the bench probe.

**Tech Stack:** Node ≥ 24.16 (ESM, `"type": "module"`), `node:test` + `node:assert/strict`, LanceDB (`@lancedb/lancedb`), `typescript@5.9.3` (already an `optionalDependency`; used by `scripts/typecheck.mjs` and `tools/free-identifiers.mjs`). No new dependencies.

**Spec:** `/home/claude/PLUR1BUS-Harness/docs/superpowers/specs/2026-09-23-m1b-1-engine-api-design.md` (binding). Supporting: `types/engine.d.ts` (contract 1.2.0), `types/engine.conformance.ts`, `docs/engine-api.md`, the M1a plan `/home/claude/PLUR1BUS-Harness/docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md` and its archive `/home/claude/PLUR1BUS-Harness/docs/superpowers/sdd-archive-m1a/` (`progress.md` rulings, `whole-branch-review.md`), and `/home/claude/PLUR1BUS-Harness/docs/assumptions.md` Q11 (the 3-LLM-sessions-per-sweep circuit breaker).

---

## Repository, branch, and how to run anything

**Work repo (`$PLUR1BUS`):** a worktree of `Cyb3rb1ade/openclaw-plur1bus-memory` on a new branch **`feat/engine-api-m1b1`** cut from `main` **after PR #185 is merged**. Base SHA: **`91dfce25`** (the controller fills this in; it is the merge commit of #185 on `main`). Create the worktree with the `superpowers:using-git-worktrees` skill before Task 1.

**Reference tree for this plan:** every `file:line` below was read on 2026-09-23 in `/home/claude/work/plur1bus-m1b1-plan` at `9fd7bab4` (= `main` @ `01861add` + PR #185). `91dfce25` should be content-identical in every file this plan cites; if it is not, the line numbers drift but the grep anchors still hold. **Line numbers are advisory.** Every step that edits by location gives a grep anchor first; re-derive, then edit.

**Node.** The default `node` on this machine is v22 and is **wrong**. Always use v24.21:

```bash
export PATH=/home/claude/.node24/bin:$PATH
node -v          # must print v24.21.0
```

**Full suite** (the regression net; OpenClaw is the test harness, not the customer — spec §1):

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

**Accepted baseline in this container:** `fail 0`, `skipped 3` (M1a ruling, `progress.md:31`: the two host-dependent tests self-skip as root on Linux, plus one pre-existing skip). "Suite green" in this plan means **fail 0 and skipped ≤ 3**. Record the pass/total count you see at `91dfce25` in the Task 1 report and compare every later run against it; the total grows as tasks add tests.

**One test file:**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/<name>.test.js
```

**Golden corpus only:**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
```

**Lint** (syntax sweep, `typecheck`, both boundary linters):

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
```

**Typecheck only:** `cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run typecheck`

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Node ≥ 24.16.0.** `package.json` `engines` is `">=24.16.0 <25 || >=26.1.0"`. Use `/home/claude/.node24/bin/node` (v24.21.0) for every command.
2. **No new runtime dependencies.** Do not add, move or upgrade anything in `dependencies`, `optionalDependencies` or `devDependencies`. `typescript` stays an `optionalDependency`.
3. **No edits to `.github/`.** New checks go into the existing `npm run lint` chain.
4. **`package.json` `name` (`@cyb3rb1ade/plur1bus-memory`) and `version` (`7.15.4`) are unchanged**, as are `main`, `openclaw.extensions` (`["./index.js"]`), `openclaw.compat`, `openclaw.build` and `scripts.postinstall`. `files` already lists `index.js`, `lib/`, `engine/`, `adapter/`, `types/` — no edit needed.
5. **Contract amendment policy** (`types/engine.d.ts:23-31`): a change an adapter could observe forces a `ContractVersion` bump, and `ContractVersion`, the assertions in `types/engine.conformance.ts`, and every consumer move **in one commit**. This plan bumps exactly twice: **1.3.0 in Task 11** (`HostServices.configPath()`, `HostServices.routing?`, `HostServices.pathOverrides?` — `lib/host-services.js` is the consumer), and **1.4.0 in Task 13c** (every `Engine`-side shape, consumed by `engine/create-engine.js` and the adapter). No other commit edits `ContractVersion`. The final value is **`"1.4.0"`**. Tasks 1–10 build runtime shapes that already match the 1.4.0 target below; they do not touch `types/`.
6. **Golden oracle rule for M1b-1.** `tests/fixtures/golden-prefix/expected/*.txt` for the seven existing scenarios (`recall-basic`, `recall-empty-store`, `recall-knowledge-canonical`, `recall-large-text-records`, `recall-maintenance-only`, `recall-truncated`, `recall-canonical-flagged`) is **byte-identical after every task**; no task in this plan is permitted to change it (none planned). Two scenarios are **added and written once**: `recall-aborted` (Task 3) and `jobs-ledger-retry` (Task 8). Their oracle is written by `tools/capture-golden-prefix.mjs --only <name>` in the task that adds them and never regenerated. A task that cannot keep the seven byte-identical **stops and reports** instead of touching the oracle.
7. **Behaviour changes only where the spec allows them:** (a) PR-08 run semantics (Tasks 7–9: `incomplete`/retry/`abandoned`, `already_processed` only after `completed`, the per-sweep breaker, ledger rows for skips); (b) L3 events and deferrals (Task 2: additive); (c) spec §3.2's abort contract (Task 3: an aborted or timed-out recall returns the blocks already complete instead of nothing — the golden seven never time out, so the oracle is unaffected; the PR description must name this). Everything else is behaviour-neutral, including every log line except where a task quotes the new text.
8. **`engine/**` never spells `api` followed by a dot, and never names a bare `api` identifier — not even in a comment.** `scripts/lint-engine-imports.mjs` rules 4 and 5 are text rules (`scripts/lint-engine-imports.mjs:27-36`); write "the host's `registerTool`" instead.
9. **New files are registered in three places.** (a) Every new `scripts/*.mjs` needs a `!scripts/<name>.mjs` line in `.gitignore` (the `scripts/*` denylist at `.gitignore:32`) **and** an entry in `DEPLOY_FILES` (`scripts/lib/deploy-integrity.mjs:14`). (b) Every new runtime-reachable file under `engine/`, `adapter/` or `lib/` goes into `DEPLOY_FILES` in its section (`scripts/lib/deploy-integrity.mjs:25-40` for adapter/engine; the "core runtime" block below it for `lib/`). (c) Every new module under `engine/` or `adapter/openclaw/` is listed in `ENGINE_PATHS` or `ADAPTER_PATHS` of `tests/helpers/runtime-sources.js:33-52`, whose `assertComplete` throws otherwise (`tests/helpers/runtime-sources.js:68-78`).
10. **Tests use `makeTempDir()` from `tests/helpers/temp-dir.js`**, never `mkdtempSync` directly (M1a ruling, `progress.md:52`: a guard test enforces it). Literal-source guard tests read sources through `readRuntimeSources()` / `runtimeSourcePath()` from `tests/helpers/runtime-sources.js`, not hand-kept path lists.
11. **Line numbers are advisory — re-derive by grep before every edit.** Any range you lift out of a file is verified three ways before commit: the free-identifier analyser (`tools/free-identifiers.mjs <file> <start> <end>`), a brace-balance check on the extracted text, and `node --check` on both the source and the target file (M1a ruling, `progress.md:63`).
12. **Moved code keeps its relative paths correct.** A lazy `import("../../lib/x.js")` or an `import.meta.url`-derived path (e.g. `__pluginDir`, `index.js:247`) inside moved code is rewritten for the new file's depth. Grep every moved range for `import(` and `import.meta` before committing.
13. **`index.js`'s public names are frozen.** The 19 names in `tests/index-public-exports.test.js:14-34` and the default export (`id === "memory-lancedb-namespaced"`, `typeof register === "function"`) stay importable from `../index.js`; 48 test files import from it. When a declaration moves, `index.js` re-exports it.
14. **Registration order per host event list is unchanged** (`adapter/openclaw/README.md:34-50`): the control-health `gateway_start`/`gateway_stop` pair stays between the Obsidian pair and the Neo pair; the recall `before_prompt_build` handler stays the **last** registered one (the golden driver takes `hooks.at(-1)`, `tests/helpers/golden-prefix-driver.js:243`); `agent_end` stays capture → reply-outcome → turn-route cleanup; `registerGatewayShutdownServices(...)` stays the last registration and `gateway_stop` keeps `timeoutMs: 30_000`.
15. **`engine/**` must not import** `openclaw`, `lib/setup/*-plugin-runtime.js`, `lib/runtime-shutdown.js`, `lib/host-services.js`, `lib/providers/openclaw-memory-embedding-adapters.js` or `index.js` (`scripts/lint-engine-imports.mjs:58-64`). From Task 12 this holds **transitively** over `lib/**`.
16. **No real user data and no writes outside `os.tmpdir()` in tests.** Fixture text is invented; ids are fixed literal UUIDs; no network.
17. **Conventional Commits**, one commit per task unless a task says otherwise. Scopes: `engine`, `adapter`, `host`, `types`, `jobs`, `recall`, `test`, `docs`, `bench`.
18. **Every task and every fix round that touches `tests/` or `scripts/` runs the full suite before review** (M1a rulings, `progress.md:40,52`), and every task ends with lint green and the golden corpus at 7/7 (8/8 after Task 3, 9/9 after Task 8).

---

## Target contract 1.4.0 (what Tasks 1–13c build toward)

Tasks 1–10 create runtime objects of exactly these shapes; Task 11 writes the `HostServices` half (1.3.0); Task 13c writes the rest (1.4.0). Where the spec's sketch (§3.1–§3.3) and the frozen 1.2.0 contract name the same thing differently, **the contract's names win** (it is code with a conformance gate and a published doc); the spec's intent is kept. Differences are listed so a reviewer can check each was deliberate:

| Spec §3 sketch | 1.2.0 contract | 1.4.0 target (this plan) |
|---|---|---|
| `RecallQuery { agentId, principal, agentContext, text, signal, budget?: { capChars } }` | `{ query, principal, agent, budget: RecallBudget, signal, compactedAt?, previousUserTurnAt?, validAt? }` (`types/engine.d.ts:202-212`) | keep `query`/`agent`; `budget` becomes optional `Partial<RecallBudget>`; `agentId` is `principal.agentId` |
| `ContextBlock { name, text, droppable, chars }` | `{ name, text, droppable, tokensEstimate? }` (`:189-194`) | adds required `chars` |
| `RecallResult { blocks, capChars, degraded, timing, deferrals }` | `{ blocks, capChars, degraded, trace?, timings: Record<string, number> }` (`:224-231`) | `timings` → `timing: RecallTiming`; adds `deferrals` |
| `JobRun { runId, job, phase, agentId, trigger, startedAt, finishedAt, outcome, reason?, attempt, cost }` | `{ job, agentId, partition?, startedAt, durationMs, outcome, reason?, counts, logRef? }` (`:294-304`) | union of both field sets (below) |
| `outcome` 5 values | 4 values (`:300`) | 5 values (`"abandoned"` added) |
| `Engine.jobs.run(name, agentId, { signal, trigger })`, `history(agentId, { job?, since?, limit? })` | `run(job, agentId, opts?: { signal?, dryRun? })`, `history(agentId, job?, limit?)` (`:306-310`) | spec's option shapes |
| `checkpoint(agentId, "compaction"\|"session-end"\|"manual")` | `CheckpointReason = "compaction"\|"shutdown"\|"manual"` (`:264`) | widened to all four (dropping `"shutdown"` would be a removal with no gain) |
| `close({ budgetMs })` | `close(): Promise<void>` (`:400`) | `close(opts?: { budgetMs?: number })` |

The 1.4.0 text Task 13c writes (the full file is in that task):

```ts
export type ContractVersion = "1.4.0";
export interface HostServices { /* 1.2.0 members */ configPath(): string; routing?(): Promise<unknown>; pathOverrides?: HostPathOverrides; capabilities?: HostCapabilities; }
export interface HostPathOverrides { openclawHome?(): string | undefined; configPathOverride?(): string | undefined; stateDirOverride?(): string | undefined; }
export interface HostCapabilities { resolvePath?(path: string): string; registrationMode?: string; [capability: string]: unknown; }
export interface ContextBlock { name: ContextBlockName; text: string; droppable: boolean; chars: number; tokensEstimate?: number; }
export interface Deferral { block: ContextBlockName; kind: "clipped" | "dropped"; from: number; to: number; reason: "global-cap" | "memories-cap"; }
export interface RecallTiming { phases: Record<string, unknown> | null; totalMs: number; namespacePhases?: Array<{ namespace: string; phase: string; ms: number }>; }
export interface RecallResult { blocks: ContextBlock[]; capChars: number; degraded: Degraded | null; trace?: DecisionTrace; timing: RecallTiming; deferrals: Deferral[]; }
export type CheckpointReason = "compaction" | "session-end" | "shutdown" | "manual";
export type JobOutcome = "completed" | "skipped" | "incomplete" | "failed" | "abandoned";
export type JobTrigger = "cron" | "manual" | "harness" | "capture";
export interface JobRun { runId: string; job: JobName; phase: "light" | "rem" | "deep" | null; agentId: AgentId; trigger: JobTrigger; startedAt: number; finishedAt: number; durationMs: number; outcome: JobOutcome; reason?: string; attempt: number; cost: JobCost; counts: Record<string, number>; idempotencyKey?: string; keys?: string[]; pendingKeys?: string[]; diary?: { written: boolean; reason?: string }; migrated?: boolean; }
```

`capChars` is `Number.POSITIVE_INFINITY` for the three recall exits that today return an **uncapped** join (neo-only early returns and the error fallback — `engine/recall/assemble-prompt-context.js:273,281,1201`); `applyGlobalInjectBudget` treats a non-finite cap as "join only" (`lib/inject-budget.js:209-212`), which is what makes the adapter's join byte-identical on every path.

---

## Review Focus

Five inputs or failure modes the spec implies that no task's happy path exercises, most likely first. Each has its test pinned to the owning task.

1. **The caller's signal is already aborted when `recall()` starts.** The easy implementation checks the signal inside the scheduled callback, after the start notice has been *consumed* (deleted from disk, `lib/setup/feature-profiles.js:589-605`) and after a scheduler slot was taken. **Fix:** the assembler checks `signal.aborted` as its first statement and returns `degraded: { reason: "aborted", capability: "recall" }` with zero blocks, before the policy check, the scheduler and the notice. **Test in Task 3:** `recall(event, hookCtx, { signal: AbortSignal.abort() })` resolves with `degraded.reason === "aborted"`, `blocks.length === 0`, the stub embedder was never called, `runtimeScheduler.status().recallQueued` is unchanged, and a pending start-notice file still exists afterwards.
2. **The ledger directory is unwritable.** "A row before the body" (spec §3.3) is only true if the marker write can fail the run. A registry that logs and runs anyway produces an unrecorded run — exactly the invisibility PR-08 exists to remove. **Fix:** `jobs.run()` writes the `<runId>.started` marker first; if that throws, the body is **not** invoked and `run()` resolves `outcome: "failed", reason: "ledger_unwritable"` (logged at `warn`, emitted as `job.run`). **Test in Task 7:** with the ledger root pointed at a regular file, the body spy is never called and the returned run has that outcome and reason.
3. **Migration meets a corrupt `run-state.json`.** `readJson` in `lib/neo-arch.js:2471-2478` swallows parse errors and returns `{}`, so a migration built on `store.readRunState()` silently imports nothing *and then writes its migrated marker over the corrupt file*, destroying the only copy. **Fix:** the migration reads `store.paths.runs` raw; on a parse error it logs `warn`, writes **no** rows, **does not** rewrite the file, copies the raw bytes to `run-state.json.migrated` only if that file does not exist, and leaves itself un-marked so it retries next time. **Test in Task 9.**
4. **A job body throws after it has already written the dream diary.** The row must still record the diary outcome (spec §3.3: "Diary write outcome is part of the row") and the marker must be removed, or the next start reports a false `crash`. **Fix:** `jobCtx.noteDiary(result)` stores the outcome on the in-flight run; the `catch` path records `failed` with that `diary` field and removes the marker in a `finally`. **Test in Task 8:** a stub `rem-dream` body calls `noteDiary({ written: true })` then throws; the ledger row has `outcome: "failed"`, `diary: { written: true }`, and no marker is left.
5. **Recall where no block is droppable and the cap is smaller than the non-droppable sum.** `applyGlobalInjectBudget` breaks out of its loop when no droppable index is left (`lib/inject-budget.js:216-217`), so the joined text exceeds `capChars`. A deferral planner that assumes "over cap ⇒ something was clipped" would invent a phantom deferral or loop. **Fix:** `planGlobalInjectBudget` records a deferral only when it actually trims or drops a block. **Test in Task 2:** three non-droppable blocks of 50 chars with `maxChars: 20` → `text` equals the plain `"\n\n"` join, `deferrals` is `[]`, and no event is emitted.

---

## File Structure

| Path | Task | Responsibility |
|---|---|---|
| `engine/recall/recall-result.js` | 1 | `contextBlock()`, `recallResult()`, `UNCAPPED`, `ABORTED` — the `RecallResult` value helpers |
| `adapter/openclaw/join-recall.js` | 1 | `prependContextFromRecall(result)` — the OpenClaw host's join and cap |
| `engine/events.js` | 2 | `emitEngineEvent(host, name, payload)` — the one place engine code emits through `host.events` |
| `lib/inject-budget.js` (modify) | 2 | `planGlobalInjectBudget()` returning `{ text, deferrals }`; `applyGlobalInjectBudget` delegates |
| `lib/abort.js` (modify) | 3 | `raceAbort(promise, signal, message)` |
| `engine/checkpoint/checkpoint-store.js` | 5 | `createCheckpointStore()`, `resolveCompactedAt()` |
| `engine/jobs/job-specs.js` | 6 | the 18 `JobSpec`s |
| `engine/jobs/job-registry.js` | 6–8 | `createJobRegistry()`: `list`, `run`, `history`, `bind` |
| `engine/jobs/internal-job-bodies.js` | 6 | the 17 internal runners lifted from `engine/commands/plur1bus-command.js` |
| `engine/jobs/job-ledger.js` | 7 | JSONL ledger, `.started` markers, crash recovery |
| `engine/jobs/rem-outcome.js` | 8 | `remJobOutcome()`, `ledgerBackedCompletion()` |
| `engine/jobs/run-state-migration.js` | 9 | `migrateRunStateCompletions()` |
| `engine/identity/principal.js` | 10 | `memoryContextFromPrincipal()`, `principalFromMemoryContext()`, `createChannelRegistry()` |
| `adapter/openclaw/turn-principal.js` | 10 | `createTurnPrincipalResolver()`, `agentContextFromCommand()` — the moved hook-identity code and cron matching |
| `lib/host-paths.js` | 11 | `bindHostPaths()`, `hostStateDir()`, `hostConfigPath()`, … — the engine graph's only path defaults, no env |
| `lib/host-sdk-loader.js` | 11 | `setHostSdkLoader()`, `loadHostSdk()` — replaces two `lib → feature-cron-plugin-runtime` imports |
| `lib/plugin-meta.js` | 11 | `PLUGIN_ROOT`, `PLUGIN_VERSION` |
| `lib/feature-crons-hint.js` | 11 | `featureCronsMarkerPath`, `getFeatureCronsSetupHint`, `resetFeatureCronsHintCache`, `parseFeatureCronBootstrapLastPlanCreateCount` |
| `adapter/openclaw/host-probes.js` | 11 | the five pre-`register()` `api`-taking functions |
| `scripts/lint-engine-imports.mjs` (modify) | 12 | transitive graph walk + env rule |
| `engine/runtime/*.js`, `engine/store/*.js`, `engine/providers/*.js`, `engine/knowledge/*.js`, `engine/commands/command-helpers.js`, `engine/recall/namespace-recall.js` | 13a | index.js's module-level declarations |
| `lib/local-model-generation.js` | 13b | `createLocalModelGenerationLifecycle` lifted out of `lib/runtime-shutdown.js` |
| `engine/create-engine.js` | 13b–13c | `createEngine(host, config, testOptions?)`, `EngineInternals` |
| `engine/internals.js` | 13b | `ENGINE_INTERNALS` symbol + `internalsOf(engine)` (adapter-only seam) |
| `engine/lifecycle/close-resources.js` | 13b | the shutdown body lifted from `lib/runtime-shutdown.js:241-291` |
| `adapter/openclaw/plugin.js` | 13b | `registerPlur1bus(api, registrationDependencies)` — host services → `createEngine` → nine `register-*` modules |
| `engine/recall/system-supplement.js` | 13c | `buildSystemSupplement({ neoEnabled })` |
| `types/engine.d.ts`, `types/engine.conformance.ts` | 11, 13c | 1.3.0, 1.4.0 |
| `docs/engine-api.md`, `docs/compatibility-openclaw.md`, `CHANGELOG.md`, `bench/recall-budget-probe.mjs` | 14 | documentation and the bench switch |

Each task also creates its own `tests/…` file(s), named in the task.

---

### Task 1 (PR-04a): recall returns `RecallResult`; the adapter joins and caps

The engine stops producing `{ prependContext }` and returns blocks as data (spec §3.2 bullet 1). The adapter calls `applyGlobalInjectBudget` itself. Every exit of both `before_prompt_build` engine handlers is mapped so the adapter's join is byte-identical to today's string on that exit.

**Files:**
- Create: `engine/recall/recall-result.js`
- Create: `adapter/openclaw/join-recall.js`
- Modify: `engine/recall/assemble-prompt-context.js` — the policy early return (`:146`), the two neo-only returns (`:273`, `:281`), the main return (`:1186-1196`), the error fallback (`:1199-1201`), the outer returns (`:1221-1235`)
- Modify: `engine/recall/minimal-maintenance.js:56`, `:76-79`, `:142-144`
- Modify: `adapter/openclaw/register-recall-hook.js:16-21`, `adapter/openclaw/register-maintenance-hook.js:37-40`
- Modify: `tests/engine-assemble-prompt-context.test.js:31-52`, `tests/engine-minimal-maintenance.test.js:33-66`
- Modify: `tests/helpers/runtime-sources.js` (two new entries), `scripts/lib/deploy-integrity.mjs` (two new entries)
- Create: `tests/engine-recall-result.test.js`

**Interfaces:**
- Consumes: `applyGlobalInjectBudget({ blocks, maxChars })` (`lib/inject-budget.js:201`).
- Produces:
  - `contextBlock(name: string, text: string, droppable: boolean) -> { name, text, droppable, chars }`
  - `recallResult({ blocks?, capChars?, degraded?, timing?, deferrals? }) -> RecallResult` (defaults: `[]`, `UNCAPPED`, `null`, `{ phases: null, totalMs: 0 }`, `[]`)
  - `UNCAPPED = Number.POSITIVE_INFINITY`
  - `prependContextFromRecall(result) -> { prependContext: string } | undefined` — `undefined` iff `result.blocks.length === 0`
  - `createPromptContextAssembler(ctx)` now returns `async (event, hookCtx) => RecallResult` (never `undefined`)
  - `createMinimalMaintenance(ctx)` now returns `async (event, hookCtx) => RecallResult`

**Why the mapping is exact.** Today there are three distinct string shapes: the capped join of six blocks (`:1186-1196`, `prependContext` may be `""`), a bare `neoContext` (`:273`, `:281`), and `[neoContext, startNoticeContext].filter(Boolean).join("\n\n")` (`:1200`). `applyGlobalInjectBudget` filters empty-text blocks and joins with `"\n\n"` (`lib/inject-budget.js:202-213`), so a one-block list with an uncapped cap is the bare text and a two-block uncapped list is the fallback join. "Return `undefined`" becomes "return zero blocks", and "return `{ prependContext: "" }`" stays "six blocks whose texts are all empty" — the adapter maps `blocks.length === 0` to `undefined` and anything else to `{ prependContext }`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/engine-recall-result.test.js`:

```js
/**
 * tests/engine-recall-result.test.js — PR-04a.
 *
 * The engine returns blocks as data; the OpenClaw host joins and caps. These
 * pin the two value helpers and the host join on every exit shape the recall
 * handlers produce, so the golden corpus is not the only thing standing
 * between a mapping slip and a changed prompt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { contextBlock, recallResult, UNCAPPED } from "../engine/recall/recall-result.js";
import { prependContextFromRecall } from "../adapter/openclaw/join-recall.js";

describe("engine/recall/recall-result", () => {
  it("contextBlock carries chars and coerces text", () => {
    assert.deepEqual(contextBlock("time", "abc", false), { name: "time", text: "abc", droppable: false, chars: 3 });
    assert.deepEqual(contextBlock("neo", undefined, true), { name: "neo", text: "", droppable: true, chars: 0 });
  });

  it("recallResult fills every field of the 1.4.0 shape", () => {
    assert.deepEqual(recallResult(), {
      blocks: [],
      capChars: UNCAPPED,
      degraded: null,
      timing: { phases: null, totalMs: 0 },
      deferrals: [],
    });
  });
});

describe("adapter/openclaw/join-recall", () => {
  it("maps zero blocks to undefined (the old `return undefined` exits)", () => {
    assert.equal(prependContextFromRecall(recallResult()), undefined);
    assert.equal(prependContextFromRecall(undefined), undefined);
  });

  it("keeps an all-empty six-block result as an empty prependContext", () => {
    const blocks = ["neo", "start", "memories", "time", "temporal", "reminder"]
      .map((name) => contextBlock(name, "", name !== "time" && name !== "temporal" && name !== "reminder"));
    assert.deepEqual(prependContextFromRecall(recallResult({ blocks, capChars: 17_000 })), { prependContext: "" });
  });

  it("returns a lone uncapped neo block verbatim (the neo-only early returns)", () => {
    const neo = "<plur1bus-recall>x</plur1bus-recall>";
    assert.deepEqual(
      prependContextFromRecall(recallResult({ blocks: [contextBlock("neo", neo, true)] })),
      { prependContext: neo },
    );
  });

  it("joins the error fallback exactly like [neo, start].filter(Boolean).join", () => {
    const neo = "N".repeat(40);
    const start = "S".repeat(30);
    const expected = [neo, start].filter(Boolean).join("\n\n");
    const blocks = [contextBlock("neo", neo, true), contextBlock("start", start, true)].filter((b) => b.text);
    assert.equal(prependContextFromRecall(recallResult({ blocks })).prependContext, expected);
  });

  it("applies the cap when capChars is finite", () => {
    const blocks = [contextBlock("start", "S".repeat(50), true), contextBlock("time", "T".repeat(10), false)];
    assert.equal(prependContextFromRecall(recallResult({ blocks, capChars: 20 })).prependContext, "T".repeat(10));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-recall-result.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND … engine/recall/recall-result.js`.

- [ ] **Step 3: Create the two modules**

Create `engine/recall/recall-result.js`:

```js
/**
 * engine/recall/recall-result.js
 *
 * Value helpers for the recall contract (types/engine.d.ts, target 1.4.0):
 * the engine returns ContextBlocks as data and the host joins and caps them.
 * `UNCAPPED` marks the exits that today inject an uncapped join; the host's
 * joiner treats a non-finite cap as "join only".
 */

export const UNCAPPED = Number.POSITIVE_INFINITY;

/** @type {{reason: string, capability: string}} */
export const ABORTED = Object.freeze({ reason: "aborted", capability: "recall" });

/**
 * @param {string} name Block name (neo, start, memories, time, temporal, reminder).
 * @param {unknown} text Block text; anything falsy becomes "".
 * @param {boolean} droppable Whether the host may clip or drop it.
 * @returns {{name: string, text: string, droppable: boolean, chars: number}}
 */
export function contextBlock(name, text, droppable) {
  const value = text ? String(text) : "";
  return { name, text: value, droppable: droppable === true, chars: value.length };
}

/**
 * @param {{blocks?: object[], capChars?: number, degraded?: object|null, timing?: object|null, deferrals?: object[]}} [fields]
 * @returns {{blocks: object[], capChars: number, degraded: object|null, timing: {phases: object|null, totalMs: number}, deferrals: object[]}}
 */
export function recallResult({ blocks = [], capChars = UNCAPPED, degraded = null, timing = null, deferrals = [] } = {}) {
  return {
    blocks,
    capChars,
    degraded,
    timing: timing ?? { phases: null, totalMs: 0 },
    deferrals,
  };
}
```

Create `adapter/openclaw/join-recall.js`:

```js
/**
 * adapter/openclaw/join-recall.js
 *
 * The OpenClaw host's half of the recall contract: join the engine's blocks
 * and cap them with the record-boundary budget (lib/inject-budget.js), then
 * hand OpenClaw the `{ prependContext }` shape its before_prompt_build hook
 * expects. Zero blocks means "inject nothing", which OpenClaw expresses as
 * returning undefined.
 */

import { applyGlobalInjectBudget } from "../../lib/inject-budget.js";

/**
 * @param {{blocks?: object[], capChars?: number}|undefined} result RecallResult.
 * @returns {{prependContext: string}|undefined}
 */
export function prependContextFromRecall(result) {
  if (!result || !Array.isArray(result.blocks) || result.blocks.length === 0) return undefined;
  return { prependContext: applyGlobalInjectBudget({ blocks: result.blocks, maxChars: result.capChars }) };
}
```

- [ ] **Step 4: Run the unit test — it passes**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-recall-result.test.js 2>&1 | tail -5
```

Expected: `tests 7`, `pass 7`.

- [ ] **Step 5: Convert the recall assembler's exits**

Add to the import block of `engine/recall/assemble-prompt-context.js`:

```js
import { contextBlock, recallResult } from "./recall-result.js";
```

Then make these six replacements (anchor each with `grep -n` first; the numbers are at `9fd7bab4`):

(a) `:146` — the pre-schedule policy refusal:

```js
    if (hookCtx?.workspaceDir && !automaticWorkspacePolicyDecision(event, hookCtx).allowed) return undefined;
```
becomes
```js
    if (hookCtx?.workspaceDir && !automaticWorkspacePolicyDecision(event, hookCtx).allowed) return recallResult();
```

(b) and (c) — both neo-only early returns, `:273` and inside the magic-message `if` at `:281`:

```js
    if (!event.prompt || event.prompt.length < 5) return neoContext ? { prependContext: neoContext } : undefined;
```
becomes
```js
    if (!event.prompt || event.prompt.length < 5) return neoContext ? recallResult({ blocks: [contextBlock("neo", neoContext, true)] }) : undefined;
```
and
```js
    ) { return neoContext ? { prependContext: neoContext } : undefined; }
```
becomes
```js
    ) { return neoContext ? recallResult({ blocks: [contextBlock("neo", neoContext, true)] }) : undefined; }
```

Those two keep returning `undefined` for "nothing": they are *inside* the scheduled callback, and an `undefined` job value is deliberately never cached by the scheduler (`lib/runtime-scheduler.js:349`). Step 5(f) converts `undefined` at the single outer exit.

(d) `:1186-1196` — the main return:

```js
      return { prependContext: applyGlobalInjectBudget({
        blocks: [
          { name: "neo", text: neoContext, droppable: true },
          { name: "start", text: startNoticeContext, droppable: true },
          { name: "memories", text: fullMemoriesContext + nudge + conflictNudge + skillProposalNudge, droppable: true },
          { name: "time", text: timeContext, droppable: false },
          { name: "temporal", text: temporalContinuityContext, droppable: false },
          { name: "reminder", text: reminderNudge, droppable: false },
        ],
        maxChars: cfg.recall?.globalInjectMaxChars ?? 17_000,
      }) };
```
becomes
```js
      return recallResult({
        blocks: [
          contextBlock("neo", neoContext, true),
          contextBlock("start", startNoticeContext, true),
          contextBlock("memories", fullMemoriesContext + nudge + conflictNudge + skillProposalNudge, true),
          contextBlock("time", timeContext, false),
          contextBlock("temporal", temporalContinuityContext, false),
          contextBlock("reminder", reminderNudge, false),
        ],
        capChars: cfg.recall?.globalInjectMaxChars ?? 17_000,
      });
```

and delete the now-unused `import { applyGlobalInjectBudget } from "../../lib/inject-budget.js";` (`:20`) — Task 2 re-imports `planGlobalInjectBudget` from the same module.

(e) `:1199-1201` — the error fallback:

```js
      const fallbackContext = [neoContext, startNoticeContext].filter(Boolean).join("\n\n");
      if (fallbackContext) return { prependContext: fallbackContext };
```
becomes
```js
      const fallbackBlocks = [contextBlock("neo", neoContext, true), contextBlock("start", startNoticeContext, true)]
        .filter((block) => block.text);
      if (fallbackBlocks.length > 0) return recallResult({ blocks: fallbackBlocks });
```

(f) `:1221-1235` — the outer exits after the scheduler settles. Replace:

```js
      return scheduledRecall.value;
    }
    if (scheduledRecall.timedOut) {
      host.logger.warn(`memory-lancedb-namespaced: recall timed out without cache for agent=${agentIdForCache}${background ? " (background)" : ""}`);
      return undefined;
    }
    if (scheduledRecall.error) {
      host.logger.warn(`memory-lancedb-namespaced: recall scheduler failed for agent=${agentIdForCache}: ${String(scheduledRecall.error)}`);
    }
    return undefined;
```
with
```js
      return scheduledRecall.value ?? recallResult();
    }
    if (scheduledRecall.timedOut) {
      host.logger.warn(`memory-lancedb-namespaced: recall timed out without cache for agent=${agentIdForCache}${background ? " (background)" : ""}`);
      return recallResult();
    }
    if (scheduledRecall.error) {
      host.logger.warn(`memory-lancedb-namespaced: recall scheduler failed for agent=${agentIdForCache}: ${String(scheduledRecall.error)}`);
    }
    return recallResult();
```

Also update the JSDoc `@returns` of `createPromptContextAssembler` (`:65`) to `Promise<object>` "a RecallResult (engine/recall/recall-result.js)".

- [ ] **Step 6: Convert the maintenance branch**

In `engine/recall/minimal-maintenance.js` add `import { contextBlock, recallResult } from "./recall-result.js";`, then:

- `:56` `if (!automaticWorkspacePolicyDecision(event, hookCtx).allowed) return undefined;` → `… return recallResult();`
- `:76-79` both `return undefined;` → `return recallResult();`
- `:142-144` replace

```js
    if (nudge || conflictNudge || startNoticeContext || timeContext || temporalContinuityContext || reminderNudge) {
      return { prependContext: [startNoticeContext, nudge + conflictNudge, timeContext, temporalContinuityContext, reminderNudge].filter(Boolean).join("\n\n") };
    }
```
with
```js
    return recallResult({
      blocks: [
        contextBlock("start", startNoticeContext, true),
        contextBlock("memories", nudge + conflictNudge, true),
        contextBlock("time", timeContext, false),
        contextBlock("temporal", temporalContinuityContext, false),
        contextBlock("reminder", reminderNudge, false),
      ].filter((block) => block.text),
    });
```

The old `if` returned the `filter(Boolean)` join of the same five strings in the same order, or fell off the end (`undefined`) when all were empty; zero non-empty blocks now yields zero blocks, which the adapter maps to `undefined`. Update `@returns` (`:37`) accordingly.

- [ ] **Step 7: Make both adapter registrations join**

`adapter/openclaw/register-recall-hook.js` — replace the body of `registerRecallHook`:

```js
import { createPromptContextAssembler } from "../../engine/recall/assemble-prompt-context.js";
import { prependContextFromRecall } from "./join-recall.js";

export function registerRecallHook(ctx) {
  const recall = createPromptContextAssembler(ctx);
  ctx.api.on("before_prompt_build", async (event, hookCtx) => prependContextFromRecall(await recall(event, hookCtx)), {
    timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000,
  });
}
```

`adapter/openclaw/register-maintenance-hook.js`:

```js
import { createMinimalMaintenance } from "../../engine/recall/minimal-maintenance.js";
import { prependContextFromRecall } from "./join-recall.js";

export function registerMaintenanceHook(ctx) {
  const maintain = createMinimalMaintenance(ctx);
  ctx.api.on("before_prompt_build", async (event, hookCtx) => prependContextFromRecall(await maintain(event, hookCtx)));
}
```

Keep each file's docblock; update "Registers" to say the handler joins the engine's blocks through `join-recall.js`.

- [ ] **Step 8: Update the two engine unit tests to the new return shape**

`tests/engine-assemble-prompt-context.test.js:31-39` pins the block literals. Replace that `it(...)` with:

```js
  it("keeps the six named blocks and the 17000-char default in one place", () => {
    const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
    for (const [name, droppable] of [["neo", true], ["start", true], ["memories", true], ["time", false], ["temporal", false], ["reminder", false]]) {
      assert.match(source, new RegExp(`contextBlock\\("${name}", [^\\n]+, ${droppable}\\)`), `block ${name} must keep droppable=${droppable}`);
    }
    assert.match(source, /capChars: cfg\.recall\?\.globalInjectMaxChars \?\? 17_000/);
  });
```

and at `:51` change `assert.equal(await handler(…), undefined);` to

```js
    const result = await handler({ prompt: "x" }, { workspaceDir: "/tmp/ws", agentId: "a" });
    assert.equal(result.blocks.length, 0);
```

`tests/engine-minimal-maintenance.test.js` — at `:37`, `:42` and `:65` change each `assert.equal(await handler(…), undefined);` to `assert.equal((await handler(…)).blocks.length, 0);` with the same arguments, and rename the two `it` titles from "returns undefined when…" to "returns no blocks when…".

- [ ] **Step 9: Register the new files**

In `tests/helpers/runtime-sources.js` add `recallResult: "engine/recall/recall-result.js",` to `ENGINE_PATHS` and `joinRecall: "adapter/openclaw/join-recall.js",` to `ADAPTER_PATHS` (keep alphabetical order within each object). In `scripts/lib/deploy-integrity.mjs` add `"adapter/openclaw/join-recall.js",` after `"adapter/openclaw/register-cron.js",` and `"engine/recall/recall-result.js",` after `"engine/recall/minimal-maintenance.js",`.

- [ ] **Step 10: Verify — golden first**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check engine/recall/assemble-prompt-context.js && /home/claude/.node24/bin/node --check engine/recall/minimal-maintenance.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-recall-result.test.js tests/engine-assemble-prompt-context.test.js tests/engine-minimal-maintenance.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: golden `pass 9 / fail 0` (7 scenarios + determinism + count); the three unit files green; lint clean; suite `fail 0`, `skipped ≤ 3`. A golden diff in `recall-maintenance-only` is a Step 6 slip; in any other scenario a Step 5 slip.

- [ ] **Step 11: Commit**

```bash
cd "$PLUR1BUS"
git add engine/recall adapter/openclaw tests/engine-recall-result.test.js tests/engine-assemble-prompt-context.test.js tests/engine-minimal-maintenance.test.js tests/helpers/runtime-sources.js scripts/lib/deploy-integrity.mjs
git commit -m "refactor(recall): return RecallResult blocks; the OpenClaw adapter joins and caps

PR-04 part 1 (spec 3.2). Both before_prompt_build engine handlers return a
RecallResult; adapter/openclaw/join-recall.js applies applyGlobalInjectBudget.
Uncapped exits carry capChars=Infinity, which the budget treats as a plain
join, so every exit's string is byte-identical (golden 7/7)."
```

---

### Task 2 (PR-04b): L3 — every clip and drop is a `Deferral` and a host event

Spec §3.2 bullet 2: no silent truncation on the recall path. Two truncators exist: the inner memories cap (`truncateMemoryContext`, reached via `formatRelevantMemoriesContext`'s `maxTotalChars`, `lib/relevant-memory-context.js:250`, driven by `recall.memoriesMaxChars ?? 12_000` at `engine/recall/assemble-prompt-context.js:926`) and the global budget (`applyGlobalInjectBudget`). The engine computes the global budget's deferrals itself — with the same planner the host uses — so `RecallResult.deferrals` is exact without the host reporting back.

**Files:**
- Modify: `lib/inject-budget.js:197-229` (add `planGlobalInjectBudget`, make `applyGlobalInjectBudget` delegate)
- Modify: `lib/relevant-memory-context.js:66-75` (option), `:250` (report)
- Create: `engine/events.js`
- Modify: `engine/recall/assemble-prompt-context.js` — the `formatRelevantMemoriesContext(` call (`:922-935`) and the main return from Task 1
- Modify: `lib/host-services.js:79-112` (`events` option)
- Modify: `index.js` — `register()`'s dependency destructuring (`:260-266`), validation (`:267-284`) and `createHostServices(api)` (`:4307`)
- Modify: `tests/helpers/golden-prefix-driver.js` (a `hostEvents` option)
- Create: `tests/engine-recall-deferrals.test.js`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs` (register `engine/events.js`)

**Interfaces:**
- Consumes: Task 1's `recallResult`, `contextBlock`.
- Produces:
  - `planGlobalInjectBudget({ blocks, maxChars }) -> { text: string, deferrals: Deferral[] }` where `Deferral = { block, kind: "clipped"|"dropped", from, to, reason: "global-cap" }`
  - `applyGlobalInjectBudget(input) -> string` (unchanged signature; now `planGlobalInjectBudget(input).text`)
  - `formatRelevantMemoriesContext(memories, { …, onTruncate?: ({ from, to }) => void })`
  - `emitEngineEvent(host, name: string, payload: object) -> void`
  - Host events emitted: `recall.block-clipped`, `recall.block-dropped` with payload `{ agentId, block, from, to, reason }`
  - `createHostServices(api, { …, events? })` — `events` must be `{ emit(name, payload) }`
  - `plugin.register(api, { …, hostEvents? })` — test-injection dependency, validated like `commandRuntimeHooks`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-recall-deferrals.test.js`:

```js
/**
 * tests/engine-recall-deferrals.test.js — PR-04b (L3).
 *
 * The planner must report exactly the clips and drops the joiner performs,
 * and nothing it does not perform — including the over-cap case where no
 * block is droppable (Review Focus 5).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyGlobalInjectBudget, planGlobalInjectBudget } from "../lib/inject-budget.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import { emitEngineEvent } from "../engine/events.js";
import { createStubHost } from "../lib/host-services.js";
import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const record = (id, body) => `<memory-record id="${id}">${body}</memory-record>`;

describe("planGlobalInjectBudget", () => {
  it("returns the same text as applyGlobalInjectBudget", () => {
    const blocks = [
      { name: "neo", text: "N".repeat(30), droppable: true },
      { name: "memories", text: `<relevant-memories>\n${record("a", "x".repeat(40))}\n${record("b", "y".repeat(40))}\n</relevant-memories>`, droppable: true },
      { name: "time", text: "T".repeat(20), droppable: false },
    ];
    for (const maxChars of [17_000, 150, 90, 40, 10]) {
      assert.equal(planGlobalInjectBudget({ blocks, maxChars }).text, applyGlobalInjectBudget({ blocks, maxChars }), `maxChars=${maxChars}`);
    }
  });

  it("records a drop for a droppable block with no record boundary", () => {
    const { deferrals } = planGlobalInjectBudget({
      blocks: [{ name: "start", text: "S".repeat(50), droppable: true }, { name: "time", text: "T".repeat(10), droppable: false }],
      maxChars: 20,
    });
    assert.deepEqual(deferrals, [{ block: "start", kind: "dropped", from: 50, to: 0, reason: "global-cap" }]);
  });

  it("records a clip at a record boundary", () => {
    const memories = `<relevant-memories>\n${record("a", "x".repeat(40))}\n${record("b", "y".repeat(40))}\n</relevant-memories>`;
    // 198 chars; at 170 the first record (ends at 98) plus the marker (34) and
    // the closing wrapper (21) fits, the second does not.
    const { text, deferrals } = planGlobalInjectBudget({ blocks: [{ name: "memories", text: memories, droppable: true }], maxChars: 170 });
    assert.equal(deferrals.length, 1);
    assert.equal(deferrals[0].kind, "clipped");
    assert.equal(deferrals[0].from, memories.length);
    assert.equal(deferrals[0].to, text.length);
  });

  it("records nothing when no block is droppable and the cap is exceeded (Review Focus 5)", () => {
    const blocks = ["time", "temporal", "reminder"].map((name) => ({ name, text: name[0].repeat(50), droppable: false }));
    const plan = planGlobalInjectBudget({ blocks, maxChars: 20 });
    assert.equal(plan.text, blocks.map((b) => b.text).join("\n\n"));
    assert.deepEqual(plan.deferrals, []);
  });
});

describe("formatRelevantMemoriesContext onTruncate", () => {
  it("reports the inner cap with from/to lengths, and stays silent under the cap", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, category: "fact", source: "memory", display: `memory number ${i} `.repeat(8), memoryStrength: 1 }));
    const reports = [];
    const text = formatRelevantMemoriesContext(items, { maxTotalChars: 800, onTruncate: (r) => reports.push(r) });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].to, text.length);
    assert.ok(reports[0].from > reports[0].to);
    const quiet = [];
    formatRelevantMemoriesContext(items.slice(0, 1), { maxTotalChars: 12_000, onTruncate: (r) => quiet.push(r) });
    assert.deepEqual(quiet, []);
  });
});

describe("emitEngineEvent", () => {
  it("is a no-op without host.events and survives a throwing listener", () => {
    emitEngineEvent(createStubHost(), "recall.block-dropped", {});
    const debug = [];
    emitEngineEvent(createStubHost({ events: { emit() { throw new Error("boom"); } }, logger: { debug: (m) => debug.push(m) } }), "x", {});
    assert.equal(debug.length, 1);
  });
});

describe("recall emits one event per deferral", () => {
  it("recall-truncated emits memories-cap and global-cap deferrals, and its prefix is unchanged", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "recall-truncated");
    const events = [];
    const withEvents = await runScenario(scenario, { hostEvents: { emit: (name, payload) => events.push({ name, payload }) } });
    const without = await runScenario(scenario);
    assert.equal(withEvents, without);
    const reasons = events.filter((e) => e.name.startsWith("recall.block-")).map((e) => `${e.payload.block}:${e.payload.reason}`);
    assert.ok(reasons.includes("memories:memories-cap"), `got ${reasons.join(",")}`);
    assert.ok(reasons.includes("memories:global-cap"), `got ${reasons.join(",")}`);
  });
});
```

If `formatRelevantMemoriesContext` needs more item fields than `id`/`category`/`source`/`display`/`memoryStrength` to render a record, copy an item from an existing `tests/*relevant-memor*.test.js` fixture; the assertion only needs the output to exceed 800 chars. `recall-truncated` fires both caps by construction (`tests/fixtures/golden-prefix/scenarios.js:228-261`: `globalInjectMaxChars` is 11 000 precisely so both cut).

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-recall-deferrals.test.js 2>&1 | tail -8
```

Expected: `SyntaxError … does not provide an export named 'planGlobalInjectBudget'`.

- [ ] **Step 3: Add the planner**

Replace `lib/inject-budget.js:197-229` (the JSDoc and body of `applyGlobalInjectBudget`) with:

```js
/**
 * Plan the aggregate cap: the joined text plus one deferral per block the cap
 * actually clipped or dropped. A deferral is recorded only when a block's text
 * changes, so an over-cap result with nothing droppable left reports none.
 *
 * @param {{blocks: Array<{name: string, text?: string, droppable?: boolean}>, maxChars: number}} input
 * @returns {{text: string, deferrals: Array<{block: string, kind: "clipped"|"dropped", from: number, to: number, reason: "global-cap"}>}}
 */
export function planGlobalInjectBudget({ blocks = [], maxChars } = {}) {
  const parts = (Array.isArray(blocks) ? blocks : [])
    .map((block) => ({
      name: String(block?.name || ""),
      text: String(block?.text || ""),
      droppable: block?.droppable === true,
    }))
    .filter((block) => block.text);
  const join = (items) => items.map((block) => block.text).join("\n\n");
  const deferrals = [];
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0) {
    return { text: join(parts), deferrals };
  }
  let current = [...parts];
  while (join(current).length > cap) {
    const idx = current.map((block, i) => (block.droppable ? i : -1)).filter((i) => i >= 0).pop();
    if (idx == null) break;
    const block = current[idx];
    const overflow = join(current).length - cap;
    const allowedLen = Math.max(0, block.text.length - overflow);
    const trimmed = trimDroppableBlockText(block.text, allowedLen);
    if (!trimmed) {
      deferrals.push({ block: block.name, kind: "dropped", from: block.text.length, to: 0, reason: "global-cap" });
      current.splice(idx, 1);
      continue;
    }
    deferrals.push({ block: block.name, kind: "clipped", from: block.text.length, to: trimmed.length, reason: "global-cap" });
    current[idx] = { ...block, text: trimmed };
  }
  return { text: join(current), deferrals };
}

/**
 * @param {{blocks: Array<{name: string, text?: string, droppable?: boolean}>, maxChars: number}} input
 * @returns {string}
 */
export function applyGlobalInjectBudget(input = {}) {
  return planGlobalInjectBudget(input).text;
}
```

The loop is the old one statement for statement (`lib/inject-budget.js:214-228`); only the two `deferrals.push` lines are new.

- [ ] **Step 4: Report the inner cap**

In `lib/relevant-memory-context.js` add `onTruncate = null,` to the options destructuring of `formatRelevantMemoriesContext` (after `now = Date.now(),` at `:74`), document it in the JSDoc (`onTruncate?: ({from, to}) => void — called once when the maxTotalChars cap shortens the block`), and replace `:250`

```js
  return truncateMemoryContext(output, maxTotalChars);
```
with
```js
  const truncated = truncateMemoryContext(output, maxTotalChars);
  if (truncated !== output && typeof onTruncate === "function") {
    onTruncate({ from: output.length, to: truncated.length });
  }
  return truncated;
```

- [ ] **Step 5: Create `engine/events.js`**

```js
/**
 * engine/events.js
 *
 * The single path engine code uses to tell the host something happened
 * (types/engine.d.ts HostServices.events). Absent events are a no-op; a
 * throwing listener is the host's bug and must never break a turn, so it is
 * logged at debug and swallowed.
 */

/**
 * @param {{events?: {emit?: (name: string, payload: unknown) => void}, logger: {debug: (m: string) => void}}} host HostServices.
 * @param {string} name Event name.
 * @param {object} payload Event payload.
 * @returns {void}
 */
export function emitEngineEvent(host, name, payload) {
  const emit = host?.events?.emit;
  if (typeof emit !== "function") return;
  try {
    emit.call(host.events, name, payload);
  } catch (error) {
    host.logger.debug(`engine event ${name}: listener failed: ${String(error?.message || error)}`);
  }
}
```

- [ ] **Step 6: Wire deferrals into the recall assembler**

In `engine/recall/assemble-prompt-context.js`:

1. Imports: `import { planGlobalInjectBudget } from "../../lib/inject-budget.js";` and `import { emitEngineEvent } from "../events.js";`.
2. Directly above `const memoriesContext = formatRelevantMemoriesContext(promptItems, {` (`:922`) add `const memoryDeferrals = [];`, and add this option inside that call, after `now: nowMs,`:

```js
        onTruncate: ({ from, to }) => {
          memoryDeferrals.push({ block: "memories", kind: "clipped", from, to, reason: "memories-cap" });
        },
```

3. Replace Task 1's main return with:

```js
      const blocks = [
        contextBlock("neo", neoContext, true),
        contextBlock("start", startNoticeContext, true),
        contextBlock("memories", fullMemoriesContext + nudge + conflictNudge + skillProposalNudge, true),
        contextBlock("time", timeContext, false),
        contextBlock("temporal", temporalContinuityContext, false),
        contextBlock("reminder", reminderNudge, false),
      ];
      const capChars = cfg.recall?.globalInjectMaxChars ?? 17_000;
      const deferrals = [...memoryDeferrals, ...planGlobalInjectBudget({ blocks, maxChars: capChars }).deferrals];
      for (const deferral of deferrals) {
        emitEngineEvent(host, `recall.block-${deferral.kind}`, { agentId, ...deferral });
      }
      return recallResult({ blocks, capChars, deferrals });
```

The planner runs on the block texts only to compute deferrals; the blocks returned are untouched and the host's join (Task 1) produces the identical string.

- [ ] **Step 7: Plumb `host.events` through the OpenClaw host**

`lib/host-services.js` — add `events = undefined,` to `createHostServices`'s options (after `platform = platformCapabilities,` at `:82`) and, inside the `host` literal after `platform,`, `...(events && typeof events.emit === "function" ? { events } : {}),`. Document the option in the JSDoc (`@param … events Host event sink; test and harness seam`).

`index.js` — in `register()` add `hostEvents,` to the destructuring at `:260-266`, and after the `commandRuntimeHooks` check at `:270-272` add:

```js
    if (hostEvents !== undefined && (hostEvents === null || typeof hostEvents.emit !== "function")) {
      throw new TypeError("hostEvents must expose emit(name, payload) when provided");
    }
```

and change `:4307` `const host = createHostServices(api);` to `const host = createHostServices(api, { events: hostEvents });`.

- [ ] **Step 8: Give the golden driver a `hostEvents` option**

In `tests/helpers/golden-prefix-driver.js`, extend `runScenario`'s options destructuring (`:193`) with `hostEvents = null`, document it in the JSDoc (`hostEvents: forwarded to plugin.register as the hostEvents dependency`), and change `:241` to:

```js
    plugin.register(api, { importRouting: async () => routingCapability, ...(hostEvents ? { hostEvents } : {}) });
```

- [ ] **Step 9: Run the new test, the golden corpus, lint and the suite**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-recall-deferrals.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js tests/inject-budget*.test.js tests/relevant-memory-context*.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `tests 9, pass 9` in the new file; golden 9/9; lint clean (register `engine/events.js` in `runtime-sources.js` as `events` and in `DEPLOY_FILES` first); suite green. If the glob `tests/inject-budget*.test.js` matches nothing, drop it — `ls tests | grep -i budget` shows what exists.

- [ ] **Step 10: Commit**

```bash
cd "$PLUR1BUS"
git add lib/inject-budget.js lib/relevant-memory-context.js lib/host-services.js engine index.js tests/engine-recall-deferrals.test.js tests/helpers scripts/lib/deploy-integrity.mjs
git commit -m "feat(recall): L3 deferrals — every clip and drop is reported

PR-04 part 2 (spec 3.2). planGlobalInjectBudget returns the joined text and
one Deferral per block it clipped or dropped; the inner memories cap reports
through onTruncate. The engine emits recall.block-clipped/-dropped via
host.events and returns RecallResult.deferrals. Additive: golden 7/7."
```

---

### Task 3 (PR-05): the recall signal is mandatory and reaches the embedder, the reranker and LanceDB

Spec §3.2 bullet 3 and success criterion 3. Today `lib/setup/memory-host-runtime.js:170-172` accepts the host's signal and drops it ("The recall pipeline has no cancellation input"), and `lib/recall-pipeline.js` has no `signal` parameter at all (`grep -n signal lib/recall-pipeline.js` is empty at `9fd7bab4`). The scheduler already owns an internal `AbortController` per recall job (`lib/runtime-scheduler.js:415-426`) and passes its signal to the job callback; this task links the **caller's** signal into it, threads the job signal down to every await that can block, and makes an aborted recall resolve with the blocks already complete.

**Files:**
- Modify: `lib/abort.js` (add `raceAbort`)
- Modify: `lib/runtime-scheduler.js:380-478` (`runRecall`: `meta.signal`)
- Modify: `engine/recall/assemble-prompt-context.js` — handler signature (`:143`), a completed-blocks record, `_autoRecallBaseParams` (`:426-477`), the outer exits
- Modify: `index.js:700-705` (`runMergedNamespaceRecall`'s `requestEmbeddings`)
- Modify: `lib/recall-pipeline.js:205-231` (`runVectorSearchWithValidTimeFallback`), `:1446-1533` (`runRecallPipeline` params, `embeddingContext`, post-embed check), the two vector-search call sites (`:1622-1629`, `:1674-1681`)
- Modify: `lib/providers/embedding-local-transformers.js:657-672`, `lib/providers/embedding-openai.js:161-215`, `lib/providers/scoped-embedding-ipc.js:675-689`
- Modify: `lib/setup/memory-host-runtime.js:170-171` (comment only — the call already passes the signal)
- Modify: `adapter/openclaw/register-recall-hook.js` (pass `AbortSignal.timeout(recallTimeoutMs)`)
- Modify: `tests/helpers/golden-prefix-driver.js`, `tests/fixtures/golden-prefix/scenarios.js`, `tools/capture-golden-prefix.mjs`
- Create: `tests/fixtures/golden-prefix/expected/recall-aborted.txt` (written by the capture tool, once)
- Create: `tests/engine-recall-abort.test.js`, `tests/runtime-scheduler-caller-signal.test.js`

**Interfaces:**
- Consumes: Task 1's `recallResult`, `contextBlock`, `ABORTED`; Task 2's `emitEngineEvent`.
- Produces:
  - `raceAbort(promise, signal, message?) -> Promise` — rejects with the abort error as soon as `signal` aborts; `signal` may be null
  - `runtimeScheduler.runRecall({ …, signal? }, fn)` — resolves `{ ok: false, aborted: true, reason: "aborted" }` immediately when `signal` is already aborted; on a later abort resolves like a timeout with `aborted: true` added
  - `createPromptContextAssembler(ctx)` returns `async (event, hookCtx, { signal }) => RecallResult`; a missing or non-`AbortSignal` `signal` yields `degraded: { reason: "invalid-query", capability: "recall", detail: "signal is required" }`
  - Host event `recall.degraded` with `{ agentId, degraded }` whenever the result is degraded
  - `runRecallPipeline({ …, signal? })`; embedding providers honour `options.signal`

- [ ] **Step 1: Write the failing scheduler test**

Create `tests/runtime-scheduler-caller-signal.test.js`:

```js
/**
 * tests/runtime-scheduler-caller-signal.test.js — PR-05.
 *
 * The caller's AbortSignal joins the scheduler's own controller: an abort
 * cancels the job's signal and resolves runRecall promptly, and an already
 * aborted signal never takes a queue slot.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe("runRecall caller signal", () => {
  it("resolves within 50 ms of an abort at 100 ms and aborts the job signal", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: { recallTimeoutMs: 10_000 }, logger: quietLogger });
    let jobSignal = null;
    const started = Date.now();
    const result = await scheduler.runRecall({ cacheKey: "", signal: AbortSignal.timeout(100) }, (signal) => {
      jobSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(jobSignal.aborted, true);
    assert.ok(elapsed < 150, `resolved after ${elapsed} ms`);
  });

  it("never enqueues when the signal is already aborted", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    const before = scheduler.status().recallQueued;
    let called = false;
    const result = await scheduler.runRecall({ signal: AbortSignal.abort() }, async () => { called = true; });
    assert.deepEqual({ ok: result.ok, aborted: result.aborted, reason: result.reason }, { ok: false, aborted: true, reason: "aborted" });
    assert.equal(called, false);
    assert.equal(scheduler.status().recallQueued, before);
  });

  it("behaves exactly as before when no signal is given", async () => {
    const scheduler = createBackgroundMemoryScheduler({ config: {}, logger: quietLogger });
    const result = await scheduler.runRecall({ cacheKey: "" }, async () => "value");
    assert.deepEqual(result, { ok: true, value: "value", background: false });
  });
});
```

`status()` is part of the scheduler's return object (`lib/runtime-scheduler.js:649`); check `grep -n "function status" lib/runtime-scheduler.js` that it exposes `recallQueued` (the counter incremented at `:413`) and adjust the property path if it nests it.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/runtime-scheduler-caller-signal.test.js 2>&1 | tail -8
```

Expected: the first test times out against the 10 000 ms recall timeout or fails `result.aborted === true`; the second fails because the callback runs.

- [ ] **Step 3: Add `raceAbort` to `lib/abort.js`**

Append:

```js
/**
 * Race a promise against a cancellation signal. The underlying work is not
 * stopped (a promise cannot be), but the caller stops waiting the moment the
 * signal aborts, and a late rejection of the losing promise is observed so it
 * never surfaces as an unhandled rejection.
 *
 * @template T
 * @param {Promise<T>|T} promise
 * @param {AbortSignal|null|undefined} signal
 * @param {string} [message]
 * @returns {Promise<T>}
 */
export function raceAbort(promise, signal, message = "operation aborted") {
  const settlement = Promise.resolve(promise);
  if (!signal) return settlement;
  if (signal.aborted) {
    settlement.catch(() => {});
    return new Promise((_, reject) => {
      try { throwIfAborted(signal, message); } catch (error) { reject(error); }
    });
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      settlement.catch(() => {});
      try { throwIfAborted(signal, message); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    settlement.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
```

- [ ] **Step 4: Link the caller's signal in `runRecall`**

In `lib/runtime-scheduler.js` `runRecall` (`:380`):

(a) directly after `const pressure = currentPressure();` (`:396`) insert:

```js
    const callerSignal = meta?.signal ?? null;
    if (callerSignal?.aborted) {
      return Promise.resolve({ ok: false, aborted: true, reason: "aborted", background });
    }
```

(b) the job literal's `signal: controller.signal,` (`:426`) becomes

```js
        signal: callerSignal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([controller.signal, callerSignal])
          : controller.signal,
```

(c) replace the final `return Promise.race([queued, timeout.promise]).then((result) => {` block (`:470-478`) with:

```js
    let removeAbortListener = null;
    const aborted = callerSignal
      ? new Promise((resolve) => {
          const onAbort = () => {
            try { controller.abort(callerSignal.reason); } catch (_) {}
            if (job && !job.startedAt) {
              const idx = recallQueue.queue.indexOf(job);
              if (idx >= 0) recallQueue.queue.splice(idx, 1);
            }
            resolve({ timedOut: true, aborted: true });
          };
          callerSignal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => callerSignal.removeEventListener("abort", onAbort);
        })
      : null;
    return Promise.race(aborted ? [queued, timeout.promise, aborted] : [queued, timeout.promise]).then((result) => {
      timeout.clear();
      removeAbortListener?.();
      if (result?.timedOut) {
        const flag = result.aborted === true ? { aborted: true } : {};
        const value = cachedRecall(cacheKey);
        return value !== null
          ? { ok: true, value, timedOut: true, fromCache: true, background, ...flag }
          : { ok: false, timedOut: true, background, ...flag };
      }
      return result;
    });
```

With no `signal` the race has the same two contestants and the same result objects as before (`...flag` is empty) — the third test in Step 1 pins that.

- [ ] **Step 5: Run the scheduler test — it passes**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/runtime-scheduler-caller-signal.test.js tests/runtime-scheduler-*.test.js 2>&1 | tail -8
```

Expected: all green, including the four existing `runtime-scheduler-*` files.

- [ ] **Step 6: Thread the job signal through the pipeline**

`index.js:700-705` — `runMergedNamespaceRecall`'s request embedder:

```js
  const requestEmbeddings = Object.freeze({
    embedQuery: (text) => typeof providerEmbeddings.embedQuery === "function"
      ? providerEmbeddings.embedQuery(text, { agentId: baseParams.agentId })
      : providerEmbeddings.embed(text, { agentId: baseParams.agentId }),
    embed: (text) => providerEmbeddings.embed(text, { agentId: baseParams.agentId }),
  });
```
becomes
```js
  const embedOptions = baseParams.signal
    ? { agentId: baseParams.agentId, signal: baseParams.signal }
    : { agentId: baseParams.agentId };
  const requestEmbeddings = Object.freeze({
    embedQuery: (text) => typeof providerEmbeddings.embedQuery === "function"
      ? providerEmbeddings.embedQuery(text, embedOptions)
      : providerEmbeddings.embed(text, embedOptions),
    embed: (text) => providerEmbeddings.embed(text, embedOptions),
  });
```

`runMergedNamespaceRecall` already spreads `...baseParams` into each `runRecallPipeline` call (`index.js:726-737`), so `signal` reaches the pipeline once the pipeline accepts it.

`lib/recall-pipeline.js`:

1. `import { raceAbort, throwIfAborted } from "./abort.js";` (add to the imports near `:45`).
2. `runVectorSearchWithValidTimeFallback` (`:205`): add `signal = null,` to its destructured parameters and wrap both `toArray()` calls: `query.limit(fetchLimit).toArray()` → `raceAbort(query.limit(fetchLimit).toArray(), signal, "recall aborted")`, and the legacy fallback's `dbTable.vectorSearch(vector).limit(fetchLimit).toArray()` likewise.
3. `runRecallPipeline` (`:1446`): add `signal = null,` after `validAt = null,` in the destructured parameters, and document it (`@param {AbortSignal|null} [options.signal=null] Caller cancellation (PR-05)`).
4. `:1509` `const embeddingContext = Object.freeze({ agentId: requestAgentId });` → `const embeddingContext = Object.freeze(signal ? { agentId: requestAgentId, signal } : { agentId: requestAgentId });`
5. After `phaseTimer?.end("embedding");` (`:1533`) insert `throwIfAborted(signal, "recall aborted");`.
6. Both call sites of `runVectorSearchWithValidTimeFallback` (the primary at `:1622-1629`, the refined at `:1674-1681`) gain `signal,` in their argument object.

The `ETIMEOUT` branch at `:1631` only catches `TimeoutError`; an `AbortError` propagates, the namespace settle rejects, `combineNamespaceRecallFailures` rethrows, and the assembler's `catch` (`engine/recall/assemble-prompt-context.js:1198`) rethrows via its `throwIfAborted(signal, …)` — the job rejects and the scheduler's abort result wins the race.

- [ ] **Step 7: Make the three embedding providers honour `options.signal`**

`lib/providers/embedding-local-transformers.js` — `_embedBatchForPurpose` (`:657-672`): add `import { raceAbort, throwIfAborted } from "../abort.js";`, then after `const finish = this._beginOperation();` and inside the `try`, before the license assertion, insert `throwIfAborted(options.signal, "embedding aborted");`, and wrap the two computing returns:

```js
      if (!this._cache) return await raceAbort(this._computeBatch(input, purpose), options.signal, "embedding aborted");
      return await raceAbort(this._cache.getMany(input, {
        provider: this.id,
        model: `${this.model}:${purpose}`,
        dimensions: this.dim,
        agentId: options.agentId,
      }, (missing) => this._computeBatch(missing, purpose)), options.signal, "embedding aborted");
```

`lib/providers/embedding-openai.js` — `embedBatch(texts, retries = 3, options = {})` (`:198`): same import; first statement `throwIfAborted(options.signal, "embedding aborted");`; pass the signal into `_computeBatch(input, retries, options.signal)` in both call sites; `_computeBatch(texts, retries = 3, signal = null)` (`:161`) passes `signal ? { signal } : undefined` as the second argument of every `client.embeddings.create(...)` call (the OpenAI SDK's request-options argument), and in the retry `catch` adds `if (signal?.aborted) throw err;` before the backoff, whose delay becomes `await raceAbort(new Promise((r) => setTimeout(r, delay)), signal, "embedding aborted");`.

`lib/providers/scoped-embedding-ipc.js` — the `ReloadSafeIpcScopedEmbeddingProvider` public methods (`:675-689`) gain an `options = {}` parameter and wrap their dispatch: e.g.

```js
  async embedQuery(text, options = {}) {
    return await raceAbort(this._dispatch("embedQuery", [text]), options.signal, "embedding aborted");
  }
```

for `embedBatch(texts, options)`, `embedQuery`, `embedPassage`, and `embed(text, options) { return await this.embedPassage(text, options); }`. Import `raceAbort` from `../abort.js`.

`lib/setup/memory-host-runtime.js:170-171` — replace the two-line comment with `// The host's signal cancels the recall pipeline's embedder and LanceDB waits (PR-05).`. The call on `:172` is unchanged; `index.js`'s `recall:` closure already spreads `...(signal ? { signal } : {})` into `runMergedNamespaceRecall`'s params (`index.js:4371`), which now reach the pipeline.

- [ ] **Step 8: Write the failing engine-level test**

Create `tests/engine-recall-abort.test.js`:

```js
/**
 * tests/engine-recall-abort.test.js — PR-05, spec success criterion 3.
 *
 * Drives the real before_prompt_build path through the golden driver with an
 * embedder that only settles when its signal aborts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const aborted = () => SCENARIOS.find((s) => s.name === "recall-aborted");

describe("recall abort", () => {
  it("abort at 100 ms cancels the embedder and resolves within 50 ms with degraded.reason=aborted", async () => {
    const scenario = { ...aborted(), config: { ...aborted().config, runtime: { recallTimeoutMs: 100 } } };
    const events = [];
    const embedder = { calls: 0, abortedAt: null };
    let recallMs = null;
    const prefix = await runScenario(scenario, {
      hostEvents: { emit: (name, payload) => events.push({ name, payload }) },
      embedderProbe: embedder,
      onTiming: (t) => { recallMs = t.recallMs; },
    });
    assert.ok(embedder.calls >= 1, "the embedder was reached");
    assert.ok(embedder.abortedAt !== null, "the embedder saw its signal abort");
    assert.ok(recallMs < 150, `recall took ${recallMs} ms`);
    const degraded = events.find((e) => e.name === "recall.degraded");
    assert.ok(degraded, "recall.degraded emitted");
    assert.ok(["aborted", "timeout"].includes(degraded.payload.degraded.reason));
    assert.match(prefix, /^<plur1bus-start-notice>\n/);
  });

  it("an already-aborted signal returns zero blocks and consumes nothing (Review Focus 1)", async () => {
    const { createPromptContextAssembler } = await import("../engine/recall/assemble-prompt-context.js");
    const touched = [];
    const handler = createPromptContextAssembler({
      automaticWorkspacePolicyDecision: () => { touched.push("policy"); return { allowed: true }; },
      runtimeScheduler: { config: { recallTimeoutMs: 1_000 }, runRecall: () => { touched.push("scheduler"); } },
      host: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    });
    const result = await handler({ prompt: "hello there" }, { agentId: "a" }, { signal: AbortSignal.abort() });
    assert.deepEqual(result.degraded, { reason: "aborted", capability: "recall" });
    assert.equal(result.blocks.length, 0);
    assert.deepEqual(touched, []);
  });

  it("a missing signal is an invalid query, not a throw", async () => {
    const { createPromptContextAssembler } = await import("../engine/recall/assemble-prompt-context.js");
    const handler = createPromptContextAssembler({ host: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
    const result = await handler({ prompt: "hello there" }, { agentId: "a" });
    assert.equal(result.degraded.reason, "invalid-query");
  });
});
```

The prefix assertion holds for either race winner: the adapter's `AbortSignal.timeout(100)` and the scheduler's own 100 ms timer fire together, and both paths return the completed start-notice block (Step 10).

- [ ] **Step 9: Add the `recall-aborted` scenario and the driver hooks it needs**

Append to `SCENARIOS` in `tests/fixtures/golden-prefix/scenarios.js`:

```js
  {
    // Signal fires mid-recall: the embedder only settles when its signal
    // aborts, so the recall is cut after the start notice was consumed and
    // before any memory was embedded. Spec 3.2: the aborted recall returns
    // the blocks already complete — here exactly the start notice.
    name: "recall-aborted",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    startNotice: "PLUR1BUS is set up. This notice is shown once.",
    hangEmbedder: true,
    topics: {
      "what happened while I was away": "away",
      "The user travelled to Lisbon in December.": "away",
      "Lisbon trip": "away",
    },
    memories: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        text: "The user travelled to Lisbon in December.",
        summary: "Lisbon trip",
        category: "fact",
        ageDays: 20,
      },
    ],
    config: { runtime: { recallTimeoutMs: 300 } },
    event: eventFor("what happened while I was away", "golden-session-8", "golden-run-8"),
    ctx: ctxFor("golden-session-8", "golden-run-8"),
  },
```

and change the file header's "Seven synthetic recall scenarios" (`:4`) to "Eight".

In `tests/helpers/golden-prefix-driver.js`:

1. `import { writePlur1busStartNotice } from "../../lib/setup/feature-profiles.js";`
2. `stubEmbedder(topicOf)` (`:74`) becomes `stubEmbedder(topicOf, { hang = false, probe = null } = {})` and its `_embedBatchForPurpose` replacement becomes:

```js
  proto._embedBatchForPurpose = async (texts, _purpose, options = {}) => {
    if (probe) probe.calls += 1;
    if (hang) {
      return await new Promise((_, reject) => {
        const signal = options?.signal;
        if (!signal) return; // no signal: hangs until the scenario's timeout; the recall still resolves via the scheduler
        signal.addEventListener("abort", () => {
          if (probe) probe.abortedAt = performance.now();
          reject(signal.reason);
        }, { once: true });
      });
    }
    return (Array.isArray(texts) ? texts : [texts]).map((text) => topicVector(topicOf(text)));
  };
```

3. `runScenario`'s options gain `embedderProbe = null`; the install line (`:215`) becomes `restoreEmbedder = stubEmbedder(topicOf, { hang: scenario.hangEmbedder === true, probe: embedderProbe });`.
4. After `mkdirSync(join(workspaceDir, "memory"), { recursive: true });` (`:216`) add:

```js
    if (scenario.startNotice) writePlur1busStartNotice(stateDir, { text: scenario.startNotice });
```

`OPENCLAW_HOME` is already `stateDir` at this point (`:213`), so `host.stateDir` resolves to the same directory the notice was written into.

In `tools/capture-golden-prefix.mjs` add an `--only a,b` filter after `const force = …` (`:20`):

```js
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;
```

and at the top of the `for (const scenario of SCENARIOS)` loop add `if (only && !only.has(scenario.name)) continue;`. Update the usage line in the header to `node tools/capture-golden-prefix.mjs [--force] [--only=name[,name]]`.

- [ ] **Step 10: Make the assembler require the signal and keep completed blocks**

In `engine/recall/assemble-prompt-context.js`:

1. Imports: `ABORTED` from `./recall-result.js` (extend the Task 1 import).
2. `:143` `return async function assemblePromptContext(event, hookCtx) {` becomes `return async function assemblePromptContext(event, hookCtx, opts = {}) {`, and the first statements of the body become:

```js
    const callerSignal = opts?.signal;
    if (!(callerSignal instanceof AbortSignal)) {
      return recallResult({ degraded: { reason: "invalid-query", capability: "recall", detail: "signal is required" } });
    }
    if (callerSignal.aborted) {
      emitEngineEvent(host, "recall.degraded", { agentId: hookCtx?.agentId || "default", degraded: ABORTED });
      return recallResult({ degraded: ABORTED });
    }
    // Blocks finished before the scheduled work completes. An aborted or
    // timed-out recall returns these (spec 3.2) instead of nothing.
    const completed = { neo: "", start: "" };
```

(the existing `const background = …` line follows unchanged).

3. `runtimeScheduler.runRecall({` (`:155`) gains `signal: callerSignal,` in its meta object.
4. After the neo section closes and before the prelude log block — i.e. directly above `{\n      const preludeMs = Date.now() - recallPrelude.startedAt;` (`:258-259`) — add `completed.neo = neoContext;`. After `const startNoticeContext = pendingStartNotice ? … : "";` (`:284-286`) add `completed.start = startNoticeContext;`.
5. `_autoRecallBaseParams` (`:426`) gains `signal,` (the job signal the scheduler passes to the callback at `:160`).
6. The outer exits from Task 1, Step 5(f), become:

```js
    if (replyOutcomeEnabled) replyOutcomeDynamics.kick(agentIdForCache);
    const partial = () => [contextBlock("neo", completed.neo, true), contextBlock("start", completed.start, true)]
      .filter((block) => block.text);
    if (scheduledRecall.ok) {
      if (scheduledRecall.timedOut && scheduledRecall.fromCache) {
        host.logger.warn(`memory-lancedb-namespaced: using cached recall after timeout for agent=${agentIdForCache}${background ? " (background)" : ""}`);
      }
      return scheduledRecall.value ?? recallResult();
    }
    if (scheduledRecall.aborted || scheduledRecall.timedOut) {
      const degraded = scheduledRecall.aborted ? ABORTED : { reason: "timeout", capability: "recall" };
      if (scheduledRecall.timedOut && !scheduledRecall.aborted) {
        host.logger.warn(`memory-lancedb-namespaced: recall timed out without cache for agent=${agentIdForCache}${background ? " (background)" : ""}`);
      }
      emitEngineEvent(host, "recall.degraded", { agentId: agentIdForCache, degraded });
      return recallResult({ blocks: partial(), degraded });
    }
    if (scheduledRecall.error) {
      host.logger.warn(`memory-lancedb-namespaced: recall scheduler failed for agent=${agentIdForCache}: ${String(scheduledRecall.error)}`);
    }
    return recallResult();
```

The `replyOutcomeEnabled` line already sits immediately above `if (scheduledRecall.ok)` (`:1220`); keep a single copy of it.

`adapter/openclaw/register-recall-hook.js` — the handler becomes:

```js
  ctx.api.on("before_prompt_build", async (event, hookCtx) => prependContextFromRecall(
    await recall(event, hookCtx, { signal: AbortSignal.timeout(ctx.runtimeScheduler.config.recallTimeoutMs) }),
  ), { timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000 });
```

The maintenance branch does no recall and takes no signal.

- [ ] **Step 11: Capture the new oracle once, then run everything**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/capture-golden-prefix.mjs --only=recall-aborted
cd "$PLUR1BUS" && cat tests/fixtures/golden-prefix/expected/recall-aborted.txt; echo
```

Expected: `wrote …/recall-aborted.txt`, and the file is exactly

```
<plur1bus-start-notice>
PLUR1BUS is set up. This notice is shown once.
</plur1bus-start-notice>
```

If it is anything else (in particular a memory record), the embedder was not hung or the notice was not written — fix the driver, delete the file, re-capture. Then:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-recall-abort.test.js tests/runtime-scheduler-caller-signal.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && git diff --stat 91dfce25 -- tests/fixtures/golden-prefix/expected/
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: both new files green; golden `pass 10` (8 scenarios + determinism + count); the diff stat lists **only** `recall-aborted.txt` as added; lint clean; suite green.

- [ ] **Step 12: Commit**

```bash
cd "$PLUR1BUS"
git add lib/abort.js lib/runtime-scheduler.js lib/recall-pipeline.js lib/providers lib/setup/memory-host-runtime.js index.js engine adapter tests tools/capture-golden-prefix.mjs
git commit -m "feat(recall): mandatory AbortSignal reaches the embedder and LanceDB

PR-05 (spec 3.2). runRecall links the caller's signal into its controller;
runRecallPipeline, the vector search and all three embedding providers honour
it. An aborted or timed-out recall resolves with the blocks already complete
and degraded {reason, capability: \"recall\"} (spec 3.2 behaviour change on the
timeout path). The adapter passes AbortSignal.timeout(recallTimeoutMs).
Golden: new write-once scenario recall-aborted; the seven are unchanged."
```

---

### Task 4 (PR-09): one timeout owner for rerank

Spec §3.2 bullet 4. Today two timers race for one rerank: the pipeline's `Promise.race` with `setTimeout(…, rerankerTimeoutMs)` (`lib/recall-pipeline.js:2025-2034`) and Cohere's own `AbortController` timer at `this.timeoutMs` (`lib/providers/reranker-cohere.js:49-50`); both default to 5 000 ms from the same `rerankerCfg.timeoutMs`. The local reranker has no timer at all (`lib/providers/reranker-local-transformers.js:298`). After this task the pipeline builds one signal, `AbortSignal.any([callerSignal, AbortSignal.timeout(rerankerTimeoutMs)])`, and every provider's request is driven by it; a provider called without a signal (its unit tests, `tests/reranker-cohere-timeout.test.js`) creates its own single timer.

**Files:**
- Create: `lib/providers/rerank-signal.js`
- Modify: `lib/recall-pipeline.js:2017-2046` (the rerank block)
- Modify: `lib/providers/reranker-cohere.js:46-76`, `lib/providers/reranker-chained.js:101-119`, `lib/providers/reranker-local-transformers.js:298-322`
- Modify: `scripts/lib/deploy-integrity.mjs` (register `lib/providers/rerank-signal.js`)
- Create: `tests/rerank-single-timeout.test.js`

**Interfaces:**
- Consumes: Task 3's `signal` parameter of `runRecallPipeline`, `raceAbort`.
- Produces:
  - `rerankSignal(callerSignal: AbortSignal|null, timeoutMs: number) -> AbortSignal|undefined` — the only place a rerank timer is created
  - `provider.rerank(query, documents, topN, { signal }?)` for all three providers
  - The pipeline's rerank rejection message on timeout stays `reranker timeout`, so the fallback warning (`lib/recall-pipeline.js:2044`) reads as before

- [ ] **Step 1: Write the failing test**

Create `tests/rerank-single-timeout.test.js`:

```js
/**
 * tests/rerank-single-timeout.test.js — PR-09.
 *
 * Exactly one timer per rerank, and it is the one that aborts the HTTP request.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { CohereRerankerProvider } from "../lib/providers/reranker-cohere.js";

const rows = Array.from({ length: 4 }, (_, i) => ({
  id: `r${i}`, text: `memory ${i}`, summary: `memory ${i}`, _distance: i * 0.01,
  importance: 0.5, scope: "agent-private", agentId: "agent-a", storedBy: "agent-a",
}));
const dbTable = { vectorSearch: () => ({ limit: () => ({ toArray: async () => rows }) }) };
const embeddings = { embedQuery: async () => [0.1, 0.2, 0.3], embed: async () => [0.1, 0.2, 0.3] };

function countTimers() {
  const realTimeout = AbortSignal.timeout;
  const realSetTimeout = globalThis.setTimeout;
  const seen = { abortTimeouts: [], rerankSetTimeouts: 0 };
  AbortSignal.timeout = (ms) => { seen.abortTimeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 60) seen.rerankSetTimeouts += 1;
    return realSetTimeout(fn, ms, ...rest);
  };
  return { seen, restore() { AbortSignal.timeout = realTimeout; globalThis.setTimeout = realSetTimeout; } };
}

describe("rerank timeout ownership", () => {
  it("creates exactly one 60 ms timer and aborts the HTTP request with it", async () => {
    const originalFetch = globalThis.fetch;
    let requestSignal = null;
    globalThis.fetch = (_url, opts) => new Promise((_, reject) => {
      requestSignal = opts.signal;
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
    });
    const timers = countTimers();
    try {
      const reranker = new CohereRerankerProvider({ apiKey: "test-key", timeoutMs: 60 });
      const { memories } = await runRecallPipeline({
        query: "q", dbTable, embeddings, reranker, rerankerTimeoutMs: 60,
        logger: { info() {}, warn() {}, debug() {}, error() {} }, recallMinScore: 0, topN: 3, dedupEnabled: false,
        canonicalEnabled: false, associativeEnabled: false, agentId: "agent-a",
      });
      assert.equal(memories.length, 3, "fell back to unreranked top-N");
      assert.equal(timers.seen.abortTimeouts.filter((ms) => ms === 60).length, 1, "one AbortSignal.timeout for the whole rerank");
      assert.equal(timers.seen.rerankSetTimeouts, 0, "no setTimeout-based rerank race left");
      assert.equal(requestSignal.aborted, true, "the HTTP request observed the abort");
    } finally {
      timers.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("a caller abort during rerank propagates instead of falling back", async () => {
    const controller = new AbortController();
    const reranker = { id: "stub", rerank: (_q, _d, _n, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
      controller.abort(new Error("caller gone"));
    }) };
    await assert.rejects(() => runRecallPipeline({
      query: "q", dbTable, embeddings, reranker, rerankerTimeoutMs: 5_000, signal: controller.signal,
      logger: { info() {}, warn() {}, debug() {}, error() {} }, recallMinScore: 0, topN: 3, dedupEnabled: false,
      canonicalEnabled: false, associativeEnabled: false, agentId: "agent-a",
    }), /caller gone/);
  });
});
```

The row shape and the `vectorSearch().limit().toArray()` mock follow `tests/recall-p0.test.js:57-80`. If `runRecallPipeline` needs another option to reach the rerank stage with four rows (e.g. `rerankCandidates`), copy it from `tests/smoke-reranker-pipeline.test.js`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/rerank-single-timeout.test.js 2>&1 | tail -8
```

Expected: the first test fails `rerankSetTimeouts === 0` (the pipeline race) and finds no 60 ms `AbortSignal.timeout` (Cohere uses `setTimeout` + `AbortController`).

- [ ] **Step 3: Create `lib/providers/rerank-signal.js`**

```js
/**
 * lib/providers/rerank-signal.js — the single owner of a rerank timeout (PR-09).
 *
 * The recall pipeline builds one signal per rerank from the caller's signal and
 * the configured budget and hands it to the provider, whose HTTP request or
 * model call is driven by it. A provider called directly (no signal) builds its
 * own — still exactly one timer.
 */

/**
 * @param {AbortSignal|null|undefined} callerSignal
 * @param {number} timeoutMs Budget; <= 0 or non-finite means "no timer".
 * @returns {AbortSignal|undefined}
 */
export function rerankSignal(callerSignal, timeoutMs) {
  const budget = Number(timeoutMs);
  const timer = Number.isFinite(budget) && budget > 0 ? AbortSignal.timeout(budget) : null;
  if (timer && callerSignal) return AbortSignal.any([callerSignal, timer]);
  return timer ?? callerSignal ?? undefined;
}
```

- [ ] **Step 4: Replace the pipeline race**

`lib/recall-pipeline.js` — import `rerankSignal` from `./providers/rerank-signal.js`. In the rerank block replace

```js
      const rerankPromise = reranker.rerank(query, docs, rerankLimit);
      let reranked;
      if (rerankerTimeoutMs > 0) {
        reranked = await Promise.race([
          rerankPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("reranker timeout")), rerankerTimeoutMs)),
        ]);
      } else {
        reranked = await rerankPromise;
      }
```
with
```js
      const rerankAbort = rerankSignal(signal, rerankerTimeoutMs);
      let reranked;
      try {
        reranked = await reranker.rerank(query, docs, rerankLimit, rerankAbort ? { signal: rerankAbort } : undefined);
      } catch (rerankError) {
        throwIfAborted(signal, "recall aborted");
        if (rerankAbort?.aborted) throw new Error("reranker timeout");
        throw rerankError;
      }
```

The outer `catch (e)` (`:2042`) is unchanged: a timeout arrives there as `Error("reranker timeout")` exactly as before, and a caller abort was rethrown by `throwIfAborted` before reaching the fallback — add, as the first statement of that outer `catch`, `throwIfAborted(signal, "recall aborted");` so the caller abort is never swallowed by `rerankerFallbackOnError`.

- [ ] **Step 5: Drive every provider by the given signal**

`lib/providers/reranker-cohere.js` — `rerank(query, documents, topN, { signal } = {})`:

```js
  async rerank(query, documents, topN, { signal } = {}) {
    if (!documents || documents.length === 0) return [];
    const apiKey = await this._resolveApiKey();
    const requestSignal = signal ?? rerankSignal(null, this.timeoutMs);
    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: topN,
        return_documents: false,
      }),
      signal: requestSignal,
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${err}`);
    }
    return (await response.json()).results;
  }
```

with `import { rerankSignal } from "./rerank-signal.js";`. The `AbortController`/`setTimeout`/`clearTimeout` trio is gone.

`lib/providers/reranker-chained.js` — `rerank(query, documents, topN, options)` passes `options` to both `this.primary.rerank(query, documents, topN, options)` and `this.fallback.rerank(query, documents, topN, options)`. A primary that timed out leaves the shared signal aborted, so the fallback rejects at once — the same outcome as today, where the pipeline race (same budget) rejected before a fallback could finish.

`lib/providers/reranker-local-transformers.js` — `rerank(query, documents, topN, { signal } = {})`: import `raceAbort` from `../abort.js`, and wrap the scoring: after `const classifier = await this._getPipeline();` compute scores inside `const scores = await raceAbort((async () => { /* the existing if/else that assigns scores, returning scores */ })(), signal, "rerank aborted");`. The model call cannot be interrupted; the pipeline stops waiting.

- [ ] **Step 6: Run the new test and the reranker tests**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/rerank-single-timeout.test.js tests/reranker-cohere-timeout.test.js tests/chained-reranker-null-fallback.test.js tests/smoke-reranker-pipeline.test.js tests/recall-cap-after-rerank.test.js tests/reranker-bge-fallback.test.js tests/reranker-jina.test.js 2>&1 | tail -10
```

Expected: all green. `tests/reranker-cohere-timeout.test.js` still sees its 30 ms bound: without a signal the provider creates its own `AbortSignal.timeout(30)`.

- [ ] **Step 7: Golden, lint, suite**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: golden 10/10; lint clean (after adding `"lib/providers/rerank-signal.js",` to `DEPLOY_FILES` next to the other `lib/providers/*` entries); suite green.

- [ ] **Step 8: Commit**

```bash
cd "$PLUR1BUS"
git add lib/providers lib/recall-pipeline.js scripts/lib/deploy-integrity.mjs tests/rerank-single-timeout.test.js
git commit -m "fix(recall): one timeout owner for rerank

PR-09 (spec 3.2). The pipeline's Promise.race is gone; one signal,
AbortSignal.any([caller, AbortSignal.timeout(rerankerTimeoutMs)]), drives the
provider's request. Cohere, chained and local rerankers accept { signal } and
build their own single timer only when called without one."
```

---

### Task 5 (PR-15): `checkpoint(agentId, reason)` replaces the `event.compactedAt` read

Spec §3.3 last bullet. Reactivation recall (CRR) receives `compactedAt: event?.compactedAt || hookCtx?.compactedAt || null` (`engine/recall/assemble-prompt-context.js:825`) and treats "compacted after the last CRR run" as a trigger (`lib/conversation-reactivation-recall.js:394`). A checkpoint store records the timestamp a host reports through `checkpoint()`; the assembler keeps the explicit event value first, so a host that only sets `compactedAt` feeds CRR the identical value (the spec's step-4 gate).

**Files:**
- Create: `engine/checkpoint/checkpoint-store.js`
- Modify: `engine/recall/assemble-prompt-context.js:825` and its ctx destructuring
- Modify: `index.js` — create the store next to `runtimeScheduler` (`:4568`); pass it into `registerRecallHook({…})` (`:7538`) and `registerCaptureHook({…})` (`:7289`)
- Modify: `adapter/openclaw/register-capture-hook.js` (register `before_compaction`)
- Create: `tests/engine-checkpoint.test.js`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`

**Interfaces:**
- Consumes: `host.clock` (`lib/host-services.js:80`).
- Produces:
  - `CHECKPOINT_REASONS = ["compaction", "session-end", "shutdown", "manual"]`
  - `createCheckpointStore({ clock }) -> { checkpoint(agentId, reason, { at?, sessionKey? }?) -> { agentId, reason, digest, written }, lastAt(agentId, reason) -> number|null }`
  - `resolveCompactedAt({ event, hookCtx, store, agentId }) -> number|null`
  - OpenClaw hook `before_compaction` (`node_modules/openclaw/dist/hook-types-BAcOolQ8.d.ts:631,849-855,1494`) → `checkpoint(agentId, "compaction")`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-checkpoint.test.js`:

```js
/**
 * tests/engine-checkpoint.test.js — PR-15.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CHECKPOINT_REASONS, createCheckpointStore, resolveCompactedAt } from "../engine/checkpoint/checkpoint-store.js";

describe("checkpoint store", () => {
  it("records the host clock and is idempotent for the same digest", () => {
    let now = 1_000;
    const store = createCheckpointStore({ clock: () => now });
    const first = store.checkpoint("agent-a", "compaction", { sessionKey: "s1" });
    assert.equal(first.written, true);
    assert.match(first.digest, /^[a-f0-9]{32}$/);
    assert.equal(store.lastAt("agent-a", "compaction"), 1_000);
    assert.equal(store.checkpoint("agent-a", "compaction", { sessionKey: "s1", at: 1_000 }).written, false);
    now = 2_000;
    assert.equal(store.checkpoint("agent-a", "compaction", { sessionKey: "s1" }).written, true);
    assert.equal(store.lastAt("agent-a", "compaction"), 2_000);
    assert.equal(store.lastAt("agent-b", "compaction"), null);
  });

  it("accepts the four reasons and rejects anything else", () => {
    assert.deepEqual(CHECKPOINT_REASONS, ["compaction", "session-end", "shutdown", "manual"]);
    const store = createCheckpointStore({ clock: () => 1 });
    for (const reason of CHECKPOINT_REASONS) store.checkpoint("a", reason);
    assert.throws(() => store.checkpoint("a", "reboot"), /unknown checkpoint reason/);
  });
});

describe("resolveCompactedAt — the step-4 gate", () => {
  it("is identical to the old expression when only compactedAt is given", () => {
    const store = createCheckpointStore({ clock: () => 9 });
    const old = (event, hookCtx) => event?.compactedAt || hookCtx?.compactedAt || null;
    for (const [event, hookCtx] of [[{ compactedAt: 5 }, {}], [{}, { compactedAt: 7 }], [{}, {}], [{ compactedAt: 0 }, { compactedAt: 3 }]]) {
      assert.equal(resolveCompactedAt({ event, hookCtx, store, agentId: "a" }), old(event, hookCtx));
    }
  });

  it("falls back to the checkpoint when the host reported none on the event", () => {
    const store = createCheckpointStore({ clock: () => 42 });
    store.checkpoint("a", "compaction");
    assert.equal(resolveCompactedAt({ event: {}, hookCtx: {}, store, agentId: "a" }), 42);
    assert.equal(resolveCompactedAt({ event: { compactedAt: 7 }, hookCtx: {}, store, agentId: "a" }), 7);
    assert.equal(resolveCompactedAt({ event: {}, hookCtx: {}, store: null, agentId: "a" }), null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-checkpoint.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Create `engine/checkpoint/checkpoint-store.js`**

```js
/**
 * engine/checkpoint/checkpoint-store.js — PR-15.
 *
 * Hosts tell the engine that a transcript boundary happened (compaction,
 * session end, shutdown, a manual mark) through Engine.checkpoint(). The
 * reactivation recall keys off the last compaction timestamp; an explicit
 * `compactedAt` a host still puts on the turn event wins, so a host that only
 * does that sees exactly the old behaviour.
 */

import { createHash } from "node:crypto";

export const CHECKPOINT_REASONS = Object.freeze(["compaction", "session-end", "shutdown", "manual"]);

/**
 * @param {{clock?: () => number}} [options]
 * @returns {{checkpoint: (agentId: string, reason: string, opts?: {at?: number, sessionKey?: string}) => {agentId: string, reason: string, digest: string, written: boolean}, lastAt: (agentId: string, reason: string) => number|null}}
 */
export function createCheckpointStore({ clock = () => Date.now() } = {}) {
  const last = new Map();
  const keyOf = (agentId, reason) => `${agentId}\u0000${reason}`;
  return {
    checkpoint(agentId, reason, { at, sessionKey = "" } = {}) {
      if (!CHECKPOINT_REASONS.includes(reason)) throw new TypeError(`unknown checkpoint reason: ${reason}`);
      const when = Number.isFinite(at) ? at : clock();
      const digest = createHash("sha256")
        .update(JSON.stringify([String(agentId), reason, String(sessionKey), when]))
        .digest("hex")
        .slice(0, 32);
      const key = keyOf(agentId, reason);
      const previous = last.get(key);
      const written = !previous || previous.digest !== digest;
      if (written) last.set(key, { at: when, digest });
      return { agentId, reason, digest, written };
    },
    lastAt(agentId, reason) {
      return last.get(keyOf(agentId, reason))?.at ?? null;
    },
  };
}

/**
 * @param {{event?: object, hookCtx?: object, store?: {lastAt: Function}|null, agentId: string}} input
 * @returns {number|null}
 */
export function resolveCompactedAt({ event, hookCtx, store, agentId }) {
  const explicit = event?.compactedAt || hookCtx?.compactedAt || null;
  if (explicit) return explicit;
  return store?.lastAt(agentId, "compaction") ?? null;
}
```

- [ ] **Step 4: Run it — it passes**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-checkpoint.test.js 2>&1 | tail -5
```

Expected: `tests 4`, `pass 4`.

- [ ] **Step 5: Use it in the assembler**

`engine/recall/assemble-prompt-context.js`: import `resolveCompactedAt` from `../checkpoint/checkpoint-store.js`; add `checkpointStore = null,` to the ctx destructuring (alphabetical position, after `candidateTopK,`); replace `:825`

```js
              compactedAt: event?.compactedAt || hookCtx?.compactedAt || null,
```
with
```js
              compactedAt: resolveCompactedAt({ event, hookCtx, store: checkpointStore, agentId }),
```

- [ ] **Step 6: Create the store in `index.js` and register the host hook**

In `index.js`, directly after the `const runtimeScheduler = createBackgroundMemoryScheduler({ … });` statement (`:4568-4571`), add:

```js
    const checkpointStore = createCheckpointStore({ clock: host.clock });
```

with `import { createCheckpointStore } from "./engine/checkpoint/checkpoint-store.js";` in the import block. Add `checkpointStore,` to the object literals of `registerRecallHook({…})` (alphabetically, after `canonicalMinScore,`) and `registerCaptureHook({…})`.

`adapter/openclaw/register-capture-hook.js` — after the existing `ctx.api.on("agent_end", handler, { timeoutMs: 60_000 });` add:

```js
  if (ctx.checkpointStore) {
    ctx.api.on("before_compaction", (event, hookCtx) => {
      ctx.checkpointStore.checkpoint(hookCtx?.agentId || "default", "compaction", {
        sessionKey: hookCtx?.sessionKey ?? event?.sessionKey ?? "",
      });
    });
  }
```

`before_compaction` is a fresh event list in the host, so no existing handler order changes (Global Constraint 14). Update the module docblock: it now registers `agent_end` auto-capture and the `before_compaction` checkpoint.

- [ ] **Step 7: Register, verify, commit**

Add `checkpointStore: "engine/checkpoint/checkpoint-store.js",` to `ENGINE_PATHS` and `"engine/checkpoint/checkpoint-store.js",` to `DEPLOY_FILES`.

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-checkpoint.test.js tests/conversation-reactivation*.test.js tests/golden-prefix.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add engine index.js adapter tests/engine-checkpoint.test.js tests/helpers/runtime-sources.js scripts/lib/deploy-integrity.mjs
git commit -m "feat(engine): checkpoint store; reactivation recall keys off it

PR-15 (spec 3.3). The OpenClaw adapter records before_compaction through the
store; an explicit event.compactedAt still wins, so a host that only sets it
feeds reactivation recall the identical value."
```

Expected: checkpoint + CRR tests green (adjust the glob to `ls tests | grep -i reactivation`); golden 10/10; lint and suite green. If a test enumerates every hook name `register()` installs and fails on the new `before_compaction`, add the name to that test's expected list — that is the only permitted test edit here.

---
### Task 6 (PR-07): `JobRegistry` with the 18 names; `/plur1bus internal` becomes a thin caller

Spec §3.3 bullets 1–2 and step 5. The 17 internal runners live in one `if (actionKey === "internal") { … }` chain inside `runPlur1busCommand` (`engine/commands/plur1bus-command.js:406-1180`); `plur1bus.feature.run` already reaches them through `runPlur1busCommand(commandCtx)` (`adapter/openclaw/register-commands.js:123-125`), so making the chain a thin caller of `jobs.run` makes both thin. This task lifts the chain verbatim into `engine/jobs/internal-job-bodies.js`, builds the registry with the 18 specs, binds each name to exactly one owner, and rewrites every job-level skip site to `return jobCtx.skip(reason, output)` so a `JobRun` knows its outcome. **No ledger yet** — Task 7 persists what this task computes. `ctx.skip()` lands here rather than in Task 7 because step 5's gate ("`run()` returns `JobRun` for all 18 names incl. skip paths") cannot be met without it.

**Files:**
- Create: `engine/jobs/job-specs.js`, `engine/jobs/job-registry.js`, `engine/jobs/internal-job-bodies.js`
- Modify: `engine/commands/plur1bus-command.js:356-368` (policy refusal) and `:406-1180` (the internal chain)
- Modify: `index.js` — create the registry directly above the bare command block (anchor: the line `      const resolveCommandLocale = (commandCtx) => {` at `:6895`, whose enclosing `{` opens at `:6894`); add `jobs` to the `createPlur1busCommandRunner({…})` literal (`:7013`)
- Modify: `tests/engine-plur1bus-command.test.js` (the literal job-name guard now reads both files)
- Create: `tests/engine-jobs-registry.test.js`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`

**Interfaces:**
- Consumes: `REQUIRED_FEATURE_CRONS` (`lib/setup/feature-cron-plan.js:25-170`); Task 2's `emitEngineEvent`.
- Produces:
  - `JOB_NAMES` (18, the contract's `JobName` union order, `types/engine.d.ts:278-284`), `INTERNAL_JOB_NAMES` (the 17 without `light-dream`), `JOB_SPECS: JobSpec[]`
  - `createJobRegistry({ host, idFactory? }) -> { list(), run(name, agentId, opts?), bind(name, body, { defaultInput? }?), history() }`
  - `run(name, agentId, { signal?, trigger?: "cron"|"manual"|"harness"|"capture", input?, preSkip?: { reason, output } }) -> Promise<JobRun>`; the returned object carries non-enumerable `output` (the command reply) and, on `failed`, non-enumerable `error`
  - body signature `(name, jobCtx) -> Promise<output | JobExit>`; `jobCtx = { agentId, trigger, signal, input, logger, skip(reason, output?), incomplete(reason, output?), noteDiary({ written, reason? }), markCompletedKey(key), notePendingKey(key), setDiaryTarget(dir) }`
  - host event `job.run` with the `JobRun` as payload; skips logged at `info` as `plur1bus job <name>[<agentId>]: skipped (<reason>)`
  - `createInternalJobBodies(ctx) -> (name, jobCtx) => Promise<CommandResult | JobExit>`

- [ ] **Step 1: Write the failing registry test**

Create `tests/engine-jobs-registry.test.js`:

```js
/**
 * tests/engine-jobs-registry.test.js — PR-07.
 *
 * The registry holds the contract's 18 names with one owner each, and every
 * run — completed, skipped, incomplete, thrown — comes back as a JobRun.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { INTERNAL_JOB_NAMES, JOB_NAMES, JOB_SPECS } from "../engine/jobs/job-specs.js";
import { createJobRegistry } from "../engine/jobs/job-registry.js";
import { createStubHost } from "../lib/host-services.js";
import plugin from "../index.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const CONTRACT_JOB_NAMES = [
  "persona-evolve", "afterthought", "consolidate-daily", "auto-accept-stale",
  "embedding-drain", "emotion-refine", "classify-recent", "rem-dream",
  "skill-miner", "discover-semantic-links", "gc-run",
  "reminder-dispatch", "feedback-report", "proactive-check", "meta-reflect",
  "skill-benefit-backfill", "episodes-rebuild",
  "light-dream",
];

function stubHost(events = []) {
  let now = 1_000;
  return createStubHost({ clock: () => (now += 5), events: { emit: (name, payload) => events.push({ name, payload }) } });
}

describe("job specs", () => {
  it("are exactly the contract's 18 names", () => {
    assert.deepEqual(JOB_NAMES, CONTRACT_JOB_NAMES);
    assert.equal(INTERNAL_JOB_NAMES.length, 17);
    assert.ok(!INTERNAL_JOB_NAMES.includes("light-dream"));
  });

  it("carry phases, the gc-run singleton and the cron defaults", () => {
    const byName = new Map(JOB_SPECS.map((s) => [s.name, s]));
    assert.equal(byName.get("light-dream").phase, "light");
    assert.equal(byName.get("rem-dream").phase, "rem");
    assert.equal(byName.get("consolidate-daily").phase, "deep");
    assert.equal(byName.get("gc-run").singleton, true);
    assert.equal(byName.get("persona-evolve").singleton, false);
    assert.deepEqual(byName.get("rem-dream").defaultSchedule, { kind: "cron", expr: "15 1 * * *", timezone: "Europe/Berlin" });
    assert.deepEqual(byName.get("emotion-refine").defaultSchedule, { kind: "every", expr: "3600000" });
    assert.equal(byName.get("meta-reflect").defaultSchedule, undefined);
  });
});

describe("createJobRegistry", () => {
  it("returns a JobRun for all 18 names, including the skip path", async () => {
    const events = [];
    const jobs = createJobRegistry({ host: stubHost(events), idFactory: (() => { let n = 0; return () => `run-${++n}`; })() });
    for (const name of JOB_NAMES) jobs.bind(name, async (_n, ctx) => ctx.skip("test_skip", { text: name }));
    for (const name of JOB_NAMES) {
      const run = await jobs.run(name, "agent-a", { trigger: "harness" });
      assert.equal(run.job, name);
      assert.equal(run.outcome, "skipped");
      assert.equal(run.reason, "test_skip");
      assert.equal(run.output.text, name);
      assert.equal(run.trigger, "harness");
      assert.equal(run.attempt, 1);
      assert.ok(run.finishedAt >= run.startedAt);
    }
    assert.equal(events.filter((e) => e.name === "job.run").length, 18);
  });

  it("maps completed, incomplete and thrown bodies", async () => {
    const jobs = createJobRegistry({ host: stubHost() });
    jobs.bind("gc-run", async () => ({ text: "done" }));
    jobs.bind("rem-dream", async (_n, ctx) => ctx.incomplete("no_narrative", { text: "open" }));
    const boom = new TypeError("boom");
    jobs.bind("skill-miner", async () => { throw boom; });
    const completed = await jobs.run("gc-run", "a");
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.output.text, "done");
    assert.equal(completed.phase, null);
    const incomplete = await jobs.run("rem-dream", "a");
    assert.deepEqual([incomplete.outcome, incomplete.reason, incomplete.phase], ["incomplete", "no_narrative", "rem"]);
    const failed = await jobs.run("skill-miner", "a");
    assert.deepEqual([failed.outcome, failed.reason], ["failed", "error:TypeError"]);
    assert.equal(failed.error, boom);
    assert.equal(Object.keys(failed).includes("error"), false, "error is not enumerable");
  });

  it("enforces one owner per name and rejects unknown names", async () => {
    const jobs = createJobRegistry({ host: stubHost() });
    jobs.bind("gc-run", async () => ({}));
    assert.throws(() => jobs.bind("gc-run", async () => ({})), /already has an owner/);
    assert.throws(() => jobs.bind("nope", async () => ({})), /unknown job/);
    await assert.rejects(() => jobs.run("nope", "a"), /unknown job/);
    const unowned = await jobs.run("meta-reflect", "a");
    assert.deepEqual([unowned.outcome, unowned.reason], ["skipped", "no_owner"]);
  });

  it("honours preSkip and a defaultInput that pre-skips", async () => {
    const jobs = createJobRegistry({ host: stubHost() });
    let called = 0;
    jobs.bind("gc-run", async () => { called += 1; return {}; }, {
      defaultInput: async () => ({ preSkip: { reason: "workspace_disabled", output: { text: "NO_REPLY" } } }),
    });
    const pre = await jobs.run("gc-run", "a", { preSkip: { reason: "policy", output: { text: "NO_REPLY" } } });
    assert.deepEqual([pre.outcome, pre.reason, pre.output.text], ["skipped", "policy", "NO_REPLY"]);
    const viaDefault = await jobs.run("gc-run", "a");
    assert.equal(viaDefault.reason, "workspace_disabled");
    assert.equal(called, 0);
  });
});

describe("/plur1bus internal goes through jobs.run", () => {
  it("every internal name emits one job.run, with the expected skip reasons", async () => {
    const baseDbPath = makeTempDir("plur1bus-jobs-db-");
    const workspaceDir = makeTempDir("plur1bus-jobs-ws-");
    const commands = [];
    const events = [];
    const noop = () => {};
    const api = {
      pluginConfig: {
        baseDbPath,
        embedding: { provider: "local-transformers", local: { dimensions: 384 } },
        autoCapture: false, autoRecall: false,
        neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
        merging: { enabled: false }, skillMiner: { enabled: false }, afterthought: { enabled: false },
        dailyConsolidation: { enabled: false }, criticalPush: { enabled: false },
      },
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      runtime: { agent: { async resolveAgentWorkspaceDir() { return workspaceDir; } } },
      resolvePath: (p) => p,
      registerCommand(command) { commands.push(command); },
      registerTool: noop, registerService: noop, on: noop,
    };
    plugin.register(api, {
      importRouting: async () => ({
        parseAgentSessionKey: (v) => { const m = /^agent:([^:]+):(.+)$/.exec(v); return m ? { agentId: m[1], rest: m[2] } : null; },
        parseThreadSessionSuffix: (v) => ({ baseSessionKey: v, threadId: "" }),
        normalizeOptionalAccountId: (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
        normalizeMessageChannel: (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
      }),
      hostEvents: { emit: (name, payload) => events.push({ name, payload }) },
    });
    const command = commands.find((c) => c.name === "plur1bus");
    const expectedSkips = {
      "consolidate-daily": "dailyConsolidation_disabled",
      "classify-recent": "criticalPush_disabled",
      "rem-dream": "no_llm_config",
      "skill-miner": "not_configured",
      "skill-benefit-backfill": "not_configured",
      afterthought: "disabled",
      "episodes-rebuild": "neo_disabled",
      "gc-run": "gc_disabled",
      "embedding-drain": "neo_disabled",
      "feedback-report": "no_workspace",
      "proactive-check": "no_workspace",
      "meta-reflect": "no_workspace",
    };
    for (const name of INTERNAL_JOB_NAMES) {
      const before = events.length;
      await command.handler({ agentId: "agent-a", channel: "cron", sessionKey: "agent:agent-a:cron:test", args: `internal ${name}`, config: {} });
      const runs = events.slice(before).filter((e) => e.name === "job.run");
      assert.equal(runs.length, 1, `${name} emitted ${runs.length} job.run events`);
      assert.equal(runs[0].payload.job, name);
      assert.equal(runs[0].payload.trigger, "cron");
      if (expectedSkips[name]) {
        assert.deepEqual([runs[0].payload.outcome, runs[0].payload.reason], ["skipped", expectedSkips[name]], name);
      }
    }
  });
});
```

`api.on` is a no-op in this stub, so no `gateway_stop` handler is registered and there is nothing to stop; the temp dirs are removed by `makeTempDir`'s exit hook. The twelve asserted skip reasons are the ones whose guard the config above switches off; the other five names (`auto-accept-stale`, `persona-evolve`, `reminder-dispatch`, `discover-semantic-links`, `emotion-refine`) only have to emit their `job.run`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-registry.test.js 2>&1 | tail -8
```

Expected: `ERR_MODULE_NOT_FOUND … engine/jobs/job-specs.js`.

- [ ] **Step 3: Create `engine/jobs/job-specs.js`**

```js
/**
 * engine/jobs/job-specs.js — the 18 engine-owned jobs (spec 3.3, contract JobName).
 *
 * Eleven carry a host cron default from lib/setup/feature-cron-plan.js; six are
 * RPC/CLI features with no default schedule; light-dream runs from capture.
 * `phase` marks the dreaming phases the per-sweep breaker counts (Task 8).
 * `needsLlm` is informational: whether the job can reach an LLM route at all.
 */

import { REQUIRED_FEATURE_CRONS } from "../../lib/setup/feature-cron-plan.js";

const JOB_TABLE = Object.freeze([
  ["persona-evolve", true, null],
  ["afterthought", true, null],
  ["consolidate-daily", true, "deep"],
  ["auto-accept-stale", false, null],
  ["embedding-drain", false, null],
  ["emotion-refine", true, null],
  ["classify-recent", true, null],
  ["rem-dream", true, "rem"],
  ["skill-miner", true, null],
  ["discover-semantic-links", false, null],
  ["gc-run", false, null],
  ["reminder-dispatch", false, null],
  ["feedback-report", false, null],
  ["proactive-check", false, null],
  ["meta-reflect", true, null],
  ["skill-benefit-backfill", true, null],
  ["episodes-rebuild", true, null],
  ["light-dream", true, "light"],
]);

const CRON_BY_FEATURE = new Map(REQUIRED_FEATURE_CRONS.map((spec) => [spec.feature, spec]));

function defaultScheduleOf(cron) {
  if (cron.schedule.kind === "every") return Object.freeze({ kind: "every", expr: String(cron.schedule.everyMs) });
  return Object.freeze({
    kind: "cron",
    expr: cron.schedule.expr,
    ...(cron.timezone ? { timezone: cron.timezone } : {}),
  });
}

export const JOB_NAMES = Object.freeze(JOB_TABLE.map(([name]) => name));

export const INTERNAL_JOB_NAMES = Object.freeze(JOB_NAMES.filter((name) => name !== "light-dream"));

export const JOB_SPECS = Object.freeze(JOB_TABLE.map(([name, needsLlm, phase]) => {
  const cron = CRON_BY_FEATURE.get(name);
  return Object.freeze({
    name,
    needsLlm,
    singleton: cron?.singleton === true,
    ...(phase ? { phase } : {}),
    ...(cron ? { defaultSchedule: defaultScheduleOf(cron) } : {}),
  });
}));
```

- [ ] **Step 4: Create `engine/jobs/job-registry.js`**

```js
/**
 * engine/jobs/job-registry.js — PR-07 (spec 3.3).
 *
 * One owner per job name. A body returns its output (the command reply) for
 * a completed run, or `jobCtx.skip(...)` / `jobCtx.incomplete(...)` for the
 * other exits; a throw is a failed run. Every run resolves to a JobRun.
 */

import { randomUUID } from "node:crypto";

import { emitEngineEvent } from "../events.js";
import { JOB_SPECS } from "./job-specs.js";

const EXIT = Symbol("plur1bus.job.exit");

/**
 * @param {"completed"|"skipped"|"incomplete"|"failed"|"abandoned"} outcome
 * @param {string|undefined} reason
 * @param {unknown} output
 * @returns {{outcome: string, reason?: string, output: unknown}}
 */
export function jobExit(outcome, reason, output) {
  return { [EXIT]: true, outcome, reason, output };
}

/**
 * @param {{host: object, idFactory?: () => string}} options
 */
export function createJobRegistry({ host, idFactory = () => randomUUID() } = {}) {
  const specs = new Map(JOB_SPECS.map((spec) => [spec.name, spec]));
  const owners = new Map();
  const clock = () => (typeof host?.clock === "function" ? host.clock() : Date.now());

  function bind(name, body, { defaultInput = null } = {}) {
    if (!specs.has(name)) throw new TypeError(`unknown job: ${name}`);
    if (owners.has(name)) throw new Error(`job ${name} already has an owner`);
    if (typeof body !== "function") throw new TypeError(`job ${name} body must be a function`);
    owners.set(name, { body, defaultInput });
  }

  function jobContext(inflight, { signal, input }) {
    return Object.freeze({
      agentId: inflight.agentId,
      trigger: inflight.trigger,
      signal,
      input,
      logger: host.logger,
      skip: (reason, output) => jobExit("skipped", reason, output),
      incomplete: (reason, output) => jobExit("incomplete", reason, output),
      noteDiary: (result) => {
        inflight.diary = { written: result?.written === true, ...(result?.reason ? { reason: String(result.reason) } : {}) };
      },
      markCompletedKey: (key) => { if (key && !inflight.keys.includes(key)) inflight.keys.push(String(key)); },
      notePendingKey: (key) => { if (key && !inflight.pendingKeys.includes(key)) inflight.pendingKeys.push(String(key)); },
      setDiaryTarget: (dir) => { inflight.diaryTarget = dir || null; },
    });
  }

  function finish(inflight, exit, error) {
    const finishedAt = clock();
    const durationMs = Math.max(0, finishedAt - inflight.startedAt);
    const run = {
      runId: inflight.runId,
      job: inflight.job,
      phase: inflight.phase,
      agentId: inflight.agentId,
      trigger: inflight.trigger,
      startedAt: inflight.startedAt,
      finishedAt,
      durationMs,
      outcome: exit.outcome,
      ...(exit.reason ? { reason: exit.reason } : {}),
      attempt: inflight.attempt,
      cost: { ms: durationMs },
      counts: {},
      ...(inflight.keys.length ? { keys: [...inflight.keys] } : {}),
      ...(inflight.pendingKeys.length ? { pendingKeys: [...inflight.pendingKeys] } : {}),
      ...(inflight.pendingKeys.length || inflight.keys.length ? { idempotencyKey: inflight.pendingKeys[0] ?? inflight.keys[0] } : {}),
      ...(inflight.diary ? { diary: inflight.diary } : {}),
    };
    Object.defineProperty(run, "output", { value: exit.output, enumerable: false });
    if (error) Object.defineProperty(run, "error", { value: error, enumerable: false });
    if (run.outcome === "skipped") host.logger.info(`plur1bus job ${run.job}[${run.agentId}]: skipped (${run.reason})`);
    emitEngineEvent(host, "job.run", run);
    return run;
  }

  async function run(name, agentId, { signal, trigger = "manual", input, preSkip } = {}) {
    const spec = specs.get(name);
    if (!spec) throw new TypeError(`unknown job: ${name}`);
    const inflight = {
      runId: idFactory(),
      job: name,
      phase: spec.phase ?? null,
      agentId,
      trigger,
      startedAt: clock(),
      attempt: 1,
      keys: [],
      pendingKeys: [],
      diary: undefined,
      diaryTarget: null,
    };
    const owner = owners.get(name);
    let exit;
    let error = null;
    try {
      if (preSkip) {
        exit = jobExit("skipped", preSkip.reason, preSkip.output);
      } else if (!owner) {
        exit = jobExit("skipped", "no_owner", undefined);
      } else {
        const resolved = input ?? (owner.defaultInput ? await owner.defaultInput(agentId, name) : undefined);
        if (resolved?.preSkip) {
          exit = jobExit("skipped", resolved.preSkip.reason, resolved.preSkip.output);
        } else {
          const value = await owner.body(name, jobContext(inflight, { signal, input: resolved }));
          exit = value && value[EXIT] ? value : jobExit("completed", undefined, value);
        }
      }
    } catch (thrown) {
      error = thrown;
      exit = jobExit("failed", `error:${thrown?.name || "Error"}`, undefined);
    }
    return finish(inflight, exit, error);
  }

  return Object.freeze({
    list: () => [...specs.values()],
    bind,
    run,
    history: async () => [],
  });
}
```

- [ ] **Step 5: Lift the internal chain into `engine/jobs/internal-job-bodies.js`**

Confirm the range and its free names:

```bash
cd "$PLUR1BUS" && grep -n 'if (actionKey === "internal") {' engine/commands/plur1bus-command.js
cd "$PLUR1BUS" && grep -n 'return formatJsonCommandResult({ error: `unknown internal job' engine/commands/plur1bus-command.js
cd "$PLUR1BUS" && grep -n 'return async function runPlur1busCommand' engine/commands/plur1bus-command.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs engine/commands/plur1bus-command.js 409 1178 > /tmp/jobs-deps.txt; cat /tmp/jobs-deps.txt
```

Expected at `9fd7bab4`: the third `if (actionKey === "internal") {` match is `:406` (the other two are `:363`, `:376`); the unknown-job return is `:1179`; the runner function is `:163`. The body range is `:409-1178` — from `if (subKey === "consolidate-daily") {` to the closing `}` of the `meta-reflect` branch. The analyser prints two lists (for a non-`index.js` file "module" means declared at the file's top level, "register" means declared anywhere else outside the range). Sort them:

- **MODULE-SCOPE names**: each is either an `import` in `plur1bus-command.js` — copy that import line into the new file unchanged (same directory depth, `engine/commands/` → `engine/jobs/`, so `../../lib/…` stays correct) — or a top-level declaration of `plur1bus-command.js` (constants such as `EMOTION_REFINE_MAX_ROWS`): **move** such a declaration into `internal-job-bodies.js` and export it; if `plur1bus-command.js` still uses it after the move, import it back from `../jobs/internal-job-bodies.js` (one direction only — `internal-job-bodies.js` must not import `plur1bus-command.js`, or lint rule 3 fails on the cycle).
- **REGISTER-SCOPE names** declared between `createPlur1busCommandRunner(ctx) {` (`:60`) and `return async function runPlur1busCommand` (`:163`) — the runner's destructured ctx keys and factory-level helpers — become the `ctx` of `createInternalJobBodies`.
- **REGISTER-SCOPE names** declared after `:163` (per-call locals of `runPlur1busCommand`: `commandCtx`, `memoryCtx`, `cronInternal`, `commandStore`, `subKey`, `internalAgent`, and any other the list shows) become fields of `jobCtx.input`, except `subKey` and `internalAgent`, which the wrapper re-derives.

Create the module:

```js
/**
 * engine/jobs/internal-job-bodies.js — the 17 internal job runners (PR-07).
 *
 * Was engine/commands/plur1bus-command.js:409-1178, the `/plur1bus internal
 * <job>` chain. Each branch is the job body for one name; its reply is the
 * job's output, and every job-level early exit is `return jobCtx.skip(...)`
 * so the registry records why the job did not run.
 */

/* the import lines the analyser's MODULE-SCOPE list requires, copied verbatim */

/**
 * @param {Record<string, any>} ctx The command runner's context plus its factory-level helpers.
 * @returns {(name: string, jobCtx: object) => Promise<object>} Job body.
 */
export function createInternalJobBodies(ctx) {
  const {
    /* the REGISTER-SCOPE names declared at runner-factory level, one per line, alphabetically */
  } = ctx;

  return async function runInternalJob(name, jobCtx) {
    const { commandCtx, memoryCtx, cronInternal, commandStore } = jobCtx.input;
    /* plus any other per-call local the analyser listed, destructured from jobCtx.input */
    const subKey = name;
    const internalAgent = commandCtx.agentId || "default";
    /* engine/commands/plur1bus-command.js:409-1178 verbatim, with the skip-site rewrites of Step 6 */
    throw new Error(`internal job ${name} has no branch`);
  };
}
```

The trailing `throw` is unreachable for the 17 validated names; it replaces the old fall-through to the unknown-job reply, which stays in the thin caller (Step 7).

- [ ] **Step 6: Rewrite the job-level skip sites**

Inside the moved body, every `return` that reports a job-level skip is wrapped so the reply text is unchanged and the registry learns the reason. At `9fd7bab4` (source line numbers of `plur1bus-command.js`) the sites are:

| Line | Job | Rewrite |
|---|---|---|
| `412` | consolidate-daily | `return jobCtx.skip("dailyConsolidation_disabled", formatJsonCommandResult({ job: "consolidate-daily", skipped: true, reason: "dailyConsolidation_disabled" }));` |
| `543-546` | classify-recent | `return jobCtx.skip("criticalPush_disabled", cronInternal ? formatClassifierCronReply(disabledResult) : formatJsonCommandResult(disabledResult));` |
| `601` | rem-dream | `return jobCtx.skip("no_llm_config", formatJsonCommandResult({ job: "rem-dream", skipped: true, reason: "no_llm_config" }));` |
| `622` | rem-dream | same pattern, reason `acl_partition_missing` |
| `702` | skill-miner | same pattern, reason `not_configured` |
| `717` | skill-miner | same pattern, reason `acl_partition_missing` (keep `partitions: []` in the reply) |
| `800` | skill-benefit-backfill | same pattern, reason `not_configured` |
| `824-827` | afterthought | `return jobCtx.skip("disabled", cronInternal ? formatAfterthoughtCronReply(disabledResult) : formatJsonCommandResult(disabledResult));` |
| `853` | persona-evolve | same pattern, reason `not_configured` |
| `899` | episodes-rebuild | same pattern, reason `neo_disabled` |
| `967` | gc-run | same pattern, reason `gc_disabled` |
| `991` | embedding-drain | same pattern, reason `neo_disabled` |
| `1100` | emotion-refine | the final `return formatJsonCommandResult({ job: "emotion-refine", ...result });` becomes `const emotionReply = formatJsonCommandResult({ job: "emotion-refine", ...result }); return result.skipped ? jobCtx.skip(result.reason, emotionReply) : emotionReply;` (the two `skipped` objects at `:1022`/`:1033` are the job-level outcome, returned out of `pool.withDb`) |
| `1103` | feedback-report | same pattern, reason `no_workspace` |
| `1113` | discover-semantic-links | same pattern, reason `no_workspace_for_agent` |
| `1153` | proactive-check | same pattern, reason `no_workspace` |
| `1167` | meta-reflect | same pattern, reason `no_workspace` |

Not job-level, left alone: `lancedbOptimize = { skipped: true, … }` (`:511`, `:513`, a sub-step of consolidate-daily) and `missingSharedPartition(…)` (`:758-763`, one partition of skill-miner). Verify no job-level site was missed:

```bash
cd "$PLUR1BUS" && grep -n 'skipped: true' engine/jobs/internal-job-bodies.js
```

Every hit must be inside a `jobCtx.skip(` call, one of the two sub-step sites, or one of the two `emotion-refine` objects.

- [ ] **Step 7: Make the command chain a thin caller**

In `engine/commands/plur1bus-command.js`:

1. Imports: `import { INTERNAL_JOB_NAMES } from "../jobs/job-specs.js";` and `import { createInternalJobBodies } from "../jobs/internal-job-bodies.js";`. Delete any import that only the moved range used (`node --check` passes either way; `npm run lint` does not flag unused imports, so check each MODULE-SCOPE name with `grep -c`).
2. Add `jobs = null,` to the ctx destructuring (`:61`).
3. After the destructuring closes (before `return async function runPlur1busCommand`, `:163`), bind the bodies once:

```js
  if (jobs) {
    const runInternalJob = createInternalJobBodies({
      ...ctx,
      /* each factory-level helper the analyser listed that is not already a ctx key, as a shorthand property */
    });
    const defaultInput = async (agentId, jobName) => {
      const commandCtx = {
        agentId,
        channel: "cron",
        origin: "cron",
        sessionKey: `agent:${agentId}:cron:${jobName}`,
        args: `internal ${jobName}`,
        config: host.config(),
      };
      const memoryCtx = await resolveCronMemoryContext(commandCtx);
      const decision = workspacePolicyGuard.decision(memoryCtx);
      if (!decision.allowed) {
        const reason = decision.reason || "workspace_disabled";
        return { preSkip: { reason, output: { text: "NO_REPLY", metadata: { skipped: true, reason } } } };
      }
      const commandStore = getNeoStore({
        workspaceDir: memoryCtx?.workspaceDir || "",
        agentId: memoryCtx?.agentId || agentId,
      });
      return { commandCtx, memoryCtx, cronInternal: true, commandStore };
    };
    for (const jobName of INTERNAL_JOB_NAMES) jobs.bind(jobName, runInternalJob, { defaultInput });
  }
```

`defaultInput` is what a harness-triggered `jobs.run(name, agentId)` uses; it builds the same cron context `resolveCronMemoryContext` handles today (`index.js:6937-6945`) and the same store the command path builds (`plur1bus-command.js:398-401`).

4. Replace the policy refusal's internal branch (`:363-368`):

```js
      if (actionKey === "internal") {
        return {
          text: "NO_REPLY",
          metadata: { skipped: true, reason: rejectionReason },
        };
      }
```
with
```js
      if (actionKey === "internal") {
        const refusal = { text: "NO_REPLY", metadata: { skipped: true, reason: rejectionReason } };
        const jobName = (sub || "").toLowerCase();
        if (jobs && INTERNAL_JOB_NAMES.includes(jobName)) {
          const refused = await jobs.run(jobName, commandCtx.agentId || "default", {
            trigger: cronInternal ? "cron" : "manual",
            preSkip: { reason: rejectionReason, output: refusal },
          });
          return refused.output;
        }
        return refusal;
      }
```

5. Replace the whole internal chain (`:406-1180`, from `if (actionKey === "internal") {` through its closing `}`) with:

```js
    if (actionKey === "internal") {
      const subKey = (sub || "").toLowerCase();
      if (!jobs || !INTERNAL_JOB_NAMES.includes(subKey)) {
        return formatJsonCommandResult({ error: `unknown internal job: ${subKey || "(none)"}`, valid: ["consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream", "skill-miner", "skill-benefit-backfill", "afterthought", "persona-evolve", "reminder-dispatch", "discover-semantic-links", "gc-run", "embedding-drain", "emotion-refine", "feedback-report", "proactive-check", "meta-reflect", "episodes-rebuild"] });
      }
      const internalRun = await jobs.run(subKey, commandCtx.agentId || "default", {
        trigger: cronInternal ? "cron" : "manual",
        signal: commandCtx.abortSignal,
        input: { commandCtx, memoryCtx, cronInternal, commandStore },
      });
      if (internalRun.outcome === "failed" && internalRun.error) throw internalRun.error;
      return internalRun.output;
    }
```

(add any other per-call local from Step 5 to `input`). The rethrow keeps today's behaviour for a throwing body — the error reaches the host exactly as before. The unknown-name reply keeps its exact literal.

- [ ] **Step 8: Create the registry in `index.js`**

Directly above the bare block that begins with `    {` and whose first statement is `      const resolveCommandLocale = (commandCtx) => {` (`:6894-6895`), insert:

```js
    const jobs = createJobRegistry({ host });
```

with `import { createJobRegistry } from "./engine/jobs/job-registry.js";`, and add `jobs,` to the `createPlur1busCommandRunner({…})` literal (`:7013`, alphabetically). The registry must exist before the command block (which binds the 17) and before `registerCaptureHook` (`:7289`), which binds `light-dream` in Task 7.

- [ ] **Step 9: Point the literal-source guards at the new home**

`tests/engine-plur1bus-command.test.js` asserts each of the 17 names appears as a string literal in `plur1bus-command.js` — still true (the unknown-job `valid` list), so it passes unchanged; confirm. Then find every other guard that read job code out of `plur1bus-command.js`:

```bash
cd "$PLUR1BUS" && grep -rln 'plur1busCommand\|plur1bus-command.js' tests | xargs grep -ln 'readRuntimeSources\|readFileSync'
```

For each hit whose assertion is about code that moved (anything that was inside `:409-1178`), change the source it reads from `engine.plur1busCommand` to `engine.internalJobBodies` (after registering the path, Step 10), or to `all` if the assertion is "somewhere in the runtime". Do not weaken an assertion.

- [ ] **Step 10: Register the new files, verify, commit**

`tests/helpers/runtime-sources.js` `ENGINE_PATHS`: `internalJobBodies: "engine/jobs/internal-job-bodies.js", jobRegistry: "engine/jobs/job-registry.js", jobSpecs: "engine/jobs/job-specs.js",`. `DEPLOY_FILES`: the same three paths in the engine section.

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check engine/jobs/internal-job-bodies.js && /home/claude/.node24/bin/node --check engine/commands/plur1bus-command.js && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-registry.test.js tests/engine-plur1bus-command.test.js tests/plur1bus-internal-auth.test.js tests/command-reachability.test.js tests/emotion-refine-cron.test.js tests/classifier-cron-partial-failure.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -4
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add engine index.js tests scripts/lib/deploy-integrity.mjs
git commit -m "feat(jobs): JobRegistry with the 18 engine-owned jobs

PR-07 (spec 3.3). The 17 /plur1bus internal runners move verbatim into
engine/jobs/internal-job-bodies.js and are bound to the registry, one owner per
name; every job-level early exit is jobCtx.skip(reason, reply), so each run
resolves to a JobRun. /plur1bus internal and plur1bus.feature.run are thin
callers of jobs.run; replies are unchanged."
```

Expected: the new file green (`tests 7`); the command/cron files green; `lint-engine-imports: clean`; golden 10/10; lint and suite green. `plur1bus-internal-auth` is the file that catches a lost auth check or a lost branch.

---

### Task 7 (PR-08a): the run ledger — marker before the body, a row for every exit, crash detection

Spec §3.3 "Run ledger". Where the ledger lives is the one deliberate deviation from the spec's path: **`<baseDbPath>/_jobs/<agentId>/ledger.jsonl`**, not `<stateDir>/<agentId>/jobs/ledger.jsonl`. Reasons: for the OpenClaw host `stateDir` is `~/.openclaw` itself (`lib/host-services.js:61-63`), where `<agentId>/` would sit beside OpenClaw's own top-level directories; every existing test isolates `baseDbPath` in a temp dir but not `OPENCLAW_HOME` (`tests/plur1bus-internal-auth.test.js:34-60`), so a `stateDir` ledger would make the suite write into the real home (Global Constraint 16); and `_jobs` cannot collide with an agent directory under `baseDbPath` because agent ids must start with an alphanumeric (`types/engine.d.ts:43`, `lib/sql-safety.js:84-89`). The PR description names this.

**Files:**
- Create: `engine/jobs/job-ledger.js`
- Modify: `engine/jobs/job-registry.js` (marker, `record`, recovery, `history`)
- Modify: `index.js` — `createJobRegistry({ host })` from Task 6 gains `jobsRoot: join(baseDbPath, "_jobs")`
- Modify: `engine/capture/capture-turn.js:750-803` (light dream through the registry) and its ctx destructuring; `index.js` — add `jobs,` to `registerCaptureHook({…})`
- Create: `tests/engine-jobs-ledger.test.js`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`

**Interfaces:**
- Consumes: Task 6's registry; `safeAgentId` (`lib/sql-safety.js:84`).
- Produces:
  - `createJobLedger({ root, agentId, logger }) -> { paths, writeMarker(inflight), removeMarker(runId), append(row), readAll() -> row[], orphanMarkers() -> marker[] }`
  - ledger row = the `JobRun` fields plus `v: 1`, `sweep: "YYYY-MM-DD"` (UTC day of `startedAt`), `llmSession: boolean`
  - `createJobRegistry({ host, jobsRoot, idFactory? })`; `history(agentId, { job?, since?, limit? }) -> Promise<JobRun[]>` newest first
  - `sweepKey(ms) -> "YYYY-MM-DD"`
  - the registry's `light-dream` owner: `createTurnCapture(ctx)` binds it when `ctx.jobs` is present

- [ ] **Step 1: Write the failing test**

Create `tests/engine-jobs-ledger.test.js`:

```js
/**
 * tests/engine-jobs-ledger.test.js — PR-08 part 1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry, sweepKey } from "../engine/jobs/job-registry.js";
import { createJobLedger } from "../engine/jobs/job-ledger.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function registry(root, { clockStart = Date.UTC(2026, 0, 13, 1, 15), logger } = {}) {
  let now = clockStart;
  let n = 0;
  const host = createStubHost({ clock: () => (now += 10), ...(logger ? { logger } : {}) });
  return { jobs: createJobRegistry({ host, jobsRoot: root, idFactory: () => `run-${++n}` }), setNow: (v) => { now = v; } };
}

const rowsOf = (root, agentId) => readFileSync(join(root, agentId, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("job ledger", () => {
  it("writes the marker before the body and one row per exit, then removes the marker", async () => {
    const root = makeTempDir("plur1bus-ledger-");
    const { jobs } = registry(root);
    let markerSeen = false;
    jobs.bind("gc-run", async () => {
      markerSeen = readdirSync(join(root, "agent-a", "running")).some((f) => f === "run-1.started");
      return { text: "ok" };
    });
    jobs.bind("rem-dream", async (_n, ctx) => ctx.skip("no_llm_config", { text: "skip" }));
    await jobs.run("gc-run", "agent-a");
    await jobs.run("rem-dream", "agent-a");
    assert.equal(markerSeen, true);
    const rows = rowsOf(root, "agent-a");
    assert.deepEqual(rows.map((r) => [r.job, r.outcome, r.reason ?? null]), [["gc-run", "completed", null], ["rem-dream", "skipped", "no_llm_config"]]);
    assert.equal(rows[0].v, 1);
    assert.equal(rows[0].sweep, "2026-01-13");
    assert.equal(rows[1].llmSession, false);
    assert.deepEqual(readdirSync(join(root, "agent-a", "running")), []);
  });

  it("does not run the body when the ledger is unwritable (Review Focus 2)", async () => {
    const parent = makeTempDir("plur1bus-ledger-ro-");
    const root = join(parent, "not-a-dir");
    writeFileSync(root, "occupied");
    const warned = [];
    const { jobs } = registry(root, { logger: { warn: (m) => warned.push(m) } });
    let called = false;
    jobs.bind("gc-run", async () => { called = true; return {}; });
    const run = await jobs.run("gc-run", "agent-a");
    assert.equal(called, false);
    assert.deepEqual([run.outcome, run.reason], ["failed", "ledger_unwritable"]);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /ledger unwritable/);
  });

  it("records an orphaned marker as failed/crash on the next start", async () => {
    const root = makeTempDir("plur1bus-ledger-crash-");
    mkdirSync(join(root, "agent-a", "running"), { recursive: true });
    writeFileSync(join(root, "agent-a", "running", "old-run.started"), JSON.stringify({ runId: "old-run", job: "rem-dream", phase: "rem", trigger: "cron", startedAt: Date.UTC(2026, 0, 12, 1, 15) }));
    const { jobs } = registry(root);
    jobs.bind("gc-run", async () => ({}));
    await jobs.run("gc-run", "agent-a");
    const rows = rowsOf(root, "agent-a");
    assert.deepEqual(rows.map((r) => [r.runId, r.outcome, r.reason ?? null]), [["old-run", "failed", "crash"], ["run-1", "completed", null]]);
    assert.equal(existsSync(join(root, "agent-a", "running", "old-run.started")), false);
  });

  it("history filters by job and since, newest first, with a limit", async () => {
    const root = makeTempDir("plur1bus-ledger-history-");
    const { jobs } = registry(root);
    jobs.bind("gc-run", async () => ({}));
    jobs.bind("rem-dream", async (_n, ctx) => ctx.skip("x"));
    for (let i = 0; i < 3; i++) { await jobs.run("gc-run", "agent-a"); await jobs.run("rem-dream", "agent-a"); }
    const all = await jobs.history("agent-a");
    assert.equal(all.length, 6);
    assert.equal(all[0].runId, "run-6");
    const rem = await jobs.history("agent-a", { job: "rem-dream", limit: 2 });
    assert.deepEqual(rem.map((r) => r.runId), ["run-6", "run-4"]);
    const since = await jobs.history("agent-a", { since: all[1].startedAt });
    assert.deepEqual(since.map((r) => r.runId), ["run-6", "run-5"]);
    assert.deepEqual(await jobs.history("agent-b"), []);
  });

  it("sweepKey is the UTC day", () => {
    assert.equal(sweepKey(Date.UTC(2026, 0, 13, 23, 59)), "2026-01-13");
    assert.equal(sweepKey(Date.UTC(2026, 0, 14, 0, 0)), "2026-01-14");
  });

  it("the ledger tolerates a torn last line", () => {
    const root = makeTempDir("plur1bus-ledger-torn-");
    mkdirSync(join(root, "agent-a"), { recursive: true });
    writeFileSync(join(root, "agent-a", "ledger.jsonl"), `${JSON.stringify({ v: 1, runId: "a", job: "gc-run", outcome: "completed" })}\n{"v":1,"runId":"b"`);
    const ledger = createJobLedger({ root, agentId: "agent-a", logger: createStubHost().logger });
    assert.deepEqual(ledger.readAll().map((r) => r.runId), ["a"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-ledger.test.js 2>&1 | tail -8
```

Expected: `ERR_MODULE_NOT_FOUND … engine/jobs/job-ledger.js`.

- [ ] **Step 3: Create `engine/jobs/job-ledger.js`**

```js
/**
 * engine/jobs/job-ledger.js — the append-only run ledger (PR-08, spec 3.3).
 *
 * <root>/<agentId>/ledger.jsonl holds one JobRun per line;
 * <root>/<agentId>/running/<runId>.started exists exactly while a body runs.
 * A marker with no row at the next start is a crash.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { safeAgentId } from "../../lib/sql-safety.js";

export const LEDGER_VERSION = 1;

/**
 * @param {{root: string, agentId: string, logger: {warn: (m: string) => void}}} options
 */
export function createJobLedger({ root, agentId, logger }) {
  const dir = join(root, safeAgentId(agentId));
  const paths = Object.freeze({ dir, ledger: join(dir, "ledger.jsonl"), markers: join(dir, "running") });
  const markerPath = (runId) => join(paths.markers, `${runId}.started`);
  let warnedTorn = false;

  return Object.freeze({
    paths,
    writeMarker(inflight) {
      mkdirSync(paths.markers, { recursive: true });
      writeFileSync(markerPath(inflight.runId), JSON.stringify({
        runId: inflight.runId,
        job: inflight.job,
        phase: inflight.phase,
        trigger: inflight.trigger,
        startedAt: inflight.startedAt,
      }), { flag: "wx" });
    },
    removeMarker(runId) {
      try {
        unlinkSync(markerPath(runId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
    append(row) {
      mkdirSync(paths.dir, { recursive: true });
      appendFileSync(paths.ledger, `${JSON.stringify({ v: LEDGER_VERSION, ...row })}\n`);
    },
    readAll() {
      if (!existsSync(paths.ledger)) return [];
      const rows = [];
      for (const line of readFileSync(paths.ledger, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
        } catch {
          if (!warnedTorn) {
            warnedTorn = true;
            logger.warn(`plur1bus jobs: ignoring an unreadable line in ${paths.ledger}`);
          }
        }
      }
      return rows;
    },
    orphanMarkers() {
      if (!existsSync(paths.markers)) return [];
      return readdirSync(paths.markers)
        .filter((name) => name.endsWith(".started"))
        .map((name) => {
          const runId = name.slice(0, -".started".length);
          try {
            return { ...JSON.parse(readFileSync(join(paths.markers, name), "utf8")), runId };
          } catch {
            return { runId };
          }
        });
    },
  });
}
```

- [ ] **Step 4: Persist runs in the registry**

In `engine/jobs/job-registry.js`:

1. Imports: `import { createJobLedger } from "./job-ledger.js";`.
2. Export the sweep helper and the breaker phase set (Task 8 uses both):

```js
export const BREAKER_PHASES = Object.freeze(new Set(["rem", "deep"]));

/** @param {number} ms @returns {string} UTC day. */
export function sweepKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
```

3. `createJobRegistry({ host, jobsRoot = null, idFactory = … })`; inside it:

```js
  const ledgers = new Map();
  const recovered = new Set();
  function ledgerFor(agentId) {
    if (!jobsRoot) return null;
    let ledger = ledgers.get(agentId);
    if (!ledger) {
      ledger = createJobLedger({ root: jobsRoot, agentId, logger: host.logger });
      ledgers.set(agentId, ledger);
    }
    return ledger;
  }
  function rowOf(run) {
    return {
      ...run,
      sweep: sweepKey(run.startedAt),
      llmSession: BREAKER_PHASES.has(run.phase) && run.outcome !== "skipped",
    };
  }
  function recoverOnce(agentId, ledger) {
    if (recovered.has(agentId)) return;
    recovered.add(agentId);
    const finished = new Set(ledger.readAll().map((row) => row.runId));
    for (const marker of ledger.orphanMarkers()) {
      if (!finished.has(marker.runId)) {
        const startedAt = Number.isFinite(marker.startedAt) ? marker.startedAt : clock();
        const finishedAt = clock();
        ledger.append(rowOf({
          runId: marker.runId,
          job: marker.job ?? "unknown",
          phase: marker.phase ?? null,
          agentId,
          trigger: marker.trigger ?? "cron",
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          outcome: "failed",
          reason: "crash",
          attempt: 1,
          cost: { ms: 0 },
          counts: {},
        }));
        host.logger.warn(`plur1bus job ${marker.job ?? "unknown"}[${agentId}]: run ${marker.runId} left no ledger row; recorded as crash`);
      }
      ledger.removeMarker(marker.runId);
    }
  }
```

`recoverOnce` runs synchronously at the top of a process's first `run()` for that agent, before that run's own marker exists, so it can never mistake a live run of this process for a crash.

4. `finish(inflight, exit, error)` gains a fourth parameter `ledger` and, after building `run` and before the `info` log, persists it:

```js
    if (ledger) {
      try {
        ledger.append(rowOf(run));
        ledger.removeMarker(run.runId);
      } catch (persistError) {
        host.logger.warn(`plur1bus job ${run.job}[${run.agentId}]: ledger append failed; the marker stays for crash recovery: ${String(persistError?.message || persistError)}`);
      }
    }
```

A row that cannot be appended leaves its marker behind, so the next start still records the run (as `crash`) instead of losing it.

5. In `run()`, directly after `inflight` is built and before `const owner = …`:

```js
    const ledger = ledgerFor(agentId);
    if (ledger) {
      try {
        recoverOnce(agentId, ledger);
        ledger.writeMarker(inflight);
      } catch (writeError) {
        host.logger.warn(`plur1bus job ${name}[${agentId}]: ledger unwritable, not running: ${String(writeError?.message || writeError)}`);
        return finish(inflight, jobExit("failed", "ledger_unwritable", undefined), writeError, null);
      }
    }
```

and the final `return finish(inflight, exit, error);` becomes `return finish(inflight, exit, error, ledger);`.

6. Replace `history: async () => []` with:

```js
    history: async (agentId, { job, since, limit } = {}) => {
      const ledger = ledgerFor(agentId);
      if (!ledger) return [];
      let rows = ledger.readAll();
      if (job) rows = rows.filter((row) => row.job === job);
      if (Number.isFinite(since)) rows = rows.filter((row) => row.startedAt >= since);
      rows.reverse();
      return Number.isInteger(limit) && limit >= 0 ? rows.slice(0, limit) : rows;
    },
```

Update the file's docblock: every run writes `<runId>.started` first; every exit appends one row and removes the marker.

- [ ] **Step 5: Root the ledger and route light dreams through it**

`index.js` — Task 6's line becomes `const jobs = createJobRegistry({ host, jobsRoot: join(baseDbPath, "_jobs") });` and `registerCaptureHook({…})` gains `jobs,`.

`engine/capture/capture-turn.js`:

1. Add `jobs = null,` to the ctx destructuring.
2. Right after the destructuring closes (before `return async function`), bind the light-dream owner:

```js
  jobs?.bind("light-dream", async (_name, jobCtx) => {
    const work = jobCtx.input?.work;
    if (typeof work !== "function") return jobCtx.skip("no_turns");
    return { dreamed: await work() };
  });
```

3. Replace the `postProcessing.push(lightDream({ … }).then((dreamResult) => { … }).catch((dreamErr) => { … }));` statement (`:750-803`) with a thunk and a registry call. Keep the `lightDream({ … })` argument object and the `.then(...)` body byte-for-byte:

```js
              const lightDreamWork = () => lightDream({
                /* the existing argument object, :751-788, unchanged */
              }).then((dreamResult) => {
                /* the existing .then body, :789-798, unchanged — it ends with `return true;` */
              });
              postProcessing.push(jobs
                ? jobs.run("light-dream", agentId, { trigger: "capture", signal, input: { work: lightDreamWork } })
                  .then((dreamRun) => {
                    if (dreamRun.outcome === "failed") {
                      host.logger.warn?.(`memory-lancedb-namespaced: light dream failed: ${String(dreamRun.error)}`);
                    }
                    return dreamRun.outcome === "completed";
                  })
                : lightDreamWork().catch((dreamErr) => {
                  host.logger.warn?.(`memory-lancedb-namespaced: light dream failed: ${String(dreamErr)}`);
                  return false;
                }));
```

The warning text is identical on both paths (`String(error)` of the same thrown value), and the pushed promise still resolves `true`/`false`.

- [ ] **Step 6: Run the tests, register, verify, commit**

`ENGINE_PATHS`: `jobLedger: "engine/jobs/job-ledger.js",`; `DEPLOY_FILES`: `"engine/jobs/job-ledger.js",`.

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-ledger.test.js tests/engine-jobs-registry.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-capture-turn.test.js tests/auto-capture-*.test.js tests/light-dream*.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -4
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
cd "$PLUR1BUS" && ls ~/.openclaw 2>/dev/null | grep -c . ; find /tmp -maxdepth 3 -name ledger.jsonl -newer package.json 2>/dev/null | head -3
git add engine index.js tests scripts/lib/deploy-integrity.mjs
git commit -m "feat(jobs): append-only run ledger with started-markers and crash detection

PR-08 part 1 (spec 3.3). jobs.run writes <runId>.started before the body and
appends exactly one JobRun row for every exit; an unwritable ledger fails the
run without invoking the body, and an orphaned marker becomes failed/crash on
the next start. Ledger root is <baseDbPath>/_jobs/<agentId>/ (spec named
<stateDir>/<agentId>/jobs; see plan). Light dreams run through the registry."
```

Expected: both jobs files green (`tests 6` + `tests 7`); capture tests green (adjust globs to what `ls tests | grep -i 'capture\|light'` shows); golden 10/10; lint and suite green. The `ls ~/.openclaw` / `find` line is a manual check: no new `ledger.jsonl` may appear outside a temp dir after the suite — if one does under `~/.openclaw` or a non-temp `baseDbPath`, a test registers the plugin with a real path and must be pointed at `makeTempDir()`.

---

### Task 8 (PR-08b): retry, `abandoned`, the per-sweep breaker, ledger-backed `already_processed`

Spec §3.3 "Semantics" (behaviour change, owner decision a) and step 6's gates. Today a REM week without a narrative stays open and is retried every night indefinitely (`lib/dreaming/rem-dream.js:1327-1338`); `already_processed` comes from `run-state.json` (`lib/dreaming/rem-dream.js:1169`, `lib/neo-arch.js:1916-1925`). After this task: completion is read from the ledger's `completed` keys; a no-narrative run records `incomplete`; the third consecutive `incomplete` for the same key records `abandoned` and writes the reason into the dream diary; an abandoned key is skipped with reason `abandoned`; and the rem/deep phases share a breaker of **3 LLM sessions per agent per sweep** counted from ledger rows (`/home/claude/PLUR1BUS-Harness/docs/assumptions.md` Q11). No such breaker exists in the code today (`grep -rni "circuit" lib engine index.js` finds none outside reranker/tie-breaker comments); this task introduces it. "Sweep" is the UTC day of `startedAt` until the M1b-3 scheduler defines sweeps explicitly.

**Files:**
- Create: `engine/jobs/rem-outcome.js`
- Modify: `engine/jobs/job-registry.js` (attempt/abandon in `finish`, breaker in `run`, key lookups on `jobCtx`)
- Modify: `engine/jobs/internal-job-bodies.js` — the `rem-dream` branch (moved from `plur1bus-command.js:599-699`)
- Modify: `lib/dreaming/rem-dream.js:1296-1308` (diary outcome) and `:1375` (return it)
- Modify: `tests/fixtures/golden-prefix/scenarios.js` (`JOB_SCENARIOS`), `tests/golden-prefix.test.js`, `tools/capture-golden-prefix.mjs`
- Create: `tests/helpers/golden-jobs-driver.js`, `tests/engine-jobs-retry.test.js`, `tests/fixtures/golden-prefix/expected/jobs-ledger-retry.txt` (captured once)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`

**Interfaces:**
- Consumes: Task 7's ledger, `sweepKey`, `BREAKER_PHASES`; `appendDreamDiaryEntry({ workspaceDir, narrative, mode, timezone, now, logger })` (`lib/dreaming/dream-diary.js:146-170`).
- Produces:
  - `MAX_ATTEMPTS = 3` (original + 2 retries), `BREAKER_LIMIT = 3`
  - `jobCtx.hasCompletedKey(key) -> boolean`, `jobCtx.isAbandonedKey(key) -> boolean`, `jobCtx.noteAbandonedKey(key)`
  - `remJobOutcome(remRuns, { narrativeExpected, dryRun }) -> { outcome: "completed"|"incomplete"|"skipped", reason?, pendingKeys: string[], diary?: {written, reason?} }`
  - `ledgerBackedCompletion(store, jobCtx) -> store'` (a frozen copy whose `hasCompletedRun`/`markRunCompleted` consult/feed the ledger)
  - `runRemDream(...)` returns `{ report, trends, diary }` (additive `diary`; `report` unchanged)
  - `runJobScenario(scenario) -> Promise<string>` (golden text: normalized ledger rows + the diary)

- [ ] **Step 1: Write the failing test**

Create `tests/engine-jobs-retry.test.js`:

```js
/**
 * tests/engine-jobs-retry.test.js — PR-08 part 2 (behaviour change, owner decision a).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry } from "../engine/jobs/job-registry.js";
import { ledgerBackedCompletion, remJobOutcome } from "../engine/jobs/rem-outcome.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DAY = 86_400_000;
const KEY = "rem:w:agent-a:private:2026-W02";

function setup() {
  const root = makeTempDir("plur1bus-retry-");
  const workspaceDir = makeTempDir("plur1bus-retry-ws-");
  let now = Date.UTC(2026, 0, 13, 1, 15);
  let n = 0;
  const host = createStubHost({ clock: () => now });
  const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: () => `run-${++n}` });
  return { root, workspaceDir, jobs, advance: (ms) => { now += ms; } };
}

function bindNoNarrativeRem(jobs, workspaceDir) {
  jobs.bind("rem-dream", async (_n, ctx) => {
    if (ctx.isAbandonedKey(KEY)) return ctx.skip("abandoned", { text: "abandoned" });
    if (ctx.hasCompletedKey(KEY)) return ctx.skip("already_processed", { text: "done" });
    ctx.notePendingKey(KEY);
    ctx.setDiaryTarget(workspaceDir);
    return ctx.incomplete("no_narrative", { text: "open" });
  });
}

describe("retry and abandon", () => {
  it("incomplete is retried on the next sweep with attempt+1 and abandoned after two retries", async () => {
    const { jobs, workspaceDir, advance } = setup();
    bindNoNarrativeRem(jobs, workspaceDir);
    const outcomes = [];
    for (let day = 0; day < 4; day++) {
      const run = await jobs.run("rem-dream", "agent-a", { trigger: "cron" });
      outcomes.push([run.outcome, run.attempt, run.reason]);
      advance(DAY);
    }
    assert.deepEqual(outcomes, [
      ["incomplete", 1, "no_narrative"],
      ["incomplete", 2, "no_narrative"],
      ["abandoned", 3, "abandoned_after_retries:no_narrative"],
      ["skipped", 1, "abandoned"],
    ]);
    const diary = readFileSync(join(workspaceDir, "DREAMS.md"), "utf8");
    assert.match(diary, /abandoned after 3 attempts/);
    const [abandoned] = await jobs.history("agent-a", { limit: 2 }).then((rows) => rows.filter((r) => r.outcome === "abandoned"));
    assert.deepEqual(abandoned.diary, { written: true });
    assert.deepEqual(abandoned.pendingKeys, [KEY]);
  });

  it("already_processed only after a completed row for the same key", async () => {
    const { jobs } = setup();
    let completeNow = false;
    jobs.bind("rem-dream", async (_n, ctx) => {
      if (ctx.hasCompletedKey(KEY)) return ctx.skip("already_processed");
      if (!completeNow) { ctx.notePendingKey(KEY); return ctx.incomplete("no_narrative"); }
      ctx.markCompletedKey(KEY);
      return { text: "dreamed" };
    });
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "incomplete");
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "incomplete");
    completeNow = true;
    const done = await jobs.run("rem-dream", "agent-a");
    assert.deepEqual([done.outcome, done.attempt, done.keys], ["completed", 3, [KEY]]);
    const again = await jobs.run("rem-dream", "agent-a");
    assert.deepEqual([again.outcome, again.reason], ["skipped", "already_processed"]);
  });

  it("the breaker counts ledger rows: a fourth rem/deep LLM session in one sweep is skipped", async () => {
    const { jobs, advance } = setup();
    let bodies = 0;
    jobs.bind("rem-dream", async (_n, ctx) => { bodies += 1; ctx.notePendingKey(`${KEY}:${bodies}`); return ctx.incomplete("no_narrative"); });
    jobs.bind("consolidate-daily", async () => { bodies += 1; return { text: "ok" }; });
    jobs.bind("gc-run", async () => ({ text: "not a phase job" }));
    const results = [];
    for (const name of ["rem-dream", "consolidate-daily", "rem-dream", "gc-run", "rem-dream", "consolidate-daily"]) {
      const run = await jobs.run(name, "agent-a");
      results.push([name, run.outcome, run.reason ?? null]);
      advance(60_000);
    }
    assert.deepEqual(results.slice(-2), [["rem-dream", "skipped", "circuit_open"], ["consolidate-daily", "skipped", "circuit_open"]]);
    assert.equal(bodies, 3);
    advance(DAY);
    assert.equal((await jobs.run("consolidate-daily", "agent-a")).outcome, "completed", "next sweep resets the breaker");
  });

  it("a body that throws after writing the diary records failed with the diary outcome (Review Focus 4)", async () => {
    const { jobs, root } = setup();
    jobs.bind("rem-dream", async (_n, ctx) => { ctx.noteDiary({ written: true }); throw new Error("after diary"); });
    const run = await jobs.run("rem-dream", "agent-a");
    assert.deepEqual([run.outcome, run.diary], ["failed", { written: true }]);
    const [row] = await jobs.history("agent-a");
    assert.deepEqual(row.diary, { written: true });
    assert.deepEqual(readdirSync(join(root, "agent-a", "running")), []);
  });
});

describe("remJobOutcome", () => {
  const report = (runKey, narrative) => ({ result: { report: { runKey, narrative }, trends: [] }, scope: "agent" });
  it("no narrative where one is expected is incomplete", () => {
    assert.deepEqual(remJobOutcome([report("k1", null)], { narrativeExpected: true, dryRun: false }), { outcome: "incomplete", reason: "no_narrative", pendingKeys: ["k1"] });
  });
  it("a narrative, or none expected, is completed", () => {
    assert.equal(remJobOutcome([report("k1", "a dream")], { narrativeExpected: true, dryRun: false }).outcome, "completed");
    assert.equal(remJobOutcome([report("k1", null)], { narrativeExpected: false, dryRun: false }).outcome, "completed");
  });
  it("all partitions skipped is skipped with the first reason", () => {
    const skipped = (reason) => ({ result: { skipped: true, reason }, scope: "agent" });
    assert.deepEqual(remJobOutcome([skipped("too_few_memories"), skipped("lock_held")], { narrativeExpected: true, dryRun: false }), { outcome: "skipped", reason: "too_few_memories", pendingKeys: [] });
  });
});

describe("ledgerBackedCompletion", () => {
  it("keeps the ACL binding and routes completion through the job context", async () => {
    const calls = [];
    const store = Object.freeze({ aclBindings: { scope: "agent" }, hasCompletedRun: () => true, markRunCompleted: (k) => calls.push(["store", k]), readPatterns: () => [] });
    const seen = [];
    const ctx = { hasCompletedKey: (k) => k === "done", isAbandonedKey: (k) => k === "gone", noteAbandonedKey: (k) => seen.push(["abandoned", k]), markCompletedKey: (k) => seen.push(["completed", k]) };
    const wrapped = ledgerBackedCompletion(store, ctx);
    assert.equal(wrapped.aclBindings, store.aclBindings);
    assert.equal(await wrapped.hasCompletedRun("new"), false, "run-state.json is no longer consulted");
    assert.equal(await wrapped.hasCompletedRun("done"), true);
    assert.equal(await wrapped.hasCompletedRun("gone"), true);
    await wrapped.markRunCompleted("k2", {});
    assert.deepEqual(seen, [["abandoned", "gone"], ["completed", "k2"]]);
    assert.deepEqual(calls, [["store", "k2"]], "run-state.json keeps being written for rollback");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-retry.test.js 2>&1 | tail -8
```

Expected: `ERR_MODULE_NOT_FOUND … engine/jobs/rem-outcome.js`.

- [ ] **Step 3: Create `engine/jobs/rem-outcome.js`**

```js
/**
 * engine/jobs/rem-outcome.js — REM run semantics over the ledger (PR-08).
 *
 * A REM job runs one pass per ACL partition. The job is incomplete when any
 * partition produced a report without the narrative it was expected to
 * produce (lib/dreaming/rem-dream.js leaves that week open); completion is
 * keyed by the partition's runKey and read from the ledger, not from
 * run-state.json.
 */

/**
 * @param {Array<{scope: string, result: object}>} remRuns
 * @param {{narrativeExpected: boolean, dryRun: boolean}} options
 * @returns {{outcome: "completed"|"incomplete"|"skipped", reason?: string, pendingKeys: string[]}}
 */
export function remJobOutcome(remRuns, { narrativeExpected, dryRun }) {
  const pendingKeys = [];
  let completed = 0;
  let firstSkipReason = null;
  for (const run of remRuns) {
    const result = run?.result;
    if (result?.report) {
      if (!dryRun && narrativeExpected && !result.report.narrative) pendingKeys.push(result.report.runKey);
      else completed += 1;
    } else if (result?.skipped && firstSkipReason === null) {
      firstSkipReason = result.reason || "skipped";
    }
  }
  if (pendingKeys.length > 0) return { outcome: "incomplete", reason: "no_narrative", pendingKeys };
  if (completed > 0) return { outcome: "completed", pendingKeys };
  return { outcome: "skipped", reason: firstSkipReason || "no_partition", pendingKeys };
}

/**
 * @param {object} store Owner-bound Neo store (a frozen plain object).
 * @param {{hasCompletedKey: Function, isAbandonedKey: Function, noteAbandonedKey: Function, markCompletedKey: Function}} jobCtx
 * @returns {object} The same store with completion routed through the ledger.
 */
export function ledgerBackedCompletion(store, jobCtx) {
  return Object.freeze({
    ...store,
    hasCompletedRun: async (runKey) => {
      if (jobCtx.isAbandonedKey(runKey)) {
        jobCtx.noteAbandonedKey(runKey);
        return true;
      }
      return jobCtx.hasCompletedKey(runKey);
    },
    markRunCompleted: async (runKey, meta, partition) => {
      jobCtx.markCompletedKey(runKey);
      return store.markRunCompleted(runKey, meta, partition);
    },
  });
}
```

The owner-bound store is a frozen spread of `createNeoStore(...)` plus `aclBindings` (`index.js:5205-5208`), so a spread copy keeps `aclBindings`, which is all `boundAclFor` reads (`lib/dreaming/rem-dream.js:901-903`).

- [ ] **Step 4: Retry, abandon and the breaker in the registry**

In `engine/jobs/job-registry.js`:

1. `import { appendDreamDiaryEntry } from "../../lib/dreaming/dream-diary.js";` and export `export const MAX_ATTEMPTS = 3;` and `export const BREAKER_LIMIT = 3;`.
2. A module-level helper:

```js
function priorIncompleteStreak(rows, job, pendingKeys) {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.job !== job || row.outcome === "skipped") continue;
    if (row.outcome !== "incomplete") break;
    const rowKeys = Array.isArray(row.pendingKeys) ? row.pendingKeys : [];
    if (pendingKeys.length > 0 && rowKeys.length > 0 && !rowKeys.some((key) => pendingKeys.includes(key))) break;
    streak += 1;
  }
  return streak;
}
```

A skipped row (breaker, `already_processed`, `abandoned`) neither counts nor breaks a streak; any other outcome breaks it.

3. `jobContext(inflight, { signal, input, ledger })` gains three members:

```js
      hasCompletedKey: (key) => (ledger ? ledger.readAll().some((row) => Array.isArray(row.keys) && row.keys.includes(key)) : false),
      isAbandonedKey: (key) => (ledger ? ledger.readAll().some((row) => row.outcome === "abandoned" && Array.isArray(row.pendingKeys) && row.pendingKeys.includes(key)) : false),
      noteAbandonedKey: (key) => { if (key && !inflight.abandonedKeys.includes(key)) inflight.abandonedKeys.push(String(key)); },
```

and `inflight` gets `abandonedKeys: []`. Pass `ledger` where `run()` calls `jobContext`.

4. In `finish(…, ledger)`, before building `run`, compute attempt and abandon:

```js
    let outcome = exit.outcome;
    let reason = exit.reason;
    if (ledger && outcome !== "skipped") {
      const streak = priorIncompleteStreak(ledger.readAll(), inflight.job, inflight.pendingKeys);
      inflight.attempt = streak + 1;
      if (outcome === "incomplete" && inflight.attempt >= MAX_ATTEMPTS) {
        outcome = "abandoned";
        reason = `abandoned_after_retries:${exit.reason || "incomplete"}`;
        const diary = appendDreamDiaryEntry({
          workspaceDir: inflight.diaryTarget,
          narrative: `REM run abandoned after ${inflight.attempt} attempts: ${exit.reason || "incomplete"}.`,
          mode: "rem",
          now: clock,
          logger: host.logger,
        });
        inflight.diary = { written: diary.written === true, ...(diary.reason ? { reason: diary.reason } : {}) };
      }
    }
    if (outcome === "skipped" && exit.reason === "already_processed" && inflight.abandonedKeys.length > 0) {
      reason = "abandoned";
    }
```

and use `outcome`/`reason` instead of `exit.outcome`/`exit.reason` in the `run` literal. `appendDreamDiaryEntry` returns `{ written: false, reason: "no_workspace" }` for a missing target (`lib/dreaming/dream-diary.js:154`), which the row then records.

5. In `run()`, after the marker is written and before `const owner = …`, the breaker:

```js
    if (ledger && BREAKER_PHASES.has(spec.phase) && !preSkip) {
      const sweep = sweepKey(inflight.startedAt);
      const sessions = ledger.readAll().filter((row) => row.sweep === sweep && row.llmSession === true && BREAKER_PHASES.has(row.phase)).length;
      if (sessions >= BREAKER_LIMIT) {
        return finish(inflight, jobExit("skipped", "circuit_open", {
          text: JSON.stringify({ job: name, skipped: true, reason: "circuit_open" }, null, 2),
        }), null, ledger);
      }
    }
```

The reply has the exact shape `formatJsonCommandResult` produces for every other skip (`index.js:3183-3185`).

- [ ] **Step 5: Wire the REM body to the ledger**

In `engine/jobs/internal-job-bodies.js`, inside the `rem-dream` branch:

1. `const remStore = createOwnerBoundNeoStore(remAclPartition);` becomes `const remStore = ledgerBackedCompletion(createOwnerBoundNeoStore(remAclPartition), jobCtx);` (import `ledgerBackedCompletion, remJobOutcome` from `./rem-outcome.js`).
2. After `remRuns.push({ scope: remAclPartition.scope, result: partitionResult });` add `if (partitionResult?.diary) jobCtx.noteDiary(partitionResult.diary);`.
3. Replace the branch's final `return formatJsonCommandResult({ job: "rem-dream", partitions: …, ...(result.report || result) });` with:

```js
        const remReply = formatJsonCommandResult({
          job: "rem-dream",
          partitions: remRuns.map((run) => describeRemPartitionRun(run)),
          ...(result.report || result),
        });
        const verdict = remJobOutcome(remRuns, { narrativeExpected: dreamNarrativeCfg?.enabled !== false, dryRun: false });
        for (const key of verdict.pendingKeys) jobCtx.notePendingKey(key);
        jobCtx.setDiaryTarget(memoryCtx?.workspaceDir || null);
        if (verdict.outcome === "incomplete") return jobCtx.incomplete(verdict.reason, remReply);
        if (verdict.outcome === "skipped") return jobCtx.skip(verdict.reason, remReply);
        return remReply;
```

`narrativeExpected` mirrors `const narrativeExpected = narrativeCfg?.enabled !== false;` (`lib/dreaming/rem-dream.js:1336`), with `narrativeCfg: dreamNarrativeCfg` being what the branch passes (`plur1bus-command.js:663`).

In `lib/dreaming/rem-dream.js`: declare `let diaryOutcome = { written: false, reason: "not_attempted" };` next to `let narrative = null;` (`:1235`); inside the diary block, after `const diary = appendDreamDiaryEntry({…});` (`:1298-1304`), add `diaryOutcome = { written: diary.written === true, ...(diary.reason ? { reason: diary.reason } : {}) };`; and change `:1375` `return { report, trends };` to `return { report, trends, diary: diaryOutcome };`. `report` and the command reply (built from `result.report`) are unchanged; `describeRemPartitionRun` copies only typed fields it knows (`lib/dreaming/rem-dream.js:117-126`).

- [ ] **Step 6: Add the `jobs-ledger-retry` golden scenario**

Append to `tests/fixtures/golden-prefix/scenarios.js`:

```js
/**
 * Job-ledger scenarios: the ledger rows (and the dream diary) a sequence of
 * sweeps leaves behind, under a virtual clock. Written once, like the prefix
 * oracle.
 */
export const JOB_SCENARIOS = [
  {
    // REM produces no narrative four nights running inside one REM week:
    // incomplete (attempt 1), incomplete (2), abandoned (3, reason written to
    // DREAMS.md), then skipped as abandoned.
    name: "jobs-ledger-retry",
    agentId: AGENT,
    job: "rem-dream",
    runKey: `rem:${WORKSPACE}:${AGENT}:private:2026-W02`,
    sweeps: [
      Date.UTC(2026, 0, 13, 0, 15),
      Date.UTC(2026, 0, 14, 0, 15),
      Date.UTC(2026, 0, 15, 0, 15),
      Date.UTC(2026, 0, 16, 0, 15),
    ],
  },
];
```

Create `tests/helpers/golden-jobs-driver.js`:

```js
/**
 * tests/helpers/golden-jobs-driver.js
 *
 * Runs one job-ledger scenario against the real registry and ledger with a
 * virtual clock. The REM body is a stub that reports "no narrative" exactly
 * like the real one does through remJobOutcome; what is under test is the
 * ledger's retry/abandon semantics and the diary line, not REM itself.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry } from "../../engine/jobs/job-registry.js";
import { createStubHost } from "../../lib/host-services.js";
import { makeTempDir } from "./temp-dir.js";

const STABLE_FIELDS = ["runId", "job", "phase", "agentId", "trigger", "startedAt", "finishedAt", "outcome", "reason", "attempt", "keys", "pendingKeys", "diary", "sweep", "llmSession"];

/**
 * @param {object} scenario One of JOB_SCENARIOS.
 * @returns {Promise<string>} Normalized ledger rows, then the diary.
 */
export async function runJobScenario(scenario) {
  const root = makeTempDir("plur1bus-golden-jobs-");
  const workspaceDir = makeTempDir("plur1bus-golden-jobs-ws-");
  let now = scenario.sweeps[0];
  let n = 0;
  const host = createStubHost({ clock: () => now });
  const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: () => `run-${++n}` });
  jobs.bind(scenario.job, async (_name, ctx) => {
    if (ctx.isAbandonedKey(scenario.runKey)) return ctx.skip("abandoned");
    if (ctx.hasCompletedKey(scenario.runKey)) return ctx.skip("already_processed");
    ctx.notePendingKey(scenario.runKey);
    ctx.setDiaryTarget(workspaceDir);
    return ctx.incomplete("no_narrative");
  });
  for (const at of scenario.sweeps) {
    now = at;
    await jobs.run(scenario.job, scenario.agentId, { trigger: "cron" });
  }
  const rows = (await jobs.history(scenario.agentId)).reverse().map((row) => {
    const stable = {};
    for (const field of STABLE_FIELDS) if (row[field] !== undefined) stable[field] = row[field];
    return JSON.stringify(stable);
  });
  const diaryPath = join(workspaceDir, "DREAMS.md");
  const diary = existsSync(diaryPath) ? readFileSync(diaryPath, "utf8") : "";
  return `${rows.join("\n")}\n--- DREAMS.md ---\n${diary}`;
}
```

`tests/golden-prefix.test.js` — import `JOB_SCENARIOS` and `runJobScenario`, and add after the prefix loop:

```js
  for (const scenario of JOB_SCENARIOS) {
    it(`${scenario.name} leaves the recorded ledger byte for byte`, async () => {
      const expected = readFileSync(join(expectedDir, `${scenario.name}.txt`), "utf8");
      assert.equal(await runJobScenario(scenario), expected);
    });
  }
```

`tools/capture-golden-prefix.mjs` — import both, and after the prefix loop run the same double-capture for `JOB_SCENARIOS` with `runJobScenario` (same `--only` filter, same non-determinism refusal, same overwrite refusal), then change the final message to count both lists.

- [ ] **Step 7: Capture once, check, verify, commit**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/capture-golden-prefix.mjs --only=jobs-ledger-retry
cd "$PLUR1BUS" && cat tests/fixtures/golden-prefix/expected/jobs-ledger-retry.txt
```

Expected: four JSON rows with `outcome` `incomplete`, `incomplete`, `abandoned`, `skipped`; `attempt` 1, 2, 3, 1; the third row carries `"diary":{"written":true}` and `"reason":"abandoned_after_retries:no_narrative"`; the fourth `"reason":"abandoned"`; then `--- DREAMS.md ---` and a diary section containing `REM run abandoned after 3 attempts: no_narrative.` dated `2026-01-15`. Anything else means the registry logic is wrong — fix the code, delete the file, re-capture.

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-retry.test.js tests/engine-jobs-ledger.test.js tests/engine-jobs-registry.test.js tests/rem-dream*.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && git diff --stat 91dfce25 -- tests/fixtures/golden-prefix/expected/
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add engine lib/dreaming/rem-dream.js tests tools/capture-golden-prefix.mjs scripts/lib/deploy-integrity.mjs
git commit -m "feat(jobs): retry, abandon and the per-sweep breaker over the ledger

PR-08 part 2 (spec 3.3, behaviour change, owner decision a). REM completion is
read from ledger keys; a no-narrative run is incomplete, retried on the next
sweep, and abandoned after two retries with the reason in DREAMS.md. rem/deep
runs share a breaker of 3 LLM sessions per agent per sweep, counted from
ledger rows. Golden: new write-once scenario jobs-ledger-retry."
```

Expected: the jobs files and the existing REM tests green; golden `pass 11` (8 prefix + 1 job + determinism + count); the diff stat lists exactly the two added oracle files; lint and suite green. Register `engine/jobs/rem-outcome.js` in `ENGINE_PATHS` (`remOutcome`) and `DEPLOY_FILES` first.

---

### Task 9 (PR-08c): migrate `run-state.json` completions into the ledger

Spec §3.3 "Migration". **The spec and the code disagree on the file:** there is no `runs.json`; the REM completions live in `completed[runKey]` of each Neo store's **`run-state.json`** (`lib/neo-arch.js:1758`), and that same file carries other jobs' state — the memory-dynamics watermarks (`lib/jobs/memory-dynamics-maintenance.js:540-557`), memory-compaction state (`lib/jobs/memory-compaction.js:280-307`), and the reflection job's own `completed` keys (`lib/jobs/reflection-job.js:54,109`). Renaming it would break all three. This task therefore follows the spec's intent against the code: copy the file once to `run-state.json.migrated` (the rollback copy), import only this agent's `rem:` keys as `completed` rows with `cost: { ms: 0 }` and `migrated: true`, and mark the file with a per-agent migration timestamp so the import never repeats. `run-state.json` stays in place for its other readers; the REM completion check has not read it since Task 8.

**Files:**
- Create: `engine/jobs/run-state-migration.js`
- Modify: `engine/jobs/job-registry.js` (`jobCtx.migrateStore(store)`)
- Modify: `engine/jobs/rem-outcome.js` (`ledgerBackedCompletion` migrates the store it wraps, once)
- Create: `tests/fixtures/jobs/run-state.json`, `tests/engine-jobs-migration.test.js`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`

**Interfaces:**
- Consumes: the Neo store's `paths.runs` and `writeRunState` (`lib/neo-arch.js:1914-1915`); Task 7's ledger.
- Produces:
  - `MIGRATION_MARKER_KEY = "plur1busLedgerMigratedAt"` (a `{ [agentId]: ISO }` map inside `run-state.json`)
  - `migrateRunStateCompletions({ store, agentId, appendRow, clock, logger }) -> { migrated: number, status: "absent"|"already"|"corrupt"|"migrated" }`
  - `jobCtx.migrateStore(store) -> result` (at most once per `store.paths.runs` per registry)

- [ ] **Step 1: Create the fixture**

`tests/fixtures/jobs/run-state.json` — the real shape (`lib/neo-arch.js:1920-1925` writes `completed[runKey] = { completedAt, ...meta }`; `lib/dreaming/rem-dream.js:1344-1348` passes `patternsFound`, `memoriesProcessed`, `durationMs`; `buildRunKey` is `rem:${workspaceKey}:${agentId}:${partitionKey}:${weekOf}`, `:102-104`), with invented values and the neighbours the migration must not disturb:

```json
{
  "completed": {
    "rem:workspace:v1:main:agent-a:private:2026-W01": { "completedAt": "2026-01-06T00:20:11.000Z", "patternsFound": 4, "memoriesProcessed": 212, "durationMs": 58100 },
    "rem:workspace:v1:main:agent-a:workspace:2026-W01": { "completedAt": "2026-01-06T00:21:40.000Z", "patternsFound": 1, "memoriesProcessed": 37, "durationMs": 9100 },
    "rem:workspace:v1:main:agent-b:private:2026-W01": { "completedAt": "2026-01-06T00:25:00.000Z", "patternsFound": 2, "memoriesProcessed": 90, "durationMs": 20100 },
    "reflect:agent-a:2026-01-05": { "reflectedAt": "2026-01-05T03:00:00.000Z" }
  },
  "memoryDynamics": {
    "agent-a:workspace:v1:main": { "lastRetrievalLedgerProcessedAt": "2026-01-06T04:00:00.000Z" }
  },
  "compaction": { "lastRunAt": "2026-01-06T04:05:00.000Z" }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/engine-jobs-migration.test.js`:

```js
/**
 * tests/engine-jobs-migration.test.js — PR-08 part 3.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateRunStateCompletions, MIGRATION_MARKER_KEY } from "../engine/jobs/run-state-migration.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "jobs", "run-state.json");

function fakeStore() {
  const dir = makeTempDir("plur1bus-migrate-");
  const runs = join(dir, "run-state.json");
  copyFileSync(FIXTURE, runs);
  return {
    paths: { runs },
    writeRunState: (state) => writeFileSync(runs, JSON.stringify(state)),
  };
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe("run-state migration", () => {
  it("imports only this agent's rem keys as completed rows, keeps a copy, and marks the file", () => {
    const store = fakeStore();
    const rows = [];
    const result = migrateRunStateCompletions({ store, agentId: "agent-a", appendRow: (r) => rows.push(r), clock: () => Date.UTC(2026, 0, 13), logger: quiet });
    assert.deepEqual(result, { migrated: 2, status: "migrated" });
    assert.deepEqual(rows.map((r) => r.idempotencyKey).sort(), [
      "rem:workspace:v1:main:agent-a:private:2026-W01",
      "rem:workspace:v1:main:agent-a:workspace:2026-W01",
    ]);
    for (const row of rows) {
      assert.equal(row.outcome, "completed");
      assert.equal(row.migrated, true);
      assert.deepEqual(row.cost, { ms: 0 });
      assert.deepEqual(row.keys, [row.idempotencyKey]);
      assert.equal(row.job, "rem-dream");
    }
    assert.equal(rows.find((r) => r.idempotencyKey.endsWith("private:2026-W01")).startedAt, Date.parse("2026-01-06T00:20:11.000Z"));
    assert.equal(readFileSync(`${store.paths.runs}.migrated`, "utf8"), readFileSync(FIXTURE, "utf8"));
    const after = JSON.parse(readFileSync(store.paths.runs, "utf8"));
    assert.ok(after[MIGRATION_MARKER_KEY]["agent-a"]);
    assert.deepEqual(after.memoryDynamics, JSON.parse(readFileSync(FIXTURE, "utf8")).memoryDynamics, "neighbours untouched");
    assert.ok(after.completed["reflect:agent-a:2026-01-05"], "other jobs' completions untouched");
  });

  it("is a no-op the second time for the same agent, and still migrates another agent", () => {
    const store = fakeStore();
    const rows = [];
    const args = { store, appendRow: (r) => rows.push(r), clock: () => 1, logger: quiet };
    migrateRunStateCompletions({ ...args, agentId: "agent-a" });
    assert.deepEqual(migrateRunStateCompletions({ ...args, agentId: "agent-a" }), { migrated: 0, status: "already" });
    assert.deepEqual(migrateRunStateCompletions({ ...args, agentId: "agent-b" }), { migrated: 1, status: "migrated" });
  });

  it("a corrupt run-state.json imports nothing, is not rewritten, and is preserved (Review Focus 3)", () => {
    const store = fakeStore();
    writeFileSync(store.paths.runs, "{\"completed\": {\"rem:x");
    const warned = [];
    const result = migrateRunStateCompletions({ store, agentId: "agent-a", appendRow: () => assert.fail("no rows"), clock: () => 1, logger: { ...quiet, warn: (m) => warned.push(m) } });
    assert.deepEqual(result, { migrated: 0, status: "corrupt" });
    assert.equal(readFileSync(store.paths.runs, "utf8"), "{\"completed\": {\"rem:x");
    assert.equal(readFileSync(`${store.paths.runs}.migrated`, "utf8"), "{\"completed\": {\"rem:x");
    assert.equal(warned.length, 1);
  });

  it("an absent file is absent", () => {
    const dir = makeTempDir("plur1bus-migrate-none-");
    const store = { paths: { runs: join(dir, "run-state.json") }, writeRunState: () => assert.fail("no write") };
    assert.deepEqual(migrateRunStateCompletions({ store, agentId: "agent-a", appendRow: () => {}, clock: () => 1, logger: quiet }), { migrated: 0, status: "absent" });
    assert.equal(existsSync(`${store.paths.runs}.migrated`), false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail; then create the module**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-migration.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND`. Create `engine/jobs/run-state-migration.js`:

```js
/**
 * engine/jobs/run-state-migration.js — PR-08 part 3 (spec 3.3 "Migration").
 *
 * The spec names runs.json; the code's file is each Neo store's
 * run-state.json, shared with other jobs' state. So: keep a one-time copy
 * (run-state.json.migrated), import this agent's REM completions as
 * completed ledger rows, and mark the file per agent. The file itself stays
 * for its other readers; REM completion is read from the ledger only.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { sweepKey } from "./job-registry.js";

export const MIGRATION_MARKER_KEY = "plur1busLedgerMigratedAt";
const MIGRATED_SUFFIX = ".migrated";

function keepCopy(path, raw) {
  const copy = `${path}${MIGRATED_SUFFIX}`;
  if (!existsSync(copy)) writeFileSync(copy, raw);
}

/**
 * @param {{store: {paths?: {runs?: string}, writeRunState: (state: object) => unknown}, agentId: string, appendRow: (row: object) => void, clock: () => number, logger: {warn: (m: string) => void}}} options
 * @returns {{migrated: number, status: "absent"|"already"|"corrupt"|"migrated"}}
 */
export function migrateRunStateCompletions({ store, agentId, appendRow, clock, logger }) {
  const path = store?.paths?.runs;
  if (!path || !existsSync(path)) return { migrated: 0, status: "absent" };
  const raw = readFileSync(path, "utf8");
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    logger.warn(`plur1bus jobs: ${path} is not valid JSON; REM completions not migrated (${String(error?.message || error)})`);
    keepCopy(path, raw);
    return { migrated: 0, status: "corrupt" };
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    logger.warn(`plur1bus jobs: ${path} is not a JSON object; REM completions not migrated`);
    keepCopy(path, raw);
    return { migrated: 0, status: "corrupt" };
  }
  const marks = state[MIGRATION_MARKER_KEY] && typeof state[MIGRATION_MARKER_KEY] === "object" ? state[MIGRATION_MARKER_KEY] : {};
  if (marks[agentId]) return { migrated: 0, status: "already" };
  keepCopy(path, raw);
  let migrated = 0;
  for (const [runKey, meta] of Object.entries(state.completed || {})) {
    if (!runKey.startsWith("rem:") || !runKey.includes(`:${agentId}:`)) continue;
    const parsed = Date.parse(meta?.completedAt);
    const at = Number.isFinite(parsed) ? parsed : clock();
    const counts = {};
    for (const field of ["patternsFound", "memoriesProcessed"]) {
      if (Number.isFinite(meta?.[field])) counts[field] = meta[field];
    }
    appendRow({
      runId: `migrated:${runKey}`,
      job: "rem-dream",
      phase: "rem",
      agentId,
      trigger: "cron",
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      outcome: "completed",
      reason: "migrated",
      attempt: 1,
      cost: { ms: 0 },
      counts,
      keys: [runKey],
      idempotencyKey: runKey,
      migrated: true,
      sweep: sweepKey(at),
      llmSession: false,
    });
    migrated += 1;
  }
  store.writeRunState({ ...state, [MIGRATION_MARKER_KEY]: { ...marks, [agentId]: new Date(clock()).toISOString() } });
  return { migrated, status: "migrated" };
}
```

`runKey.includes(":<agentId>:")` works because `buildRunKey` always places the agent id between colons and agent ids cannot contain a colon-delimited prefix of another id's form (`lib/sql-safety.js:84`); a workspace key that happens to contain `:agent-a:` would import a foreign key harmlessly (an extra `completed` row for a key that agent never computes).

`run-state-migration.js` imports `sweepKey` from `job-registry.js`; `job-registry.js` must therefore not import `run-state-migration.js` at module top level, or lint rule 3 reports the cycle. The registry receives the migration function injected from `rem-outcome.js` instead (next step).

- [ ] **Step 4: Migrate each REM store once, on first wrap**

`engine/jobs/job-registry.js` — `jobContext` gains:

```js
      migrateStore: (store, migrate) => {
        const key = store?.paths?.runs;
        if (!ledger || !key || migratedStores.has(`${inflight.agentId}\u0000${key}`)) return null;
        migratedStores.add(`${inflight.agentId}\u0000${key}`);
        return migrate({ store, agentId: inflight.agentId, appendRow: (row) => ledger.append(row), clock, logger: host.logger });
      },
```

with `const migratedStores = new Set();` in `createJobRegistry`. The migration function is a parameter so the registry never imports the migration module.

`engine/jobs/rem-outcome.js` — import `migrateRunStateCompletions` from `./run-state-migration.js`, and make `ledgerBackedCompletion` start with:

```js
  jobCtx.migrateStore?.(store, migrateRunStateCompletions);
```

Migrated rows are appended before the wrapped store's first `hasCompletedRun`, so the week keys a user already finished stay `already_processed` across the upgrade.

- [ ] **Step 5: A registry-level migration test, then verify and commit**

Append to `tests/engine-jobs-migration.test.js`:

```js
import { createJobRegistry } from "../engine/jobs/job-registry.js";
import { ledgerBackedCompletion } from "../engine/jobs/rem-outcome.js";
import { createStubHost } from "../lib/host-services.js";

describe("migration through the REM wrapper", () => {
  it("keeps a finished week already_processed across the upgrade", async () => {
    const store = { ...fakeStore(), aclBindings: { scope: "agent" }, markRunCompleted: () => {} };
    const jobs = createJobRegistry({ host: createStubHost({ clock: () => Date.UTC(2026, 0, 13) }), jobsRoot: makeTempDir("plur1bus-migrate-ledger-") });
    let seen = null;
    jobs.bind("rem-dream", async (_n, ctx) => {
      const wrapped = ledgerBackedCompletion(Object.freeze(store), ctx);
      seen = await wrapped.hasCompletedRun("rem:workspace:v1:main:agent-a:private:2026-W01");
      return ctx.skip("already_processed");
    });
    await jobs.run("rem-dream", "agent-a");
    assert.equal(seen, true);
    const history = await jobs.history("agent-a");
    assert.equal(history.filter((r) => r.migrated === true).length, 2);
  });
});
```

`ENGINE_PATHS`: `runStateMigration: "engine/jobs/run-state-migration.js",`; `DEPLOY_FILES` likewise.

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-jobs-migration.test.js tests/engine-jobs-retry.test.js tests/engine-jobs-ledger.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -4
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add engine tests scripts/lib/deploy-integrity.mjs
git commit -m "feat(jobs): migrate run-state.json REM completions into the ledger

PR-08 part 3 (spec 3.3). The spec's runs.json is each Neo store's
run-state.json, shared with other jobs' state, so it is copied once to
run-state.json.migrated and marked per agent instead of renamed. This agent's
rem: keys become completed rows (cost {ms:0}, migrated:true); a corrupt file
is preserved and not rewritten."
```

Expected: all jobs files green; `lint-engine-imports: clean` (no cycle); golden 11/11; lint and suite green.

---

### Task 10 (PR-06): `Principal` and `AgentContext` as explicit inputs; channel registry

Spec §3.4 bullets 1–2 and step 7. Three moves: (1) `resolveMemoryRequestContext` gains a constructor from a `Principal` (`engine/identity/principal.js`), and `resolveHostHookMemoryContext` reports whether its six-step ticket proof succeeded (`proved`) or fell back (`inferred`) without changing a byte of its logic; (2) the hook-identity code leaves the recall assembler for the adapter (`adapter/openclaw/turn-principal.js`), which is what "the adapter keeps `resolveHostHookMemoryContext` + the `reply_dispatch` ticket" means, and the recall/capture/command entry points accept an explicit `{ memoryCtx, agentContext }`; (3) `index.js`'s `isCronCommandContext` string matching (`index.js:6930-6936`) moves to the adapter and reaches the engine as `agentContext.origin`, and the four-provider set (`lib/memory-request-context.js:25`) becomes a registry.

**Files:**
- Create: `engine/identity/principal.js`, `adapter/openclaw/turn-principal.js`
- Modify: `lib/memory-request-context.js:25` (registry), `:463` (use it), `:1259-1418` (`resolveHostHookPrincipal`)
- Modify: `engine/recall/assemble-prompt-context.js:143-192` (options, identity block)
- Modify: `engine/capture/capture-turn.js:45` (options) and `:150-166` (identity)
- Modify: `engine/commands/plur1bus-command.js:163` (options), `:356`, `:377` (origin)
- Modify: `adapter/openclaw/register-recall-hook.js` (build the resolver)
- Modify: `index.js:6930-6936` (delete `isCronCommandContext`), the `createPlur1busCommandRunner({…})` literal (`:7013`, drop `isCronCommandContext`), the `runPlur1busCommand` binding handed to `registerChatCommands`
- Create: `tests/engine-principal.test.js`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`

**Interfaces:**
- Consumes: `resolveMemoryRequestContext(commandCtx, { workspaceAliases })` (`lib/memory-request-context.js:284-323`), `resolveHostHookMemoryContext(hookCtx, { getSessionEntry, workspaceAliases, accountTopology, turnRoutes, routingCapability, logger })` (`:1259-1418`).
- Produces:
  - `memoryContextFromPrincipal(principal, { workspaceDir?, sessionKey?, sessionId?, workspaceAliases? }) -> frozen memoryCtx` — `trust: "inferred"` yields `userPrincipal: ""` and never throws for a valid `agentId`
  - `principalFromMemoryContext(memoryCtx, trust) -> Principal`
  - `createChannelRegistry() -> { register(name), has(name), list() }`; `DEFAULT_CHANNELS = ["telegram", "discord", "slack", "mattermost"]`
  - `registerRouteProvider(name)`, `listRouteProviders()` exported from `lib/memory-request-context.js`
  - `resolveHostHookPrincipal(hookCtx, options) -> Promise<{ memoryCtx, trust: "proved"|"inferred" }>`; `resolveHostHookMemoryContext` returns its `memoryCtx`
  - `createTurnPrincipalResolver({ host, hostRoutingLoader, getMemoryTurnRoutes, memoryWorkspaceAliases, memoryAccountTopology }) -> async (event, hookCtx) => { memoryCtx, trust }`
  - `agentContextFromCommand(commandCtx) -> AgentContext` (the moved cron matcher), `agentContextFromHook(event, hookCtx) -> AgentContext`
  - recall `(event, hookCtx, { signal, memoryCtx?, agentContext? })`; capture `(event, hookCtx, { memoryCtx?, agentContext? })`; command `(commandCtx, prefixTokens, { agentContext, memoryCtx? })`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-principal.test.js`:

```js
/**
 * tests/engine-principal.test.js — PR-06 (spec 3.4, step 7 gates).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createChannelRegistry, DEFAULT_CHANNELS, memoryContextFromPrincipal, principalFromMemoryContext } from "../engine/identity/principal.js";
import { agentContextFromCommand } from "../adapter/openclaw/turn-principal.js";
import { listRouteProviders, resolveHostHookPrincipal, resolveMemoryRequestContext, stableIdentityHash } from "../lib/memory-request-context.js";

const USER = `user:v1:${stableIdentityHash(JSON.stringify(["telegram", "default", "u1"]))}`;
const proved = { agentId: "agent-a", workspace: "workspace:v1:main", user: USER, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };

describe("memoryContextFromPrincipal", () => {
  it("a proved principal reaches user scope with the on-disk hash unchanged", () => {
    const ctx = memoryContextFromPrincipal(proved, { workspaceDir: "/tmp/ws-proved" });
    assert.equal(ctx.userPrincipal, USER);
    assert.equal(ctx.workspaceIdentity, "workspace:v1:main");
    assert.equal(ctx.channel, "telegram");
    assert.equal(ctx.trust, "proved");
    const legacy = resolveMemoryRequestContext({ agentId: "agent-a", userId: "u1", channel: "telegram", accountId: "default" });
    assert.equal(ctx.userPrincipal, legacy.userPrincipal, "same pool directory as today");
    assert.ok(Object.isFrozen(ctx));
  });

  it("an inferred principal is agent-private (no user scope) and never throws", () => {
    for (const principal of [
      { ...proved, trust: "inferred" },
      { agentId: "agent-a", trust: "inferred", user: "user:v1:forged", workspace: "workspace:v1:other" },
      { agentId: "agent-a", trust: "inferred", chat: null },
    ]) {
      const ctx = memoryContextFromPrincipal(principal, { workspaceDir: "/tmp/ws-inferred" });
      assert.equal(ctx.userPrincipal, "");
      assert.equal(ctx.trust, "inferred");
      assert.notEqual(ctx.workspaceIdentity, "workspace:v1:other", "an inferred principal cannot name a foreign workspace");
    }
  });

  it("round-trips through principalFromMemoryContext", () => {
    const ctx = memoryContextFromPrincipal(proved, { workspaceDir: "/tmp/ws-proved" });
    const back = principalFromMemoryContext(ctx, "proved");
    assert.deepEqual([back.agentId, back.user, back.channel, back.accountId, back.trust], ["agent-a", USER, "telegram", "default", "proved"]);
  });
});

describe("resolveHostHookPrincipal", () => {
  it("reports inferred when the ticket proof fails, with the same fallback context as before", async () => {
    const routingCapability = {
      parseAgentSessionKey: (v) => { const m = /^agent:([^:]+):(.+)$/.exec(v); return m ? { agentId: m[1], rest: m[2] } : null; },
      parseThreadSessionSuffix: (v) => ({ baseSessionKey: v, threadId: "" }),
      normalizeOptionalAccountId: (v) => v,
      normalizeMessageChannel: (v) => v,
    };
    const hookCtx = { agentId: "agent-a", sessionKey: "agent:agent-a:telegram:direct:u1", workspaceDir: "/tmp/ws-hook" };
    const result = await resolveHostHookPrincipal(hookCtx, {
      getSessionEntry: async () => null,
      turnRoutes: { claim: () => null, explain: () => "none" },
      routingCapability,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.equal(result.trust, "inferred");
    assert.equal(result.memoryCtx.userPrincipal, "");
  });
});

describe("channel registry", () => {
  it("is seeded with today's four providers and accepts new ones", () => {
    const channels = createChannelRegistry();
    assert.deepEqual(DEFAULT_CHANNELS, ["telegram", "discord", "slack", "mattermost"]);
    for (const name of DEFAULT_CHANNELS) assert.equal(channels.has(name), true);
    assert.equal(channels.has("matrix"), false);
    channels.register("matrix");
    assert.equal(channels.has("matrix"), true);
    assert.ok(listRouteProviders().includes("matrix"), "the registry is the provider set memory-request-context validates against");
  });
});

describe("agentContextFromCommand — the moved cron matcher", () => {
  it("matches exactly what index.js's isCronCommandContext matched", () => {
    const cron = (ctx) => agentContextFromCommand(ctx).origin === "cron";
    assert.equal(cron({ channel: "cron" }), true);
    assert.equal(cron({ origin: "CRON" }), true);
    assert.equal(cron({ source: "cron" }), true);
    assert.equal(cron({ kind: "cron" }), true);
    assert.equal(cron({ sessionKey: "agent:main:cron" }), true);
    assert.equal(cron({ sessionKey: "agent:main:cron:nightly" }), true);
    assert.equal(cron({ sessionKey: "agent:main:telegram:direct:1" }), false);
    assert.equal(cron({ channel: "telegram" }), false);
    assert.deepEqual(agentContextFromCommand({ channel: "cron" }), { origin: "cron", background: true });
    assert.deepEqual(agentContextFromCommand({ channel: "telegram" }), { origin: "user", background: false });
  });
});
```

The `resolveHostHookPrincipal` fixture only needs to reach any `return base` path; if `getSessionEntry: async () => null` does not exercise the fallback because an earlier step throws on a missing field, add the field the diagnostics name (`diag.step`), keeping `trust === "inferred"` as the assertion.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-principal.test.js 2>&1 | tail -6
```

Expected: `ERR_MODULE_NOT_FOUND … engine/identity/principal.js`.

- [ ] **Step 3: The provider registry and `resolveHostHookPrincipal` in `lib/memory-request-context.js`**

Replace `:25`

```js
const SUPPORTED_ROUTE_PROVIDERS = new Set(["telegram", "discord", "slack", "mattermost"]);
```
with
```js
// Channel vocabulary is a registry (spec 3.4): seeded with the four providers
// PLUR1BUS has always accepted, extensible by a host through
// Engine.channels.register(). One set per process, like the turn-route registry.
const SUPPORTED_ROUTE_PROVIDERS = getProcessSingleton(
  "plur1bus.memory-request-context.route-providers",
  () => new Set(["telegram", "discord", "slack", "mattermost"]),
);

/** Add a provider name to the accepted conversation-provider vocabulary. */
export function registerRouteProvider(name) {
  const normalized = validatedIdentity(name, INPUT_LIMITS.CHANNEL_ID, "channel", { required: true }).toLowerCase();
  SUPPORTED_ROUTE_PROVIDERS.add(normalized);
  return normalized;
}

/** The accepted conversation-provider vocabulary, in insertion order. */
export function listRouteProviders() {
  return [...SUPPORTED_ROUTE_PROVIDERS];
}
```

`getProcessSingleton` is already imported (`:12`); `validatedIdentity` and `INPUT_LIMITS` are declared/imported in the same file (`:9`, used at `:290`). `normalizeProvider` (`:463`) keeps `SUPPORTED_ROUTE_PROVIDERS.has(normalized)` unchanged.

`resolveHostHookPrincipal`: list the function's returns first —

```bash
cd "$PLUR1BUS" && awk 'NR>=1259 && NR<=1418 && /return /{print NR": "$0}' lib/memory-request-context.js
```

Rename `export async function resolveHostHookMemoryContext(hookCtx, {` (`:1259`) to `export async function resolveHostHookPrincipal(hookCtx, {`; inside it change the single `return resolveMemoryRequestContext({` that builds the claimed context (`:1400`) into `return { trust: "proved", memoryCtx: resolveMemoryRequestContext({ … }, { workspaceAliases }) };` (closing the object literal after the call's closing paren), and every `return base;` into `return { trust: "inferred", memoryCtx: base };`. Then add below the function:

```js
/** Resolve a hook's memory context; `trust` is dropped (see resolveHostHookPrincipal). */
export async function resolveHostHookMemoryContext(hookCtx, options = {}) {
  return (await resolveHostHookPrincipal(hookCtx, options)).memoryCtx;
}
```

The awk listing must show no `return` inside the function other than those rewritten (nested functions' returns excepted — leave returns inside `.find(…)`/arrow callbacks alone).

- [ ] **Step 4: Create `engine/identity/principal.js`**

```js
/**
 * engine/identity/principal.js — PR-06 (spec 3.4).
 *
 * `Principal` is what a host proves about the speaker; the engine's memory
 * layers want the frozen request context lib/memory-request-context.js has
 * always produced. This is the constructor between them. "inferred" keeps
 * exactly the fallback the OpenClaw hook path has always used when its ticket
 * proof fails: the agent's own context, no user scope.
 */

import { listRouteProviders, registerRouteProvider, resolveMemoryRequestContext } from "../../lib/memory-request-context.js";

export const DEFAULT_CHANNELS = Object.freeze(["telegram", "discord", "slack", "mattermost"]);

/**
 * @param {object} principal Principal (types/engine.d.ts).
 * @param {{workspaceDir?: string, sessionKey?: string, sessionId?: string, workspaceAliases?: object}} [facts]
 * @returns {object} Frozen memory request context with `trust`.
 */
export function memoryContextFromPrincipal(principal, { workspaceDir, sessionKey, sessionId, workspaceAliases } = {}) {
  const options = workspaceAliases ? { workspaceAliases } : {};
  let base;
  try {
    base = resolveMemoryRequestContext({ agentId: principal?.agentId, workspaceDir, sessionKey, sessionId }, options);
  } catch (error) {
    if (principal?.trust === "proved") throw error;
    base = resolveMemoryRequestContext({ agentId: principal?.agentId }, options);
  }
  if (principal?.trust !== "proved") {
    return Object.freeze({ ...base, userPrincipal: "", trust: "inferred" });
  }
  const workspace = typeof principal.workspace === "string" && principal.workspace ? principal.workspace : base.workspaceIdentity;
  return Object.freeze({
    ...base,
    workspaceId: workspace,
    workspaceIdentity: workspace,
    userPrincipal: typeof principal.user === "string" ? principal.user : "",
    channel: String(principal.channel || ""),
    accountId: String(principal.accountId || ""),
    chatId: String(principal.chat?.id || ""),
    chatKind: principal.chat?.kind || base.chatKind,
    trust: "proved",
  });
}

/**
 * @param {object} memoryCtx Frozen memory request context.
 * @param {"proved"|"inferred"} trust
 * @returns {object} Principal.
 */
export function principalFromMemoryContext(memoryCtx, trust) {
  return Object.freeze({
    agentId: memoryCtx.agentId,
    workspace: memoryCtx.workspaceIdentity || "",
    ...(memoryCtx.userPrincipal ? { user: memoryCtx.userPrincipal } : {}),
    channel: memoryCtx.channel || "",
    accountId: memoryCtx.accountId || "",
    chat: Object.freeze({ id: memoryCtx.chatId || "", kind: memoryCtx.chatKind || "direct" }),
    trust: trust === "proved" ? "proved" : "inferred",
  });
}

/** @returns {{register: (name: string) => string, has: (name: string) => boolean, list: () => string[]}} */
export function createChannelRegistry() {
  return Object.freeze({
    register: (name) => registerRouteProvider(name),
    has: (name) => listRouteProviders().includes(String(name || "").toLowerCase()),
    list: () => listRouteProviders(),
  });
}
```

The inferred branch keeps `base.workspaceIdentity` (derived from the host's `workspaceDir`) exactly as `resolveHostHookMemoryContext`'s fallback `base` does (`lib/memory-request-context.js:1268`, `:1417`); only a *proved* principal can name its workspace.

- [ ] **Step 5: Create `adapter/openclaw/turn-principal.js`**

```js
/**
 * adapter/openclaw/turn-principal.js — the OpenClaw side of PR-06.
 *
 * The hook-identity resolution (reply_dispatch ticket + six-step proof in
 * resolveHostHookMemoryContext) and the cron string matching that index.js
 * used to do both live here now; the engine receives their results as an
 * explicit memory context / AgentContext.
 */

import { resolveHostHookPrincipal, resolveMemoryRequestContext } from "../../lib/memory-request-context.js";
import { isBackgroundTurn, shouldSkipAutoRecallForInternalTurn } from "../../lib/runtime-scheduler.js";

/**
 * Was engine/recall/assemble-prompt-context.js:165-192.
 * @param {{host: object, hostRoutingLoader: () => Promise<object>, getMemoryTurnRoutes: () => Promise<object|null>, memoryWorkspaceAliases: object, memoryAccountTopology: object}} ctx
 * @returns {(event: object, hookCtx: object) => Promise<{memoryCtx: object, trust: "proved"|"inferred"}>}
 */
export function createTurnPrincipalResolver({ host, hostRoutingLoader, getMemoryTurnRoutes, memoryWorkspaceAliases, memoryAccountTopology }) {
  return async function resolveTurnPrincipal(event, hookCtx) {
    const routingCapability = await hostRoutingLoader();
    const turnRoutes = await getMemoryTurnRoutes();
    if (turnRoutes) {
      return resolveHostHookPrincipal({
        ...hookCtx,
        runId: hookCtx?.runId ?? event?.runId,
        sessionKey: hookCtx?.sessionKey ?? event?.sessionKey,
        sessionId: hookCtx?.sessionId ?? event?.sessionId,
      }, {
        getSessionEntry: ({ agentId, sessionKey, readConsistency }) => host.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency }),
        workspaceAliases: memoryWorkspaceAliases,
        accountTopology: memoryAccountTopology,
        turnRoutes,
        routingCapability,
        logger: host.logger,
      });
    }
    return {
      trust: "inferred",
      memoryCtx: resolveMemoryRequestContext({
        agentId: hookCtx?.agentId,
        workspaceDir: hookCtx?.workspaceDir,
        channel: hookCtx?.messageProvider,
        chatId: hookCtx?.chatId,
        sessionKey: hookCtx?.sessionKey ?? event?.sessionKey,
        sessionId: hookCtx?.sessionId ?? event?.sessionId,
      }, { workspaceAliases: memoryWorkspaceAliases }),
    };
  };
}

/** Was index.js:6930-6936 (isCronCommandContext). */
export function agentContextFromCommand(commandCtx) {
  const channel = String(commandCtx?.channel || "").toLowerCase();
  const origin = String(commandCtx?.origin || commandCtx?.source || commandCtx?.kind || "").toLowerCase();
  const sessionKey = String(commandCtx?.sessionKey || "").toLowerCase();
  const cron = channel === "cron"
    || origin === "cron"
    || /^agent:[^:]+:cron(?::|$)/.test(sessionKey);
  return cron ? { origin: "cron", background: true } : { origin: "user", background: false };
}

/** The recall/capture turn classification, as an AgentContext. */
export function agentContextFromHook(event, hookCtx) {
  const background = isBackgroundTurn(event, hookCtx);
  const internal = shouldSkipAutoRecallForInternalTurn(event, hookCtx);
  return { origin: internal ? (background ? "cron" : "system") : "user", background };
}
```

`createTurnPrincipalResolver`'s body is the assembler's `:165-192` verbatim with the ternary unfolded into `if`/`return`; the two branches and every argument are unchanged.

- [ ] **Step 6: Engine entry points take explicit identity**

`engine/recall/assemble-prompt-context.js`:

1. Add `resolveTurnPrincipal = null,` to the ctx destructuring and remove `hostRoutingLoader`, `getMemoryTurnRoutes` and `memoryAccountTopology` from it **only if** `grep -n` shows no other use in the file (keep `memoryWorkspaceAliases` — it is used elsewhere).
2. The first two classification lines

```js
    const background = isBackgroundTurn(event, hookCtx);
    const skipInternalRecall = shouldSkipAutoRecallForInternalTurn(event, hookCtx);
```
become
```js
    const background = opts.agentContext ? opts.agentContext.background === true : isBackgroundTurn(event, hookCtx);
    const skipInternalRecall = opts.agentContext ? opts.agentContext.origin !== "user" : shouldSkipAutoRecallForInternalTurn(event, hookCtx);
```

(the adapter passes no `agentContext`, so its path is unchanged; `Engine.recall` in Task 13c passes one).
3. Replace the identity block `:165-192` (from `const routingCapability = await hostRoutingLoader();` through the end of the `resolveMemoryRequestContext(…)` ternary) — keeping the `recallPrelude` line (`:171`) where it is, between the two — with:

```js
    const recallPrelude = { startedAt: Date.now(), identityMs: 0, hookRecordMs: 0, windowMs: 0, embedMs: 0, embedTimedOut: false, globalMs: 0, lanesMs: 0 };
    const { memoryCtx } = opts.memoryCtx
      ? { memoryCtx: opts.memoryCtx }
      : resolveTurnPrincipal
        ? await resolveTurnPrincipal(event, hookCtx)
        : { memoryCtx: resolveMemoryRequestContext({
          agentId: hookCtx?.agentId,
          workspaceDir: hookCtx?.workspaceDir,
          channel: hookCtx?.messageProvider,
          chatId: hookCtx?.chatId,
          sessionKey: hookCtx?.sessionKey ?? event?.sessionKey,
          sessionId: hookCtx?.sessionId ?? event?.sessionId,
        }, { workspaceAliases: memoryWorkspaceAliases }) };
```

Order note: today `recallPrelude` is created between the routing-capability load and `resolveHostHookMemoryContext`; `startedAt` now precedes the routing load, so the prelude's `identityMs` includes it. That value only reaches a log line's `identity=` field (`:259-262`), never the prompt.

4. Drop the now-unused `resolveHostHookMemoryContext` import if the grep shows no other use.

`adapter/openclaw/register-recall-hook.js` — build the resolver before the assembler:

```js
import { createTurnPrincipalResolver } from "./turn-principal.js";

export function registerRecallHook(ctx) {
  const recall = createPromptContextAssembler({ ...ctx, resolveTurnPrincipal: createTurnPrincipalResolver(ctx) });
  /* the api.on(...) from Task 3, unchanged */
}
```

`engine/capture/capture-turn.js` — `return async function` handler gains `opts = {}` as a third parameter; `const background = isBackgroundTurn(event, hookCtx);` (`:145`) becomes `const background = opts.agentContext ? opts.agentContext.background === true : isBackgroundTurn(event, hookCtx);`; the `shouldSkipAutoCaptureForInternalTurn(event, hookCtx)` test (`:146`) becomes `(opts.agentContext ? opts.agentContext.origin !== "user" : shouldSkipAutoCaptureForInternalTurn(event, hookCtx))`; and the `let memoryCtx = null; try { memoryCtx = resolveMemoryRequestContext({…}) } catch …` block (`:150-166`) is wrapped: `if (opts.memoryCtx) { memoryCtx = opts.memoryCtx; } else { /* the existing try/catch, unchanged */ }`.

`engine/commands/plur1bus-command.js` — `return async function runPlur1busCommand(commandCtx, prefixTokens = []) {` (`:163`) becomes `(commandCtx, prefixTokens = [], opts = {})` with, as its first statement, `const agentContext = opts.agentContext ?? { origin: "user", background: false };`. Then `:356` `const cronInternal = actionKey === "internal" && isCronCommandContext(commandCtx);` → `const cronInternal = actionKey === "internal" && agentContext.origin === "cron";`, and `:377` `if (!isCronCommandContext(commandCtx)) {` → `if (agentContext.origin !== "cron") {`. The memory-context resolution at `:357-359` becomes `const memoryCtx = opts.memoryCtx ?? (cronInternal ? await resolveCronMemoryContext(commandCtx) : await resolveRegisteredMemoryContext(commandCtx));`. Remove `isCronCommandContext` from the destructuring (`:98`).

`index.js` — delete the `isCronCommandContext` declaration (`:6930-6936`) and its entry in `createPlur1busCommandRunner({…})` (`:7050`); import `agentContextFromCommand` from `./adapter/openclaw/turn-principal.js`; and rename the runner binding so every existing caller gets the adapter's classification without editing call sites:

```js
        const runPlur1busCommandWithIdentity = createPlur1busCommandRunner({ /* unchanged literal minus isCronCommandContext */ });
        const runPlur1busCommand = (commandCtx, prefixTokens = [], opts = {}) =>
          runPlur1busCommandWithIdentity(commandCtx, prefixTokens, { agentContext: agentContextFromCommand(commandCtx), ...opts });
```

`registerChatCommands` and the feature-cron dispatch keep receiving `runPlur1busCommand` (`adapter/openclaw/register-commands.js:114,125,158`), now the wrapper. Grep for any other `isCronCommandContext` use (`grep -rn isCronCommandContext index.js adapter engine`) and replace it with `agentContextFromCommand(x).origin === "cron"`.

- [ ] **Step 7: Register, verify, commit**

`ENGINE_PATHS`: `principal: "engine/identity/principal.js",`; `ADAPTER_PATHS`: `turnPrincipal: "adapter/openclaw/turn-principal.js",`; both into `DEPLOY_FILES`.

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-principal.test.js tests/b13-memory-request-context.test.js tests/b13-acl-callsite-adapters.test.js tests/plur1bus-internal-auth.test.js tests/engine-jobs-registry.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add lib/memory-request-context.js engine adapter index.js tests scripts/lib/deploy-integrity.mjs
git commit -m "feat(engine): Principal/AgentContext as explicit inputs; channel registry

PR-06 (spec 3.4). memoryContextFromPrincipal is the constructor from a
Principal; inferred degrades to the agent's own context, never throws. The
hook identity (reply_dispatch ticket, six-step proof) moves to the adapter,
which reports proved/inferred via resolveHostHookPrincipal. Cron matching
leaves index.js and reaches the engine as AgentContext.origin. The provider
set is a registry seeded with today's four. Golden 11/11."
```

Expected: `tests 8` in the new file; the `b13-*` identity tests and the internal-auth/job tests green; golden 11/11 (the golden scenarios run the turn-route path — a slip in Step 5 shows as a missing `authenticated` context there); `lint-engine-imports: clean`; lint and suite green.

---
### Task 11 (G1): host-neutral `lib/` — routing and paths injected, SDK loads indirected, the five `api` functions moved; contract 1.3.0

Spec §3.4 "G1 closure" (1)–(3). The spec counts 8 `OPENCLAW_*` reads in `engine/**`; walking the import graph `createEngine` will have (`engine/**` plus `register()`'s construction, which Task 13b moves in) at `9fd7bab4` finds **22** read lines: 8 in `engine/**`, 1 in `index.js`, 13 in `lib/**` (Task 12, Step 5 shows the 14 already on today's `engine/**` graph), plus two `lib → lib/setup/feature-cron-plugin-runtime.js` imports that pull `openclaw/plugin-sdk/*` in transitively (`lib/dreaming/dream-diary.js:5`, `lib/providers/secret-input.js:1`) and the routing default parameter (`lib/memory-request-context.js:346`, `:368`). All are closed here so Task 12's lint lands green. The mechanism for `lib/` defaults is `lib/host-paths.js`: path defaults come from overrides the **host** binds (the adapter binds an env-backed set built in `lib/host-services.js`, which is adapter-side and forbidden to the engine), never from `process.env` on the engine graph.

**Env reads on the engine graph at `9fd7bab4` and their replacement:**

| Site | Reads | Becomes |
|---|---|---|
| `engine/commands/plur1bus-command.js:230-231`, `:1182`, `:1212-1213`, `:1320-1321` | `OPENCLAW_HOME`, `OPENCLAW_CONFIG_PATH` | `host.stateDir`, `host.configPath()` |
| `engine/recall/assemble-prompt-context.js:283` | `OPENCLAW_HOME` | `host.stateDir` (as `minimal-maintenance.js:80` already does) |
| `index.js:5676` (moves into the engine in Task 13b) | `OPENCLAW_HOME` | `host.stateDir` |
| `lib/setup/feature-profiles.js:454` | `OPENCLAW_HOME` | `hostStateDir()` |
| `lib/setup/feature-profiles.js:570` | default param | `openclawHome = hostStateDir()` |
| `lib/telegram-commands/feature-toggle.js:147-148` | both | `return hostConfigPath();` |
| `lib/telegram-commands/status-data.js:29-30` | both | `return hostConfigPath();` |
| `lib/telegram-commands/memory-edit.js:58` | `OPENCLAW_HOME` | `join(hostHomeOverride() \|\| homedir(), ".openclaw", "memory", "_archive")` (keeps its odd double-`.openclaw` shape exactly) |
| `lib/obsidian-bridge.js:572` | `OPENCLAW_HOME` | `options.openclawHome \|\| hostStateDir()` |
| `lib/speaker-mapping-store.js:29-33` | `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` | `hostStateDirOverride()`, `hostConfigPathOverride()` |
| `lib/providers/env.js:10` | `OPENCLAW_HOME` | `hostHomeOverride() \|\| \`${process.env.HOME \|\| "."}/.openclaw\`` |

`host.stateDir` snapshots `OPENCLAW_HOME` at registration where the old engine code re-read it per call — the same trade M1a accepted for the `start` block (`progress.md:54`). `host.configPath()` is a method and re-reads per call, so it is exact.

**Files:**
- Create: `lib/host-paths.js`, `lib/host-sdk-loader.js`, `lib/plugin-meta.js`, `lib/feature-crons-hint.js`, `adapter/openclaw/host-probes.js`
- Modify: `lib/host-services.js` (`configPath`, `routing`, `pathOverrides`, `envHostPaths`; stub equivalents)
- Modify: the eleven sites in the table above
- Modify: `lib/memory-request-context.js:346`, `:368`, `:648`, `:748` (no default import)
- Modify: `lib/dreaming/dream-diary.js:5`, `:184`; `lib/providers/secret-input.js:1`, `:51-53`
- Modify: `index.js` — remove the five functions (`:3171-3182`, `:3272-3296`, `:3316-3384`, `:3385-3514`, `:4094-4114`) and the hint helpers (`:3241-3262`, `:3515-3539`), `PLUGIN_VERSION` (`:272-278`) and `_featureCronsHintCache` (`:283`); import and re-export from the new modules; bind host paths and the SDK loader; build `host` with `routing`
- Modify: `types/engine.d.ts` (1.3.0), `types/engine.conformance.ts`
- Modify: `tests/index-host-logger.test.js:26-61` (exempt lists point at the adapter module), tests that set `OPENCLAW_*` and call the rewired `lib/` functions directly
- Create: `tests/host-paths.test.js`
- Modify: `tests/host-services.test.js`, `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`

**Interfaces:**
- Produces:
  - `bindHostPaths(overrides)`, `resetHostPaths()`, `hostHomeOverride()`, `hostStateDir()`, `hostConfigPath()`, `hostConfigPathOverride()`, `hostStateDirOverride()`
  - `envHostPaths(env = process.env) -> { openclawHome(), configPathOverride(), stateDirOverride() }` (in `lib/host-services.js`)
  - `HostServices.configPath(): string`, `HostServices.routing?(): Promise<unknown>`, `HostServices.pathOverrides?: HostPathOverrides` — contract **1.3.0**
  - `createHostServices(api, { routing?, … })`: `routing` defaults to `() => import("openclaw/plugin-sdk/routing")`; `pathOverrides` is `envHostPaths()`
  - `createHostRoutingLoader({ importRouting, logger })` without `importRouting` returns a loader that rejects `host routing capability not provided`; same for `createHostIncognitoSessionClassifier`
  - `setHostSdkLoader(fn)`, `loadHostSdk(subpath, options)`
  - `PLUGIN_ROOT`, `PLUGIN_VERSION`; `featureCronsMarkerPath`, `getFeatureCronsSetupHint`, `resetFeatureCronsHintCache`, `parseFeatureCronBootstrapLastPlanCreateCount`
  - `adapter/openclaw/host-probes.js` exports `resolveNeoHooksConfig`, `inspectCronNativeCapabilities`, `reconcileUnsafeDirectCronsWithService`, `runDeferredFeatureCronBootstrap`, `makeReactionsCapabilityChecker`

- [ ] **Step 1: Write the failing tests**

Create `tests/host-paths.test.js`:

```js
/**
 * tests/host-paths.test.js — G1 (spec 3.4 (2)).
 *
 * lib/ path defaults on the engine graph come from host-bound overrides; with
 * the adapter's env-backed overrides bound, every rewired site returns what
 * its old process.env read returned.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { bindHostPaths, hostConfigPath, hostConfigPathOverride, hostHomeOverride, hostStateDir, hostStateDirOverride, resetHostPaths } from "../lib/host-paths.js";
import { createHostServices, createStubHost, envHostPaths } from "../lib/host-services.js";

afterEach(() => resetHostPaths());

describe("lib/host-paths", () => {
  it("unbound defaults never read the environment", () => {
    const previous = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = "/should/not/be/read";
    try {
      bindHostPaths({});
      assert.equal(hostStateDir(), join(homedir(), ".openclaw"));
      assert.equal(hostConfigPath(), join(homedir(), ".openclaw", "openclaw.json"));
      assert.equal(hostHomeOverride(), undefined);
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_HOME; else process.env.OPENCLAW_HOME = previous;
    }
  });

  it("the adapter's env-backed overrides reproduce the old reads, per call", () => {
    const env = {};
    bindHostPaths(envHostPaths(env));
    assert.equal(hostStateDir(), join(homedir(), ".openclaw"));
    env.OPENCLAW_HOME = "/srv/oc";
    assert.equal(hostStateDir(), "/srv/oc");
    assert.equal(hostConfigPath(), "/srv/oc/openclaw.json");
    env.OPENCLAW_CONFIG_PATH = "/etc/oc.json";
    assert.equal(hostConfigPath(), "/etc/oc.json");
    assert.equal(hostConfigPathOverride(), "/etc/oc.json");
    env.OPENCLAW_STATE_DIR = "/var/oc";
    assert.equal(hostStateDirOverride(), "/var/oc");
    assert.equal(hostHomeOverride(), "/srv/oc");
  });
});

describe("HostServices 1.3.0 members", () => {
  it("createHostServices supplies configPath, routing and pathOverrides", async () => {
    const host = createHostServices({ logger: {} }, { stateDir: "/srv/oc", routing: async () => ({ marker: 1 }) });
    assert.equal(typeof host.configPath, "function");
    assert.match(host.configPath(), /openclaw\.json$/);
    assert.deepEqual(await host.routing(), { marker: 1 });
    assert.equal(typeof host.pathOverrides.openclawHome, "function");
  });

  it("createStubHost has a configPath under its stateDir and no routing", () => {
    const host = createStubHost({ stateDir: "/tmp/stub-state" });
    assert.equal(host.configPath(), "/tmp/stub-state/openclaw.json");
    assert.equal(host.routing, undefined);
    assert.equal(host.pathOverrides, undefined);
  });
});
```

Add to `tests/host-services.test.js` (in its `createStubHost` describe) a case asserting `createStubHost({ configPath: () => "/x.json", routing: async () => ({}) })` honours both overrides, and that `STUB_HANDLED_KEYS` no longer re-copies them.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/host-paths.test.js 2>&1 | tail -6
```

Expected: `ERR_MODULE_NOT_FOUND … lib/host-paths.js`.

- [ ] **Step 3: Create `lib/host-paths.js` and extend `lib/host-services.js`**

```js
/**
 * lib/host-paths.js — path defaults for lib/ modules on the engine graph.
 *
 * Nothing here reads process.env. A host binds overrides (the OpenClaw adapter
 * binds lib/host-services.js envHostPaths(), which reads OPENCLAW_* per call);
 * unbound, every default is ~/.openclaw. One binding per process: the engine
 * is the only memory owner in a process (host-contract), so last bind wins.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const NONE = Object.freeze({
  openclawHome: () => undefined,
  configPathOverride: () => undefined,
  stateDirOverride: () => undefined,
});

let overrides = NONE;

/** @param {{openclawHome?: () => string|undefined, configPathOverride?: () => string|undefined, stateDirOverride?: () => string|undefined}|null|undefined} next */
export function bindHostPaths(next) {
  overrides = { ...NONE, ...(next || {}) };
}

export function resetHostPaths() {
  overrides = NONE;
}

/** The host's raw OPENCLAW_HOME-equivalent, or undefined when unset. */
export function hostHomeOverride() {
  return overrides.openclawHome() || undefined;
}

export function hostStateDir() {
  return hostHomeOverride() || join(homedir(), ".openclaw");
}

export function hostConfigPathOverride() {
  return overrides.configPathOverride() || undefined;
}

export function hostConfigPath() {
  return hostConfigPathOverride() || join(hostStateDir(), "openclaw.json");
}

export function hostStateDirOverride() {
  return overrides.stateDirOverride() || undefined;
}
```

In `lib/host-services.js`:

```js
/**
 * Env-backed path overrides for lib/host-paths.js. Adapter-side: this module
 * is forbidden to engine/** (scripts/lint-engine-imports.mjs), so the env read
 * stays off the engine graph. Every accessor re-reads, like the code it replaces.
 * @param {object} [env]
 */
export function envHostPaths(env = process.env) {
  return Object.freeze({
    openclawHome: () => env.OPENCLAW_HOME,
    configPathOverride: () => env.OPENCLAW_CONFIG_PATH,
    stateDirOverride: () => env.OPENCLAW_STATE_DIR,
  });
}
```

`createHostServices` options gain `routing = () => import("openclaw/plugin-sdk/routing"),`; compute `const resolvedStateDir = stateDir ?? resolveStateDir();` before the `host` literal, use it for `stateDir:`, and add to the literal:

```js
    configPath: () => process.env.OPENCLAW_CONFIG_PATH || join(resolvedStateDir, "openclaw.json"),
    routing,
    pathOverrides: envHostPaths(),
```

(a closure, not a `this` method, so a destructured `configPath` still works).

`createStubHost` gains `configPath: overrides.configPath ?? (() => join(host.stateDir, "openclaw.json")),` (write it as a function that reads `host.stateDir` after the literal is built), `routing: overrides.routing,`, `pathOverrides: overrides.pathOverrides,`, `capabilities: overrides.capabilities,`; add `"configPath", "routing", "pathOverrides", "capabilities"` to `STUB_HANDLED_KEYS` (`:121-124`). Update the module header: contract 1.3.0.

- [ ] **Step 4: Rewire the eleven env sites**

Apply the table above. Each `lib/` file adds `import { … } from "../host-paths.js";` (`./host-paths.js` for `lib/obsidian-bridge.js` and `lib/speaker-mapping-store.js`; `../host-paths.js` under `lib/setup/`, `lib/telegram-commands/`, `lib/providers/`). In `lib/telegram-commands/memory-edit.js` also make the two `DEFAULT_ARCHIVE_DIR` defaults lazy — `archiveDir = DEFAULT_ARCHIVE_DIR,` (`:227`, `:373`) become `archiveDir = resolveDefaultArchiveDir(),` — so a default computed at import time (before the host binds) is never used; `export const DEFAULT_ARCHIVE_DIR` stays for importers. In the two engine files replace each `process.env.OPENCLAW_HOME || join(homedir(), ".openclaw")` with `host.stateDir` and each `process.env.OPENCLAW_CONFIG_PATH || join(openclawHome, "openclaw.json")` with `host.configPath()`; drop `homedir` imports the grep shows unused. Then:

```bash
cd "$PLUR1BUS" && grep -rn 'process\.env\.OPENCLAW_\|process\.env\[.OPENCLAW_' engine lib/setup/feature-profiles.js lib/telegram-commands lib/obsidian-bridge.js lib/speaker-mapping-store.js lib/providers/env.js
```

Expected: no output.

- [ ] **Step 5: Routing without a default import; SDK loads through a seam**

`lib/memory-request-context.js`:

- `:346` `export function createHostRoutingLoader({ importRouting = () => import("openclaw/plugin-sdk/routing"), logger = null } = {}) {` → `export function createHostRoutingLoader({ importRouting = missingHostRouting, logger = null } = {}) {`
- `:367-368` the classifier's `importRouting = () => import("openclaw/plugin-sdk/routing"),` → `importRouting = missingHostRouting,`
- add above `createHostRoutingLoader`:

```js
/** Routing is a host capability (HostServices.routing, contract 1.3.0); without one there is none. */
async function missingHostRouting() {
  throw new Error("host routing capability not provided");
}
```

`routingLoader = createHostRoutingLoader(),` defaults (`:648`, `:748`) are unchanged in form; every caller passes `routingLoader` (`adapter/openclaw/register-commands.js:326,359`). Update the file's header comment ("Host routing support is loaded lazily…", `:3`) to "Host routing support is injected by the host (HostServices.routing)".

Create `lib/host-sdk-loader.js`:

```js
/**
 * lib/host-sdk-loader.js — the one seam lib/ uses to reach a host SDK module
 * (e.g. OpenClaw's memory-host-events or secret-input runtime) without
 * importing the host. The OpenClaw adapter installs its loader at
 * registration; without one, every load rejects and callers fail open as
 * they already do on a missing SDK.
 */

let loader = null;

/** @param {((subpath: string, options?: object) => Promise<unknown>)|null} next */
export function setHostSdkLoader(next) {
  loader = typeof next === "function" ? next : null;
}

/**
 * @param {string} subpath
 * @param {object} [options]
 * @returns {Promise<unknown>}
 */
export async function loadHostSdk(subpath, options = {}) {
  if (!loader) throw new Error(`host SDK capability ${subpath} is not available on this host`);
  return loader(subpath, options);
}
```

`lib/dreaming/dream-diary.js:5` → `import { loadHostSdk } from "../host-sdk-loader.js";` and `:184` → `importHostEvents = () => loadHostSdk("memory-host-events"),`. `lib/providers/secret-input.js:1` → `import { loadHostSdk } from "../host-sdk-loader.js";` and `:51-53` → `return loadHostSdk("secret-input-runtime", options);`. Both callers already fail open on a load error (`lib/dreaming/dream-diary.js:198-201`; the resolver's structured-secret path). In `tests/provider-secret-input.test.js` and `tests/dream-diary.test.js`, any case that relied on the *default* loader reaching the real SDK gets `setHostSdkLoader(loadOpenClawPluginSdkRuntime)` in its setup (import both); cases that inject their own loader are untouched.

- [ ] **Step 6: Plugin metadata, the cron hint, and the five host probes**

Create `lib/plugin-meta.js`:

```js
/**
 * lib/plugin-meta.js — the plugin's root directory and version, read once.
 * Was index.js:247 (__pluginDir) and :272-278 (PLUGIN_VERSION).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let version = "0.0.0";
try {
  version = JSON.parse(readFileSync(join(PLUGIN_ROOT, "openclaw.plugin.json"), "utf8")).version || version;
} catch (_err) { /* best-effort; stays "0.0.0" */ }

export const PLUGIN_VERSION = version;
```

Create `lib/feature-crons-hint.js` holding `featureCronsMarkerPath` (`index.js:3241-3243`), `getFeatureCronsSetupHint` (`:3253-3262`), the cache (`:283`) and `parseFeatureCronBootstrapLastPlanCreateCount` (`:3515-3539`), verbatim, plus:

```js
/** Forget the cached hint so the next read re-derives it (after a bootstrap run). */
export function resetFeatureCronsHintCache() {
  _featureCronsHintCache = undefined;
}
```

with imports `join` (`node:path`), `readJsonSafe` (`./atomic-file.js`), `featureCronsHintFromMarker` (`./setup/feature-cron-bootstrap.js`), `PLUGIN_VERSION` (`./plugin-meta.js`); export all four functions.

Create `adapter/openclaw/host-probes.js` with the five functions moved verbatim from `index.js` (ranges above; confirm each with `grep -n "^function <name>\|^async function <name>" index.js`), `export`ed, and their free names resolved per the analyser (Task 11 planning run at `9fd7bab4`: `resolveNeoHooksConfig` and `makeReactionsCapabilityChecker` need `runtimeIfUsable` from `../../lib/runtime-shutdown.js`; `reconcileUnsafeDirectCronsWithService` needs `planUnsafeDirectCronDisables` from `../../lib/setup/feature-cron-plan.js` and `withTimeout` from `../../lib/with-timeout.js`; `runDeferredFeatureCronBootstrap` needs `join`, `readJsonSafe`, `writeJsonAtomic`, `shouldRunCronBootstrap`, and from the new modules `PLUGIN_ROOT` (for `__pluginDir`), `PLUGIN_VERSION`, `featureCronsMarkerPath`, `parseFeatureCronBootstrapLastPlanCreateCount`, `resetFeatureCronsHintCache`; `inspectCronNativeCapabilities` needs nothing). Move `let _reactionsCapability = null;` (`index.js:4094`) with its function. Inside `runDeferredFeatureCronBootstrap` replace `__pluginDir` with `PLUGIN_ROOT` and the write `_featureCronsHintCache = undefined;` (`index.js:3469`) with `resetFeatureCronsHintCache();`.

In `index.js`: delete the moved declarations; import `PLUGIN_ROOT, PLUGIN_VERSION` and the four hint functions and the five probes; replace remaining `__pluginDir` uses with `PLUGIN_ROOT` only where `__pluginDir` was deleted (keep `const __pluginDir = PLUGIN_ROOT;` if other code in `index.js` still reads it — Task 13a moves those); extend the `export { … }` list (`index.js:7661`) so `inspectCronNativeCapabilities`, `parseFeatureCronBootstrapLastPlanCreateCount`, `reconcileUnsafeDirectCronsWithService`, `runDeferredFeatureCronBootstrap` are re-exported from their new homes (the list's names and order are unchanged; `export { x } from` or `import` + list both satisfy Global Constraint 13).

`tests/index-host-logger.test.js:26-61` scans `index.js` text between function anchors; the five functions are no longer there. Change the exempt lists to read `adapter/openclaw/host-probes.js` through `runtimeSourcePath` and assert on that file instead, or drop the entries whose anchors no longer exist in `index.js` — whichever keeps the test's assertion ("no `api.logger` in index.js outside the exempt functions") meaningful. `adapter/**` is outside that test's scope by design.

- [ ] **Step 7: Bind the host in `index.js`**

At the top of `register()`, right after the dependency validation (`:284`), add:

```js
    setHostSdkLoader(loadOpenClawPluginSdkRuntime);
```

(imports: `setHostSdkLoader` from `./lib/host-sdk-loader.js`, `loadOpenClawPluginSdkRuntime` from `./lib/setup/feature-cron-plugin-runtime.js`). Change Task 2's `const host = createHostServices(api, { events: hostEvents });` to

```js
    const host = createHostServices(api, {
      events: hostEvents,
      ...(importRouting ? { routing: importRouting } : {}),
    });
    bindHostPaths(host.pathOverrides);
```

(import `bindHostPaths` from `./lib/host-paths.js`), and the two loaders at `:5082-5089` become

```js
    const hostRoutingLoader = createHostRoutingLoader({ logger: host.logger, importRouting: host.routing });
    const classifyHostIncognitoSession = createHostIncognitoSessionClassifier({ logger: host.logger, importRouting: host.routing });
```

`host.routing` is the test's `importRouting` when given and OpenClaw's routing module otherwise — the same function the old spread selected. Replace `index.js:5676`'s `process.env.OPENCLAW_HOME || join(homedir(), ".openclaw")` with `host.stateDir`.

- [ ] **Step 8: Contract 1.3.0**

`types/engine.d.ts`: header line `Contract version 1.2.0` → `1.3.0` and "amended twice" → "amended three times"; append to the changelog `*            1.3.0 — HostServices.configPath(), HostServices.routing?, HostServices.pathOverrides? (G1 closure, M1b-1 Task 11).`; `export type ContractVersion = "1.3.0";`; in `HostServices` add after `stateDir`:

```ts
  /** The host's config file. Replaces OPENCLAW_CONFIG_PATH reads in engine code. */
  configPath(): string;
  /** Loads the host's routing capability (four session/channel parsers).
   *  Absent: turn identity degrades to the agent's own context. */
  routing?(): Promise<unknown>;
  /** Raw path overrides lib/ defaults honour (lib/host-paths.js); absent: ~/.openclaw. */
  pathOverrides?: HostPathOverrides;
```

and the interface:

```ts
export interface HostPathOverrides {
  openclawHome?(): string | undefined;
  configPathOverride?(): string | undefined;
  stateDirOverride?(): string | undefined;
}
```

`types/engine.conformance.ts`: `minimalHost` (`:62-74`) gains `configPath: () => "/tmp/plur1bus/openclaw.json",` (required now); add

```ts
// 1.3.0: routing and path overrides are optional host capabilities.
const hostWithRouting: HostServices = { ...minimalHost, routing: async () => ({}), pathOverrides: { openclawHome: () => undefined } };
void hostWithRouting;
```

`docs/engine-api.md` — header `Contract version 1.2.0` → `1.3.0` and add the 1.3.0 bullet under "Amending the contract" (Task 14 rewrites the rest of the doc).

- [ ] **Step 9: Verify and commit**

Register `lib/host-paths.js`, `lib/host-sdk-loader.js`, `lib/plugin-meta.js`, `lib/feature-crons-hint.js`, `adapter/openclaw/host-probes.js` in `DEPLOY_FILES` and the adapter file in `ADAPTER_PATHS` (`hostProbes`).

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js && /home/claude/.node24/bin/node --check adapter/openclaw/host-probes.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/host-paths.test.js tests/host-services.test.js tests/index-public-exports.test.js tests/index-host-logger.test.js tests/b13-memory-request-context.test.js tests/dream-diary.test.js tests/provider-secret-input.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/speaker-mapping-store.test.js tests/speaker-mapping-merge-results-missing.test.js tests/speaker-proposer.test.js tests/plur1bus-start-flow.test.js tests/obsidian-vault-plugin-runtime.test.js tests/obsidian-bridge-runtime-wiring.test.js tests/speaker-mapping-commands.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run typecheck
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -4
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

The second line is the seven test files that set `OPENCLAW_*` and exercise a rewired `lib/` module (found with `grep -rln 'OPENCLAW_HOME\|OPENCLAW_CONFIG_PATH\|OPENCLAW_STATE_DIR' tests test | xargs grep -ln 'feature-toggle\|status-data\|memory-edit\|speaker-mapping\|feature-profiles\|obsidian-bridge\|providers/env'`). A file that calls the `lib/` function **directly** (not through `plugin.register`, which binds) gets `bindHostPaths(envHostPaths())` in a `before` hook and `resetHostPaths()` in an `after` hook; that is the only permitted edit. Expected: all green; typecheck green on 1.3.0; golden 11/11.

```bash
git add lib adapter index.js types docs/engine-api.md tests scripts/lib/deploy-integrity.mjs
git commit -m "feat(host): host-neutral lib — routing, paths and SDK loads injected; contract 1.3.0

G1 closure (spec 3.4). HostServices gains configPath(), routing? and
pathOverrides? (1.3.0; conformance and lib/host-services.js in this commit).
Every OPENCLAW_* read on the engine graph goes through host.stateDir,
host.configPath() or lib/host-paths.js; the routing default import and the two
lib -> feature-cron-plugin-runtime imports are gone. The five pre-register
api functions move to adapter/openclaw/host-probes.js; index.js re-exports."
```

---

### Task 12 (G1 gate): transitive import lint and the env rule

Spec §3.4 "Gate" and success criterion 5. `scripts/lint-engine-imports.mjs` today checks only the direct imports of `engine/**` (`:158-194`). It gains a graph walk that follows relative imports from `engine/**` through `lib/**`, applies the forbidden-import rules to every reached file, and flags `process.env.OPENCLAW_*` and literal `openclaw/…` load specifiers on every reached file. Per spec §6 R-3, a forbidden file is reported where it is reached and **not descended into**, so `lib/setup/*-plugin-runtime.js`' own imports are not re-reported. The env rule is scoped to the engine graph, which is how criterion 5 words it ("`engine/**` and `lib/**` reachable from it"); `scripts/*.mjs` and `lib/host-services.js` read `OPENCLAW_*` legitimately and are not on it.

**Files:**
- Modify: `scripts/lint-engine-imports.mjs`
- Modify: `tests/lint-engine-imports.test.js`

**Interfaces:**
- Produces: two new violation kinds, printed with the import chain that reaches them: `transitive: <chain>: <why>` and `env: <file>:<line>: process.env.OPENCLAW_* read on the engine graph`. Exit status and the clean message (`lint-engine-imports: clean (N module(s))`, now counting reached `lib/` files too) keep their meaning.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lint-engine-imports.test.js`, inside the existing `describe`:

```js
  it("follows engine imports through lib/ and rejects a transitive openclaw import", (t) => {
    const base = fixture(t, {
      "engine/a.js": 'import { b } from "../lib/b.js";\nexport const a = b;\n',
      "lib/b.js": 'import { c } from "./c.js";\nexport const b = c;\n',
      "lib/c.js": 'export async function c() { return import("openclaw/plugin-sdk/routing"); }\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/a\.js -> lib\/b\.js -> lib\/c\.js/);
    assert.match(result.out, /openclaw/);
  });

  it("reports a reached forbidden lib file once and does not descend into it", (t) => {
    const base = fixture(t, {
      "engine/a.js": 'import "../lib/x.js";\n',
      "lib/x.js": 'import "./setup/foo-plugin-runtime.js";\n',
      "lib/setup/foo-plugin-runtime.js": 'import "openclaw";\nimport "../runtime-shutdown.js";\n',
      "lib/runtime-shutdown.js": "export {};\n",
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /lib\/setup\/foo-plugin-runtime\.js/);
    assert.doesNotMatch(result.out, /runtime-shutdown/, "the forbidden file's own imports are not walked");
  });

  it("rejects process.env.OPENCLAW_* anywhere on the engine graph", (t) => {
    const base = fixture(t, {
      "engine/a.js": 'import "../lib/b.js";\n',
      "lib/b.js": 'export const home = process.env.OPENCLAW_HOME;\nexport const cfg = process.env["OPENCLAW_CONFIG_PATH"];\n',
    });
    const result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.out, /lib\/b\.js:1/);
    assert.match(result.out, /lib\/b\.js:2/);
  });

  it("ignores env reads and openclaw imports in lib files the engine never reaches", (t) => {
    const base = fixture(t, {
      "engine/a.js": "export const a = 1;\n",
      "lib/unreached.js": 'import "openclaw";\nexport const x = process.env.OPENCLAW_HOME;\n',
    });
    assert.equal(run(base).status, 0);
  });

  it("does not flag an OPENCLAW_ mention inside a comment", (t) => {
    const base = fixture(t, {
      "engine/a.js": "// was process.env.OPENCLAW_HOME before G1\nexport const a = 1;\n",
    });
    assert.equal(run(base).status, 0);
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/lint-engine-imports.test.js 2>&1 | tail -8
```

Expected: the transitive and env cases fail (exit 0 where 1 is expected); the "unreached" and "comment" cases pass already.

- [ ] **Step 3: Implement the walk**

In `scripts/lint-engine-imports.mjs`, update the header comment with rules 6 and 7:

```
 *   6. Transitive: every lib/** module reachable from engine/** through
 *      relative imports obeys rule 1 too. A reached forbidden module is
 *      reported with the chain that reaches it and is not walked further.
 *   7. No `process.env.OPENCLAW_*` read and no literal "openclaw/…" load
 *      specifier (import()/require()/resolve()) on that graph. Host paths come
 *      from HostServices / lib/host-paths.js; host SDK modules from
 *      lib/host-sdk-loader.js.
```

Add, after the `graph` loop (`:194`) and before the cycle detection:

```js
const ENV_READ = /process\.env(?:\.|\[\s*["'`])OPENCLAW_/;
const OPENCLAW_LOAD = /\b(?:import|require|resolve)\s*\(\s*[`"']openclaw(?:[/`"'])/;
const forbiddenWhy = (spec, target) => FORBIDDEN_FOR_ENGINE.find((rule) => rule.test(spec, target))?.why ?? null;

function resolveModule(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  let target = resolve(dirname(fromFile), spec);
  if (!/\.m?js$/.test(target)) target = `${target}.js`;
  return target;
}

const reached = new Map();
const queue = [];
for (const [from] of graph) {
  if (from.startsWith("engine/")) queue.push({ file: join(root, from), chain: [from] });
}
while (queue.length > 0) {
  const { file, chain } = queue.shift();
  const rel = toPosix(relative(root, file));
  if (reached.has(rel)) continue;
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  reached.set(rel, chain);
  source.split("\n").forEach((line, index) => {
    const code = stripComments(line);
    if (ENV_READ.test(code)) violations.push(`env: ${rel}:${index + 1}: process.env.OPENCLAW_* read on the engine graph (via ${chain.join(" -> ")})`);
    if (!rel.startsWith("engine/") && OPENCLAW_LOAD.test(code)) violations.push(`transitive: ${chain.join(" -> ")}: loads the openclaw package (${line.trim()})`);
  });
  for (const spec of importsOf(source)) {
    const targetAbs = resolveModule(file, spec);
    const target = targetAbs ? toPosix(relative(root, targetAbs)) : null;
    const why = forbiddenWhy(spec, target);
    if (why && !rel.startsWith("engine/")) {
      violations.push(`transitive: ${chain.concat(target ?? spec).join(" -> ")}: engine graph must not reach ${why}`);
      continue;
    }
    if (why) continue; // rule 1 already reported this direct import
    if (target && target.startsWith("lib/")) queue.push({ file: targetAbs, chain: chain.concat(target) });
  }
}
```

and change the clean message to `console.log(\`lint-engine-imports: clean (${graph.size} module(s), ${reached.size - [...graph.keys()].filter((k) => k.startsWith("engine/")).length} lib module(s) reached)\`);`. `stripComments` strips `//` and `/* */` (`:115-117`), so the comment test passes; string literals are kept for the env and load rules (`process.env["OPENCLAW_…"]` is a real read).

- [ ] **Step 4: Run the tests — they pass — and the tree is clean**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/lint-engine-imports.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
```

Expected: all cases green, including "passes on the current tree"; the script prints `clean (…)`. If it reports a violation on the real tree, Task 11 missed a site: fix the site, never the rule.

- [ ] **Step 5: Prove both rules were red on the base**

```bash
cd "$PLUR1BUS" && git worktree add /tmp/m1b1-base 91dfce25 >/dev/null 2>&1 && cp scripts/lint-engine-imports.mjs /tmp/m1b1-lint.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node /tmp/m1b1-lint.mjs /tmp/m1b1-base | tail -30; echo "exit=$?"
cd "$PLUR1BUS" && git worktree remove --force /tmp/m1b1-base && rm -f /tmp/m1b1-lint.mjs
```

Expected: `exit=1` with at least `transitive: engine/capture/capture-turn.js -> lib/memory-request-context.js: loads the openclaw package`, `transitive: … lib/dreaming/dream-diary.js -> lib/setup/feature-cron-plugin-runtime.js: … a lib/setup plugin runtime`, and 14 `env:` lines — the 8 in `engine/**` plus `lib/setup/feature-profiles.js:454,570`, `lib/telegram-commands/feature-toggle.js:147,148`, `lib/telegram-commands/memory-edit.js:58`, `lib/obsidian-bridge.js:572`. (The other 8 lines of Task 11's table — `speaker-mapping-store.js` ×4, `providers/env.js`, `status-data.js` ×2, `index.js:5676` — are reachable today only from `index.js`; they join the engine graph when Task 13b moves the construction, which is why Task 11 fixes them now.) Paste the output into the task report — it is the "red on main today" half of the spec's gate.

- [ ] **Step 6: Lint, suite, commit**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add scripts/lint-engine-imports.mjs tests/lint-engine-imports.test.js
git commit -m "feat(engine): transitive engine-import lint and the OPENCLAW env rule

G1 gate (spec 3.4). lint-engine-imports walks engine/** through lib/** and
applies the forbidden-import rule, a no-openclaw-load rule and a no
process.env.OPENCLAW_* rule to every reached module. Red on 91dfce25 (14 env
reads on today's engine graph, two transitive openclaw paths), green here."
```

---

## Step 9 — how `createEngine()` is actually done

Tasks 13a–13c are the M1a recipe at a larger scale, in three commits that each keep the suite and the golden corpus green:

- **13a** moves `index.js`'s ~4 000 lines of *module-level* declarations (`:247-4249`) into `engine/**` modules, one module per responsibility, `index.js` importing and re-exporting. No behaviour, no `register()` change.
- **13b** moves the *construction* half of `register()` (`:4256-7659`) into `engine/create-engine.js` as `createEngine(host, config)`, holding every constructed object in one non-exported `EngineInternals`, and moves the *registration* half into `adapter/openclaw/plugin.js`, which calls the nine `register-*` modules in today's order. `index.js` becomes the ≤ ~200-line shell. The context objects of M1a stay — they become views over `EngineInternals` built once (spec §3.1).
- **13c** puts the contract's `Engine` surface on top (`recall`, `capture`, `runCommand`, `tools`, `jobs`, `checkpoint`, `status`, `close({ budgetMs })`, `events`, `channels`), bumps the contract to 1.4.0, and proves stub-host construction.

Two rules carry over from M1a unchanged: derive every context key with `tools/free-identifiers.mjs` instead of by reading (Global Constraint 11), and pass — never import — anything declared in `index.js` (after 13a nothing is).

---

### Task 13a (step 9, part 1): `index.js`'s module-level declarations move into `engine/**`

**Files:**
- Create (each holds the listed `index.js` range verbatim, at `9fd7bab4` numbering):

| Module | `index.js` range | Contents |
|---|---|---|
| `engine/runtime/debug-log.js` | `:286-329` | `pluginLogger` (+ `setPluginLogger(logger)`), `PURGE_THROTTLE_MS`, `purgeThrottleMap`, `dbg`, `runSpeakerProposalPipeline` |
| `engine/runtime/constants.js` | `:254-270`, `:285` | `DEFAULT_BASE_DB_PATH`, `DEFAULT_MODEL`, `MAX_PROMPT_REPLY_OUTCOME_READ_BYTES`, `EPISODED_TURN_ID_MEMORY`, `MAX_POSTPROCESSING_RETRIES`, `CORRECTION_PREVIEW_CHARS`, `TABLE_NAME` |
| `engine/store/lancedb-loader.js` | `:248-252`, `:330-331`, `:445-499` | legacy/plugin module paths, `getLanceDB`, `getOpenAI` |
| `engine/runtime/semantic-discovery.js` | `:373-444` | `semanticDiscoveryStats`, `addSemanticDiscoveryStats`, `selectSemanticDiscoveryWorkspaces` (public), `runSemanticDiscoveryBatches` |
| `engine/providers/legacy-providers.js` | `:337-372`, `:2961-3119` | the unused `Reranker` and `Embeddings` classes (moved, not deleted — deletion is not this milestone's call) |
| `engine/runtime/env-config.js` | `:500-643` | `resolveEnvVars`, `resolveOptionalEnvVars`, `resolveConfiguredApiKey`, `normalizedLlmErrorClass`, `commandOption`, `generateSummary`, `readFileHeadSync`, `summarizeForCapture`, `makeQuerySummarizer` |
| `engine/recall/namespace-recall.js` | `:644-852` | `normalizeBoundedRecallInteger`, `resolveRuntimeRecallBudget`, `applyMergedRecallBudget`, `runMergedNamespaceRecall`, `combineNamespaceRecallFailures`, `settleAllNamespaceReads`, `createNamespaceChildRecallTrace` |
| `engine/store/memory-db.js` | `:853-2415` | LanceDB constants, `MemoryDB` (public), `pathEntryExists`, `deriveExpectedCanonicalTarget`, `applyEpistemicStatusToLanceDb`, `applyValidTimeCloseToLanceDb`, `deriveNeoRequesterFromCtx`, `applyEpistemicStatusToNeo` (the three `apply…` public) |
| `engine/store/agent-db-pool.js` | `:2416-2866` | `AgentDbPool` (public) |
| `engine/store/control-health.js` | `:2867-2960` | control-health constants and helpers |
| `engine/commands/command-helpers.js` | `:3120-3170`, `:3183-3235`, `:3297-3315`, `:3541-3696`, `:4115-4249` | `buildMaintenanceNudges`, `formatJsonCommandResult`, `finiteSkillMetric`, `aggregateSkillMinerRuns`, `formatKnownValidityLabel`, `guardUnsafeDirectCronTurn`, the Neo/conflict-log helpers (`appendConflictLog`, `buildConflictSummaryFromLog` public), the confirmation helpers (`parseConfirmationCommand`, `resolveConfirmationIdentity`, `rememberPendingConfirmation`, `completePendingConfirmation` public) |
| `engine/runtime/llm-calls.js` | `:3697-3779` | `callLlm`, `withDeterministicLlmContext`, `callMergeCheck` |
| `engine/knowledge/knowledge-pending.js` | `:3780-4041` | the KNOWLEDGE.md pending/lock/update helpers |
| `engine/providers/runtime-reranker.js` | `:4042-4093` | `createRuntimeRerankerProvider` (public) |

- Modify: `index.js` (delete the ranges; import what `register()` still uses; re-export the 19 public names)
- Modify: `tests/helpers/runtime-sources.js` (fourteen `ENGINE_PATHS` entries), `scripts/lib/deploy-integrity.mjs` (fourteen entries)
- Create: `tests/engine-runtime-modules.test.js`

**Interfaces:**
- Produces: the modules above; `setPluginLogger(logger)` replaces the assignment `pluginLogger = host.logger;` (`index.js:4308`), because an ESM importer cannot assign a `let` it imports. `index.js`'s public names resolve to the same functions/classes (identity-equal).

- [ ] **Step 1: Write the failing test**

Create `tests/engine-runtime-modules.test.js`:

```js
/**
 * tests/engine-runtime-modules.test.js — step 9, part 1.
 *
 * The public names index.js has always exported are the engine modules'
 * bindings, not copies, and no engine module reaches back into index.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as index from "../index.js";
import { MemoryDB, applyEpistemicStatusToLanceDb, applyValidTimeCloseToLanceDb, applyEpistemicStatusToNeo } from "../engine/store/memory-db.js";
import { AgentDbPool } from "../engine/store/agent-db-pool.js";
import { buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, guardUnsafeDirectCronTurn, parseConfirmationCommand, resolveConfirmationIdentity, rememberPendingConfirmation, completePendingConfirmation } from "../engine/commands/command-helpers.js";
import { createRuntimeRerankerProvider } from "../engine/providers/runtime-reranker.js";
import { selectSemanticDiscoveryWorkspaces } from "../engine/runtime/semantic-discovery.js";
import { dbg, setPluginLogger } from "../engine/runtime/debug-log.js";

describe("index.js re-exports the engine's bindings", () => {
  it("identity-equal for every moved public name", () => {
    const moved = { MemoryDB, AgentDbPool, applyEpistemicStatusToLanceDb, applyValidTimeCloseToLanceDb, applyEpistemicStatusToNeo, buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, guardUnsafeDirectCronTurn, parseConfirmationCommand, resolveConfirmationIdentity, rememberPendingConfirmation, completePendingConfirmation, createRuntimeRerankerProvider, selectSemanticDiscoveryWorkspaces };
    for (const [name, binding] of Object.entries(moved)) assert.equal(index[name], binding, name);
  });

  it("dbg logs through the logger setPluginLogger installed", () => {
    const seen = [];
    setPluginLogger({ debug: (m) => seen.push(m) });
    dbg(new Error("probe"), "scope");
    assert.deepEqual(seen, ["[plur1bus] scope: probe"]);
    setPluginLogger(null);
  });
});
```

- [ ] **Step 2: Run it — it fails**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-runtime-modules.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Move the modules one at a time, in table order**

For each row, in order (earlier modules are dependencies of later ones):

```bash
cd "$PLUR1BUS" && grep -n '<first declaration of the row>' index.js    # re-derive the start
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js <start> <end>
```

The analyser's MODULE-SCOPE list is everything the range uses that `index.js` declares at top level or imports. For each name: if `index.js` imports it, copy that import into the new module with `./lib/` rewritten to `../../lib/`; if it is declared in an already-moved module, import it from there; if it is declared in a *later* row, the table order is wrong for that name — move the later declaration first. Export every name `index.js` (or another module) still uses. Moved code that reads `__pluginDir` imports `PLUGIN_ROOT` from `../../lib/plugin-meta.js` (Task 11) instead; moved code with a lazy `import("./lib/…")` becomes `import("../../lib/…")` (Global Constraint 12):

```bash
cd "$PLUR1BUS" && grep -n 'import(\|import\.meta\|__pluginDir' engine/runtime engine/store engine/providers engine/knowledge engine/commands/command-helpers.js engine/recall/namespace-recall.js -r
```

After each module: `node --check` both files, verify the extracted text's braces balance (`/home/claude/.node24/bin/node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");let d=0;for(const c of s.replace(/(["'"'"'`])(?:\\.|(?!\1).)*\1/gs,"")){if(c==="{")d++;if(c==="}")d--;}console.log(d)' <file>` prints `0`), run `tests/index-public-exports.test.js`, and only then take the next row.

`engine/runtime/debug-log.js` replaces the bare assignment with a setter:

```js
let pluginLogger = null;

/** Install the host logger dbg() and the speaker pipeline write to (was index.js:4308). */
export function setPluginLogger(logger) {
  pluginLogger = logger ?? null;
}
```

and `index.js:4308` `pluginLogger = host.logger;` becomes `setPluginLogger(host.logger);`. `aclDeniedError`'s `pluginLogger?.warn?.(…)` (`index.js:5234`, inside `register()`) becomes `getPluginLogger()?.warn?.(…)` with `export function getPluginLogger() { return pluginLogger; }` in the same module.

- [ ] **Step 4: Re-export the public names**

`index.js`'s tail keeps the exact export statement (`:7661`) and the nine `export function`/`export class` names become re-exports:

```js
export { MemoryDB, applyEpistemicStatusToLanceDb, applyValidTimeCloseToLanceDb, applyEpistemicStatusToNeo } from "./engine/store/memory-db.js";
export { AgentDbPool } from "./engine/store/agent-db-pool.js";
export { selectSemanticDiscoveryWorkspaces } from "./engine/runtime/semantic-discovery.js";
export { parseConfirmationCommand, resolveConfirmationIdentity, rememberPendingConfirmation, completePendingConfirmation, buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, guardUnsafeDirectCronTurn } from "./engine/commands/command-helpers.js";
export { createRuntimeRerankerProvider } from "./engine/providers/runtime-reranker.js";
export { inspectCronNativeCapabilities, reconcileUnsafeDirectCronsWithService, runDeferredFeatureCronBootstrap } from "./adapter/openclaw/host-probes.js";
export { parseFeatureCronBootstrapLastPlanCreateCount } from "./lib/feature-crons-hint.js";
export default plugin;
```

(merge with Task 11's re-exports; each name exported once). `buildMaintenanceNudges` is still passed into the recall/maintenance contexts by `register()` — it is now an import there, which is what M1a's "pass, don't import" rule was waiting for (the engine modules may import it directly now that it lives in `engine/`; leave the context keys in place until 13b removes them wholesale).

- [ ] **Step 5: Verify and commit**

Register the fourteen modules (`ENGINE_PATHS` short names = file basenames in camelCase; `DEPLOY_FILES` engine section).

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js && wc -l index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-runtime-modules.test.js tests/index-public-exports.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -4
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add engine index.js tests scripts/lib/deploy-integrity.mjs
git commit -m "refactor(engine): move index.js module-level declarations into engine/

Step 9 part 1. Fourteen modules under engine/{runtime,store,providers,
knowledge,commands,recall}; index.js re-exports the 19 public names
(identity-equal). The pluginLogger assignment becomes setPluginLogger()."
```

Expected: `index.js` ≈ 3 500 lines (only `register()` and imports left); both test files green; engine lint clean (the transitive walk now covers the fourteen modules — a violation means a moved range imports an adapter-side `lib/` module; `lib/runtime-shutdown.js` is the likely one, which Task 13b relocates, so if it shows up here, move `createLocalModelGenerationLifecycle` now as described in 13b Step 2); golden 11/11; lint and suite green.

---

### Task 13b (step 9, part 2): `createEngine(host, config)`; the adapter registers; `index.js` ≤ ~200 lines

**Files:**
- Create: `lib/local-model-generation.js` (`createLocalModelGenerationLifecycle` + its two helpers, `lib/runtime-shutdown.js:7-216`, re-exported from `lib/runtime-shutdown.js` for its importers)
- Create: `engine/lifecycle/close-resources.js` (the `shutdownOnce` body, `lib/runtime-shutdown.js:240-291`)
- Modify: `lib/runtime-shutdown.js:218-313` (`registerGatewayShutdown` builds its closer from the engine module; signature unchanged)
- Modify: `lib/host-services.js` (`createHostServices(api, { capabilities })`)
- Create: `engine/internals.js`, `engine/create-engine.js`, `adapter/openclaw/plugin.js`
- Modify: `index.js` (reduced to the shell)
- Modify: the nine `adapter/openclaw/register-*.js` modules only where a context key they read was a *registration-scope* value that now lives in `EngineInternals` (they keep their `(ctx)` signature; `plugin.js` builds `ctx` from internals)
- Modify: `tests/helpers/golden-prefix-driver.js` only if `hooks.at(-1)` changes (it must not — Global Constraint 14)
- Create: `tests/engine-create-engine.test.js`

**Interfaces:**
- Consumes: Task 11's `HostServices` 1.3.0; every module from 13a.
- Produces:
  - `createEngine(host, config, testOptions?: { internals?: object }) -> Engine` (13c fills the public surface; here `Engine` has `contract`, `close`, and the internals seam)
  - `ENGINE_INTERNALS` (a `Symbol.for("plur1bus.engine.internals")`) and `internalsOf(engine) -> EngineInternals` — **adapter-only**, documented as the transitional seam PR-14 removes
  - `HostServices.capabilities?: HostCapabilities` (lands in the 1.4.0 text in 13c) carrying the OpenClaw-only construction inputs listed below
  - `registerPlur1bus(api, registrationDependencies) -> void` — the old `register()` contract
  - `createResourceCloser({ logger, …the old registerGatewayShutdown options }) -> () => Promise<void>` (idempotent)

**Every `api` read inside `register()` at `9fd7bab4` and where it goes** (from `awk 'NR>=4256 && NR<=7660 && /(^|[^A-Za-z0-9_.$])api([^A-Za-z0-9_$]|$)/' index.js`):

| Line(s) | Read | Destination |
|---|---|---|
| `4293` | `api.pluginConfig` | `config` argument of `createEngine` |
| `4296-4298` | `shouldCoordinateLocalModelGeneration(api)`, `api.registrationMode` | `host.capabilities.coordinatesLocalModelGeneration` (boolean, computed in `plugin.js`), `host.capabilities.registrationMode` |
| `4305`, `4316`, `4674`, `5718`, `5897`, `7131`, `7141` | `api.config` | `host.config()` (`lib/host-services.js:87` returns `api.config ?? {}`) |
| `4307` | `createHostServices(api)` | `plugin.js` |
| `4309-4385` | `api.registerMemoryCapability(…)` | `plugin.js` → `registerMemoryCapability(internals, api)` in `adapter/openclaw/register-tools.js` (same file as the tool registration; first registration, as today) |
| `4387-4396` | `inspectCronNativeCapabilities(api)`, the skill-workshop probe | `plugin.js`; results in `host.capabilities.cronDirectDispatchReady`, `host.capabilities.skillWorkshop` |
| `4397` | `registerUnsafeDirectCronGuard({ api, … })` | `plugin.js`, position 2 |
| `4398` | `makeReactionsCapabilityChecker(api)` | `host.capabilities.detectReactions` |
| `4399`, `4997` | `api.resolvePath(…)` | `host.capabilities.resolvePath` (identity when absent) |
| `4948` | `registerOpenClawMemoryEmbeddingProviders(api, …)` | `plugin.js`, position 3 |
| `5150` | `registerNeoWorkerWarmUp` | `plugin.js`, position 4 |
| `5734-5800` | `api.on("skill_proposal_changed", …)` | `plugin.js`, position 5 (the handler body moves to `adapter/openclaw/register-commands.js` as `registerSkillProposalListener(ctx)`) |
| `6003` | `createOpenClawEmbeddingSelectionMutator({ api })` | `host.capabilities.createEmbeddingSelectionMutator()` (factory; the guard stays in the engine) |
| `6027` | `configMutationLogNotice(api)` | `host.capabilities.configMutationNotice` |
| `6866`, `6869`, `6879` | Obsidian lifecycle, deferred cron bootstrap, prompt supplements | `plugin.js`, positions 6–8 |
| `6908-7280` | the bare command block (`registerPluginCommand`, `registerChatCommands`, `/wiki`, `runOperatorCommand`) | `plugin.js`, position 9; `createPlur1busCommandRunner(…)` itself is construction → `createEngine`, **unconditional** (today it only runs when `api.registerCommand` exists) |
| `7090` | `resolveNeoHooksConfig(api, commandConfig)` | `host.capabilities.resolveNeoHooksConfig` |
| `7279`, `7289`, `7352-7371`, `7377`, `7496-7533`, `7536-7632` | Neo service, capture + checkpoint, reply-outcome `agent_end`, tools, reply-outcome `before_prompt_build`, turn route + recall / maintenance | `plugin.js`, positions 10–15, in this order |
| `7641` | `registerGatewayShutdownServices` | `plugin.js`, last |
| `4260-4284` | `registrationDependencies` | validated in `plugin.js`; `commandRuntimeHooks`, `skillWorkshop`, `handleObsidianBridgeCommand`, `shareCard` travel as `host.capabilities.*`; `importRouting` as `host.routing`; `hostEvents` as `host.events` |

- [ ] **Step 1: Write the failing test**

Create `tests/engine-create-engine.test.js`:

```js
/**
 * tests/engine-create-engine.test.js — step 9, part 2 (spec success criterion 1).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { runtimeSourcePath } from "./helpers/runtime-sources.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function stubConfig(baseDbPath) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: false, autoRecall: true,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  };
}

describe("createEngine", () => {
  it("constructs from a stub host with no OpenClaw api anywhere", async () => {
    const baseDbPath = makeTempDir("plur1bus-create-engine-");
    const host = createStubHost({ stateDir: makeTempDir("plur1bus-create-engine-state-") });
    const engine = createEngine(host, stubConfig(baseDbPath));
    const internals = internalsOf(engine);
    assert.equal(typeof internals.pool.withDb, "function");
    assert.equal(typeof internals.runPlur1busCommand, "function", "the command runner is built without a registerCommand host");
    assert.equal(internals.jobs.list().length, 18);
    await engine.close({ budgetMs: 5_000 });
  });

  it("index.js is the thin shell", () => {
    const lines = readFileSync(runtimeSourcePath("index.js"), "utf8").split("\n").length;
    assert.ok(lines <= 220, `index.js has ${lines} lines`);
  });

  it("close() is idempotent", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("plur1bus-ce-state-") }), stubConfig(makeTempDir("plur1bus-ce-db-")));
    const first = engine.close({ budgetMs: 5_000 });
    const second = engine.close({ budgetMs: 5_000 });
    assert.equal(first, second, "the same promise");
    await first;
  });
});
```

- [ ] **Step 2: Run it — it fails**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-create-engine.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND … engine/create-engine.js`.

- [ ] **Step 3: Relocate the two host-coupled pieces the engine needs**

`lib/local-model-generation.js` — move `localModelGenerationState`, `lifecycleError` and `createLocalModelGenerationLifecycle` (`lib/runtime-shutdown.js:7-216`) verbatim; in `lib/runtime-shutdown.js` replace them with `export { createLocalModelGenerationLifecycle } from "./local-model-generation.js";` (and import the two helpers back if the remaining file uses them — `grep -n 'lifecycleError\|localModelGenerationState' lib/runtime-shutdown.js`).

`engine/lifecycle/close-resources.js`:

```js
/**
 * engine/lifecycle/close-resources.js — the engine's close path (spec 3.1).
 *
 * Was the body of shutdownOnce in lib/runtime-shutdown.js:240-291. Idempotent:
 * every call returns the same promise. The OpenClaw adapter still registers it
 * as the host's runtime-lifecycle cleanup and gateway_stop handler.
 */

/**
 * @param {object} options The resources registerGatewayShutdown received, plus `logger`.
 * @returns {() => Promise<void>}
 */
export function createResourceCloser({
  logger,
  memoryDbAdapter,
  pool,
  sharedMemoryPool = null,
  clearTurnRoutes = null,
  flushMetrics,
  llmResultCache,
  scopedEmbeddingServer = null,
  embeddings = null,
  reranker = null,
  modelPreparationCoordinator = null,
  reembeddingCoordinator = null,
  localModelGeneration = null,
}) {
  let shutdownPromise = null;
  return function closeResources() {
    if (shutdownPromise) return shutdownPromise;
    localModelGeneration?.beginCleanup?.();
    shutdownPromise = (async () => {
      const cleanup = async (label, operation) => {
        try { await operation(); } catch (err) { logger.warn?.(`${label}: ${err?.message}`); }
      };
      /* lib/runtime-shutdown.js:247-289 verbatim (localModelResources, immediate, ordered, Promise.all) */
    })();
    return shutdownPromise;
  };
}
```

`registerGatewayShutdown(api, options)` keeps its signature; its `let shutdownPromise … const shutdownOnce = () => { … };` (`:240-293`) becomes `const shutdownOnce = createResourceCloser({ logger: api.logger, ...options });` (import from `../engine/lifecycle/close-resources.js`; `lib/` importing `engine/` is permitted — the reverse is what the lint forbids). The `cleanup` warnings still go to `api.logger.warn` (same object `host.logger` wraps), so log text is unchanged.

- [ ] **Step 4: Build `engine/internals.js` and `engine/create-engine.js`**

`engine/internals.js`:

```js
/**
 * engine/internals.js — the adapter's transitional window into EngineInternals.
 *
 * The OpenClaw adapter still registers M1a's context-object handlers, which
 * are views over the engine's internals. That is the only legitimate reader;
 * the harness uses the public Engine surface. Removed with PR-14.
 */

export const ENGINE_INTERNALS = Symbol.for("plur1bus.engine.internals");

/** @param {object} engine @returns {object} EngineInternals */
export function internalsOf(engine) {
  const internals = engine?.[ENGINE_INTERNALS];
  if (!internals) throw new TypeError("not a PLUR1BUS engine");
  return internals;
}
```

`engine/create-engine.js` — the move itself. Derive the construction statements of `register()`: everything from `const rawPluginConfig = api.pluginConfig || {};` (`index.js:4293`) to just before `registerGatewayShutdownServices({` (`:7641`), **minus** the registration calls in the table above. Run the analyser over the whole body once to see what it closes over:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js $(grep -n 'const rawPluginConfig = api.pluginConfig' index.js | cut -d: -f1) $(( $(grep -n 'registerGatewayShutdownServices({' index.js | cut -d: -f1) - 1 ))
```

Expected after 13a: `REGISTER-SCOPE … 2` = `api registrationDependencies` (the only names from outside), and a MODULE-SCOPE list of imports (all now `engine/**` or `lib/**`). The move:

```js
/**
 * engine/create-engine.js — the one construction path (spec 3.1, owner decision A).
 *
 * Was the construction half of index.js register(). Every object it builds is
 * a member of one EngineInternals; the OpenClaw adapter registers views over
 * it (engine/internals.js), the harness uses the Engine surface.
 */

/* the MODULE-SCOPE imports from the analyser, "./lib/" → "../lib/", "./engine/" → "./" */
import { ENGINE_INTERNALS } from "./internals.js";
import { bindHostPaths } from "../lib/host-paths.js";
import { setPluginLogger } from "./runtime/debug-log.js";

/**
 * @param {object} host HostServices (contract 1.4.0).
 * @param {object} config The plugin config (EngineConfig).
 * @param {{internals?: object}} [testOptions] Test-only: overrides applied to EngineInternals after construction.
 * @returns {object} Engine.
 */
export function createEngine(host, config, testOptions = {}) {
  const capabilities = host.capabilities ?? {};
  const resolvePath = typeof capabilities.resolvePath === "function" ? capabilities.resolvePath : (value) => value;
  bindHostPaths(host.pathOverrides);
  setPluginLogger(host.logger);
  /* index.js register() construction statements, in order, with exactly these substitutions:
     - `api.pluginConfig || {}`                          -> `config || {}`
     - `shouldCoordinateLocalModelGeneration(api)`       -> `capabilities.coordinatesLocalModelGeneration === true`
     - `typeof api.registrationMode === "string" && api.registrationMode !== "full"`
                                                         -> `typeof capabilities.registrationMode === "string" && capabilities.registrationMode !== "full"`
     - `api.config` (seven sites)                        -> `host.config()`
     - `api.resolvePath(`                                -> `resolvePath(`
     - `openClawSkillWorkshop` (the probe at :4390-4396) -> `capabilities.skillWorkshop ?? null`
     - `cronDirectDispatchReady` (:4387-4389)            -> `capabilities.cronDirectDispatchReady === true`
     - `makeReactionsCapabilityChecker(api)`             -> `capabilities.detectReactions ?? (async () => false)`
     - `createOpenClawEmbeddingSelectionMutator({ api })`-> `(capabilities.createEmbeddingSelectionMutator?.() ?? null)` (the surrounding
                                                            `reembeddingConfigMutationAvailable ? … : null` condition, index.js:6001-6004, stays in the engine)
     - `configMutationLogNotice(api)`                    -> `capabilities.configMutationNotice ?? null`
     - `(commandConfig) => resolveNeoHooksConfig(api, commandConfig)` -> `capabilities.resolveNeoHooksConfig ?? (() => ({}))`
     - the registrationDependencies destructuring (:260-266) -> `const { commandRuntimeHooks = null, handleObsidianBridgeCommand: registeredObsidianCommandHandler = handleObsidianBridgeCommand, shareCard: registeredShareCard = shareCard } = capabilities;`
     - `const host = createHostServices(api, …)` and `pluginLogger = host.logger` -> deleted (host is the parameter)
     - the `if (typeof api.registerCommand === "function") {` guard around createPlur1busCommandRunner -> removed; the runner is always built
     - Task 10's `const runPlur1busCommand = (commandCtx, …) => runPlur1busCommandWithIdentity(…, { agentContext: agentContextFromCommand(commandCtx), … })`
                                                         -> stays in plugin.js (it imports the adapter's agentContextFromCommand); the engine keeps the
                                                            raw runner as `internals.runPlur1busCommand` and plugin.js wraps it for registerChatCommands
     - each registration call in the table -> deleted here (plugin.js makes it)
  */
  const internals = {
    /* every const/let the adapter's register-* contexts or the Engine surface read, as shorthand
       properties — generate the list from the union of the nine register-* ctx literals in index.js
       (grep -n "register[A-Z][A-Za-z]*({" index.js) plus runPlur1busCommand, jobs, checkpointStore,
       runtimeScheduler, embeddings, reranker, pool, sharedMemoryPool, memoryDbAdapter, closeResources */
    ...(testOptions.internals ?? {}),
  };
  const engine = {
    contract: "1.4.0",
    close: ({ budgetMs } = {}) => internals.closeEngine(budgetMs),
  };
  Object.defineProperty(engine, ENGINE_INTERNALS, { value: internals, enumerable: false });
  return engine;
}
```

`let` bindings the old body reassigns at turn time (`cfg` at `:4295`/`:4411`, the ten thunk targets rebound after `registerChatCommands`, `index.js:7174`) must become properties of `internals` that later code reads through `internals.x`, exactly as M1a converted the meta-reflection counters (M1a plan Task 14, Step 1): the command runner's thunks read `internals.commandBodies.runMemoryCommand(...)`, and `plugin.js` assigns `internals.commandBodies = registerChatCommands(ctx)`. Grep the moved body for `let ` and for each reassigned name decide: construction-time only (stays `let` inside `createEngine`) or turn-time (becomes an `internals` property).

`closeEngine(budgetMs)` is built at the end of construction:

```js
  const closeResources = createResourceCloser({ logger: host.logger, memoryDbAdapter, pool: { shutdown: async () => { legacyMigrationShutdown.abort(); await pool.shutdown(); } }, sharedMemoryPool, clearTurnRoutes: clearInitializedTurnRoutes, flushMetrics, llmResultCache, scopedEmbeddingServer, embeddings, reranker, modelPreparationCoordinator, reembeddingCoordinator, localModelGeneration });
  let closing = null;
  const closeEngine = (budgetMs) => {
    if (closing) return closing;
    const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 30_000;
    closing = Promise.race([
      closeResources(),
      new Promise((resolve) => { const timer = setTimeout(() => { host.logger.warn(`plur1bus engine: close exceeded ${budget} ms; resources still closing in the background`); resolve(); }, budget); timer.unref?.(); }),
    ]);
    return closing;
  };
```

The arguments are the ones `registerGatewayShutdownServices` passes today (`adapter/openclaw/register-gateway.js:152-168`); `flushMetrics` is whatever that module imports it from — import it the same way. The 30 000 ms default matches the `gateway_stop` envelope (Global Constraint 14). `registerGatewayShutdownServices` then receives `closeResources` and hands it to `registerGatewayShutdown` instead of the separate resources — keep the four `…AfterLifecycle` calls exactly as they are.

- [ ] **Step 5: `adapter/openclaw/plugin.js` and the `index.js` shell**

`adapter/openclaw/plugin.js`:

```js
/**
 * adapter/openclaw/plugin.js — the OpenClaw plugin's register().
 *
 * createHostServices(api) -> createEngine(host, config) -> the nine
 * register-*.js modules, in the order index.js called them (registration
 * order per host event list is a contract: adapter/openclaw/README.md).
 */

import { createEngine } from "../../engine/create-engine.js";
import { internalsOf } from "../../engine/internals.js";
import { createHostServices } from "../../lib/host-services.js";
import { setHostSdkLoader } from "../../lib/host-sdk-loader.js";
import { loadOpenClawPluginSdkRuntime } from "../../lib/setup/feature-cron-plugin-runtime.js";
import { shouldCoordinateLocalModelGeneration, configMutationLogNotice } from "../../lib/runtime-shutdown.js";
import { createOpenClawSkillWorkshopClient } from "../../lib/setup/skill-workshop-plugin-runtime.js";
import { createOpenClawEmbeddingSelectionMutator } from "../../lib/reembedding/runtime-config.js";
import { inspectCronNativeCapabilities, makeReactionsCapabilityChecker, resolveNeoHooksConfig } from "./host-probes.js";
/* the nine register-* imports index.js has today (index.js:231-240), plus registerMemoryCapability and registerSkillProposalListener */

/**
 * @param {object} api OpenClaw plugin API.
 * @param {object} [registrationDependencies] Test-injection dependencies (unchanged contract).
 */
export function registerPlur1bus(api, registrationDependencies = {}) {
  /* index.js:257-284 validation, verbatim (including hostEvents from Task 2) */
  setHostSdkLoader(loadOpenClawPluginSdkRuntime);
  const skillWorkshop = registrationDependencies.skillWorkshop !== undefined
    ? registrationDependencies.skillWorkshop
    : (typeof api.registerGatewayMethod === "function" && typeof api.registerCli === "function" ? createOpenClawSkillWorkshopClient() : null);
  const host = createHostServices(api, {
    events: registrationDependencies.hostEvents,
    ...(registrationDependencies.importRouting ? { routing: registrationDependencies.importRouting } : {}),
    capabilities: {
      registrationMode: api.registrationMode,
      coordinatesLocalModelGeneration: shouldCoordinateLocalModelGeneration(api),
      resolvePath: (value) => api.resolvePath(value),
      cronDirectDispatchReady: process.env.NODE_TEST_CONTEXT ? true : inspectCronNativeCapabilities(api),
      skillWorkshop,
      detectReactions: makeReactionsCapabilityChecker(api),
      createEmbeddingSelectionMutator: () => createOpenClawEmbeddingSelectionMutator({ api }),
      configMutationNotice: configMutationLogNotice(api),
      resolveNeoHooksConfig: (commandConfig) => resolveNeoHooksConfig(api, commandConfig),
      commandRuntimeHooks: registrationDependencies.commandRuntimeHooks ?? null,
      ...(registrationDependencies.handleObsidianBridgeCommand ? { handleObsidianBridgeCommand: registrationDependencies.handleObsidianBridgeCommand } : {}),
      ...(registrationDependencies.shareCard ? { shareCard: registrationDependencies.shareCard } : {}),
    },
  });
  const engine = createEngine(host, api.pluginConfig || {}, registrationDependencies.engineInternals ? { internals: registrationDependencies.engineInternals } : {});
  const internals = internalsOf(engine);
  /* positions 1–16 from the table, each call's ctx literal copied from index.js with `api` plus internals.<key> for every key */
}
```

`createHostServices` gains a `capabilities` option copied onto the host as-is. The embedding-selection mutator is passed as a factory because its guard (`typeof host.runtime?.config?.mutateConfigFile === "function"`, `index.js:6001`) reads the lazily usable runtime and must keep running at construction time inside the engine. `process.env.NODE_TEST_CONTEXT` is read in the adapter, where env reads are allowed.

`index.js` becomes:

```js
/**
 * memory-lancedb-namespaced — the OpenClaw plugin entry point.
 *
 * openclaw.plugin.json `extensions` and package.json `main` point here, and
 * 48 test files import the default export and the named exports below. The
 * plugin itself is adapter/openclaw/plugin.js over engine/create-engine.js.
 */

import { registerPlur1bus } from "./adapter/openclaw/plugin.js";

const plugin = {
  id: "memory-lancedb-namespaced",
  name: "Memory (LanceDB, per-Agent)",
  description: "Per-agent isolated LanceDB memory",
  kind: "memory",
  register(api, registrationDependencies = {}) {
    return registerPlur1bus(api, registrationDependencies);
  },
};

/* the re-exports from Task 13a Step 4, unchanged */
export default plugin;
```

- [ ] **Step 6: Verify — golden first, then the ordering pins**

Register `engine/internals.js`, `engine/create-engine.js`, `engine/lifecycle/close-resources.js`, `adapter/openclaw/plugin.js`, `lib/local-model-generation.js` (`ENGINE_PATHS`/`ADAPTER_PATHS` for the first four; all five in `DEPLOY_FILES`).

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js && /home/claude/.node24/bin/node --check engine/create-engine.js && /home/claude/.node24/bin/node --check adapter/openclaw/plugin.js && wc -l index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-create-engine.test.js tests/index-public-exports.test.js tests/adapter-register-gateway.test.js tests/critical-review-command.test.js tests/adapter-register-commands.test.js tests/runtime-shutdown*.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs && /home/claude/.node24/bin/node scripts/lint-no-api-outside-adapter.mjs
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `index.js` ≤ ~200 lines; golden 11/11 — **a byte difference is a construction statement that moved relative to a registration it depended on, or a registration out of order**; `adapter-register-gateway` pins the 30 000 ms `gateway_stop`; `critical-review-command` pins the last `before_agent_reply` handler; both linters clean (a transitive violation names the `lib/` module the construction pulled in — route it through `host.capabilities` as the table does); lint and suite green. A hung `npm test` means `registerGatewayShutdownServices` is no longer last or the closer never resolves.

- [ ] **Step 7: Commit**

```bash
git add engine adapter lib/local-model-generation.js lib/runtime-shutdown.js lib/host-services.js index.js tests scripts/lib/deploy-integrity.mjs
git commit -m "refactor(engine): createEngine(host, config) is the one construction path

Step 9 part 2 (spec 3.1, owner decision A). register()'s construction moves
into engine/create-engine.js behind one EngineInternals; OpenClaw-only inputs
arrive as host.capabilities. adapter/openclaw/plugin.js is createHostServices
-> createEngine -> the nine register-* modules in unchanged order. index.js is
the entry shell. The shutdown body becomes the engine's idempotent close path."
```

---

### Task 13c (step 9, part 3): the `Engine` surface and contract 1.4.0

**Files:**
- Create: `engine/recall/system-supplement.js`
- Modify: `engine/create-engine.js` (public members), `adapter/openclaw/register-prompt-supplements.js:36-50` (use the builder)
- Modify: `lib/runtime-scheduler.js:558-` (`enqueueCapture` accepts `meta.signal` like `runRecall`)
- Modify: `types/engine.d.ts` (1.4.0), `types/engine.conformance.ts`
- Modify: `tests/helpers/golden-prefix-driver.js` (the embedder stub through `engineInternals`, if byte-identical — Step 5)
- Create: `tests/engine-contract.test.js`

**Interfaces:**
- Produces (on the object `createEngine` returns): `contract: "1.4.0"`, `open(agentId)`, `close({ budgetMs })`, `status()`, `systemSupplement()`, `recall(q)`, `capture(t)`, `checkpoint(agentId, reason)`, `tools`, `commands`, `runCommand(name, args, principal, agent)`, `jobs`, `embedding`, `admin`, `events`, `channels`

- [ ] **Step 1: Write the failing contract test**

Create `tests/engine-contract.test.js`:

```js
/**
 * tests/engine-contract.test.js — the Engine surface against a stub host
 * (spec success criteria 1, 3; step 9 gates).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
});

function hangingEmbedder(probe) {
  const hang = (_text, options = {}) => new Promise((_, reject) => {
    probe.calls += 1;
    options.signal?.addEventListener("abort", () => { probe.abortedAt = Date.now(); reject(options.signal.reason); }, { once: true });
  });
  return { embed: hang, embedQuery: hang, embedPassage: hang, embedBatch: async () => [], shutdown: async () => {} };
}

const principal = { agentId: "agent-a", workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "inferred" };
const agent = { origin: "user", background: false };

describe("Engine", () => {
  it("reports contract 1.4.0, 18 jobs, the tools and a status", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    assert.equal(engine.contract, "1.4.0");
    assert.equal(engine.jobs.list().length, 18);
    assert.deepEqual(engine.tools.map((t) => t.name).sort(), ["knowledge_update", "memory_forget", "memory_recall", "memory_search", "memory_store"]);
    assert.equal((await engine.status()).contract, "1.4.0");
    assert.ok(engine.systemSupplement().length >= 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() aborted at 100 ms cancels the embedder and resolves within 50 ms (criterion 3)", async () => {
    const probe = { calls: 0, abortedAt: null };
    const host = createStubHost({ stateDir: makeTempDir("ec-state-"), workspaceDir: async () => makeTempDir("ec-ws-") });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: hangingEmbedder(probe) } });
    const signal = AbortSignal.timeout(100);
    const result = await engine.recall({ query: "what happened while I was away", principal, agent, signal });
    const resolvedAt = Date.now();
    assert.deepEqual(result.degraded, { reason: "aborted", capability: "recall" });
    assert.ok(probe.calls >= 1);
    assert.ok(probe.abortedAt !== null);
    assert.ok(resolvedAt - probe.abortedAt <= 50, `resolved ${resolvedAt - probe.abortedAt} ms after the abort`);
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() never throws: a missing signal and a bad principal come back degraded", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    assert.equal((await engine.recall({ query: "x", principal, agent })).degraded.reason, "invalid-query");
    assert.equal((await engine.recall({ query: "x", principal: { ...principal, agentId: "../etc" }, agent, signal: AbortSignal.timeout(1_000) })).degraded.reason, "invalid-query");
    await engine.close({ budgetMs: 5_000 });
  });

  it("jobs.run returns a JobRun and checkpoint returns a CheckpointResult", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-"), clock: () => 5 }), config(makeTempDir("ec-db-")));
    const run = await engine.jobs.run("gc-run", "agent-a", { trigger: "harness" });
    assert.equal(run.job, "gc-run");
    assert.ok(["skipped", "completed", "failed"].includes(run.outcome));
    const cp = await engine.checkpoint("agent-a", "session-end");
    assert.deepEqual([cp.agentId, cp.reason, cp.written], ["agent-a", "session-end", true]);
    await assert.rejects(() => engine.checkpoint("agent-a", "reboot"), /unknown checkpoint reason/);
    await engine.close({ budgetMs: 5_000 });
  });

  it("capture() returns a handle immediately", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    const started = Date.now();
    const handle = engine.capture({ agentId: "agent-a", principal, agent, messages: [{ role: "user", content: "hi" }], incognito: false, signal: AbortSignal.timeout(5_000) });
    assert.ok(Date.now() - started < 5);
    assert.equal(typeof handle.id, "string");
    assert.ok(handle.done instanceof Promise);
    handle.abort("test over");
    await handle.done;
    await engine.close({ budgetMs: 5_000 });
  });

  it("close() under a tiny budget still resolves, and stays idempotent", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    const started = Date.now();
    await engine.close({ budgetMs: 1 });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(engine.close({ budgetMs: 1 }), engine.close());
  });
});
```

`gc-run` with `gc.enabled: false` is `skipped/gc_disabled` through `defaultInput` when the stub host's runtime can resolve a workspace; with the stub's `runtime: null`, `resolveCronMemoryContext` throws inside `defaultInput` and the run is `failed` — both are JobRuns, which is the contract; the test accepts either.

- [ ] **Step 2: Run it — it fails**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-contract.test.js 2>&1 | tail -6
```

Expected: `engine.jobs` is undefined (13b exposed only `contract` and `close`).

- [ ] **Step 3: Add the public members**

`engine/recall/system-supplement.js` — the two literal arrays of `register-prompt-supplements.js:40` and `:44-49` as `buildSystemSupplement({ neoEnabled })` (importing `buildRecallSafetyPreamble` from where that module does); the adapter's two `api.registerMemoryPromptSupplement(() => …)` calls become `() => buildSystemSupplement({ neoEnabled })` inside the same guards.

`lib/runtime-scheduler.js` `enqueueCapture(agentId, meta, fn)` — link `meta.signal` exactly as Task 3 did for `runRecall` (already-aborted → resolve `{ ok: false, aborted: true, reason: "aborted", background }` without enqueueing; otherwise the job's signal is `AbortSignal.any([controller.signal, meta.signal])`).

In `createEngine`, after `internals` is built, replace the `engine` literal with:

```js
  const openedAgents = new Set();
  const recallTurn = createPromptContextAssembler(/* the recall ctx view, as registerRecallHook builds it, minus api */ internals.recallContext);
  const captureTurn = createTurnCapture(internals.captureContext);
  const toolFactory = createMemoryTools(internals.toolContext);
  const channels = createChannelRegistry();
  const listeners = new Map();
  const emit = (name, payload) => { for (const fn of listeners.get(name) ?? []) { try { fn(payload); } catch (error) { host.logger.debug(`engine listener ${name} failed: ${String(error?.message || error)}`); } } };
  const engine = {
    contract: "1.4.0",
    async open(agentId) {
      const id = safeAgentId(agentId);
      await internals.pool.withDb(id, (db) => db.init());
      openedAgents.add(id);
      return { agentId: id, close: async () => { openedAgents.delete(id); } };
    },
    close: ({ budgetMs } = {}) => internals.closeEngine(budgetMs),
    async status() {
      return { ready: true, degraded: null, agents: openedAgents.size, contract: "1.4.0" };
    },
    systemSupplement: () => buildSystemSupplement({ neoEnabled: internals.neoEnabled }),
    async recall(q) {
      if (!(q?.signal instanceof AbortSignal)) {
        return recallResult({ degraded: { reason: "invalid-query", capability: "recall", detail: "signal is required" } });
      }
      try {
        const agentId = safeAgentId(q.principal?.agentId);
        const workspaceDir = await host.workspaceDir(agentId);
        const memoryCtx = memoryContextFromPrincipal(q.principal, { workspaceDir, workspaceAliases: internals.memoryWorkspaceAliases });
        const event = { prompt: String(q.query ?? ""), messages: [{ role: "user", content: String(q.query ?? "") }], ...(q.compactedAt ? { compactedAt: q.compactedAt } : {}) };
        const hookCtx = { agentId, workspaceDir };
        const result = await recallTurn(event, hookCtx, { signal: q.signal, memoryCtx, agentContext: q.agent });
        emit("recall.completed", { agentId, timing: result.timing, degraded: result.degraded });
        return result;
      } catch (error) {
        return recallResult({ degraded: { reason: "invalid-query", capability: "recall", detail: String(error?.message || error).slice(0, 200) } });
      }
    },
    capture(t) {
      const controller = new AbortController();
      const signal = t?.signal ? AbortSignal.any([t.signal, controller.signal]) : controller.signal;
      const acceptedAt = typeof host.clock === "function" ? host.clock() : Date.now();
      const done = (async () => {
        if (t?.incognito) return { stored: 0, skipped: 1, reason: "incognito" };
        const agentId = safeAgentId(t.agentId);
        const workspaceDir = await host.workspaceDir(agentId);
        const memoryCtx = memoryContextFromPrincipal(t.principal, { workspaceDir, sessionKey: t.sessionKey, workspaceAliases: internals.memoryWorkspaceAliases });
        const outcome = await captureTurn(
          { messages: t.messages, success: true, runId: t.runId, sessionKey: t.sessionKey },
          { agentId, workspaceDir, sessionKey: t.sessionKey },
          { memoryCtx, agentContext: t.agent, signal },
        );
        return outcome?.ok ? { stored: 1, skipped: 0 } : { stored: 0, skipped: 1, reason: outcome?.reason ?? "not_captured" };
      })().catch((error) => ({ stored: 0, skipped: 1, reason: String(error?.message || error).slice(0, 200) }));
      return { id: randomUUID(), acceptedAt, done, abort: (reason) => controller.abort(reason) };
    },
    async checkpoint(agentId, reason) {
      return internals.checkpointStore.checkpoint(safeAgentId(agentId), reason);
    },
    get tools() {
      return toolFactory({ agentId: "default" }).map(({ name, description, parameters }) => ({ name, description, parameters }));
    },
    commands: [{ name: "plur1bus", description: "PLUR1BUS memory commands", acceptsArgs: true }],
    async runCommand(name, args, principalIn, agentIn) {
      if (name !== "plur1bus") return { text: `command not available on this host: ${name}` };
      const memoryCtx = memoryContextFromPrincipal(principalIn, { workspaceDir: await host.workspaceDir(principalIn.agentId) });
      return internals.runPlur1busCommand(
        { agentId: principalIn.agentId, args: String(args ?? ""), channel: principalIn.channel, accountId: principalIn.accountId, chatId: principalIn.chat?.id, config: host.config() },
        [],
        { agentContext: agentIn, memoryCtx },
      );
    },
    jobs: Object.freeze({
      list: () => internals.jobs.list(),
      run: (name, agentId, opts = {}) => internals.jobs.run(name, agentId, { trigger: "harness", ...opts }),
      history: (agentId, opts = {}) => internals.jobs.history(agentId, opts),
    }),
    embedding: internals.embeddingService,
    admin: internals.adminOps,
    events: Object.freeze({
      on(name, handler) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handler);
        return { dispose: () => listeners.get(name)?.delete(handler) };
      },
    }),
    channels,
  };
  Object.defineProperty(engine, ENGINE_INTERNALS, { value: internals, enumerable: false });
  return engine;
```

Supporting edits: `createTurnCapture`'s handler passes `opts.signal` into `runtimeScheduler.enqueueCapture(agentId, { background, signal: opts.signal }, …)` (Task 10 already added `opts`); `internals.recallContext`, `captureContext`, `toolContext` are the three ctx literals `plugin.js` hands to `registerRecallHook`/`registerCaptureHook`/`registerMemoryTools`, built once in `createEngine` and reused by `plugin.js` (spec §3.1 "views … built once, not per call") — move their construction from `plugin.js` into `createEngine` and have `plugin.js` spread them with `api`.

**Build the capture handler exactly once.** `createTurnCapture` binds the `light-dream` job owner at factory time (Task 7), and a second call throws `job light-dream already has an owner`. So `captureTurn` above is stored as `internals.captureTurn`, and `adapter/openclaw/register-capture-hook.js` changes `const handler = createTurnCapture(ctx);` to `const handler = ctx.captureTurn ?? createTurnCapture(ctx);`, with `plugin.js` passing `captureTurn: internals.captureTurn`. The recall assembler is the opposite case: the adapter's instance must carry the adapter's `resolveTurnPrincipal` (Task 10), so `register-recall-hook.js` keeps building its own, and `Engine.recall`'s instance (`recallTurn`, no resolver — it always passes `opts.memoryCtx`) is a second, side-effect-free construction. `createMemoryTools` has no factory-time side effect; `register-tools.js` may use `ctx.toolFactory ?? createMemoryTools(ctx)` for symmetry. `internals.embeddingService` and `internals.adminOps` are thin objects over the existing members: `embedding = { embed: (texts, o) => Promise.all(texts.map((t) => embeddings[o.kind === "query" ? "embedQuery" : "embedPassage"](t, { signal: o.signal }))), rerank: (q, docs, o) => reranker ? reranker.rerank(q, docs, o.topN, { signal: o.signal }) : Promise.resolve([]), probe: async () => ({ ok: true, cached: false }), identities: () => [], serve: async () => ({ dispose() {} }) }` and `admin` = the existing coordinators behind the contract's method names, each missing operation rejecting `not available in M1b-1` (document which in `docs/engine-api.md`, Task 14). Engine events are fed by wrapping `host.events` once at the top of `createEngine`: `host = { ...host, events: { emit: (n, p) => { emit(n, p); host.events?.emit?.(n, p); } } }` — do it before any construction statement reads `host`.

- [ ] **Step 4: Contract 1.4.0**

Write `types/engine.d.ts` against the target section at the top of this plan:

1. Header: `Contract version 1.4.0`, "amended four times"; changelog line `*            1.4.0 — Engine surface of createEngine (M1b-1): ContextBlock.chars; RecallResult.timing (replaces timings) and .deferrals; RecallQuery.budget optional; JobRun/JobRegistry/JobSpec per spec 3.3 (outcome gains "abandoned"); CheckpointReason gains "session-end"; Engine.close({ budgetMs }); Engine.channels; HostServices.capabilities?; EngineEventName gains recall.block-clipped/-dropped, recall.completed; createEngine testOptions.`
2. `ContractVersion = "1.4.0"`.
3. Replace `ContextBlock`, `RecallQuery.budget` (→ `budget?: Partial<RecallBudget>`), `RecallResult`; add `Deferral`, `RecallTiming`, `HostCapabilities`, `JobOutcome`, `JobTrigger`, `JobCost` (`{ ms: number; provider?: string; model?: string; inputTokens?: number; outputTokens?: number }`), the new `JobRun`; `JobRegistry` becomes `list(): JobSpec[]; run(job: JobName, agentId: AgentId, opts?: { signal?: AbortSignal; trigger?: JobTrigger; dryRun?: boolean }): Promise<JobRun>; history(agentId: AgentId, opts?: { job?: JobName; since?: number; limit?: number }): Promise<JobRun[]>;`; `CheckpointReason` four values; `EngineEventName` += `"recall.block-clipped" | "recall.block-dropped" | "recall.completed"`; `HostServices` += `capabilities?: HostCapabilities;`; `Engine.close(opts?: { budgetMs?: number }): Promise<void>;` and `channels: { register(name: ChannelRef): string; has(name: ChannelRef): boolean; list(): ChannelRef[] };`; `createEngine(host: HostServices, config: EngineConfig, testOptions?: { internals?: Record<string, unknown> }): Engine;` with the doc comment "testOptions is test-only".

`types/engine.conformance.ts`:

```ts
// 1.4.0: five outcomes, abandoned included.
assertTrue<Exact<(typeof run)["outcome"], "completed" | "skipped" | "incomplete" | "failed" | "abandoned">>();
// Deferral kinds and the timing object replace the untyped timings map.
declare const result: RecallResult;
assertTrue<Exact<(typeof result)["deferrals"][number]["kind"], "clipped" | "dropped">>();
assertTrue<Exact<(typeof result)["timing"]["totalMs"], number>>();
// CheckpointReason is the widened union.
assertTrue<Exact<CheckpointReason, "compaction" | "session-end" | "shutdown" | "manual">>();
```

(replacing the old outcome assertion at `:57-59`; add `CheckpointReason` to the import list), and every `ContextBlock` literal in `blocks` (`:41-48`) gains `chars: 0`.

Also: `docs/engine-api.md` header → 1.4.0 (full rewrite in Task 14).

- [ ] **Step 5: The driver's embedder seam (spec §3.1)**

In `tests/helpers/golden-prefix-driver.js`, replace the prototype patch with `plugin.register(api, { importRouting, hostEvents, engineInternals: { embeddings: stubProvider } })`, where `stubProvider` implements `embed`, `embedQuery`, `embedPassage`, `embedBatch` and `shutdown` with the same `topicVector(topicOf(text))` mapping and the same hang/probe behaviour as Task 3. Run the golden corpus. **If all eleven stay byte-identical, keep it and delete `stubEmbedder`; if any differs** (the provider's embedding cache or `ensureDimensions` path can differ from a plain object), revert this step, keep the prototype patch, and record in the task report that the internals seam exists (`createEngine`'s third argument, used by `tests/engine-contract.test.js`) but the driver still patches — the oracle outranks the seam (Global Constraint 6).

- [ ] **Step 6: Verify and commit**

Register `engine/recall/system-supplement.js`.

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-contract.test.js tests/engine-create-engine.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run typecheck
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -6
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add engine adapter lib/runtime-scheduler.js types docs/engine-api.md tests scripts/lib/deploy-integrity.mjs
git commit -m "feat(engine): the Engine surface of createEngine; contract 1.4.0

Step 9 part 3 (spec 3.1-3.5). recall/capture/runCommand take Principal and
AgentContext; recall never throws and honours its signal end to end; jobs,
checkpoint, tools, channels, events and close({ budgetMs }) are public.
types/engine.d.ts 1.4.0 and its conformance move with their consumer."
```

Expected: `tests 6` + `tests 3`; typecheck green; golden 11/11; engine lint clean; lint and suite green.

---

### Task 14 (step 10): timing through `host.events`, the bench, and the documentation

Spec §3.2 last bullet, §5 last sentence, step 10. The M1a sink (`recallTimingSink`, fed from the test-only `api.__recallTimingSinkForTests`, `index.js:7584-7589` at `9fd7bab4`, `engine/recall/assemble-prompt-context.js:55-63,1206-1217`) is replaced by `RecallResult.timing` and the `recall.completed` host event; the fine per-namespace phases stop being folded into the outer timer (which the scheduler's timeout log reads) and are collected separately as `timing.namespacePhases`, always.

**Files:**
- Modify: `engine/recall/assemble-prompt-context.js` (remove `recallTimingSink`; fill `timing`; emit `recall.completed`)
- Modify: `engine/recall/namespace-recall.js` (was `index.js:683-808`: `recordNamespacePhases` → `onNamespacePhases`)
- Modify: `adapter/openclaw/plugin.js` (drop `recallTimingSink: api.__recallTimingSinkForTests ?? null`)
- Modify: `tests/helpers/golden-prefix-driver.js` (`recallTimingSink` option becomes a `hostEvents` listener)
- Modify: `tests/engine-assemble-prompt-context.test.js:54-112` (the sink tests become timing tests)
- Modify: `bench/recall-budget-probe.mjs:33-83` (docstring), `:256-262` (reads `timing`)
- Rewrite: `docs/engine-api.md`; modify `docs/compatibility-openclaw.md:175-187`, `CHANGELOG.md`, `adapter/openclaw/README.md`
- Create: `bench/results/2026-09-23-recall-budget-probe.md` (the re-run)

**Interfaces:**
- Produces: `RecallResult.timing = { phases: phaseTimer.summary(), totalMs: phaseTimer.elapsedMs(), namespacePhases: [{ namespace, phase, ms }] }` on every scheduled recall; host event `recall.completed` `{ agentId, timing, degraded }`; `runMergedNamespaceRecall(…, { strictReadErrors, onNamespacePhases? })`

- [ ] **Step 1: Rewrite the sink tests first (they fail)**

In `tests/engine-assemble-prompt-context.test.js`, replace the `recallTimingSink` describe (`:54-112`) with:

```js
  describe("RecallResult.timing (replaces recallTimingSink)", () => {
    it("recall.completed carries phases, totalMs and per-namespace phases, and never changes the prefix", async () => {
      const scenario = SCENARIOS[0];
      const events = [];
      const withEvents = await runScenario(scenario, { hostEvents: { emit: (name, payload) => events.push({ name, payload }) } });
      const without = await runScenario(scenario);
      assert.equal(withEvents, without);
      const completed = events.filter((e) => e.name === "recall.completed");
      assert.equal(completed.length, 1);
      const { timing } = completed[0].payload;
      assert.ok(Array.isArray(timing.phases.completed));
      assert.ok(timing.phases.completed.some((c) => c.phase === "namespace-recall"));
      assert.ok(timing.totalMs >= 0);
      assert.ok(timing.namespacePhases.some((p) => p.phase === "embedding"), "fine phases are always collected, separately");
    });

    it("no test-only api property remains", () => {
      const { all } = readRuntimeSources();
      for (const source of all) assert.doesNotMatch(source, /__recallTimingSinkForTests|recallTimingSink/);
    });
  });
```

(import `readRuntimeSources` from `./helpers/runtime-sources.js`). Run it: the first fails (no `recall.completed`), the second fails (the sink is still there).

- [ ] **Step 2: Replace the sink**

`engine/recall/namespace-recall.js`: the options parameter `{ strictReadErrors = false, recordNamespacePhases = false } = {}` becomes `{ strictReadErrors = false, onNamespacePhases = null } = {}`, and the fold block (`if (recordNamespacePhases) { for (const entry of childTimer.summary().completed) phaseTimer?.record?.(…) }`) becomes:

```js
      if (typeof onNamespacePhases === "function") {
        onNamespacePhases(namespace, childTimer.summary().completed);
      }
```

— the outer `phaseTimer` is never written, so the scheduler's timeout log line (`lib/runtime-scheduler.js:456-476`) reads exactly what it read in production before. Delete the fix-round comment paragraphs that described the gate.

`engine/recall/assemble-prompt-context.js`: delete `recallTimingSink = null,` from the destructuring and its JSDoc paragraph (`:55-63`); before `runtimeScheduler.runRecall(` add `const namespacePhases = [];`; in the `runMergedNamespaceRecall(…)` options replace `recordNamespacePhases: Boolean(recallTimingSink),` with `onNamespacePhases: (namespace, completed) => { for (const entry of completed) namespacePhases.push({ namespace, phase: entry.phase, ms: entry.ms }); },`; replace the sink `try { recallTimingSink?.(…) } catch (sinkErr) { dbg(sinkErr); }` block with

```js
    const timing = { phases: phaseTimer.summary(), totalMs: phaseTimer.elapsedMs(), namespacePhases };
    const withTiming = (result) => ({ ...result, timing });
```

and wrap every `return` after it (`scheduledRecall.value ?? recallResult()`, the abort/timeout `recallResult({ blocks: partial(), degraded })`, the final `recallResult()`) in `withTiming(…)`, then emit once just before those returns: `emitEngineEvent(host, "recall.completed", { agentId: agentIdForCache, timing, degraded: … })` — compute the result first, emit with its `degraded`, return it. A cached value's `timing` is the current attempt's, which is the one worth reporting.

`adapter/openclaw/plugin.js`: delete the `recallTimingSink: api.__recallTimingSinkForTests ?? null,` line and its comment. `tests/helpers/golden-prefix-driver.js`: `runScenario`'s `recallTimingSink` option stays (the bench uses it) but is implemented as a listener — before `plugin.register(…)`:

```js
    const listeners = [hostEvents, recallTimingSink && {
      emit: (name, payload) => {
        if (name === "recall.completed") recallTimingSink({ agentId: payload.agentId, phases: payload.timing.phases, totalMs: payload.timing.totalMs, namespacePhases: payload.timing.namespacePhases });
      },
    }].filter(Boolean);
    const events = listeners.length ? { emit: (name, payload) => { for (const l of listeners) l.emit(name, payload); } } : null;
```

and pass `...(events ? { hostEvents: events } : {})` to `register`. Remove `__recallTimingSinkForTests` from `makeApi`.

- [ ] **Step 3: Switch the bench and re-run it**

`bench/recall-budget-probe.mjs`: `recordPhases` (`:256-262`) folds both lists:

```js
  const recordPhases = (entry) => {
    recallAttempts += 1;
    const samples = [
      ...entry.phases.completed.map(({ phase, ms }) => ({ phase, ms })),
      ...(entry.namespacePhases ?? []).map(({ namespace, phase, ms }) => ({ phase: `${namespace}:${phase}`, ms })),
    ];
    for (const { phase, ms } of samples) {
      if (!phaseSamples.has(phase)) phaseSamples.set(phase, []);
      phaseSamples.get(phase).push(ms);
    }
  };
```

— the `${namespace}:${phase}` names are the ones the M1a fold recorded, so the report's phase table keeps its rows. Rewrite the docstring paragraphs at `:33-83` to say the probe reads `RecallResult.timing` through the `recall.completed` host event. Then:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node bench/recall-budget-probe.mjs 2>&1 | tee /tmp/m1b1-probe.txt | tail -40
```

Write `bench/results/2026-09-23-recall-budget-probe.md` with the same sections as `bench/results/2026-09-22-recall-budget-probe.md`, the new numbers, and a "Comparison" table (per scenario: 2026-09-22 p50/p95 vs 2026-09-23 p50/p95, delta). Acceptance: no scenario's recall p95 worse than 2026-09-22 by more than 20 % (the probe's N=20 noise band; state the observed spread). A larger regression stops the task and goes to the report — do not tune to pass. `bench/` is outside `npm run lint`'s sweep (`package.json` `lint`), so run `node --check bench/recall-budget-probe.mjs` by hand.

- [ ] **Step 4: Documentation**

`docs/engine-api.md` — rewrite to contract 1.4.0, keeping its structure (`docs/engine-api.md:1-158`): header `Contract version 1.4.0` with the four amendments listed; "The two halves" describes `HostServices` including `configPath()`, `routing?`, `pathOverrides?`, `capabilities?`, `events`, `clock`; "Rules the types encode" gains: blocks are data and the host joins (`adapter/openclaw/join-recall.js`); every clip/drop is a `Deferral` and a `recall.block-*` event; the signal reaches embedder, reranker and LanceDB, abort returns completed blocks with `degraded.reason = "aborted"`; one rerank timer; every job run has a ledger row (`<baseDbPath>/_jobs/<agentId>/ledger.jsonl`, and why not `stateDir`), `incomplete` → retry ×2 → `abandoned`, the 3-session breaker; `Principal.trust` and what `inferred` means in code; `checkpoint()` and `compactedAt`. Replace "What is implemented in M1a" with "What is implemented in M1b-1" (`createEngine`, the adapter shape, `engine/internals.js` as the adapter-only seam, the six command bodies still adapter-owned — `runCommand` answers only `plur1bus` on a host without the OpenClaw adapter — and which `admin` operations reject). Update the module-layout table with every file this plan created. Update the lint paragraph with rules 6–7.

`docs/compatibility-openclaw.md` — in the table at `:175-187`, change the "Harness behaviour" cells whose text still says "Proposed" or names PR-07/PR-08/PR-15 as future to what now exists (scheduled tasks: `Engine.jobs.run()` with the ledger; compaction: `Engine.checkpoint(agentId, "compaction")`); add a row "Recall budget and cancellation" (OpenClaw: `AbortSignal.timeout(recallTimeoutMs)`; harness: its own budget, G6).

`CHANGELOG.md` — under `## [Unreleased]`, one bullet per task in user-facing German-or-English matching the file's existing style (check the top entries), including the three behaviour changes of Global Constraint 7 and the ledger location.

`adapter/openclaw/README.md` — the module table gains `plugin.js`, `join-recall.js`, `turn-principal.js`, `host-probes.js`; the "Deliberately still in index.js" section is replaced by "Still adapter-owned after M1b-1" (the six command bodies, `/wiki`, the critical-push claiming hooks, the control-UI descriptor), each with the PR that owns it.

- [ ] **Step 5: Verify and commit**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-assemble-prompt-context.test.js tests/config-docs-contract.test.js tests/golden-prefix.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check bench/recall-budget-probe.mjs
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
git add engine adapter tests bench docs/engine-api.md docs/compatibility-openclaw.md CHANGELOG.md
git commit -m "docs: engine API 1.4.0; recall timing via host.events; bench re-run

Step 10. RecallResult.timing and the recall.completed host event replace the
test-only recallTimingSink; per-namespace phases are collected separately and
no longer written into the timer the timeout log reads. The bench probe reads
timing and is re-run against 2026-09-22. docs/engine-api.md, the OpenClaw
compatibility matrix, CHANGELOG and the adapter README describe M1b-1."
```

Expected: timing tests green; `config-docs-contract` green (the spec's step-10 gate); golden 11/11; lint and suite green.

---

## Done means

- `git log --oneline 91dfce25..HEAD` shows the sixteen task commits in order (plus any fix-round commits).
- `npm test`: fail 0, skipped ≤ 3. `npm run lint`: clean, including `lint-engine-imports: clean` with the transitive walk and `typecheck` on 1.4.0.
- `git log --format=%h --name-status 91dfce25..HEAD -- tests/fixtures/golden-prefix/expected/` shows exactly two `A` entries (`recall-aborted.txt` in Task 3, `jobs-ledger-retry.txt` in Task 8) and no `M`/`D`.
- `wc -l index.js` ≤ ~200.
- `grep -rn 'process\.env\.OPENCLAW_' engine` and the lint's env rule: nothing on the engine graph.
- `bench/results/2026-09-23-recall-budget-probe.md` exists with a comparison to 2026-09-22.
- The PR description lists: the three behaviour changes (Global Constraint 7), the ledger location deviation (Task 7), the `run-state.json` vs `runs.json` finding (Task 9), the 22-vs-8 env-read count (Task 11), the breaker's definition of "sweep" (Task 8), and whether Task 13c Step 5 kept the prototype patch.

---

## Self-review

### Spec coverage

| Spec section | Requirement | Task |
|---|---|---|
| §1 criterion 1 | `createEngine(createStubHost(), config)`; no `openclaw` in the graph; adapter = host services → `createEngine` → nine `register-*`; `index.js` ≤ ~200 | 13b (construction, shell, adapter), 12 (graph proof), 13c (stub-host surface test) |
| §1 criterion 2 | suite green and golden byte-identical at every step | every task's verify step; Global Constraint 6 |
| §1 criterion 3 | `recall()` never throws; abort at 100 ms → embedder cancelled, ≤ 50 ms, `degraded.reason = "aborted"` | 3 (adapter path, scheduler), 13c (`Engine.recall`) |
| §1 criterion 4 | ledger row per run incl. skips; no-narrative REM `incomplete`, retried, at most twice | 6 (skips as outcomes), 7 (rows), 8 (retry/abandon) |
| §1 criterion 5 | no `openclaw` import or `OPENCLAW_*` read on the engine graph | 11 (fixes), 12 (lint) |
| §2 non-goals | none implemented | — (PR-10…PR-14, harness, scheduler untouched; `truncateMemoryContext` warning branch untouched in Task 2) |
| §3.1 shape | `Engine` members, `EngineInternals`, views built once, `clock`/`events` seams, `createEngine` third arg, `close({ budgetMs })` via the shutdown owner, `runtimeIfUsable` stays in adapter | 13b, 13c, 14 (sink → events) |
| §3.2 bullet 1 | blocks as data; host joins and caps; golden gate | 1 |
| §3.2 bullet 2 | L3 events + `Deferral`s; inner memories cap reports too | 2 |
| §3.2 bullet 3 | mandatory signal into embedder, reranker, LanceDB; `memory-host-runtime` stops dropping it; abort semantics; adapter passes `AbortSignal.timeout(recallTimeoutMs)` | 3 (reranker signal completed in 4) |
| §3.2 bullet 4 | one rerank timeout owner; one timer; HTTP abort | 4 |
| §3.2 bullet 5 | `timing` replaces the sink; bench reads it | 1 (field), 14 (sink removal, bench) |
| §3.3 JobSpec/JobRun/registry | 18 names, one owner, phases engine-owned, internal command + `feature.run` thin callers | 6 |
| §3.3 ledger | JSONL, marker before body, `ctx.skip()`, crash → `failed/crash`, skips at `info` | 6 (`ctx.skip`, info log), 7 |
| §3.3 semantics | `already_processed` after `completed` only; retry ×2 → `abandoned` + diary; breaker counts rows; diary outcome in row | 8 |
| §3.3 migration | `completed[runKey]` → rows with `cost {ms:0}`, `migrated`; old file never read again | 9 (against the code's `run-state.json`, see task) |
| §3.3 checkpoint | `checkpoint(agentId, reason)`; reactivation keys off it; adapter `before_compaction` | 5, 13c (public) |
| §3.4 Principal/AgentContext | explicit inputs; constructor; adapter keeps hook proof → `proved`; `inferred` agent-private, never throws; origin from caller; channel registry | 10, 13c (public entry points) |
| §3.4 G1 (1)–(3) + gate | routing injected; env reads via `host.stateDir`/`configPath()`; five `api` functions to adapter; transitive + env lint red→green | 11, 12 |
| §3.5 contract | bumps with reasons; conformance in the same commit; final 1.4.0 | 11 (1.3.0), 13c (1.4.0) |
| §4 step gates | steps 1–10 | Tasks 1, 2 (step 1); 3 (2); 4 (3); 5 (4); 6 (5); 7–9 (6); 10 (7); 11–12 (8); 13a–13c (9); 14 (10) |
| §5 testing | `tests/engine-*.test.js` on `createStubHost()`; adapter tests on the stub `api`; two new golden scenarios; bench re-run | per task; 3, 8 (scenarios); 14 (bench) |
| §6 risks | R1: ctx objects kept through step 8, `EngineInternals` last; migration fixture from the real shape; forbidden-list exclusion in the walk | 13b ordering; 9 fixture; 12 walk |

No spec requirement is without a task. Two are met differently from the spec's wording, deliberately, with the reason in the task: the ledger path (Task 7) and the migrated file (Task 9).

### Placeholder scan

Searched this file for `TBD`, `TODO`, `implement later`, `add error handling`, `similar to Task`, `write tests`, `fill in`: none. Four kinds of bracketed instruction remain and are intentional, each bounded by an exact command that produces its content: (a) "the analyser's MODULE-SCOPE/REGISTER-SCOPE list" (Tasks 6, 13a, 13b) — produced by `tools/free-identifiers.mjs` on a stated range, as in M1a; (b) "`<range>` verbatim, with these substitutions" for moves of 770 (Task 6), ~4 000 (13a) and ~3 400 (13b) lines — the substitutions are enumerated one by one; (c) the `internals` key list in 13b, defined as "the union of the nine `register-*` context literals", derivable with the quoted grep; (d) `91dfce25`, which the controller fills. No sketch in the file leaves a value to be filled in.

### Type consistency

- `RecallResult` is built only through `recallResult()` (Task 1) and gains `deferrals` (2), `degraded`/partial blocks (3), `timing` (1 default, 14 real); the 1.4.0 `.d.ts` in 13c names exactly these fields, and `timings` is removed there, not earlier (nothing consumes the type before 13c).
- `ContextBlock.chars` is set by `contextBlock()` from Task 1 on; conformance literals gain `chars: 0` in 13c.
- `Deferral.reason` is `"global-cap"` (2, planner) or `"memories-cap"` (2, `onTruncate`); the 1.4.0 union has exactly those two.
- `JobRun` fields are produced by `finish()` (6), persisted with `sweep`/`llmSession` (7, row-only extras that are not part of the contract type), extended with `keys`/`pendingKeys`/`idempotencyKey`/`diary` (6/8) and `migrated` (9). The 1.4.0 `JobRun` in the target section lists every one of those optional fields; `cost` is `{ ms }` everywhere in M1b-1 (provider/model/token fields stay unset until a job reports them).
- `JobTrigger` values used: `"cron"`, `"manual"` (6), `"capture"` (7), `"harness"` (13c, migrated rows use `"cron"`) — all four in the 1.4.0 union.
- `CheckpointReason`: `CHECKPOINT_REASONS` (5) equals the 1.4.0 union exactly; conformance asserts it (13c).
- `jobCtx` members: `skip`/`incomplete`/`noteDiary`/`markCompletedKey`/`notePendingKey`/`setDiaryTarget` (6), `hasCompletedKey`/`isAbandonedKey`/`noteAbandonedKey` (8), `migrateStore` (9). `ledgerBackedCompletion` (8/9) uses only these; the golden jobs driver (8) uses the 6+8 set.
- Recall handler signature grows `(event, hookCtx)` (1) → `(event, hookCtx, { signal })` (3) → `+ { memoryCtx, agentContext }` (10); the adapter hook always passes `signal` from Task 3 on; `Engine.recall` (13c) passes all three.
- `HostServices`: `events` option (2, runtime only), `configPath`/`routing`/`pathOverrides` (11, typed at 1.3.0), `capabilities` (13b runtime, typed at 1.4.0 in 13c).
