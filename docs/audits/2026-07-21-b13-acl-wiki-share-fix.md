# B13 ACL, Wiki, and shared-memory remediation receipt

Date: 2026-07-23  
Base: `216472a` (Task 11 documentation start)  
Scope: SEC-01/02/03/04/05/08/12/16, FA-04, FE-ADD-04

## Contract and unchanged boundaries

All access decisions use the request-bound canonical principal before graph,
reranker, provider, Wiki selection/display/mutation, or shared-pool work.
Workspace canonicalization rejects conflicts rather than choosing hidden alias
precedence. Shared cards are copied, never moved, from a visible private source
and retain canonical origin for additive recall deduplication. Workspace and
user pools have opaque, <=64-character physical routes and strict workspace or
channel+account+user bindings.

`/plur1bus migrate-legacy-shared` is an initialized-runtime, destructively
authorized dry-run first workflow. It has an opaque continuation cursor,
250-row/4-MiB/100-provider/60-second per-run limits, pinned source-version
continuation, and abort/restart behavior for unavailable versions, mismatches,
timeouts, and uncertain commits. Legacy `workspace_shared` rows are never
reinterpreted or re-scoped. There is no standalone DB/config/credential
bootstrap. Multi-Namespace, Neo/Obsidian aliases, Semantic Lens, CRR, default
OpenClaw LLM selection, and per-agent credentials are unchanged.

The auto-recall hook adds the optional user-shared source only with `autoRecall`
and an account-bearing session key, exact host-run ticket, or conservative
default-only topology. Handled native/slash commands do not reach that hook and
therefore do not mint a ticket. Ambiguous named/multi-account main/group/channel
turns omit only the optional source; host-supplied account paths (`/memory`,
`/share --user`, tools) stay available. Session-last-route state is not used as
a turn-bound proof.

## TDD and verification commands

- Doc RED: `node --test --test-concurrency=1 tests/config-docs-contract.test.js`
  failed as intended: the new B13 contract test could not find `/share <id>
  --user` before this documentation was added.
- Doc GREEN: same command, recorded after the documentation edit below.
- Original executable proofs, exact Wiki rubrics, named Wiki regression, the
  focused/adjacent B13 serial command, lint, manifest parse, and change-aware
  `rg` reviews are recorded in the final verification section.

## Finding receipts

All rows use the following evidence shorthand: RED is the causal pre-fix test
named in the changed test file(s); GREEN is that named regression after its
minimal fix; original proof is the historical executable proof or named Wiki
rubric/regression; positive path is an authorized same-owner/same-principal
control; bypass review is the call-site and sensitive-field search recorded
below. No source text is included in this receipt.

| Finding | Changed files / commits | RED → GREEN | Original proof and positive path | Bypass review / remaining uncertainty |
|---|---|---|---|---|
| SEC-01 strict bindings + ownership-preserving graph projection/hydration | `lib/recall-pipeline.js`, `lib/memory-request-context.js`, `tests/user-scope-acl.test.js`, `tests/recall-pipeline-hydration.test.js`; `6d2a33e` | pre-ACL foreign graph/hydration regressions → focused gate | `cand-acl-missing-ownership-fail-open/proof.mjs`; same-owner graph hydration remains available | all `runRecallPipeline(` callers inspected; historical proof has obsolete assumptions but confirms no disclosure; uncertainty: host adapter variants remain bounded by conservative context resolution |
| SEC-02 initial/refined/graph ACL before reranker/provider | `lib/recall-pipeline.js`, `lib/memory-request-context.js`, `tests/b13-recall-provider-acl.test.js`; `6d2a33e` | foreign candidate reaching reranker/provider → denied before provider | `cand-pattern-pre-acl-cross-scope/proof.mjs`; authorized candidate reaches configured reranker | provider/key call sites searched; no new model/key/endpoint/header branch; uncertainty: optional provider failures retain their existing fallback policy |
| SEC-03 Wiki duplicate preview after active Wiki ACL | `index.js`, `lib/wiki-command.js`, `tests/smoke-wiki-command.test.js`; `e238596`, `ca8fbc2` | foreign duplicate preview → active-scope-only preview | duplicate rubric + named smoke regression; same-scope duplicate preview remains | all `runWikiCommand(` paths inspected; denied text is absent; uncertainty: Obsidian remains B14 boundary |
| SEC-04 Wiki UUID delete after active Wiki ACL, denied == missing | `index.js`, `lib/wiki-command.js`, `tests/smoke-wiki-command.test.js`; `e238596`, `ca8fbc2` | foreign UUID delete → missing-style denial/no mutation | UUID-delete rubric + named smoke regression; owned UUID archive-first delete remains | Wiki handlers inspected; response/mutation uses post-ACL record only; uncertainty: filesystem audit path validation is separately covered by Task 3 fixes |
| SEC-05 Wiki query selection/display/mutation after active Wiki ACL | `index.js`, `lib/wiki-command.js`, `tests/smoke-wiki-command.test.js`; `e238596`, `ca8fbc2` | foreign query selection/display/mutation → no selection/no mutation | query-delete rubric + named smoke regression; owned query remains actionable | `registerCommand(` data handlers inspected; no foreign response text reaches output; uncertainty: bounded selection caps intentionally limit large result sets |
| SEC-08 same fallback-search lifecycle predicate and logged catch | `lib/wiki-command.js`, `tests/smoke-wiki-command.test.js`; `ca8fbc2` | inactive fallback disclosure → same active predicate/logged catch | inactive-fallback rubric + named smoke regression; active fallback remains available | Wiki lifecycle branches reviewed; catch is logged; uncertainty: provider/runtime error message content remains intentionally generic |
| SEC-12 all named sensitive chat reads gated before work | `index.js`, `tests/b13-sensitive-read-auth.test.js`, `tests/plur1bus-internal-auth.test.js`; `2d14f60`, `9818ca2`, `ea128f5`, `569bca8`, `ca7ed52`, `9d45fba` | denied branches initialized DB/LLM/locale → zero-work denial | Task 5 named dispatch regressions; authorized internal exact runtime route remains | every data-bearing `registerCommand` handler reviewed; uncertainty: public help intentionally remains data-free |
| SEC-16 safeUpdate exact ownership tuple preservation | `lib/memory-store.js`, `tests/safe-update-dataloss.test.js`; `3053573` | ownership alias loss on update → aliases preserved verbatim | focused safe-update regression; exact-owner correction remains durable | ownership write/update calls reviewed; uncertainty: legacy rows retain original aliases by design |
| FA-04 dedicated pools, share commands, confirmation, shared recall, migration | `lib/shared-memory*.js`, `lib/memory-request-context.js`, `index.js`, `tests/b13-shared-memory-pool.test.js`, `tests/b13-share-store.test.js`, `tests/b13-share-runtime.test.js`, `tests/b13-shared-recall.test.js`, `tests/b13-legacy-share-migration.test.js`; `f86dc06..216472a` | route/auth/store/migration causal suites → focused B13 gate | authorized workspace/user copy and additive recall controls; migration dry-run/apply controls | shared scope and route searches reviewed; no legacy reinterpretation or credential bootstrap; uncertainty: account proof is deliberately conservative in ambiguous hook turns |
| FE-ADD-04 common Wiki ACL/lifecycle plus destructive audit | `index.js`, `lib/wiki-command.js`, `lib/directory-capability.js`, `tests/smoke-wiki-command.test.js`; `e238596..12df055` | pre-ACL Wiki lifecycle/audit path cases → post-ACL and fail-closed audit paths | four Wiki rubrics + named smoke regression; owned mutation creates one audit record | all Wiki callers reviewed; uncertainty: audit destination permissions are environment-dependent and safely reject unusable paths |

## Known implementation reviews and commits

Tasks 1–2: independent specification reviewer **PASS** and independent
quality/security reviewer **PASS**, Critical 0 / Important 0 / Minor 0, for
the recall/provider ACL commit `6d2a33e`. Task 3: independent specification and
quality re-reviews **PASS**, Critical 0 / Important 0, across `e238596`,
`ca8fbc2`, `b74782f`, `2a34054`, and `12df055`. Task 4: independent
specification and quality re-reviews **PASS**, Critical 0 / Important 0, for
`3053573` and `72c374c` (known Minor: duplicate nonce/target registration at
capacity may evict the oldest unrelated pending entry; production uses fresh
UUIDs). Task 5: all known Critical/Important findings closed; the documented
Task 5 three-file gate passed 70 tests.

Tasks 6–10 commits are `f86dc06`, `ca00b10`, `afc921a`, `f84246f`, `1f089f3`,
`55370e5`, `f84451a`, `82449e4`, `b10f1b9`, and `216472a`. No independent
Task 6–10 reviewer identity/outcome was available in the local receipt at Task
11 start; this receipt does not invent one. The final owner audit remains the
authority for that outstanding review evidence.

## Final Task 11 verification

- Doc RED was observed before the edit: 3/4 passed and the B13 phrase contract
  failed on missing `/share <id> --user`. Doc GREEN is 4/4 passed.
- The exact Step 4 serial command initially exposed two direct B13 stale test
  contracts: `migrate-legacy-shared` was absent from the sensitive dispatcher
  class matrix, and the shutdown-source assertion still required bare `pool`
  after B13 wrapped it to abort an active migration. Causal test-only commits
  `9519eb7` and `b9cad92` close those mismatches; each focused test is green
  (11/11 and 3/3 respectively).
- A subsequent exact serial invocation passed all B13-specific suites shown in
  the TAP output, including migration (17 cases), request context (44), provider
  ACL (5), sensitive reads (11), share runtime/store/pool/recall, and docs.
  It still reports `tests/command-reachability.test.js` and
  `tests/llm-result-cache-lifecycle.test.js` as failed child files. The latter
  is green alone after `b9cad92`; `command-reachability` is an environment
  issue outside the Task 11 docs scope: the supported Node 20.9 reproduction
  reports that optional `@huggingface/transformers` cannot parse `with` import
  attributes, so its local-transformers query path returns the dependency error
  instead of its reachability assertions. Node 24 runs the first recall but
  does not surface child assertion detail in this runner. No product change was
  made for that non-B13 dependency/runtime mismatch.
- `npm run lint` exited 0, `git diff --check` was empty, and manifest parsing
  printed `manifest-json-ok`.
- SEC-01 original proof exited nonzero at assertion `0 !== 1`; SEC-02 original
  proof exited nonzero because its expected pre-ACL reranker disclosure no
  longer occurs. These are expected historical-proof outcomes after the ACL
  fixes, not a reintroduced disclosure. All four Wiki rubrics were inspected;
  their unchecked items describe the pre-fix behavior, and
  `tests/smoke-wiki-command.test.js` passed (1/1).
- Change-aware `rg` review found every current `checkAccess`, recall, Wiki, and
  registered-command call site in the listed ACL adapters/handlers and tests;
  `workspace_shared` appears only in the legacy migration/shared adapters and
  existing Neo/Obsidian adapters; model/key/endpoint/header matches are
  existing index-level provider configuration and `withLlmCallContext` routes,
  with no B13-added branch. Remaining uncertainty is the separate
  local-transformers import-attribute compatibility issue noted above.

Repository-wide tests are intentionally excluded from this task; the owner
performs that later final audit.
