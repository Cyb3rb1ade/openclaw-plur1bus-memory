# Engine inventory — 2026-10-16

Source: fresh `origin/main` at `0c451b68f9` (merge of #250), inspected in an isolated worktree. Harness baseline: `3859b949`, consuming `6868b7b117cf7d59b24eb1e75f02aafc1a48f46c` (contract 1.12.0). This is a source inventory, not an acceptance or release claim. PR-01…15 below refer to the extraction-plan identifiers, not GitHub PR numbers.

## Extraction plan

| Plan | On main / evidence commit | Gate to run / limits |
| --- | --- | --- |
| PR-01 platform | Yes: `44a2930d48`, `75fb6d2a3b` | `tests/platform.test.js`, `platform-callsites.test.js`; native Windows coverage cannot be inferred from a macOS run. |
| PR-02 HostServices | Yes: `68174ca3e2`, `af22980070`, `684a733d0a` | `tests/host-services.test.js`, `index-host-logger.test.js`; v1 still exposes a host-shaped runtime. |
| PR-03 split | Yes: #184 `01861add88`; construction completed by `8df0edce89` in #186 | `engine-create-engine.test.js`, `lint-engine-imports.test.js`; static lint covers imports, not all host semantics. |
| PR-04 recall blocks | Yes: `59b1151a85`, `7868efae58` | `tests/golden-prefix.test.js`, `engine-recall-result.test.js`, `engine-recall-deferrals.test.js`. |
| PR-05 abort | Yes: `0956b4b6b2`, `9c84d6a2bb` | `tests/engine-recall-abort.test.js`, `engine-contract.test.js`, `abort-commit-barriers.test.js`. |
| PR-06 principals | Yes: `35007dabd9`, `663621dacd`; host-path/import work `402788eaed`, `6a6e689e1a` | `tests/engine-principal.test.js`, `host-paths.test.js`, `lint-engine-imports.test.js`. |
| PR-07 jobs | Yes: `6eab4bffb4` | `tests/engine-jobs-registry.test.js`. |
| PR-08 durable jobs | Yes: `2b8833f9e1`, `fea894ac65`, `8365d801c5` | `tests/engine-jobs-ledger.test.js`, `engine-jobs-retry.test.js`, `engine-jobs-migration.test.js`; historically behavior-changing. |
| PR-09 rerank timeout | Yes: `034d023cf3`, `2c5bd2ed5e` | `tests/rerank-single-timeout.test.js`, `reranker-cohere-timeout.test.js`. |
| PR-10 identities | Yes: #246 merged as `dbf59704dd`, implementation `24e17195fe`, contract 1.14.0 | `tests/multi-identity.test.js`; the PR reports unchanged frozen golden-prefix fixtures and existing engine different-dimension/share tests. Re-run those gates locally; RRF threshold measurements, Harness integration and migration-route evidence remain package work. The owner merged #246 on 2026-10-10; this records the historical merge and does not waive the new package’s Draft/owner gate. |
| PR-11 Windows IPC | Implementation exists: `8fb25437ab`, `f76a5a50bd` | `tests/engine-embedding-serve.test.js`, scoped IPC tests; macOS cannot prove named-pipe behavior. |
| PR-12 Bash to Node | Partial: snapshot port `c5e77650e7` and installer work `a36938dd34` | Four historical shell scripts still exist. Not accepted as a complete four-script port; outside this package. |
| PR-13 UI extraction | No separate control-UI package; renderer remains in `lib/setup/control-ui-plugin-runtime.js` | Outside this package; no extraction/snapshot acceptance claimed. |
| PR-14 package publication | No separate `@cyb3rb1ade/plur1bus-engine` package in this tree | Publication remains an owner decision; no publishing in this package. |
| PR-15 checkpoint | Yes: `fb42697d70` | `tests/engine-checkpoint.test.js`, `auto-capture-checkpoint.test.js`. |

## Engine contract increments

| Increment | On main / commit | Gate |
| --- | --- | --- |
| E1 memory operations, 1.5 | Yes: #188 `215193e528`, types `bb7ec441e2` | `engine-memory-tools.test.js`. |
| E2 admin operations, 1.6 | Yes: #190 `09bf873c22`, types `6144fae60a` | Memory proposals/shared-ops, Obsidian and store-schema tests. |
| E3 embedding service, 1.7 | Yes: #193 `3a4426a59f`, types `331ed05f07` | `tests/engine-embedding-probe.test.js`, `engine-embedding-serve.test.js`. |
| E4 status/models/replay, 1.8 | Yes: #194 `d084242405`, types `1425608d58`; follow-ups #195/#196 and E4.3 `e8cf18ca34` | Status-health, replay-guard and verified-path shared-memory tests. |
| E5 config schema/warm recall, 1.9 | Yes: #197/#198 (`ce65a17684`), types `aec4b4647c` | Config-schema/readat, warm-only recall, honest timing and worker-close tests. |
| E6 host-neutral contract 2.0 | No at the inventory baseline | Current `HostServices` contains `HostRuntime`, `HostPathOverrides.openclawHome` and optional clock. Engine construction directly reads runtime config/LLM/workspace members. |

Current frozen contract is **1.14.0** (`types/engine.d.ts`, `types/engine.conformance.ts`, `engine/create-engine.js`). Subsequent 1.x additions include import (1.11), rebind/unbind (1.12), unimport (1.13), and multi-identity routing (1.14). Hard erasure and exhaustive ACL cursor export are absent at this baseline.

## Boundary findings and sequencing

A static walk starting at every `engine/**/*.js` and following literal relative ESM imports reaches 321 JavaScript modules. 81 contain case-insensitive occurrences of the host name (399 mentions, including comments and compatibility strings). This deliberately broad count is an inventory, not a claim that every mention is an SDK dependency. Important live dependencies include the host-shaped runtime, `lib/setup/config-contract.js` loading the plugin manifest, host config mutations in commands, and provider/path defaults. Direct clocks, console logging and environment reads also remain in engine modules.

PR-04/05/06 prerequisites exist, so no prerequisite implementation needs to precede E6. Phase 3 will extend and verify existing PR-10 rather than reintroducing it. Keep the ranking and thresholds owner questions open for the new Draft PRs; do not undo or reinterpret the historical merge. Phase 2 must define erasure as deletion from engine-managed stores, including physical store history and sidecar files, with resume/fail-closed admission; `forget` is not a substitute.

## Validation record

- Host: macOS arm64; Node 24.21.0.
- Initial attempts with old dependencies or a symlinked dependency tree were discarded: the old tree mismatched the current dev-host pin, and a lock-path test rejects dependency resolution outside its own checkout. These are **not** clean-baseline results.
- A fresh `npm ci --ignore-scripts` was installed in the isolated engine worktree using the committed lockfile, without dependency changes. Lifecycle scripts were suppressed to avoid the package's cron-setup postinstall on the owner's machine.
- Final exact-commit baseline: a separate detached worktree at `0c451b68f9` with its own physical `npm ci --ignore-scripts` installation. A previous run in the feature worktree overlapped a path edit and is excluded from exact-baseline evidence.
- Existing `npm test` mixes plugin-adapter tests and stub-host engine tests. Existing CI runs it on several Node/OS combinations, but has no explicit OpenClaw/Harness adapter matrix. Therefore M1 criterion 12 is **not proven** by the existing workflow or this inventory.
- No CI polling, merges, releases or upstream `openclaw/openclaw` comments performed.

## Known gaps

- [ ] E6 contract 2.0 implementation and dual-adapter suite evidence.
- [ ] Resumable hard erasure with physical-history/marker tests and foreign-scope preservation.
- [ ] ACL cursor export of 1,000 cards, complete and duplicate-free.
- [ ] Harness pin/adapter, delete/export wiring and required local gates.
- [ ] PR-10 frozen single-identity corpus, measurements, Harness different-dimension system test and additive M7 hook.
- [ ] Owner decisions: PR-10 merge/ranking, RRF thresholds, eventual PR-14 publication.

## E6 foundation changes on this branch

The engine's missing `baseDbPath` now resolves under `HostServices.stateDir`. The OpenClaw adapter explicitly supplies its historical home-relative default through the existing extensible capabilities object, so the plugin retains the same default even when its host state directory differs. Standalone host-path helpers keep their legacy defaults; an engine without adapter overrides binds the owning host's state/config paths. Lazy adapter overrides retain their previous priority and fallback behavior.

`tests/engine-host-path-isolation.test.js` adds five regressions: neutral host paths, explicit database and lazy override precedence, adapter-supplied historical default, the dynamic home-only config-file fallback, and the actual plugin registration default with a changed host home. The neutral-default test runs in a subprocess with a throw-away HOME/USERPROFILE. No existing test expectation or golden fixture is changed. This is a foundation fix, **not completed E6**; the contract remains 1.14.0 until the full 2.0 boundary is implemented.

Local foundation gates (Node 24.21.0):

| Gate | Result |
| --- | --- |
| New neutral-path regression before fix | 1 failed / 1 passed, wrong default proven; no expectation weakened. |
| Host paths + HostServices + four new regressions | 23 passed, 0 failed, 0 skipped. |
| Golden prefix + engine construction/follow-ups + host/path regressions | 48 passed, 0 failed, 0 skipped; frozen prefix fixtures unchanged. |
| Baseline extraction contract gates (recall/abort/deferral/jobs/checkpoint/embedding) | 125 passed, 0 failed, 0 skipped. |
| Inventory spot gates (platform/principal/host/timeout/checkpoint/multi-identity) | 77 passed, 0 failed, 0 skipped. |
| Real adapter construction + neutral host path file, final focused run | 5 passed, 0 failed, 0 skipped; actual plugin registration stops at the path resolver before store I/O. |
| `npm run lint` | Pass: syntax, TypeScript conformance, API/engine import rules. |

The suites above are named subsets of the existing mixed plugin/stub-host suite. They do **not** establish a full engine suite under the actual Harness-Core adapter. No Harness pin is raised by this foundation: the requested contract 2.0 is not available yet.

## Final full-suite results

Both final runs used Node 24.21.0 on macOS arm64, the committed lockfile and physical per-worktree dependencies. `npm test` exited 0 in both worktrees. The full feature run includes all five new path regressions.

| Source | Tests | Passed | Failed | Skipped | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unmodified baseline `0c451b68f9` | 6,366 | 6,279 | 0 | 87 | 0 |
| E6 foundation `13627c4051` | 6,371 | 6,284 | 0 | 87 | 0 |

The 87 skips are reported by the existing suite; no skip was added by this branch. No existing expectation changed. This is the existing mixed OpenClaw-plugin/stub-host suite, **not** evidence of an entire suite running under the actual Harness-Core adapter. Independent read-only review found no actionable correctness issue in the foundation. Its suggested actual-adapter path regression was added and passed before the final full run.
