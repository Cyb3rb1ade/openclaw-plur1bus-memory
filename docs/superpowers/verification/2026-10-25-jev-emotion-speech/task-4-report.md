# Task 4 — shared Telegram speech adapter and rollout artifacts

Implementation only; the controller owns installation, live shadow/active delivery, service operations and final acceptance. No native TTS/talk/Discord/STT files/configuration were edited. No live provider requests or subagents. A test-fixture isolation mistake briefly changed live toggle JSONs; the incident and verified exact-byte recovery are documented below rather than omitted.

## Interfaces and behavior

- `lib/telegramSpeech.js` exports `planTelegramSpeech(input, options)`, `readSpeechContext(options)`, `loadSpeechConfig(file, agentId)`, `resolveSpeechJevKey(options, env, file)`. It consumes existing `prepareSpeechText`, planner/renderer and effective configuration modules without changing Task1/Task5 modules. No outgoing mood update.
- `scripts/plan-speech.mjs`: JSON stdin/stdout, version 1, explicit allowlisted `main`/`bernhardine`/`heisenberg`, one/two unique version IDs `default`, `de`, `pl`. Output includes version/agent/mode/context classification/decision and `{id,text,speech,blocked}` versions. Static stderr on input/config failure; no source/secret logs.
- Reads existing private `openclaw.json`, selects the plugin entry and applies `resolveEffectiveConfig`. Reads configured feature global/agent/mode directly, independently of incoming runtime's active-only `isEnabled`. Explicit key precedes inherited selected env name; only if absent, selected assignment from existing private `/root/.openclaw/gateway.systemd.env`. No eval, whole-env import, key argv, new key or endpoint.
- Exact run snapshot validation: canonical selected workspace path, 64-hex filename, private owned directories/file, no symlink file, version/agent/run/session, created/expiry bounds including 15-minute maximum. Source context uses the existing 16,000-code-point validation contract and max two authored entries. Missing/stale/forged/unsafe context returns final-text-only planning; no latest-run/agent lookup. Context never updates mood.
- All ElevenLabs text is canonicalized once before outgoing Jev; bilingual text shares one batched outgoing call. Active applies closed tags; shadow logs only `speech_shadow_decision:accepted|rejected` on stderr and sends neutral words; disabled skips Jev/tags. Task ruling confirmed by controller: mandatory sanitation/cap/no later punctuation also applies when emotion is disabled; routing/toggle/speaker/model/neutral synthesis behavior stays intact.
- Python `say-prepared --voice <configured> --out <wrapper output>` takes `{version:1,text,speech}` on stdin. Validates <=2,000 canonical Python Unicode code points, literal bracket directives, closed tags, <=64 insertions, and exact equality after removing tags. Bypasses legacy clipping/strip. Normal `say` and management commands remain supported. Provider errors no longer echo arbitrary response/error contents. Conversion failure/empty output never claims success.
- Actual installed helper and three skill/bin trees were copied first into `scripts/telegramTts/`; no live helper/wrapper/skill edits. ElevenLabs generator branch precedes old filtering/punctuation logic and threads explicit agent into bridge. Legacy local/Edge paths remain. Bilingual bridge preserves same configured speaker, separate files, partial success and skip-empty-language behavior. No fallback speaker for ElevenLabs failure.

## Host patch

`tests/fixtures/telegramSpeech/bash-tools-host.mjs` contains the copied installed 2026.10.4 real caller fragment. `scripts/telegramTts/patch-exec-speech-context.mjs` changes only its trusted projection:

- `context?.hookContext?.runId ?? params.defaults?.runId`
- `context?.hookContext?.workspaceDir`

No cwd/workdir/env/model argument proof, spread of arbitrary hook context or latest lookup. Unique exact-shape `.mjs` bundle detection; dry-run default; atomic replacement with explicit `--apply`; rerun byte-identical; unsupported/ambiguous anchors refuse. Existing original hook/env return behavior remains.

Tests execute the copied patched caller, ignore forged model fields, show wrapper precedence/default fallback, omit missing workspace/run, and reach the actual incoming runtime to obtain distinct live context files for concurrent run IDs. Missing trusted workspace returns `{}`. Patched fixture passes `node --check`.

## Packaging, install and rollback

All runtime modules/CLI and Telegram assets are in `DEPLOY_FILES`; inventory test now covers `.py`, `.sh`, `.md` in the shipped Telegram asset tree. Added `.gitignore` exceptions and excluded Python bytecode. Repository config docs and all three copied runtime skills describe the same contracts. Root's verification ledger remains unstaged/unmodified by this task.

After controller deploys the plugin runtime modules to the installed extension (with its own version/tag/pin/guard flow):

```sh
python3 scripts/telegramTts/deploy.py --host-patch
python3 scripts/telegramTts/deploy.py --apply --host-patch
```

The first command was actually executed and passed: `/tmp/task-4-deploy-dry-run.log`. Mapping is explicit: shared helper/bridge, all three skill directories, patch helper; optional exact installed bundle `/usr/lib/node_modules/openclaw/dist/bash-tools-ClkbGMDV.mjs` and existing startup `/root/.openclaw/patches/apply-media-patch.sh`. The startup hook inserts the narrow patch invocation before its unique `exit $rc`, preserving the established systemd/update entrypoint. No new service/server/timer.

Private snapshot includes only affected files plus read-only copies of relevant config/toggles. Installer never resets/writes toggle state or config. It validates host plugin config through the effective contract. Rollback previews and then restores only manifest-listed affected files, refuses changed targets and parent symlink escapes, and never restores state/config evidence automatically:

```sh
python3 scripts/telegramTts/deploy.py --rollback /root/.openclaw/.snapshots/telegram-speech-YYYYMMDD-HHMMSS
python3 scripts/telegramTts/deploy.py --rollback /root/.openclaw/.snapshots/telegram-speech-YYYYMMDD-HHMMSS --apply
```

Details: `scripts/telegramTts/README.md`.

## Actual RED/GREEN evidence

- Initial missing adapter/CLI check: `node --test tests/telegram-speech-adapter.test.js > /tmp/task-4-red.log 2>&1`, failed. Expanded initial module-import tests `/tmp/task-4-red-behavior.log` likewise failed. These are scaffolding RED, not behavior-level regression evidence. Default isolated reporter here reports one file; subsequent runs explicitly use `--test-isolation=none` to expose individual cases.
- Helper missing prepared API: `python3 tests/telegram-speech-helper.test.py > /tmp/task-4-red-helper.log 2>&1`, failed 3 tests (missing `say_prepared`, six reported errors including subcases). GREEN `/tmp/task-4-green-helper.log`: 3 passed. Host missing patch API: `/tmp/task-4-red-host.log`, two failed; `/tmp/task-4-green-host.log`, two passed.
- Meaningful wrapper regression RED: `python3 tests/telegram-speech-wrappers.test.py WrapperTests.test_empty_language_is_skipped_without_false_partial_failure > /tmp/task-4-red-empty-language.log 2>&1`, one failure: valid PL with empty DE returned 1. Fix skips unrequested empty versions. Same command GREEN `/tmp/task-4-green-empty-language.log`, one passed.
- Context bound regression RED `/tmp/task-4-red-context-bound.log`: adapter rejected a valid 5,000-code-point authored Unicode context due to a newly introduced 4,000-code-unit limit. Fix uses the existing authored-text bound and sufficient bounded JSON size. GREEN `/tmp/task-4-green-context-bound.log`: 8 adapter tests passed.
- Rollback path regression RED `python3 tests/telegram-speech-deploy.test.py > /tmp/task-4-red-rollback-escape.log 2>&1`: 4 passed/1 failed (parent symlink escape accepted in dry-run). Fix canonicalizes under allowed runtime/dist root before hash/read/restore. GREEN `/tmp/task-4-green-rollback-escape.log`: 5 passed.
- Targeted combined command:

```sh
node --test --test-isolation=none tests/telegram-speech-adapter.test.js tests/telegram-speech-host-patch.test.js tests/telegram-speech-python.test.js tests/jev-emotion-speech.test.js tests/deploy-manifest-covers-shipped-scripts.test.js tests/deploy-integrity.test.js > /tmp/task-4-verification.log 2>&1
```

111 tests, 111 passed, no skips/failures (~18.5 s). Node aggregate invokes the actual Python helper/wrapper/deploy tests. Covered all3 identities, Unicode/cap/ellipsis/exact words, raw tags, active/shadow/disabled, batched bilingual agreement/speaker, current run context vs stale/forged, selected-only credentials, Jev timeout, synthesis/conversion errors, no stdout contamination/secrets, partial success, empty language and fixture guard. An additional run after adding the exact installed regression adapter is recorded below.

- Actual copied installed routing test source is retained at `tests/fixtures/telegramSpeech/installed-tts-routing.py`; `tests/telegram-speech-routing.test.py` reuses all six original test methods/assertions unchanged, with adapters onto the real guarded wrapper/manager/bridge/helper fixtures. It translates the old generator-log observation into provider text/voice observations and old test flags into isolated actual manager/provider-double controls. No live paths execute. This is more precise than claiming the original generator-double `setUp` can exercise the new combined bilingual branch unchanged.
- `node --check` adapter/CLI/patcher and patched copied host, `python3 -m py_compile` three Python runtime scripts, `bash -n` all copied shell files, `git diff --check`: passed. No full suite, real provider call, config activation or service operation performed.

## Fixture incident and recovery audit

Initial wrapper test command at approximately 2026-10-25 17:55:40–17:55:49 +01:00:

```sh
python3 tests/telegram-speech-wrappers.test.py > /tmp/task-4-wrapper-initial.log 2>&1
```

The copied manager retained its live `STATE_DIR`, while wrapper/output/provider paths were otherwise redirected/doubled. Five test setups and the disabled test's extra state reset called the copied manager for all3 agents: enable/disable, an invalid `voice` command, then `set-voice el-otto` (54 manager invocations total). Actual writes were `/root/.openclaw/settings/tts-toggle/{main,bernhardine,heisenberg}.json` and their transient `.tmp` files; each final JSON was enabled=true, voice=el-otto, lastUsed refreshed. `voice-ok el-otto` used the installed helper's read-only alias validation. Provider HTTP was doubled; temporary audio stayed in private fixture output paths. No other live writes were identified. The incident was reported immediately to the controller.

Before further accepted tests, `STATE_DIR`, all workspaces/tools/helper key/settings/default output/config paths were redirected into the private fixture. A first fail-fast scan rejected a residual helper `/tmp/openclaw` default **before any commands**; corrected. A fixture construction audit with state-changing methods replaced by no-op then proved all copied `.sh/.py/.mjs` contain neither `/root/.openclaw` nor `/tmp/openclaw`. Guard now runs before every fixture's first subprocess, with a retained regression that rejects a leaked live manager path. Example audited roots: `/tmp/tmpu_9h48wq/{toggles,helper.py,bridge.py,audio,config.json,planner.mjs}`; subsequent provider tool doubles use `external-tools/` within the same fixture.

Controller restored exact original bytes from `/root/.openclaw/.snapshots/jev-emotion-20261025-151700/settings/tts-toggle/` and archived accidental files at `/root/.openclaw/.snapshots/jev-emotion-test-toggle-recovery-20261025/`. Original main/Bernhardine disabled, Heisenberg enabled, with original Felix/Lucy/Simon voices. This task did not attempt to guess/restore flags itself.

Guarded wrapper runs and later targeted tests were followed by read-only byte comparison against the original snapshot. All three matched exactly, recorded at `/tmp/task-4-toggle-integrity.log`:

- main `ac2a81b7ea96882ae062fc96aae5709073f033e338ccfc01021da715690dca87`
- bernhardine `85a7fa11ce6d6908c1a80deada1cecc6ee499d7c6ca0b76757bc412fd5f04951`
- heisenberg `f5e4142708e765e7230f597fefdf666ff46c92f7e0f6948e61ded6afd999782c`

## Limits

Host patch was tested against the actual copied caller and runtime, plus dry-run inspected the live shape; it was not applied by this task. Real live speech/context propagation belongs to controller rollout. Hearing acceptance has been approved by the user per controller message; this task did not independently send samples. No claim of live activation or full suite result. Interrupted deployment manifests/backups remain available for inspection; rollback deliberately refuses operator changes. Existing unrelated root verification-ledger edits must remain unstaged. The independently discovered legacy-owner race is assigned to the later review/fix wave and is outside this task.

## Final verification and handoff

Final aggregate after including the copied installed routing cases: same targeted command with output `/tmp/task-4-final-verification.log`, exit 0, **111 Node tests passed / 0 failed / 0 skipped**, ~38.1 s. Python aggregate runs 3 prepared-helper tests, 10 real wrapper/fixture-guard tests, 5 deploy/rollback tests and the 6 unchanged installed routing test bodies (24 Python cases). Independent clean six-case routing run: `python3 tests/telegram-speech-routing.test.py > /tmp/task-4-installed-routing-final.log 2>&1`, exit 0, **6 passed**, ~12.7 s. Final deploy dry-run `/tmp/task-4-deploy-final-dry-run.log` passed; final syntax/diff checks passed. Final read-only live-toggle comparison again matched all original snapshot bytes/hashes listed above, `/tmp/task-4-toggle-integrity.log`.

Task started from base `750e221e`; controller's version-only metadata commit `24aa8f1b` was added while implementation was in progress. The Task4 commit contains only the 36 owned artifact/source/test/docs/packaging files; controller's verification ledger remains unstaged. No forced workflow-report add.

Commit: `e10283d2b0ba6cb99c25772bb23788e0d4c85125` — `feat: share canonical Telegram speech planning and rollout artifacts`.

## Task4 review fix round 1 — Important findings I1, I2, I3

Base: `0381182e1e166a84c688a9af84aac2ad01768e8b` (reviewed Task4 implementation plus controller docs). Read the complete binding `task-4-review.md`; implemented only its three Important findings. The legacy-owner race and deferred Minor captured-reference entrypoint remain outside this fix scope. No subagents, live calls, deployment, configuration writes or service operations.

### I1: observable content-free shadow proposals

`planTelegramSpeech` now includes `proposed` per version. Each element contains only `{section,intent,delivery,action}`: section index 0–11 and the existing closed planner enums. Projection validates contiguous bounded spans, confidence, closed choices and uses the active renderer's congruence/confidence gate; no original words, arbitrary planner properties, persona/context, keys, model or paths enter this metadata. At most two versions and 12 sections per version.

The bridge logs `speech_shadow_decision:` followed by compact JSON `{decision:'accepted'|'rejected',versions:[{id,proposed}]}`. It independently projects only fixed version IDs, closed choices and bounded section indices. The actual shadow helper payload still receives the exact neutral canonical `speech` text. Adapter and real-wrapper regressions distinguish warm, firm and neutral proposals for the same final words; assert metadata excludes extra planner fields and source/secret strings; assert all shadow provider calls remain neutral. README/configuration docs describe the new additive field and stderr shape.

### I2: helper errors stay within one language

Helper timeout and spawn/OSError handling now lives inside the per-version loop. It emits bounded `ERR_DE:` / `ERR_PL:` classifications (`timeout`, `spawn_failed`, existing `generation_failed`), removes any partial output and continues to the next version. Cleanup errors are explicitly reported as `cleanup_failed` without escaping the loop. Aggregate result remains nonzero while successful `OK_DE:` / `OK_PL:` lines and nonempty files remain usable. No provider/helper exception content is logged.

The real wrapper fixture doubles only the selected external helper subprocess failure, writes a synthetic partial file first and raises `TimeoutExpired` or `OSError`. Four subcases cover first/second language and timeout/spawn failure. Assertions check both helper attempts, the successful other-language nonempty path, missing failed partial path, aggregate error status, classified error and no exception secret leakage. Existing fixture live-path scan still executes before every first manager command.

### I3: Heisenberg command identity

Changed only the three incorrect operational command targets in Heisenberg's table from main to heisenberg (`enable`, `disable`, `set-voice`). Added a guard checking all three skill tables' operational commands, including status, target their own agent.

### Actual RED / GREEN and validation

Meaningful RED commands:

```sh
node --test --test-isolation=none tests/telegram-speech-adapter.test.js > /tmp/task-4-fix1-red-adapter.log 2>&1
python3 tests/telegram-speech-wrappers.test.py SkillInstructionsTests WrapperTests.test_shadow_logs_distinct_closed_proposals_without_speaking_them WrapperTests.test_each_language_timeout_or_spawn_failure_preserves_the_other_success > /tmp/task-4-fix1-red-wrappers.log 2>&1
```

Adapter: 8 passed / 1 failed (missing proposed metadata). Focused wrapper/docs run: three methods failed with six assertion failures, including four failure subcases: unstructured shadow accepted/rejected evidence; first-language failure skipping Polish; second-language failures missing `ERR_PL:` classification; Heisenberg enable targeting main. An initial shadow assertion attempted JSON parsing before checking the structured prefix and errored; changed the test to make the existing missing-summary behavior an explicit assertion failure, then reran RED before implementation.

GREEN commands/results:

- Same adapter command, `/tmp/task-4-fix1-green-adapter.log`: **9 passed / 0 failed**, ~106 ms.
- Same focused wrapper/docs command, `/tmp/task-4-fix1-green-wrappers-focused.log`: **3 passed / 0 failed**, ~7.8 s, including the four helper error subcases.
- `python3 tests/telegram-speech-helper.test.py > /tmp/task-4-fix1-green-helper.log 2>&1`: **3 passed / 0 failed**.
- `python3 tests/telegram-speech-wrappers.test.py > /tmp/task-4-fix1-green-wrappers.log 2>&1`: **13 passed / 0 failed**, ~26.3 s; includes mandatory fixture path guard and per-agent skill identity guard.
- `python3 tests/telegram-speech-routing.test.py > /tmp/task-4-fix1-green-routing.log 2>&1`: **6 passed / 0 failed**, ~14.3 s; unchanged copied installed test methods on guarded real toolchain adapters.
- `node --check lib/telegramSpeech.js`, `python3 -m py_compile scripts/telegramTts/speech-bridge.py`, `git diff --check`: passed. No full suite or unrelated deploy/host suite rerun.

After all wrapper/routing runs, read-only exact-byte comparison of the three live toggle JSONs to `/root/.openclaw/.snapshots/jev-emotion-20261025-151700/settings/tts-toggle/` passed again, recorded in `/tmp/task-4-fix1-toggle-integrity.log`:

- main `ac2a81b7ea96882ae062fc96aae5709073f033e338ccfc01021da715690dca87`
- bernhardine `85a7fa11ce6d6908c1a80deada1cecc6ee499d7c6ca0b76757bc412fd5f04951`
- heisenberg `f5e4142708e765e7230f597fefdf666ff46c92f7e0f6948e61ded6afd999782c`

Fix-round commit: `20fc42b8431801e2083aa5c19ca01a3b3e95c816` — `fix: retain shadow speech proposals and isolate language errors` (7 owned files). Working tree clean after commit; workflow report remains ignored/unforced.
