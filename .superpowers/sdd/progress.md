# High/Mid Remediation — SDD Progress

Date: 2026-07-20
Branch: `fix/high-mid-audit-findings`
B11 implementation base: `33bb9c4`
B11 reviewed head: `94a7376dd8e4689ff2a9541f76fdb2242b118496`

## B11 OpenClaw-default LLM series

```text
3532a76 feat: add OpenClaw LLM router
f0818ad docs: document LLM route kinds
b7ffa0d feat: use OpenClaw default for core LLM routes
03c4a62 fix: preserve LLM command context and critical no-op
10afa93 fix: warn when critical LLM runtime is unavailable
267fb71 feat: add LLM call context helper
211b18d fix: preserve existing LLM call context
5c8492b refactor: isolate feature LLM routes
3be8e18 fix: bound semantic input fallback
e8dfb26 fix: remove hard-coded chat model defaults
743ede9 fix: sanitize LLM failures and cancel timeouts
1ea8072 fix: propagate LLM cancellation before dispatch
a3547cf fix: block writes after LLM abort
60b0786 docs: align config with OpenClaw LLM defaults
07f56a7 fix: deploy LLM failure helper
90d7dd6 fix: sanitize remaining LLM failure logs
e9fedab fix: make LLM cancellation authoritative
94a7376 fix: clear Emotion Tier 3 timeout
```

## B11 final evidence

- Final focused B11/default-LLM gate: 391/391 pass, 0 skipped.
- Independent specification review: PASS, 0 Critical, 0 Important, 0 Minor.
- Independent route/spec verification: 334/334 pass, 0 skipped.
- Independent cancellation/error-hygiene verification: 72/72 pass.
- Authoritative serial suite at `94a7376`: 2,855 tests, 2,854 pass,
  0 fail, 1 unchanged root-only permission skip, 524 suites,
  411318.698593 ms, exit 0.
- `npm run lint` and `git diff --check 33bb9c4..94a7376`: exit 0.
- Evidence: `/tmp/plur1bus-sdd/openclaw-default-llm-review.md` and
  `/tmp/plur1bus-sdd/openclaw-default-llm-serial.md`.

**B11 final review complete.** Main, Remote, and the primary checkout remain
untouched.

## B12 handoff

B12-Core now owns namespace schema, identifier/path containment, role
disjointness, multi-namespace result/canonical/trace merging, and real public
runtime coverage. B12-P later owns query refinement, adaptive budgeting,
semantic compression, candidate limits, and graph-index behavior. Every B12-P
chat-LLM path must consume `lib/llm-router.js`, pass the current target
`agentId`, preserve the base-recall fallback and timeout contracts, and add no
PLUR1BUS model default or cross-feature inheritance.

## B12-Core recall and namespaces

Base: `a53e244d1d73e9e19681c17da4740a18d4401b5e`

Implementation head: `5cf2f305e362d4cdb3926889ab0caf87f0ce224c`

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

Current evidence:

- Reconstructed Task-1 RED: 14/17 pass, 3 fail on `22ee72e`; missing public
  schema/layout contract. Current tests GREEN.
- Reconstructed initial Task-2 RED: 26/53 pass, 27 fail on `e512219`; missing
  safe named routing/read-only behavior. Final Task-2 spec review PASS 146/146;
  quality review PASS 136/136 with no Critical/Important finding.
- Reconstructed Task-3 RED: 31/38 pass, 7 fail on `390feb2`; broken global
  merge, duplicate canonical, first-trace-only and early sibling settlement.
- Task-3 initial spec review PASS 61/61. Its quality review found one Important
  timeout-settlement gap. RED 0/1 and GREEN 1/1 prove the fix; self-review then
  retained every simultaneous namespace/hydration timeout settlement.
- The first full B12 spec review found one Important temporal-anchor read gap
  and one stale-receipt Minor. Reproduced RED 0/2, then GREEN 2/2 at `8a379bc`;
  coordinated namespace recall now fails closed without a partial ledger while
  the single-table temporal fallback remains compatible.
- The repeat full review found one further Important deploy-closure gap: the
  fixed temporal helper was not in `DEPLOY_FILES`. Reproduced RED 0/1, then
  GREEN 1/1 at `95551d5`; the full deploy-integrity suite passes 21/21.
- The next full re-review found one Important post-skip fallback: an absent
  configured legacy table reduced the live reader list to one and disabled
  strict reads. Reproduced RED 0/1, then GREEN 1/1 at `7b8e855`; a paired
  preservation case confirms genuine single-namespace fail-soft behavior.
- The first full quality/security review found one Important lifecycle gap:
  every timed-out `MemoryDB.init()` operation could close known handles before
  raw settlement, leak a late connection/table handle, or let writable schema
  timeouts be swallowed. The initial six causal regressions produced 8/14 pass
  and 6 fail. Commit `f66563e` adds one settlement barrier for every init
  operation, exact-once late-handle cleanup, retry/shutdown/capability ordering,
  bootstrap-sentinel recovery, observable cleanup/logger failures, and rejects
  direct work while shutdown is in progress. The final lifecycle suite passes
  20/20; independent fix spec review passes with no C/I/M and independent fix
  quality review passes with no C/I finding.
- The fresh full specification review at `f66563e` failed with one Important:
  a throwing namespace-pool warning stopped terminal cleanup before child-map
  clearing and root-capability close. The quality/security review confirmed the
  same pattern in AgentDbPool shutdown/clear, eviction, and late-settlement
  tracking, then found the related phase-timer and retrieval-ledger logging
  paths could replace a primary timeout or a successful recall. The pool RED
  was 32/37 with five causal failures; the phase/ledger RED was 10/14 with four
  failures. Commit `73897d8` captures logger failures as secondary evidence,
  preserves every primary error and attached raw settlement, completes all
  cleanup, bounds deferred lifecycle errors, and makes ledger diagnostics
  non-interfering. Its pool GREEN is 37/37; the logger/phase/ledger GREEN is
  32/32. The unused-import Minor was removed.
- Plan-defined final B12 focus at `73897d8`: 326/326 across 48 suites, no skip.
  Expanded lifecycle/security/timeout gate: 219/219 across 39 suites, no skip.
  `npm run lint` and `git diff --check` pass. Final Task-3
  spec re-review PASS 62/62 plus 16/16 timeout/hydration/lease tests, with no
  finding. Final Task-3 quality re-review also PASS with 70/70 and no finding.
  The pre-lifecycle full B12 specification re-review passed at `7b8e855` with
  no C/I/M finding; its reviewer gates passed 319/319 plus 70/70.
- The fix-only specification review at `73897d8` passed, but its independent
  adversarial quality/security review failed with Critical 0 / Important 2 /
  Minor 0. Promise-rejecting logger/callback returns were unobserved, hostile
  logger errors could still abort terminal cleanup through their `message`
  getter, late-settlement warnings exposed raw credentials, and phase summaries
  retained arbitrary error/query text. The new causal set was RED at 62/73 with
  11 failures. Commit `b85f8f7` adds immediate non-rejecting thenable
  observation, a bounded non-settling-warning deadline, hostile-value-safe
  contextualization, redacted lifecycle warnings, payload-free phase failures,
  and asynchronous ledger settlement. Its first GREEN was 73/73; the current
  expanded lifecycle/security/timeout gate was 200/200 across 32 suites. A real
  `Promise.reject` probe reported `unhandled=[]`; lint and diff checks passed.
- The independent fix-only reviews at `b85f8f7` then both failed. The
  specification review found Critical 0 / Important 2 / Minor 0: a late raw
  DB error disappeared from the shutdown aggregate when warning delivery also
  failed, and credential redaction did not cover `sk-proj`, `password`, or
  `secret` forms. The adversarial quality/security review found Critical 0 /
  Important 4 / Minor 0: native Promise assimilation could be defeated by a
  self-cycle, an async `then`, or a rejecting ignored return; async MemoryDB
  debug logging remained unobserved; retrieval-ledger warnings could copy
  payloads; and the same late primary error was lost.
- The second causal RED set was 55/63 with eight failures. Commit `4d93679`
  replaces generic thenable assimilation with a bounded cycle-aware observer,
  observes ignored native/foreign return settlements, tracks async MemoryDB
  diagnostics through terminal shutdown, retains both late primary and
  secondary logger failures, emits fixed payload-free ledger warnings, and
  broadens credential redaction. The current plan-focus gate is 386/386 across
  58 suites; the expanded lifecycle/security/timeout gate is 206/206 across 33
  suites. A standalone five-path process probe reports
  `{"pending":5,"settled":5,"failedSettlements":4,"unhandled":[]}`. Lint and
  diff checks pass.
- Independent fix-only reviews at `4d93679` both found the same remaining
  Important: the late-settlement lifecycle warning could copy query/memory
  text and left the value of `Authorization: Basic ...` visible; vendor-prefixed
  keys such as `GOOGLE_API_KEY` also bypassed generic redaction. The quality
  review additionally recorded one Minor for describing a depth-limit abort as
  a cycle and noted a pre-existing direct-`safeWarn()` async rejection for the
  later full review.
- Two final causal RED phases were 34/36 for payload/Auth redaction and 23/25
  for depth/direct-warning observation. Commit `643ad39` makes the late warning
  a fixed payload-free classification while retaining the raw primary error in
  bounded shutdown evidence, covers Authorization schemes and vendor-prefixed
  credential keys, distinguishes cycle from depth exhaustion, and observes
  direct async `safeWarn()` returns without changing their return value. The
  current plan-focus gate is 388/388 across 59 suites; the expanded gate is
  208/208 across 34 suites. The process probe reports `authRedacted:true`,
  `directWarnObserved:true`, and `unhandled:[]`; lint and diff checks pass.
- The independent fix-only specification review at `643ad39` passed with no
  finding (115/115). The adversarial review found one remaining Important in
  the generic helper: multi-part Digest, AWS4, or Negotiate Authorization
  values could retain fields after a space or comma. The new causal case was
  RED at 25/26. Commit `606c604` redacts the complete untrusted Authorization
  header value to its line boundary while keeping vendor-key coverage
  independent. The current plan-focus gate is 389/389 across 59 suites; the
  expanded gate is 209/209 across 34 suites. Lint and diff checks pass.
- The independent specification review at `606c604` passed with no finding
  (116/116). Its quality review found one final Important CRLF boundary: `\s*`
  could consume a normal following line while a folded Authorization
  continuation leaked. The causal case was RED at 26/27. Commit `6669a8a`
  restricts separator whitespace to SP/HTAB and explicitly consumes only
  indented continuation lines. The current plan-focus gate is 390/390 across
  59 suites; the expanded gate is 210/210 across 34 suites. The final
  specification and adversarial fix-only reviews both pass 117/117 with
  Critical 0 / Important 0 / Minor 0.
- The first full post-documentation specification review passed, while its
  adversarial quality review found Critical 0 / Important 3 / Minor 0:
  hostile-own-`then` native rejections, lost primary shutdown errors, and
  last-namespace-only saturated traces. Commit `e8a1f12` closes all three.
  `d7acf12` and `85dfedd` remove the nested installer-probe stdin deadlocks;
  the original two-file hang reproducer passes.
- The next full reviews at `85dfedd` found Critical 0 / Important 2 / Minor 0
  across them: post-replay global decisions could destroy namespace fairness,
  and hostile Promise-subclass Species could throw before handler attachment.
  Commit `5cf2f30` closes both with deterministic `(phase, namespace)` trace
  buckets and brand-safe, reversibly neutralized native Promise observation.
  Causal coverage includes local/cross-realm subclasses, frozen instances,
  pre-existing descriptors, `unhandled=[]`, all four decision buckets, exact
  summaries, and immutable inputs.
- Final independent specification review over `a53e244d..5cf2f305`: product
  Critical 0 / Important 0; its only Minor was the then-pending receipt/progress
  update recorded here. Reviewer gate 404/404. Final quality/security review:
  **PASS**, Critical 0 / Important 0 / Minor 0; gates 413/413 plus 56/56.
- Final focused owner gate: 319/319 tests across 58 suites, no failures/skips;
  lint and diff checks pass. Exact authoritative serial suite:
  `node --test --test-concurrency=1 tests/*.test.js test/*.test.js` — 2970
  tests, 2969 pass, 0 fail, 1 existing environment-dependent skip, exit 0,
  335439.875688 ms.
- Receipt: `docs/audits/2026-07-20-b12-core-recall-namespaces-fix.md`.

FA-03 and FE-ADD-05 are CLOSED for B12-Core. FA-07 remains B12-P. Sharing and
cross-principal ACL behavior remain B13. Main and Remote remain untouched.

## 2026-07-21 — B5 cron/delivery provisioning remediation

- Closed BUG-04, BUG-05, and the cron-provisioning portion of FA-08.
- `setup-feature-crons.mjs` now consumes exactly one valid `config.get`
  snapshot. `sourceConfig` owns only explicit feature gates/raw skill-miner
  schedule; `runtimeConfig` owns only effective agents/accounts/delivery.
- Exactly seven explicitly gated jobs are supported. Every job keeps the
  OpenClaw default model and per-agent credentials and runs in an isolated
  exact-agent session.
- Delivery never uses `allowFrom`; peer/defaultTo routes, accounts, existing
  deliveries, ownership, placeholders, redaction markers, and Telegram ids are
  validated fail-closed. Conflicts disable delivery instead of guessing.
- Missing, option-like, invalid, or redacted manual agent/account arguments
  stop before config or cron access; legacy bare-name planning also requires
  exact target-agent ownership.
- Added causal RED/GREEN coverage for prefix-normalized sentinels, defensive
  add args, unsafe-job disable/no-deliver edits, runtime-only flags, Telegram
  zero ids, Croner steps/ranges, candidate unanimity, case-sensitive ownership,
  safe hints, account defaults, and OpenClaw `***` redaction.
- Receipt:
  `docs/audits/2026-07-21-b5-cron-delivery-provisioning-fix.md`.
- Final focused cron gate: 116/116. Adjacent configuration/default-LLM
  contract gate: 45/45. Serial deploy/symlink/default-LLM runtime gate exited
  0. Lint, manifest JSON parsing, and diff checks pass.

### B5 specification-review follow-up

- Initial independent B5 specification review: FAIL, Critical 0 / Important 7.
- Closed Croner grammar gaps, cross-provider binding ambiguity, explicit-empty
  account inheritance, normalized announce modes, first-match-only duplicate
  cleanup, missing-mode non-delivery cleanup, bare `t.me` normalization, and
  incomplete manifest ownership/delivery documentation.
- Every finding received a causal RED before its minimal fix. Post-review
  focused gate: 122/122 across 20 suites, no failures or skips.
- Post-review serial adjacent config/default-LLM/deploy gate exited 0; lint,
  manifest JSON parsing, and diff checks pass.

### B5 second specification-review follow-up

- Independent re-review: FAIL, Critical 0 / Important 2 / Minor 0.
- Closed descending Croner ranges across numeric, named-month, and named-day
  fields while retaining ascending forms.
- Closed omitted-account root-default ambiguity: routing fields alone no longer
  invent `default`; a supported root `botToken`/`tokenFile` (including the
  effective redacted `botToken: "***"` shape) proves the real root account even
  alongside multiple named accounts. Explicit missing accounts remain denied.
- Both account counterexamples were RED 0/2 and GREEN 2/2. The combined
  focused cron/bootstrap gate passes 124/124 across 20 suites with no failures
  or skips.

### B5 quality-review follow-up

- Independent quality/security review: FAIL, Critical 0 / Important 2 /
  Minor 1; every finding is now closed with a causal regression.
- Cron validation rejects bare `W`/`L` modifiers and oversized field steps,
  while preserving Croner-valid numeric/named last-weekday forms.
- A proven Telegram root account can be selected explicitly as `default`;
  missing non-root accounts remain denied. Root SecretRef object evidence is
  structurally validated instead of accepting arbitrary objects.
- Final focused cron/bootstrap/symlink gate: 126/126 across 20 suites, no
  failures or skips. No PLUR1BUS handler, default-LLM route, API-key lookup, or
  per-agent credential inheritance changed.
- The first quality re-review found one remaining Important DOW step-boundary
  false-positive (`*/8` versus Croner's maximum `7`). Five- and six-field
  regressions now reject it while retaining `*/7`; no other route changed.
- Final independent quality re-review at `b287e39`: **PASS**, Critical 0 /
  Important 0 / Minor 0. Focused gate 126/126 across 20 suites; lint and diff
  checks pass. B5 is closed without handler, default-LLM, API-key, per-agent
  credential, Main, or Remote changes.

## 2026-07-23 — B13 Task 2 recall/provider ACL boundary

- Commit `6d2a33e` (`fix: authorize recall before graph and providers`) preserves
  complete ownership/provenance across initial, refined, and hydrated recall
  rows and enforces the frozen canonical ACL context before graph traversal,
  embeddings, reranking, and every soft-budget return.
- Graph authorization inspects at most 400 ordered edges and 200 endpoint IDs.
  Endpoint reads use bounded 100-ID chunks, a shared deadline, strict
  multi-namespace error propagation, and an explicit
  `ERR_UNSUPPORTED_IN_QUERY` compatibility signal; free-text error inference is
  intentionally absent.
- Initial, refined, graph-relevance, temporal-anchor, and canonical cache-miss
  embeddings receive the request-bound frozen agent context. Model selection,
  API-key/endpoint/header routing, provider fallback, and per-agent credential
  behavior remain unchanged.
- Historical disclosure proofs stop at their obsolete disclosure assumptions.
  Final focused and directly affected gate: 113/113, no failures or skips.
- Independent specification review: **PASS**, Critical 0 / Important 0 /
  Minor 0. Independent quality review: **PASS**, Critical 0 / Important 0 /
  Minor 0.
- Work remains local on `fix/high-mid-audit-findings-continuation`; Main,
  `fix/high-mid-audit-findings`, PR #85, and Remote remain untouched.

## 2026-07-23 — B13 Task 3 Wiki visibility and destructive audit

- Commits `e238596`, `ca8fbc2`, `b74782f`, `2a34054`, and `12df055` close
  Wiki lifecycle, object-ACL, non-enumeration, handler-validation, bounded
  post-ACL selection, and destructive-audit path findings.
- Invalid or missing arguments stop before routing, runtime LLM, pool, lease,
  DB initialization, or provider work. Add/search/delete preserve canonical
  ownership and agent-scoped embedding purpose.
- Delete remains archive-first, awaits DB deletion, then writes exactly one
  audit record. Canonical audit parent and target paths reject files,
  directories in the wrong position, non-writable nodes, and symlinks before
  mutation; true missing paths remain creatable.
- Final focused gates: 51/51 Wiki cases and 29/29 handler/auth/adapter/default-
  LLM cases. Independent specification and quality re-reviews both pass with
  Critical 0 / Important 0.
- Main, `fix/high-mid-audit-findings`, PR #85, and Remote remain untouched.

## 2026-07-23 — B13 Task 4 safe-update ownership and confirmations

- Commits `3053573` and `72c374c` validate the stored ownership tuple before
  idempotency or writes, preserve all ownership aliases verbatim, and keep
  store-before-supersede durability.
- `/forget` and `/correct` use the canonical host request tuple for both
  confirmation creation and completion. Only complete UUID nonces with exact
  command/target/identity bindings redeem; prefixes and mismatches do not
  consume live confirmations.
- Pending confirmations are expiry-swept atomically across both maps and capped
  at 1,024 entries. Final affected gate: 157/157.
- Independent specification and quality re-reviews pass with Critical 0 /
  Important 0. Minor: re-registering the identical nonce+target at full
  capacity can evict one unrelated oldest entry; production handlers generate
  fresh random UUID nonces.
