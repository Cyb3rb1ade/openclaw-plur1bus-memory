# Task 6 — native admitted-user forwarding and fresh-shadow hydration

Status: implementation complete, offline validation passed. Implementation commit: `76c6725a80321a631fcb56694e30d5ca78071d90`. This report stays in the repository-ignored local SDD directory, consistent with the other task artifacts. No installed file, service, feature flag, toggle, provider, or live memory store was changed by this worker. Root owns deployment, restart, and live acceptance. Base was `4514a1ec`; root's metadata-only `aad25b77` was already present before this implementation commit.

## Closed gaps

1. Native OpenClaw session preparation already resolves the admitted transcript `preparedUserTurnMessage`, but native prompt phase omitted it from assembly, and the native helper projected away typed current-user fields. The patch now preserves this path through `before_prompt_build`.
2. Root explicitly extended this task after a real fresh-shadow reproduction showed persisted mood was not hydrated with recall off. The single runtime guard now hydrates any stable, configured, eligible admitted run (shadow or active). Configuration still precedes hydration. Existing active-only timed evidence, state/mood-file writes, and guidance remain unchanged.

## Interface and source changes

- `scripts/telegramTts/patch-exec-speech-context.mjs` retains `patchExecContextSource` and the existing exec projection. Added exact native source/helper transformations and all-target preflight. Existing bash-tools projection bytes are unchanged.
- Native prompt phase forwards its already resolved admitted message. Assembly projects **only** `currentUserMessage` from authored `content` and `currentUserMessageId` from the existing `idempotencyKey`. Strings preserve whitespace and Unicode; structured `text` blocks concatenate in order without inserted separators. Non-text blocks contribute nothing; malformed text blocks refuse projection.
- Neither typed field is emitted for missing, skipped, excluded, non-user, blank, invalid content, or missing/invalid stable identity. Explicit non-external/subagent provenance on the admitted message also refuses projection. Existing `hookCtx.inputProvenance`, identity, audience assertion, workspace, and hook invocation remain untouched. No model projection, effective prompt, stale history, or generated identity can supply these fields.
- Native helper forwards only the two typed fields. Raw-model and settled-finalization paths keep their original hook suppression. Runtime eligibility/internal/incognito/currentness/session/workspace gates remain in charge.
- Directory inspection retains `file` as the exec target and adds `files: string[]` for all three targets. `targets` includes `{file, changed, originalSha256, patchedSha256}`. `changed` is aggregate; `applied` remains explicit. All three implementation shapes are validated before any mutation. Alias/metadata bundles without the relevant implementation are ignored; duplicate implementations, unsupported/partial shapes, and unsafe paths refuse. Changes remain atomic per file.
- `deploy.py` consumes all paths, validates containment and projected hashes, snapshots every original before the apply subprocess, then checks all three syntax results. Its failure finalizer attributes only exact original/projected bytes. A partial apply can roll back; unknown concurrent or later operator bytes remain refused before any restoration. Existing startup invocation applies all projections, without another service.
- `lib/jevEmotionRuntime.js`: one guard changed from `isEnabled(c.agentId) && stable` to `stable` at hydration, after the existing configured/eligible/current/stable checks.
- Deployment README documents the producer requirement, all targets, inspection contract, backup/rollback behavior, and shadow hydration.

## Fixtures and execution boundary

New native fixture source was copied from the installed `builtin-openclaw-D3tz5Ca2.mjs` and `context-engine-maintenance-CLQ35L-o.mjs`, not invented typed events. The producer fixture includes the exact session transcript-resolution statement, the complete phase prefix through its assembly call, and the assembly prefix through the real helper call. Explicit fixture returns stop unrelated host work after these boundaries. The helper function is copied in full. Host-only dependencies for config/queue/context assembly are supplied offline; incoming assessment and speech planning have offline assessor/planner replacements only at their provider boundary.

The regression executes copied session producer → copied native phase → copied native assembly → copied native helper → real Jev runtime → existing copied exec caller → real speech adapter. It tests exact structured and string text, stable ID, adversarial `modelPromptProjection`, missing/excluded/skip/non-user/invalid source, provenance and runtime gates, duplicate rebuilds and retry run isolation, private matched context files, shadow neutral speech/no mood writes/no guidance, active dedupe, exact-prompt suppression, idempotence, unsupported/partial/ambiguous shapes, and all-target preflight.

JavaScript fixtures use `tests/helpers/temp-dir.js`. The Python installer fixture rewrites all executable deployment/patch destinations into its private root and scans for live destinations before spawning. It exercises real installer and patcher subprocesses in three cases: successful install, failure immediately after the first atomic rename, and unknown bytes replacing that first output. Successful and partial cases restore all bundle originals; unknown bytes and later operator drift reject rollback without restoring anything.

## TDD and commands/results

Meaningful RED observations before the relevant implementation:

- `node --test --test-reporter=tap tests/telegram-speech-native-host.test.js`: 17 tests, 15 passed / 2 failed. Native chain expected one incoming assessment but got zero; inspection did not contain the all-target inventory.
- `python3 tests/telegram-speech-deploy.test.py`: new actual-installer fixture failed inside the patch subprocess with `missing_original_before_patch` because only the exec bundle had been backed up.
- Added unknown-write failure case: same Python command failed because the post-failure manifest adopted the unknown current digest. Exact original/projected attribution then fixed it.
- `node --test --test-reporter=tap --test-name-pattern='fresh shadow' tests/jev-emotion-runtime.test.js`: 2 failed; fresh shadow assessor saw baseline joy .25/trust .45 instead of persisted joy .91/trust .87. After the one-line hydration fix: 2 passed; both accepted and unknown assessor results leave saved bytes unchanged, no mood file, no timed evidence, and outgoing context sees the persisted vector.

Final scoped verification:

```sh
node --test --test-reporter=spec tests/telegram-speech-host-patch.test.js tests/telegram-speech-native-host.test.js tests/jev-emotion-runtime.test.js tests/emotional-state-timed.test.js tests/telegram-speech-adapter.test.js tests/jev-final-review.test.js tests/deploy-manifest-covers-shipped-scripts.test.js tests/temp-dir-helper.test.js
```

Result: **107 tests passed, 0 failed**, including deployment inventory and strict temp-helper guard.

```sh
python3 tests/telegram-speech-deploy.test.py
```

Result: **6 tests passed**; real install test covers success, partial application, and unknown concurrent bytes, plus later operator drift.

```sh
node --test --test-reporter=spec tests/telegram-speech-python.test.js
```

Result: **1 aggregate test passed, 0 failed** (46.3 s), executing all four offline Python helper, wrappers, deploy, and routing suites.

```sh
git diff --check
node --check scripts/telegramTts/patch-exec-speech-context.mjs
python3 -m py_compile scripts/telegramTts/deploy.py tests/telegram-speech-deploy.test.py
```

All passed. No full repository suite was rerun, as explicitly scoped by root.

The following read-only installed inspection passed:

```sh
node scripts/telegramTts/patch-exec-speech-context.mjs /usr/lib/node_modules/openclaw/dist
```

Additionally, a `node --input-type=module` smoke script imported `makeTempDir`, copied only the inspected installed bundles into that temporary directory, invoked `patchExecContextDirectory(copy, true)`, ran `node --check` for each copy, and invoked apply a second time. Result: **3 complete installed bundle copies syntax-valid; second apply changed=false; liveApplied=false**. No fixture-only shape assumption is needed for the installed three implementations.

## Concrete rollout targets and inspected digests

| Installed target | Before SHA-256 | Projected SHA-256 |
| --- | --- | --- |
| `/usr/lib/node_modules/openclaw/dist/bash-tools-ClkbGMDV.mjs` | `cdc26e8de8e42f1960d5dd7b634453e8b0bdafda4b7b1a73ed022f2cd04cb133` | unchanged |
| `/usr/lib/node_modules/openclaw/dist/builtin-openclaw-D3tz5Ca2.mjs` | `592dc4948915dc8a6374e2af02ba56e7dedacd4800ab307ae8eea06aa5c21d2d` | `4a7f9e13d978303dfd96f66406f2d3cb0cc940b4a29ab48caacc610a90073ba2` |
| `/usr/lib/node_modules/openclaw/dist/context-engine-maintenance-CLQ35L-o.mjs` | `3f1ba6f15431be4555c5c33bec6fca51a79d3c0acd29eeaf11bf2af3b6113e7d` | `2cd292ffdb7809e7b1fab029a11506718ce09df87f6d4c8ee9ba77f458ab1e4c` |

Updated installer/patcher artifact: `/root/.openclaw/patches/patch-exec-speech-context.mjs`; existing startup persistence: `/root/.openclaw/patches/apply-media-patch.sh`. Plugin rollout must include the existing manifest-listed `/root/.openclaw/extensions/memory-lancedb-namespaced/lib/jevEmotionRuntime.js`. Remaining helper/wrapper/skill mappings remain the existing installer inventory.

## Limits and remaining owner work

- This patch deliberately supports exact inspected host shapes. A future upstream shape change fails closed and requires another reviewed compatibility update.
- Atomicity is per bundle, not one filesystem-wide transaction. Controlled install failure preserves originals and known landed outputs for rollback. Abrupt termination before the final manifest write still requires snapshot inspection; unknown drift is never force-restored.
- Offline native-chain success proves forwarding and consumer behavior, not external Telegram eligibility. Root still owns controlled `.2` deployment/restart, genuinely eligible contextual shadow/live-audio acceptance, and later activation. CLI/manual/internal input policy is unchanged.
- No new dependencies, raw-content diagnostics, policy relaxation, config/toggle writes, live patch application, service operations, tag movement, or provider calls were introduced or performed.
