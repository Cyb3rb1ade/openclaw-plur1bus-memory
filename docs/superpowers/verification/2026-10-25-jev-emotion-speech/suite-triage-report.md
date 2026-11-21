# Auto-capture full-suite failure triage

Source: `/root/plur1bus-dev-afterthought-jev`, starting HEAD `1189feb6`.

The three auto-capture failures are a test-fixture result-position assumption, not a capture runtime regression. `createJevEmotionRuntime` registers `endRun` on `agent_end` before the capture hook. `endRun` returns `undefined`; the fixture previously included every hook return and read index zero as the capture result.

## Evidence and TDD

1. Unmodified final-source reproduction:
   `node --test --test-isolation=none tests/auto-capture-batch.test.js`
   exited 1: 9 tests, 6 pass, 3 fail. All failures expected `true` from index-zero `timedOut` but received `undefined`:
   - checks abort after a late batch embed and performs no durable capture write
   - retains the same-agent capture slot until a timed-out store really settles
   - retains the same-agent capture slot through a timed-out reminder store
2. RED: strengthened the five timeout/success assertions to require an exact singleton scheduler-result array, before changing the fixture emitter. Ran:
   `node --test --test-isolation=none tests/auto-capture-batch.test.js > /tmp/plur1bus-jev-capture-triage-red.log 2>&1`
   Exit 1: 6 pass, the same 3 fail. Every timeout diagnostic showed the actual array `[undefined, {ok: false, timedOut: true, background: false}, undefined, undefined]`. The capture timeout result already existed and was correct. A baseline checkout was unnecessary after this direct result-boundary proof.
3. GREEN: changed only the fixture emitter to retain `result !== undefined`, still awaiting every registered handler and retaining every defined result. Ran:
   `node --test --test-isolation=none tests/auto-capture-batch.test.js > /tmp/plur1bus-jev-capture-triage-green.log 2>&1`
   Exit 0: 9 tests pass, 0 fail, 0 cancelled, 0 skipped (7.171 seconds).

The GREEN run reaches the late-embed gate release and asserts zero durable-store calls after abort. Both settlement tests assert the second same-agent store stays queued while the timed-out first store/reminder remains active, active/max-active stay one, and the queued capture succeeds only after the first mutation settles. Exact result arrays reject missing, duplicate, or unexpected defined outcomes; no `some()` fallback or weaker capture assertions were introduced.

## Scope and remaining suite status

Only `tests/auto-capture-batch.test.js` is changed for commit. All feature runtime bytes remain unchanged. The fixture uses private temporary test roots; no live data, providers, services, configuration, toggles, or deployment was changed. No additional full-suite run was started or existing process interrupted, per assignment; the parent owns the still-running full-suite result in `/tmp/plur1bus-jev-final-suite.log`.

That original suite already reported the three above failures using the old fixture and also `Local Inference resolves patched adm-zip with ONNX Runtime-compatible APIs`. The latter is the supplied known baseline lockfile/symlink failure and is out of scope. This focused GREEN result does not claim the whole suite passes. `git diff --check` returned 0.

Commit: `bb5c1e19` (`test: isolate capture outcomes from lifecycle hook returns`), containing the test file only. `git diff --exit-code 1189feb6 -- index.js lib openclaw.plugin.json package.json package-lock.json` returned 0. The report remains an ignored workflow artifact as requested.

## Completed full-suite RED and test-housekeeping supplement

The original `npm test` run completed after the capture correction: 5,580 tests, 932 suites, 5,571 pass, 6 fail, 3 skipped; duration 805,316.970 ms. Log: `/tmp/plur1bus-jev-final-suite.log`. Its command expands to syntax checks followed by `node --test --test-concurrency=1 tests/*.test.js test/*.test.js`. No second full-suite run was started.

The six failures were the three old-fixture capture failures already addressed above, the known baseline Local Inference lockfile/symlink assertion, and these two housekeeping failures supplying RED before the supplement:

- `7.5.0 release identity retains its build baseline and declares the stable OpenClaw floor`: actual package version `7.18.32-jev.1`, stale expected constant `7.18.31` at `tests/release-750-compat.test.js:34`.
- `kein Test legt noch selbst ein temporäres Verzeichnis an`: the unchanged guard listed `emotional-state-timed.test.js`, `jev-emotion-plugin.test.js`, `jev-emotion-runtime.test.js`, `jev-final-review.test.js`, `telegram-speech-adapter.test.js`, and `telegram-speech-host-patch.test.js` as bypassing the cleanup helper.

The supplement changes only the expected local version to `7.18.32-jev.1` and adopts `makeTempDir` from the existing `tests/helpers/temp-dir.js` in those six files. Every original prefix and default private temporary root, existing explicit cleanup, timing and assertion remains intact. Direct `mkdtempSync` calls/imports and now-unused `tmpdir` imports are removed. The helper adds cleanup at process exit, including failed tests. The guard itself and all build, gateway-floor and upstream-identity assertions remain unchanged.

Focused verification command:

```sh
node --test --test-isolation=none tests/emotional-state-timed.test.js tests/jev-emotion-plugin.test.js tests/jev-emotion-runtime.test.js tests/jev-final-review.test.js tests/telegram-speech-adapter.test.js tests/telegram-speech-host-patch.test.js tests/temp-dir-helper.test.js tests/release-750-compat.test.js
```

The first sandbox run (`> /tmp/plur1bus-jev-housekeeping-green.log 2>&1`) exited 1: 89/91 passed, including the corrected release identity and unchanged no-direct-temp-dir guard. The two helper subprocess tests, `löscht beim Prozessende auch nach einer Ausnahme und mit Inhalt` and `respektiert ein abgemeldetes Verzeichnis und ein fremdes Wurzelverzeichnis`, failed with `spawnSync /usr/bin/node EPERM`.

The identical eight-file command was rerun with approved escalation solely to allow the helper's private child Node processes (`> /tmp/plur1bus-jev-housekeeping-escalated-green.log 2>&1`). GREEN: exit 0, **91/91 tests pass**, 1 suite, 0 fail, 0 cancelled, 0 skipped, 1,957.777 ms. This includes the process-exit exception/contents cleanup check and custom-root/forget behavior. No test or production change was made between sandbox and escalated runs.

`git diff --check` returned 0. `git diff --exit-code 1189feb6 -- index.js lib scripts openclaw.plugin.json package.json package-lock.json` returned 0 after the supplement, proving runtime, scripts, manifest and dependency bytes still match the reviewed starting source. The separate known Local Inference baseline assertion remains unmodified and out of scope; these results do not claim a second full-suite GREEN.

Supplement commit: `4d4ce775` (`test: align Jev release fixtures with cleanup conventions`), seven test files only. The parent's untracked verification-document directory was left untouched.
