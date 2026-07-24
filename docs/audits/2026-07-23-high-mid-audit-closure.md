# High/Mid Audit Closure Receipt

Date: 2026-07-23  
Branch: `fix/high-mid-audit-findings-continuation`  
Outcome: **all high/medium findings in the 2026-07-18 remediation design are closed**

## Scope and receipt inventory

The authoritative scope is
`docs/superpowers/specs/2026-07-18-high-mid-remediation-design.md`.
The final checkout preserves every feature-positive invariant in that design and
contains the following durable receipts:

| Batch | Findings | Receipt |
|---|---|---|
| B1 | BUG-01 | `docs/audits/2026-07-19-bug-01-command-reachability-fix.md` |
| B2 | BUG-02, BUG-09 | `docs/audits/2026-07-19-bug-02-bug-09-durable-merge-fix.md` |
| B3 | BUG-03, BUG-07, BUG-ADD-03 | `docs/audits/2026-07-19-b3-timeout-admission-recall-cache-fix.md` |
| B4 | BUG-ADD-01 | `docs/audits/2026-07-19-b4-auto-capture-checkpoint-fix.md` |
| B5 | BUG-04, BUG-05, FA-08 | `docs/audits/2026-07-21-b5-cron-delivery-provisioning-fix.md` |
| B6 | BUG-06, BUG-08 embedding half, BUG-10, SEC-10 | `docs/audits/2026-07-19-b6-embedding-cache-dependency-fix.md` |
| B7 | BUG-08 MemoryDB half, BUG-11, BUG-12 | `docs/audits/2026-07-19-b7-lancedb-lifecycle-atomic-updates-fix.md` |
| B8 | BUG-ADD-04, BUG-ADD-05, SEC-14, FE-ADD-02 | This receipt |
| B9 | BUG-ADD-02, BUG-ADD-06, BUG-ADD-07, FE-ADD-06 | `docs/audits/2026-07-19-b9-operations-maintenance-fix.md` |
| B10 | BUG-ADD-08, FE-ADD-07 | `docs/audits/2026-07-19-b10-provider-wizard-input-fix.md` |
| B11 | FA-01, FA-02, FA-06, FA-09, FA-10, FE-ADD-01 | `docs/audits/2026-07-19-b11-configuration-contract-fix.md` |
| B12 Core | FA-03, FE-ADD-05 | `docs/audits/2026-07-20-b12-core-recall-namespaces-fix.md` |
| B12-P | FA-07 | This receipt |
| B13 | SEC-01–SEC-05, SEC-12, SEC-16, FA-04, FE-ADD-04 | `docs/audits/2026-07-21-b13-acl-wiki-share-fix.md` |
| B14 | SEC-11, FA-05, FE-ADD-03 | This receipt |
| B15 | SEC-15 | This receipt |

BUG-08 is closed jointly by the B6 and B7 receipts. The opportunistic low
findings changed on the same paths are covered by their owning receipts; no
standalone low-severity remediation lane was introduced.

## B8 — Neo ownership, embeddings, and backpressure

### Closure

- Every Neo read, lookup, recall, pattern, and behavior-card path applies the
  canonical requester ACL before scoring or rendering.
- Agent-private, workspace, and user ownership remain distinct. Missing or
  conflicting bindings fail closed.
- Workspace storage uses a collision-resistant full-identity key. Legacy paths
  move only through an explicit, serialized migration that preserves source
  identity, nested state, and canonical collisions.
- A vector is marked fresh only after a real finite provider embedding is
  persisted. Divergent lexical queries are covered by semantic-recall tests.
- Worker admission and pending state are bounded and reject excess work
  deterministically.

### Files and commits

- Commits: `467bd95`, `f5e75ad`, `fe22dc2`, `646d961`.
- Production: `index.js`, `lib/neo-arch.js`,
  `lib/neo-worker-runtime.js`.
- Regression coverage: `tests/neo-b8-closure.test.js`,
  `tests/neo-worker-runtime.test.js`, `tests/smoke-neo.test.js`,
  `tests/neo-arch-jsonl-utf8.test.js`,
  `tests/neo-arch-regex-perf.test.js`.

### Proof and bypass review

The focused controller run passed all five owning files. Positive controls
prove same-workspace sharing, provider-backed embedding recall, worker
execution, UTF-8 ledger handling, and normal Neo smoke behavior. Negative
controls cover foreign owners/workspaces, unbound rows, path-key collisions,
same-name legacy migration, state collision preservation, and full admission.
No requester-relative legacy ownership inference remains.

Remaining uncertainty is operational only: explicit migration still requires
the operator to choose and run the migration command; it is intentionally not
an automatic reinterpretation of legacy data.

## B12-P — advertised recall runtime

### Closure

The public configuration now reaches all six promised lanes: query refinement,
`candidateTopK` ANN fetch, global adaptive budgeting, prompt-only semantic
compression, authorized GraphIndex use, and real pattern records. Compression
does not rewrite stored memory, and one final ledger records the actual
post-budget result.

### Files and commits

- Commits: `6a95c93`, `e9388b5`.
- Production/config: `index.js`, `lib/recall-pipeline.js`,
  `lib/text-utils.js`, `openclaw.plugin.json`.
- Regression coverage: `tests/b12p-runtime-reachability.test.js`,
  `tests/recall-compression.test.js`, `tests/config-audit.test.js`.

### Proof and bypass review

The focused 17-file recall suite passed. Positive controls prove default private
recall, multi-line metadata preservation, GraphIndex and pattern reachability,
and candidate-limit behavior. Negative controls prove a one-token budget can
inject zero memories, disabled switches remain inert, and no compression write
path exists.

Remaining uncertainty: provider quality can change ranking quality, but failure
continues through the documented fail-soft base-recall path and does not weaken
ACL or persistence semantics.

## B14 — Obsidian and Semantic Discovery

### Closure

- Raw command tokens are parsed once into a deeply frozen command plan and
  exact owner/workspace mutation policy.
- Authorization precedes every data-bearing read, preview, provider call, and
  writer. Contradictory or denied plans perform zero mutation.
- Every Obsidian, review, archive, dashboard, SOUL, cron, mirror, and semantic
  sink consumes the same policy.
- Review authority and vault confirmations live in protected, owner-partitioned
  storage outside editable display artifacts.
- Semantic Discovery has a bound prepare/confirm flow; preparation is read-only,
  and no link index or mirror is written before confirmation.
- Known cron agents map back to their canonical workspace name while the
  command policy remains bound to the canonical request identity.

### Files and commits

- Core commits: `bb33876`, `b801941`.
- Final integration commit: `b94d187`.
- Principal production files: `index.js`, `lib/obsidian-bridge.js`,
  `lib/obsidian-control-room.js`, `lib/obsidian-mutation-policy.js`,
  `lib/obsidian-review-authority.js`,
  `lib/obsidian-vault-authority.js`,
  `lib/obsidian-vault-confirmation-flow.js`,
  `lib/obsidian-semantic-discovery-flow.js`, `lib/install/soul-patcher.js`,
  and the writers below `lib/obsidian/`.
- Principal regressions: `tests/b14-command-policy.test.js`,
  `tests/b14-review-authority.test.js`,
  `tests/b14-semantic-confirmation.test.js`,
  `tests/b14-terminal-fixes.test.js`,
  `tests/b14-vault-confirmation.test.js`,
  `tests/b14-zero-mutation.test.js`,
  `tests/auth-003-obsidian-command-gate.test.js`, and the Obsidian smoke suites.

### Proof and bypass review

The isolated 19-file B14 suite and the post-integration 22-file B8/B12-P/B14/B15
suite passed. Final legacy-harness coverage additionally passed 97/97 tests.
Positive controls prove confirmed vault writes, protected review
approve/reject/snooze/apply, dashboard generation, semantic confirmation, and
session-bound merge routing. Negative controls snapshot content and mtimes for
missing, augment, no-write, unconfirmed, unauthorized, selector-mismatch, and
cross-owner cases.

Remaining uncertainty: display-only legacy review artifacts are readable only
through the explicit legacy-view compatibility path; they never become
authoritative mutation state.

## B15 — REM scope partitioning

### Closure

- Candidate memories and graph neighbors are ACL-filtered before pattern,
  narrative, or echo provider input.
- Each run has one normalized owner partition with distinct run, lock,
  completion, and vault identity.
- Workspace/user bindings survive pattern records, dream memories, echoes, and
  vault evidence.
- User-scoped REM requires an explicit authenticated owner. Legacy or unbound
  echoes fail closed.

### Files and commits

- Commits: `338cff9`, `f52fab9`, `5e3f1b4`.
- Production: `index.js`, `lib/dream-echo.js`,
  `lib/dreaming/light-dream.js`, `lib/dreaming/dream-narrative.js`,
  `lib/dreaming/rem-dream.js`.
- Regression coverage: `tests/rem-dream-acl.test.js`,
  `tests/dream-echo.test.js`, `tests/dream-memory-recall.test.js`,
  `tests/openclaw-default-llm-callers.test.js`.

### Proof and bypass review

The owning ACL suite passed 10/10 focused tests and remains green in the final
serial suite. Positive controls prove bound workspace and user dreams, echo
recall, and vault output. Negative controls prove foreign neighbors never reach
providers, missing owners stop before provider input, mixed accessible scopes
select exactly one partition, and unbound echoes remain unreadable.

Remaining uncertainty is quality-only: REM pattern/narrative usefulness depends
on the configured model, while ACL and persistence behavior remain
deterministic and covered.

## Final integration corrections

Two final commits close integration-only gaps without expanding scope:

- `b94d187 fix: close final audit integration gaps`
  - adds every new direct runtime import to `DEPLOY_FILES`;
  - preserves known-agent Evening Review routing across canonical workspace
    identities.
- `34b68cf test: align legacy harnesses with secured contexts`
  - injects confirmed mutation policies into direct writer fixtures;
  - updates host-command fixtures to the canonical session/workspace contract;
  - keeps the session-bound Obsidian merge positive path protected by real
    review and vault authority.

Five initially red files were not product failures: their nested Node
subprocesses were denied by the filesystem sandbox with `spawnSync ... EPERM`.
The authoritative outside-sandbox rerun passed all 97 affected tests.

## Final verification

Executed on the final clean checkout:

```text
npm ci --ignore-scripts
  added 131 packages

npm audit
  found 0 vulnerabilities

npm run lint
  exit 0

git diff --check
  exit 0

node --test --test-concurrency=1 tests/*.test.js test/*.test.js
  tests 3259
  pass 3258
  fail 0
  skipped 1
  duration_ms 467517.804789
```

The single skipped permission-mode test is an intentional platform-dependent
fixture. No test failed. The worktree was clean after verification.

The previously noted reranker-scoring quality issue is not one of the
high/medium findings enumerated by the authoritative remediation design and is
not used to claim any security or durability closure here.

