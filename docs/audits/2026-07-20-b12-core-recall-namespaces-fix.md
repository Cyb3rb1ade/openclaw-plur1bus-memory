# B12-Core Recall and Namespaces Fix Receipt

Date: 2026-07-21

Branch: `fix/high-mid-audit-findings`

Planning/base commit: `a53e244d1d73e9e19681c17da4740a18d4401b5e`

Implementation head: `5cf2f305e362d4cdb3926889ab0caf87f0ce224c`
(`fix: preserve hostile settlements and fair trace caps`)

## Disposition

- **FA-03: CLOSED.** Multi-namespace recall is schema-reachable, invokes the
  same existing recall pipeline for each configured table of the same agent,
  and performs one globally capped result/canonical/trace merge for the public
  tool, its search alias, and the prompt hook.
- **FE-ADD-05: CLOSED.** Namespace identifiers, roles, layouts, contained
  paths, canonical collisions, symlink substitutions, read-only behavior, and
  lease/shutdown lifetimes are validated fail-closed.
- An absent raw `namespaces` key preserves the exact legacy-flat
  `{baseDbPath}/{agentId}` route. No migration or path reinterpretation occurs.
- An explicit `namespaces` object selects named same-agent storage routing. It
  is not cross-agent, cross-workspace, or cross-user sharing.

> FA-07 remains OPEN for B12-P. B12-Core did not expose or change Query
> Refinement, Semantic Compression, Adaptive Budget, GraphIndex,
> candidateTopK runtime behavior, or Pattern Surfacing.

B13 still owns sharing and the broader ACL redesign. B12-Core retains existing
ownership fields but grants no new cross-principal access.

## Source-to-sink correction

The original runtime accepted no `namespaces` field through the strict public
schema. Internal routing accepted unsafe or ambiguous namespace shapes, did
not make the legacy role non-mutating, and could collapse a requested route to
`.`. The multi-table caller then flattened child output and passed the
deduplication threshold as the result cap, duplicated workspace canonical
content, and retained only the first trace.

The corrected path is:

```text
strict manifest + path-aware config validation
  -> immutable legacy-flat or named layout
  -> canonical namespace and agent directory capabilities
  -> one write lease for the active writer / read leases in configured order
  -> one existing recall pipeline per same-agent table
  -> Promise.allSettled for every child
  -> stable global canonical + memory + trace merge
  -> one final retrieval-ledger record
```

Every non-absent namespace failure rejects the public recall after all sibling
pipelines settle. No successful partial result or ledger record is exposed.

## Commit series

```text
22ee72e docs: plan B12 core namespace remediation
6d5eb68 feat: validate namespace configuration
e512219 fix: preserve internal flat namespace routing
a6066cf fix: contain namespace storage routes
cd4b506 fix: revalidate namespace routes before use
2389d76 fix: pin cached namespace routes
7e390ce fix: pin namespace paths through database open
3f92172 fix: bind database routes to directory capabilities
9943226 fix: retry read-only namespace discovery
6da068e fix: preserve legacy namespace path aliases
74f8d5c fix: serialize agent DB cache clearing
1f11321 fix: complete shutdown after cache clear failures
390feb2 fix: harden read-only cleanup portability
d72e05f fix: merge multi-namespace recall globally
cbbee2f fix: retain namespace reads through timeout settlement
e111ac6 fix: retain all namespace timeout settlements
8a379bc fix: fail closed on namespace anchor reads
95551d5 fix: deploy temporal recall helper
7b8e855 fix: retain strict reads after legacy skip
f66563e fix: settle timed-out database initialization
73897d8 fix: keep recall cleanup terminal under logger failure
b85f8f7 fix: contain asynchronous recall diagnostics
4d93679 fix: harden hostile diagnostic settlements
643ad39 fix: keep lifecycle warnings payload free
606c604 fix: redact complete authorization headers
6669a8a fix: contain folded authorization values
3470fcd docs: document B12 core namespace remediation
d7acf12 test: isolate upgrade child process
e8a1f12 fix: close b12 adversarial quality gaps
85dfedd test: avoid nested installer pipe deadlocks
5cf2f30 fix: preserve hostile settlements and fair trace caps
```

Commit `3470fcd` introduced the first complete receipt. The later implementation
and test-harness commits close findings from the post-documentation full reviews;
this documentation-only closure records their final independent review and
serial evidence.

## Changed files

Configuration and routing:

- `openclaw.plugin.json`
- `lib/setup/config-contract.js`
- `lib/namespace-config.js`
- `lib/multi-namespace-pool.js`
- `lib/directory-capability.js`
- `lib/sql-safety.js`
- `index.js`
- `scripts/lib/deploy-integrity.mjs`

Global recall merge and trace:

- `lib/recall-pipeline.js`
- `lib/recall-decision-trace.js`
- `lib/recall-phase-timer.js`
- `lib/temporal-filter.js`
- `lib/safe-logging.js`

Causal regressions:

- `tests/config-contract.test.js`
- `tests/namespace-config.test.js`
- `tests/runtime-config-contract.test.js`
- `tests/multi-namespace-pool.test.js`
- `tests/agent-db-pool-lease.test.js`
- `tests/memory-db-readonly.test.js`
- `tests/security-safety.test.js`
- `tests/deploy-integrity.test.js`
- `tests/namespace-recall-merge.test.js`
- `tests/multi-namespace-recall-runtime.test.js`
- `tests/recall-decision-trace.test.js`
- `tests/recall-pipeline-hydration.test.js`
- `tests/recall-pipeline-decision-trace.test.js`
- `tests/recall-phase-timer.test.js`
- `tests/p1-robustness.test.js`
- `tests/temporal-filter.test.js`
- `tests/memory-db-lifecycle-atomic.test.js`

Plan, current behavior, and evidence:

- `docs/superpowers/plans/2026-07-20-b12-core-recall-namespaces.md`
- `README.md`
- `docs/configuration.md`
- `docs/recall-architecture.md`
- `docs/audits/2026-07-20-b12-core-recall-namespaces-fix.md`
- `.superpowers/sdd/progress.md`

## Requirement-to-proof map

| Contract | Implementation | Causal proof |
|---|---|---|
| Strict optional schema; absence remains absent | `openclaw.plugin.json`, `lib/setup/config-contract.js`, raw-presence capture in `index.js` | `tests/config-contract.test.js`, `tests/runtime-config-contract.test.js` |
| Identifier syntax, semantic defaults, writer present in active reads, active/legacy disjoint | `lib/namespace-config.js` | `tests/namespace-config.test.js` |
| Exact flat compatibility; explicit root and active-leaf forms; non-writer leaf rejected | `resolveNamespaceLayout()` | `tests/namespace-config.test.js`, `tests/runtime-config-contract.test.js` |
| Same validated agent in every namespace | `MultiNamespacePool.withReadDbs()` | `tests/multi-namespace-pool.test.js`, registered runtime fixture uses one `AGENT_ID` |
| Containment, canonical collision, late symlink/root/agent substitution | `lib/directory-capability.js`, `lib/multi-namespace-pool.js`, `resolveInside()` | `tests/multi-namespace-pool.test.js`, `tests/memory-db-readonly.test.js`, `tests/security-safety.test.js` |
| Legacy tables never created, migrated, or mutated | `MemoryDB({readOnly:true})`, legacy pool role | schema/row and mutation-entrypoint assertions in `tests/memory-db-readonly.test.js` and `tests/multi-namespace-recall-runtime.test.js` |
| Missing legacy skipped; all other init/query failures, including temporal anchor reads, reject without partial output | tool/hook initialization loops, strict child reads, and `Promise.allSettled` | `tests/runtime-config-contract.test.js`, deferred sibling and temporal-anchor tests in `tests/multi-namespace-recall-runtime.test.js`, `tests/temporal-filter.test.js` |
| Leases cover every child until real callback settlement | `AgentDbPool.withDb()`, `MultiNamespacePool.withReadDbs()` | `tests/agent-db-pool-lease.test.js`, `tests/multi-namespace-pool.test.js` |
| Stable global score order, higher duplicate-ID score, configured-order ties | `mergeNamespaceRecallResults()` | `tests/namespace-recall-merge.test.js` |
| Jaccard dedup uses exactly `(memories, memorySlots, threshold)` only when enabled | `mergeNamespaceRecallResults()` | enabled and disabled cases in `tests/namespace-recall-merge.test.js` |
| Canonical heading+text normalized and global; canonical plus memories never exceed `maxOut` | canonical merge and slot calculation | pure merge and registered global-limit assertions |
| Results cloned without dropping ownership | wrapper/entry clone in merge | input immutability, reference inequality, and ownership assertions |
| Every child trace replayed through capped helpers with sanitized namespace; global drops traced | trace replay and namespace sanitizer | `tests/namespace-recall-merge.test.js`, `tests/recall-decision-trace.test.js` |
| Canonical pipeline once, child ledgers suppressed, final ledger once | shared tool/hook orchestrator in `index.js` | four exact ledger-count assertions across recall/search/hook |
| Tool, search alias, and prompt hook share identical orchestration; single namespace remains direct | `runMergedNamespaceRecall()` | registered runtime test plus existing single-namespace recall suites |
| Init timeouts retain raw operations and every acquired handle through cleanup; retry/shutdown/capability release cannot overtake them | `MemoryDB._deferTimedOutInitCleanup()`, pending-init drain, shutdown barrier | connect/tableNames/openTable/schema/addColumns/create/delete/final-refresh and throwing-logger cases in `tests/memory-db-lifecycle-atomic.test.js` |
| Writable init repairs a bootstrap sentinel after interrupted table creation | central idempotent `deleteSchemaRow` after open/create | late-create fulfillment/rejection and pre-existing-sentinel regressions |
| Throwing, promise-rejecting, hostile-value, or non-settling warning loggers cannot stop AgentDbPool/MultiNamespacePool cleanup, replace the primary DB error, or produce an unhandled late-settlement rejection | immediate non-rejecting thenable capture, bounded warning settlement, hostile-value-safe contextualization, bounded background lifecycle errors, aggregate-preserving pool shutdown/clear/eviction | `tests/agent-db-pool-lease.test.js`, `tests/multi-namespace-pool.test.js`, `tests/p1-robustness.test.js` |
| Phase-timer and retrieval-ledger diagnostics cannot replace a namespace timeout, detach its raw settlement, turn a successful recall into failure, or retain query/memory/credential text | `trySafeWarn()`, payload-free `createRecallPhaseTimer().fail()`, asynchronously observed `emitRetrievalLedger()` | `tests/multi-namespace-recall-runtime.test.js`, `tests/recall-phase-timer.test.js`, `tests/namespace-recall-merge.test.js`, `tests/recall-pipeline-decision-trace.test.js`, `tests/p1-robustness.test.js` |

## TDD evidence

The following RED runs were reproduced on isolated commit archives in `/tmp`.
Only the test files were overlaid from the corresponding GREEN commit; the
feature worktree and Git refs were not changed.

### Task 1: schema and immutable layout

Parent snapshot `22ee72e` with the `6d5eb68` Task-1 tests:

```text
tests 17; pass 14; fail 3; skipped 0; exit 1
```

The causal failures were the public schema rejecting `namespaces` as an unknown
property, the error path stopping at the object instead of the invalid leaf,
and the missing `resolveNamespaceLayout` export. The current focused gate makes
the same tests GREEN.

### Task 2: safe routing and read-only legacy storage

Parent snapshot `e512219` with the initial `a6066cf` Task-2 tests:

```text
tests 53; pass 26; fail 27; skipped 0; exit 1
```

Failures were causal: no read-only `MemoryDB` contract, wrong named-root route,
missing containment/collision rejection, missing pool lease APIs, and public
recall that did not implement the required absent/error behavior. Review-driven
RED/GREEN additions in `cd4b506..390feb2` then covered late cached-route swaps,
root/agent pinning, descriptor-bound opens, discovery retry, legacy aliases,
clear/shutdown races, cleanup propagation, terminal shutdown, and platform-safe
lexical containment.

Task-2 final specification review at `390feb2`: **PASS**, 146/146 focused
tests, no Critical/Important/Minor finding. Final quality review: **PASS**,
136/136 focused tests, no Critical/Important finding. One accepted Minor is
recorded under Remaining uncertainty.

### Task 3: global merge and public runtime

Parent snapshot `390feb2` with the `d72e05f` Task-3 tests:

```text
tests 38; pass 31; fail 7; skipped 0; exit 1
```

The pure merge export and namespace trace provenance were absent. Registered
recall returned only the active memory, duplicated canonical output, settled
before a deferred sibling, and did not enforce the global contract.

During the GREEN cycle, a newly added return-contract assertion produced a
second observed RED: merged `queryVector` was `undefined` instead of
`[0.1, 0.2, 0.3]`. `mergeNamespaceRecallResults()` now returns a cloned vector.

Final Task-3 focused gate:

```text
tests 61; suites 21; pass 61; fail 0; skipped 0
duration_ms 12007.346075; exit 0
```

Independent Task-3 specification review at `d72e05f`: **PASS**, no
Critical/Important/Minor finding; the reviewer independently reproduced 61/61.

The following quality/security review then found one **Important** issue: a
primary vector-read `TimeoutError` was converted into an empty fulfilled child
while its attached raw settlement was still pending. That allowed another
namespace's result and ledger record to escape and could release DB leases too
early. The new registered regression reproduced the active partial result:

```text
tests 1; pass 0; fail 1; skipped 0; duration_ms 640.642051; exit 1
```

Commit `cbbee2f` enables strict read-error propagation only for coordinated
multi-namespace children. The default single-table pipeline retains its
existing fail-soft timeout behavior. The GREEN regression proves no partial
result or ledger and blocks shutdown until `TimeoutError.settlement` resolves:

```text
tests 1; pass 1; fail 0; skipped 0; duration_ms 468.122312; exit 0
```

The self-review then generalized the settlement invariant before re-review:
`e111ac6` combines every unique attached timeout settlement across simultaneous
namespace failures and across strict graph-hydration batch failures. Strict
hydration also waits for every parallel lookup before propagating the first
failure. Its causal test and the three registered runtime tests pass 11/11
together.

Final Task-3 specification re-review at `e111ac6`: **PASS**, no
Critical/Important/Minor finding. The reviewer independently reproduced the
62/62 Task-3 gate and the 16/16 timeout/hydration/lease suite. Final Task-3
quality/security re-review: **PASS**, no Critical/Important/Minor finding; its
expanded Task-3/hydration gate passed 70/70.

The first full B12-Core specification review then found one **Important**
extension of the same all-or-nothing invariant. A child could finish its
primary vector read and later time out in the temporal-anchor lookup, but
`temporalRangeFromAnchor()` and the outer temporal catch converted that error
to a fail-soft `null`. The coordinated recall could consequently return and
log active or legacy partial results. The review also found one documentation
Minor: this receipt still contained a stale "review in progress" sentence;
that sentence was removed.

The temporal helper and registered runtime regression were first run against
the unfixed implementation:

```text
tests 2; pass 0; fail 2; skipped 0
duration_ms 796.251609; exit 1
```

Commit `8a379bc` threads `strictReadErrors` through the temporal-anchor helper
only for coordinated multi-namespace children and propagates the exact error,
including its attached raw settlement. The existing single-table fail-soft
default remains unchanged. The same two tests then passed, proving no partial
output, no ledger record, and lease retention until raw settlement:

```text
tests 2; pass 2; fail 0; skipped 0
duration_ms 670.797649; exit 0
```

The complete temporal-filter suite also passed 6/6, including its existing
fail-soft hanging-read compatibility case.

The same full specification review found a second **Important** closure gap:
the repaired `lib/recall-pipeline.js` was deploy-verified, but its now
security-critical transitive `lib/temporal-filter.js` dependency was absent
from `DEPLOY_FILES`. Verify/repair could therefore leave an installed old
helper that reintroduced the partial-result and lease bug. Adding the helper
to the existing critical-runtime coverage produced the causal RED:

```text
tests 1; pass 0; fail 1; skipped 0
duration_ms 780.929273; exit 1
missing: lib/temporal-filter.js
```

Commit `95551d5` adds that exact helper to the shared verify/repair catalog.
The regression then passed 1/1, and the complete deploy-integrity suite passed
21/21 with no skip. Lint and diff-check also passed.

The next full specification re-review found one further **Important**
all-or-nothing edge. When an opted-in legacy table was genuinely absent, the
initialization loop correctly skipped it; however, the surviving active table
then entered the direct one-reader compatibility branch. Its active query
timeout was consequently converted to an empty successful result even though
the immutable layout had originally requested multiple readers. The public
reproduction returned `No relevant memories found.`:

```text
tests 1; pass 0; fail 1; skipped 0
duration_ms 659.736008; exit 1
```

Commit `7b8e855` derives strict read semantics from the original immutable
`recallReadNamespaces` layout rather than the post-initialization reader
count. Thus an absent legacy table remains an allowed skip, while a later
active query error still rejects and retains the lease through its raw
settlement. The exact regression passed 1/1; the paired preservation test
also proves that a genuinely single configured namespace remains fail-soft.
Both cases passed 2/2, and the complete registered namespace runtime passed
6/6.

The subsequent full quality/security review found one **Important** database
lifecycle gap. `MemoryDB.init()` assigned connection/table handles only after
the timeout-wrapped await. A timed-out connect or open could therefore deliver
an untracked late handle; reads and table creation could have their connection
closed before raw settlement; and the writable schema/add-column catches
converted timeouts into continued initialization. The initial causal suite was
run before the fix:

```text
tests 14; suites 1; pass 8; fail 6; skipped 0
duration_ms 2601.313773; exit 1
```

The failures independently covered late connect, tableNames with shutdown and
directory capability, late openTable, swallowed schema/addColumns timeouts,
and late createTable cleanup. Commit `f66563e` gives every init timeout one
attached lifecycle barrier: raw operation settlement first, then an optional
late handle, the known table, and the connection. Retry and shutdown drain the
same barrier before any new connection or capability release. Schema and
add-column timeouts are rethrown; writable initialization removes the reserved
bootstrap row idempotently after both open and create. The expanded GREEN suite
also covers post-mutation create rejection, delete/final-refresh timeouts,
late-close errors with agent context, a throwing debug logger, and a direct
`init()` attempt during shutdown:

```text
tests 20; suites 1; pass 20; fail 0; skipped 0
duration_ms 3661.245908; exit 0
```

The fix-only specification review passed with no Critical/Important/Minor
finding. Its quality/security review passed with no Critical/Important
finding and independently found no unhandled rejection, double close,
retry-poisoning bypass, deadlock, capability-ordering issue, or scope drift.
The only diagnostic wording Minor was changed from "close error" to the
accurate "lifecycle error" before the final gates.

The subsequent fresh full specification re-review at `f66563e` found one
**Important** FE-ADD-05 terminal-cleanup defect: a throwing `logger.warn()` in
`MultiNamespacePool.shutdown()` replaced the child failure and stopped before
child-map clearing and root-capability close. The parallel quality/security
review confirmed the same defect in `AgentDbPool.shutdown()` and `clear()`,
showed loss of the original eviction error, and reproduced an unhandled
rejection after a late raw-operation failure. It then found two related recall
non-interference defects: a throwing phase-timer logger replaced the primary
`TimeoutError` and its attached settlement, and a throwing warning after a
retrieval-ledger callback failure turned a successful merged recall into an
error. Its only separate Minor was an unused `realpathSync` import.

The initial pool regressions were run before the fix:

```text
tests 37; suites 2; pass 32; fail 5; skipped 0
duration_ms 1339.745981; exit 1
```

They independently covered terminal `AgentDbPool.shutdown()`, reusable
`clear()`, async eviction, late-settlement lease tracking, and terminal
`MultiNamespacePool.shutdown()`. The phase-timer/safe-warning/ledger cycle was
also observed RED before its exports and non-throwing behavior existed:

```text
tests 14; suites 2; pass 10; fail 4; skipped 0
duration_ms 4183.493278; exit 1
```

Commit `73897d8` makes warning delivery a captured secondary outcome, retains
both original and logger failures in lifecycle aggregates, bounds deferred
background errors, attempts every DB/child close, drains pending evictions,
clears caches, and closes base capabilities before rejecting. The public
timeout keeps the same attached raw settlement; phase-timer and final-ledger
diagnostics no longer affect recall control flow. The causal GREEN gates were:

```text
pool lifecycle: tests 37; suites 2; pass 37; fail 0; skipped 0
logger/phase/ledger: tests 32; suites 11; pass 32; fail 0; skipped 0
```

An exact always-throw late-settlement probe additionally produced
`unhandled=[]`, `active=0`, an empty cache, a closed/null base capability, and
an aggregate retaining the logger cause.

The independent fix-only specification review at `73897d8` passed with no
finding. Its adversarial quality/security review failed with Critical 0 /
Important 2 / Minor 0. First, promise-rejecting warning loggers and retrieval
callbacks were not observed, hostile logger-thrown values could throw again
while their `message` was contextualized, and both cases could either emit an
unhandled rejection or stop terminal cleanup. Second, the late-settlement
warning interpolated its raw error and phase summaries retained arbitrary
error/query text, exposing credentials and user content.

The `b85f8f7` RED run added eleven causal failures across hostile getters,
rejecting thenables, pool cleanup, ledger/phase non-interference, and secret
retention:

```text
tests 73; suites 12; pass 62; fail 11; skipped 0
duration_ms 990.115741; exit 1
```

The first GREEN of the unchanged causal set was 73/73. Follow-up tests also
prove that a logger which never settles is bounded and cannot retain pool
resources. `captureThenableSettlement()` attaches fulfillment and rejection
handlers before returning and always resolves to an explicit outcome;
`settleSafeWarning()` applies one bounded cleanup deadline. Error
contextualization no longer invokes arbitrary getters/coercion, warning errors
remain nested causes, late-settlement output uses credential redaction, and
phase summaries retain only the fixed `phase failed` classification. A probe
using actual async functions that reject (rather than synthetic thenables)
produced:

```json
{"unhandled":[],"outcomes":[{"ok":false,"hasError":true,"hasLoggingError":false},{"ok":false,"hasError":true,"hasLoggingError":false},{"ok":false,"hasError":true,"hasLoggingError":true}]}
```

The independent fix-only reviews at `b85f8f7` both failed. The specification
review reported Critical 0 / Important 2 / Minor 0: warning-delivery failure
could displace the original late DB error from bounded shutdown evidence, and
credential redaction missed `sk-proj`, `password`, and `secret` forms. The
adversarial quality/security review reported Critical 0 / Important 4 /
Minor 0: a self-resolving thenable could starve native Promise assimilation,
an async `then` or a resolved thenable's rejecting return could become
unhandled, async MemoryDB debug returns remained unobserved, retrieval-ledger
warnings could copy query/memory/credential text, and the late primary error
was lost as above.

The second causal run reproduced all eight gaps before production changes:

```text
tests 63; suites 12; pass 55; fail 8; skipped 0
duration_ms 4768.797247; exit 1
```

Commit `4d93679` replaces generic Promise assimilation with a bounded,
cycle-aware observer for foreign thenables and ignored native/foreign return
settlements. It observes async debug diagnostics through terminal MemoryDB
shutdown, retains both late primary and secondary logger errors, sends a fixed
payload-free retrieval warning while retaining the original internal outcome,
and covers the reviewed credential formats. The unchanged causal set and its
adjacent lifecycle regressions are GREEN. A standalone process probe covering
self-cycle, async `then`, resolve-plus-rejecting-return, async debug, and async
ledger/warning failures produced:

```json
{"pending":5,"settled":5,"failedSettlements":4,"unhandled":[]}
```

The independent fix-only reviews at `4d93679` both found one remaining
**Important**. The late-settlement warning still copied arbitrary query/memory
text and redacted only the `Basic` scheme label rather than its credential;
vendor-prefixed forms such as `GOOGLE_API_KEY` also bypassed the generic
pattern. The quality review additionally recorded one **Minor**: an acyclic
chain exceeding the defensive thenable limit was mislabeled as a cycle. It
also marked the pre-existing direct-`safeWarn()` async rejection behavior for
the later full review.

The payload/Auth regressions first produced 34/36, and the depth/direct-warning
regressions independently produced 23/25. Commit `643ad39` logs only the fixed
`late database operation failed` classification at that untrusted boundary,
while the raw primary DB error and any secondary logger error remain in bounded
shutdown evidence. Generic redaction now covers Authorization schemes and
vendor-prefixed credential keys. Direct `safeWarn()` observes async returns
without changing their return value; `trySafeWarn()` uses the single-delivery
internal path so it does not invoke a foreign thenable twice. Cycle and depth
failures now have separate diagnostics. The current standalone process probe
produced:

```json
{"pending":5,"settled":5,"failedSettlements":4,"authRedacted":true,"directWarnObserved":true,"unhandled":[]}
```

The independent specification review at `643ad39` passed with no finding and
independently reproduced 115/115 relevant tests. The adversarial review found
one remaining **Important** in the generic redactor: multi-part Digest, AWS4,
or Negotiate Authorization values could retain fields after the first space or
comma. The causal multi-scheme regression was RED at 25/26. Commit `606c604`
redacts the complete untrusted Authorization value to its line boundary;
vendor-prefixed key coverage is exercised before that header so over-redaction
cannot mask it. The same causal file is now 26/26.

The independent specification review at `606c604` passed with no finding and
116/116 relevant tests. Its adversarial quality review found one final
**Important** CRLF boundary: newline-capable separator whitespace could consume
a normal following line, while an indented folded Authorization continuation
remained visible. The causal CRLF/folding regression was RED at 26/27. Commit
`6669a8a` permits only SP/HTAB around the field separator and explicitly
redacts only SP/HTAB-indented continuation lines. Normal CRLF/LF follow-up
headers, text, and blank lines remain unchanged; the causal file is 27/27.

## B12-Core gates

Historical plan-defined focused command at implementation head `73897d8`:

```text
tests 326; suites 48; pass 326; fail 0; skipped 0
duration_ms 10483.266912; exit 0
npm run lint: exit 0
git diff --check: exit 0
```

Expanded lifecycle/security/timeout gate at the same implementation head:

```text
tests 219; suites 39; pass 219; fail 0; skipped 0
duration_ms 15661.566356; exit 0
```

Current plan-focus gate at `6669a8a`, including namespace contracts, public
runtime, lifecycle, deployment, security, phase, and ledger regressions:

```text
tests 390; suites 59; pass 390; fail 0; skipped 0
duration_ms 11233.155978; exit 0
```

Current expanded lifecycle/security/timeout gate at `6669a8a`, including the
hostile-thenable, async-debug, late-primary, redaction, phase, and ledger
regressions:

```text
tests 210; suites 34; pass 210; fail 0; skipped 0
duration_ms 25213.37252; exit 0
npm run lint: exit 0
git diff --check: exit 0
```

Pre-lifecycle full B12-Core specification re-review at `7b8e855`: **PASS**, no
Critical/Important/Minor finding. The reviewer independently reproduced the
319/319 plan-focus gate and a 70/70 temporal/hydration/MemoryDB-lifecycle/
security/timeout suite; lint and both commit-range/worktree diff checks passed.

Fresh full B12-Core specification re-review at `f66563e`: **FAIL**,
Critical 0 / Important 1 / Minor 0. The Important logger/terminal-cleanup
finding is fixed in `73897d8`.

Independent fix-only specification and quality/security reviews at `73897d8`:
specification **PASS** (Critical 0 / Important 0 / Minor 0); quality/security
**FAIL** (Critical 0 / Important 2 / Minor 0). Both Important clusters are
fixed in `b85f8f7`.

Independent fix-only reviews at `b85f8f7`: specification **FAIL** (Critical 0 /
Important 2 / Minor 0); quality/security **FAIL** (Critical 0 / Important 4 /
Minor 0). All six reported Important clusters are addressed in `4d93679`.

Independent fix-only reviews at `4d93679`: specification **FAIL** (Critical 0 /
Important 1 / Minor 0); quality/security **FAIL** (Critical 0 / Important 1 /
Minor 1). The shared Important and the Minor are fixed in `643ad39`; the direct
warning observation noted for the full review is fixed there as well.

Independent fix-only reviews at `643ad39`: specification **PASS** (Critical 0 /
Important 0 / Minor 0); quality/security **FAIL** (Critical 0 / Important 1 /
Minor 0). The multi-part Authorization finding is fixed in `606c604`.

Independent fix-only reviews at `606c604`: specification **PASS** (Critical 0 /
Important 0 / Minor 0); quality/security **FAIL** (Critical 0 / Important 1 /
Minor 0). The CRLF/folded-header finding is fixed in `6669a8a`.

Independent fix-only specification and quality/security reviews at `6669a8a`:
both **PASS** (Critical 0 / Important 0 / Minor 0), each with 117/117 relevant
tests.

The first full post-documentation specification review at `3470fcd` passed
with Critical 0 / Important 0 / Minor 0. Its independent adversarial quality
review failed with Critical 0 / Important 3 / Minor 0: a rejected native
Promise with a hostile own `then` getter remained unobserved; shutdown omitted
the primary active-init error when debug logging also failed; and saturated
trace caps retained only the last namespace. Commit `e8a1f12` closes all three
with causal RED/GREEN tests. Commits `d7acf12` and `85dfedd` isolate nested
installer probes and replace synchronous stdin pipes with bounded argv/file
inputs; the original two-file hang reproducer then passes.

The next full reviews at `85dfedd` found the final two Important edge cases.
Later global merge decisions could displace the fair child-decision replay,
and a Promise subclass with a throwing `Symbol.species` could fail before the
intrinsic rejection handler was installed. Commit `5cf2f30` buffers decisions
by `(phase, namespace)` and selects a deterministic newest fair suffix; the
causal test retains `ns-a/ns-b × child/global`, other trace categories, exact
summary counts, and immutable inputs. Native Promise observation now uses a
brand-safe check plus synchronously restored constructor/species overrides,
covering hostile own `then`, local and cross-realm subclasses, frozen
instances, and pre-existing descriptors without an unhandled rejection.

Final full B12-Core reviews over `a53e244d..5cf2f305`:

- specification: product **PASS**, Critical 0 / Important 0; its only Minor was
  this then-pending closure-evidence update. Reviewer gate: 404/404 tests;
- quality/security: **PASS**, Critical 0 / Important 0 / Minor 0. Reviewer
  gates: 413/413 plus 56/56 tests.

Final focused owner gate at `5cf2f30`: 319/319 tests, 58 suites, no failures or
skips, using normal process isolation outside the sandbox's known nested-spawn
`EPERM` artifact. `npm run lint` and `git diff --check` pass.

Authoritative exact serial command:

```text
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2970; suites 532; pass 2969; fail 0; skipped 1
duration_ms 335439.875688; exit 0
```

The single skip is the repository's existing environment-dependent case; no
B12 test was skipped.

## Bypass and scope review

- Every public pool alias validates `agentId` before child lookup. Namespace
  layout accessors are cloned and frozen without invoking forged getters.
- Lexical containment is followed by canonical/descriptive checks. Existing
  and initially absent targets are pinned, and routes are revalidated before
  both creation and cached reuse. The database opens through the held directory
  capability, preventing a final path swap between check and open.
- Only an actually absent legacy table is a skip. Cleanup errors and every
  other initialization/query failure remain observable and reject the recall.
- Child pipeline ledgers are disabled. A failed merge writes no final ledger.
- `Promise.allSettled`, outer pool callbacks, and DB leases keep all sibling
  work alive until raw settlement; the caller cannot expose partial success.
- `git diff -G` and independent Task-3 review found no FA-07 option wiring or
  B13 ACL/share implementation. Per-agent OpenClaw model/auth routing was not
  changed.

## Remaining uncertainty

- Explicit named routing relies on Linux directory capabilities (`O_DIRECTORY`,
  `O_NOFOLLOW`, and a verified descriptor alias). It deliberately rejects an
  unsupported platform instead of weakening the guarantee. Current end-to-end
  path evidence is Linux-based; lexical containment has a separate Win32 test.
- Every namespace table must use the configured embedding dimensions. Mixed
  per-namespace dimensions or provider migrations are not implemented.
- Read-only is enforced by the plugin's `MemoryDB` API and its production pool
  route; LanceDB does not provide a separate native read-only connection here.
- JavaScript exposes no standard-compliant way to observe the hidden target of
  a Promise proxy, or to bypass a fully frozen, non-configurable hostile
  constructor/species path. The implementation closes every mutable native,
  cross-realm, subclass, and frozen-instance path exercised by the independent
  adversarial review; these non-observable objects remain an explicit runtime
  boundary rather than a silent fallback claim.

## Boundary proof

Before this documentation closure, the feature worktree was clean at
`5cf2f305e362d4cdb3926889ab0caf87f0ce224c`. The separate checkout at
`/root/openclaw-plur1bus-memory` remained clean on `main...origin/main` at
`6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`. No push, merge, tag, release,
remote update, data migration, or destructive operation was performed.
