# BUG-01 Command Reachability Fix Receipt

Date: 2026-07-19
Finding: `BUG-01` from the 2026-07-18 repository reliability audit
Outcome: **fixed** in the `fix/high-mid-audit-findings` worktree

## Patch contract

### Vulnerable source-to-sink path

1. `plugin.register(api)` registers the public `forget` and `correct` commands and the `/plur1bus*` aliases.
2. An authorized command context reaches `runForgetCommand` or `runCorrectCommand`.
3. The initiation branch calls `normalizeCommandInput(...)` with `summarizer`.
4. Before this fix, neither handler declared that identifier. The surrounding catch returned `❌ /forget failed: summarizer is not defined` or `❌ /correct failed: summarizer is not defined` before candidate lookup and confirmation creation.
5. `/memory` remained reachable because `runMemoryCommand` already created its own agent-scoped summarizer.

The bug was reachable for every normal authorized `/forget <query>` and `/correct <old> -> <new>` initiation. It was a reliability failure, not an authorization bypass: unauthorized requests were still denied before the failing reference.

### Root cause

`summarizer` was local to `runMemoryCommand`, while the forget and correct initiation branches referenced the same name as though it were shared. JavaScript lexical scoping made the references undefined.

### Invariant

Every registered command that normalizes a memory query must receive an agent-scoped `Function|null` from:

```js
makeQuerySummarizer(mergingLlmCfg, api.logger, agentId)
```

The agent scope must be derived from that command invocation. Length validation and destructive-command authorization must remain ahead of candidate lookup and mutation. Confirmation, archive-first mutation, registration, alias routing, and public response contracts must remain unchanged.

## Patch

The production change is two declarations only:

- `runForgetCommand`: create the summarizer immediately after resolving `agentId`.
- `runCorrectCommand`: create the summarizer immediately after resolving `agentId`.

No confirmation, authorization, candidate, archive, correction, registration, or alias logic moved. The confirmation branches construct but never invoke the lazy summarizer closure, so they make no LLM call.

The deterministic LLM-cache source guard was updated from three to five exact agent-scoped `makeQuerySummarizer(...)` callsites. The guard still verifies that the summarizer's underlying LLM transform is deterministic and bound to the recall-query-summary cache purpose.

## Changed files

- `index.js` — two agent-scoped summarizer declarations.
- `tests/command-reachability.test.js` — real-plugin registered-command regression and `/memory` positive control.
- `tests/llm-result-cache-integration.test.js` — exact callsite-count guard updated for the two new scoped consumers.
- `docs/superpowers/plans/2026-07-19-b1-command-reachability.md` — implemented B1 plan, including the test-harness and guard adjustments.
- `docs/audits/2026-07-19-bug-01-command-reachability-fix.md` — this receipt.
- External, not in Git: scan bundle `artifacts/fix_report.md`.

## TDD evidence

### RED before production changes

`node --test tests/command-reachability.test.js` failed at file level with `index.js` unchanged. Because this Node runner reports an isolated failing file without nested assertion detail, the diagnostic direct run was used to verify the required failure semantics:

```text
node --trace-uncaught tests/command-reachability.test.js
tests 3; pass 1; fail 2
/memory: pass
/forget actual: ❌ /forget failed: summarizer is not defined
/correct actual: ❌ /correct failed: summarizer is not defined
```

This was the intended RED: imports, temporary LanceDB storage, command registration, and the positive control all worked.

### Test-harness corrections and review RED/GREEN

After the two-line production fix, the GREEN/review cycle produced the following test-harness evidence and corrections rather than an additional BUG-01 production change:

1. The forget post-delete assertion rejected the target query text, but the correct no-result response is `Nothing found for "<query>".` and therefore intentionally echoes that query. The test now requires a semantic not-found response and absence of the deleted memory ID. The successful deleted response plus archive file remain the archive-first deletion proof.
2. Adding the required real owner-confirm `/correct` assertions to the original single-generation fixture produced a focused review RED: 2/3 tests passed, while Lance panicked with `Column 'remindAt' is declared as non-nullable but contains null values` and the handler returned `❌ /correct failed: Update not possible: internal error; details were logged`.
3. Root-cause tracing showed a fixture lifecycle issue that also exposes a separate production risk: the first raw `MemoryDB` creates a base schema and caches its fields; the DB adapter then adds non-null reminder columns; the already-open raw DB filters reminder defaults through its stale field cache during `safeUpdate`. The regression now uses a product-realistic migrated runtime cycle: a real API generation seeds the row and runs registered `/memory` so the adapter migrates the table, then shuts down cleanly; a fresh registered API/pool generation on the same path performs correct initiation, wrong-user rejection, owner-confirm, archive verification, and corrected recall. The fresh `MemoryDB.init()` reads the complete schema and writes all non-null defaults.

These were test-only fixture corrections. No test-only production hook or additional production fix was made, and the same-generation schema-cache issue remains separately scoped.

### GREEN

```text
node --test tests/command-reachability.test.js
pass 1 file; fail 0

node tests/command-reachability.test.js
tests 3; pass 3; fail 0
```

The direct reporter confirms all three registered-command cases individually, including real owner-confirm, archive creation, and recall of the corrected content.

### Derived cache-guard RED/GREEN

The first authoritative serial run reached the existing deterministic cache guard and failed only because the exact expected callsite count was stale:

```text
Expected values to be strictly equal: 5 !== 3
tests/llm-result-cache-integration.test.js:485
```

After updating that exact count from 3 to 5:

```text
node --test tests/llm-result-cache-integration.test.js
pass 1 file; fail 0; exit 0
```

Inspection confirmed that all five source matches use the exact agent-bound argument list; this was not a scope or cache-purpose violation.

## Verification

| Gate | Command | Result |
|---|---|---|
| Baseline before test addition | `node --test tests/forget-correct-confirm.test.js tests/telegram-command-smoke.test.js tests/plur1bus-start-flow.test.js tests/smoke-semantic-input.test.js` | 4/4 files passed |
| Focused GREEN | `node --test tests/command-reachability.test.js` | Exit 0, including real correct owner-confirm |
| Individual focused GREEN | `node tests/command-reachability.test.js` | 3/3 tests passed; correct archive and corrected recall proven |
| Owning command/input suite | `node --test tests/command-reachability.test.js tests/forget-correct-confirm.test.js tests/telegram-command-smoke.test.js tests/plur1bus-start-flow.test.js tests/smoke-semantic-input.test.js` | 5/5 files passed; repeated after cache-guard and review-fixture updates |
| Original trigger | `node --test --test-name-pattern='registered /forget|registered /correct' tests/command-reachability.test.js` | Exit 0 |
| Alternate oversized-input class | `node --test tests/p1-robustness.test.js tests/telegram-command-smoke.test.js` | 2/2 files passed |
| Cache-callsite guard | `node --test tests/llm-result-cache-integration.test.js` | Exit 0 after derived guard update |
| Syntax/lint | `npm run lint` | Exit 0; repeated after final test change |
| Sandboxed serial diagnostic | `node --test --test-concurrency=1 tests/*.test.js test/*.test.js` | All files except the known nested-spawn symlink harness artifact passed: 259 pass, 1 file-level fail |
| Known artifact control | `node --test tests/setup-feature-crons-symlink.test.js` | 1/1 test passed, exit 0 |
| Authoritative serial suite outside the sandbox | `node --test --test-concurrency=1 tests/*.test.js test/*.test.js` | 2,556 tests; 2,555 passed; 0 failed; 1 skipped; exit 0 |

The sandbox-only serial artifact is not classified as fixed by B1. Its direct control passed exactly as required by the B1 plan, and the same full serial command subsequently passed outside the sandbox with zero failures.

## Original-trigger and bypass review

The source review command was:

```text
rg -n 'runForgetCommand|runCorrectCommand|makeQuerySummarizer|name: "(forget|correct|plur1bus_forget|plur1bus_correct)"' index.js
```

Review results:

- Top-level `forget` and `correct` registrations point directly to the fixed handlers.
- `plur1bus_forget` and `plur1bus_correct` route through `runPlur1busCommand` to those same handlers.
- Both handlers resolve their own `agentId` and pass it into `makeQuerySummarizer`.
- Confirmation branches return before query normalization and never invoke a summarizer.
- `checkArgsLength` still runs before trimming, normalization, candidate lookup, or summarization.
- Destructive `checkAuth` still runs before initiation and mutation.
- The registered `/memory` positive control continues to recall the seeded memory.
- Wrong-user confirmation attempts remain rejected with `security.wrong_user`.
- Forget completion still archives before deletion. Correct completion is now proven through the fresh real registered handler, including owner-bound confirmation, archive creation, and corrected recall; the existing helper suite remains an additional control.

## Remaining uncertainty

- The registered owner-confirm `/correct` path is now proven end-to-end against real, already-migrated temporary LanceDB state after a clean plugin/pool restart, matching a normal persisted runtime lifecycle. The separate same-generation schema-cache issue remains reproducible when a brand-new table is seeded, adapter-migrated, and semantically updated through an already-open raw `MemoryDB`. B1 neither fixes nor hides that production risk; it needs a separately scoped investigation and must not be conflated with BUG-01.
- The sandboxed serial runner can report `setup-feature-crons-symlink.test.js` as a nested-spawn file-level failure in this harness. The same test passes directly, and the authoritative outside-sandbox serial suite passes with zero failures. No B1 code touches that subsystem.

## Repository integrity

- Fix worktree base before B1: `1735d8e625d9582e39ef9d04c43052d442bba703`.
- `/root/openclaw-plur1bus-memory` remained on `main` at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e` throughout implementation and verification.
- B1 contains no B2 work and no unrelated production change.
