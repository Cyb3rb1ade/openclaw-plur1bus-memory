# Hermes 7.16.9 delta review

Upstream: `f23867a1de5cd5a8b94370b5172d497fad4f2427` (`v7.16.9`).
Baseline: `v7.15.4`, Hermes `7.15.4-hermes.1`.
All 15 upstream commits and 36 changed paths are merged. Bundled JavaScript
parity is not a claim of native Hermes host API parity.

## Commit assessment

| Commit | Change | Hermes disposition |
|---|---|---|
| b7762710 | Recall width settings | Native settings, review/confirm writes and both UIs; configured ANN candidate count and final prompt count |
| 40b3ed00 | 7.16.0 identity | Release metadata advanced |
| bad9ad2c | Inject host event bridge into lightDream | Retained JS; Hermes uses its own backend and scoped diary, not OpenClaw host events |
| da116c15 | Diary test cleanup | Retained upstream test |
| 677b9f88 | Public memory artifacts capability | Retained JS facade; no equivalent Hermes memory-capability registration contract claimed |
| 6616890b | 7.16.1 identity | Release metadata advanced |
| 3ceeaed3 | Host sleep schedule schema | Retained JS schema; Hermes platform maintenance scheduling remains its existing separate implementation |
| a3a3a11d | Read actual host sleep schedule | Retained JS; no invented native schedule derived from config defaults |
| 76772455 | Per-workspace chat model | Retained JS; native task-model settings remain, but are not a substitute for host chat model/session-unpin APIs |
| b620f9e9 | Host last light-dream completion | Retained JS; native scoped light-dream journal records already have completion-time createdAt; no OpenClaw status provider in Hermes |
| e6c78889 | Model write last, reject before unpin | Retained JS; no native host chat-model mutation added |
| 4d6b8d10 | Safe context truncation, inner memory budget | Native complete-record trimming, escaped memory text, structured overlays dropped atomically, default inner budget 12000 and global budget 17000 |
| 9bb163fb | Relocatable feature cron dispatch | Retained JS; Hermes scheduler does not execute OpenClaw feature crons |
| 6903b572 | Workspace/subagent model cards | Retained JS; native profile authority retained, no enumeration or writes to sibling profiles |
| f23867a1 | Never classify/push dreams as Critical | Native classifier and materialized writer gate reject origin=dream or memoryClass=dream even with importance/neverForget |

## Complete changed-path inventory

Bundled runtime, byte-exact against the upstream tag:

- `index.js`
- `lib/chat-model.js`
- `lib/control-plane-projection.js`
- `lib/critical-review.js`
- `lib/dashboard-settings.js`
- `lib/db-adapter.js`
- `lib/dreaming/dreaming-status-provider.js`
- `lib/dreaming/light-dream.js`
- `lib/inject-budget.js`
- `lib/jobs/critical-classifier.js`
- `lib/relevant-memory-context.js`
- `lib/setup/control-ui-plugin-runtime.js`
- `lib/setup/control-ui-write.js`
- `lib/setup/feature-cron-native.js`
- `lib/setup/feature-cron-plugin-runtime.js`
- `scripts/lib/deploy-integrity.mjs`

Retained upstream test changes:

- `tests/abort-commit-barriers.test.js`
- `tests/chat-model.test.js`
- `tests/critical-classifier-dream-exclusion.test.js`
- `tests/dashboard-pending-and-views.test.js`
- `tests/dashboard-settings.test.js`
- `tests/dream-diary.test.js`
- `tests/dreaming-status-provider.test.js`
- `tests/feature-cron-native-dispatch.test.js`
- `tests/feature-cron-plugin-runtime.test.js`
- `tests/inject-budget.test.js`
- `tests/openclaw-target-memory-contract.test.js`
- `tests/recall-memories-max-chars-wiring.test.js`
- `tests/release-750-compat.test.js` (Hermes version assertion)
- `tests/relevant-memory-context.test.js`

Documentation and release metadata:

- `CHANGELOG.md`
- `README.md` (Hermes release header and limitations retained)
- `docs/configuration.md`
- `openclaw.plugin.json` (Hermes version only)
- `package-lock.json` (Hermes version only)
- `package.json` (Hermes version, files and publishing channel retained)

## Preserved Hermes-specific behavior and limitations

Installers, all/default profile selection, automatic host integration, model and
dimension migrations, scoped actions, provider settings, native memory tools,
configuration help and actual Python version footer remain present. No live
profile, provider or memory store is modified by this release build.

This remains a prerelease: shared Hermes Desktop backends may retain an old
profile route; the plugin rejects mismatches instead of writing another profile.
Native GC capacity controls and full host model-catalogue/chat-model integration
remain open. Windows launchers are explicitly unsigned; macOS ARM signing and
notarization are separate release gates. Intel macOS is not a release target.

Regression coverage: `test_release_7169.py`, `test_inject_budget.py`, historical
inventory gates and both distributed UI harnesses. Release receipts record fresh
full-suite results and per-platform build/install verification separately;
passing stubbed retrieval tests is not a live provider/model quality benchmark.

## Upstream test repair

The full Node gate exposed a stale fake SQL evaluator in
`test/memory-edit.test.js`: it did not understand the newly used `!= 'dream'`
predicate. The fixture now implements SQL inequality/NULL semantics, with
positive and negative controls. Real LanceDB dream-exclusion tests were already
passing. This test-only fix is submitted upstream as
[PR #189](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/189).
