# Final review fix wave — I1, I2, M1, M2

Committed fix: `1189feb6`. Base: `20fc42b8`; feature branch `feat/jev-emotion-speech`; local version remains `7.18.32-jev.1`.

## Changes and contracts

- **I1:** `createJevEmotionRuntime` now returns `captureLegacyOwnership(agentId)`, a JSDoc-documented factory for a generation/pool-bound ownership predicate. It validates the agent ID and stays false after configuration or shared-pool replacement, even when the mode returns to shadow. The exact production legacy recall block captures the guard before hydration/inference and checks it after the inference await and before success/fallback mutation, mood calculation and each file write. Stale work leaves only the labelled legacy block; ordinary recall continues, and ownership rejection does not invoke the fallback. The stale rejected-inference branch emits a fixed diagnostic. Touched mood paths now use `resolveInside`.
- **I2:** configured shadow and active runs use the same private version-1 snapshot, exact host exec bridge and adapter context validation. `isEnabled` remains active state ownership only; configured eligibility is separately checked. Shadow creates/refreshes the private run context but adds no timed evidence, mood file, prompt directive or expressive speech. Incoming debug metadata explicitly projects only `outcome`, closed `reason`, bounded finite `elapsedMs` (0–1000 or null), and known finite [0,1] reaction dimensions. Unknown dimensions, arbitrary fields, source/persona/credentials are omitted. Rejected assessments project no reaction. Revocation after assessment and during exec closes/tombstones the run. Stale-generation exec handlers return before touching current runs; caught audience/lifecycle revocation removes their own run context.
- **M1:** the existing known-tag grammar additionally accepts recognized HTML boolean attributes. Unknown bare attribute words remain comparison prose; quoted `>` remains inside an assigned attribute. No general HTML parser or dependency was added.
- **M2:** the captured installed routing reference is import-only. Direct entry raises `SystemExit`; original setup, command execution and call-reader helpers raise `RuntimeError`. Removed its live root and unsafe fixture-building implementation. Its six assertion bodies are unchanged and still imported by the guarded routing adapter. Refusal regressions intercept `unittest.main`, temporary setup and subprocess invocation before running captured code, so even RED could not reach live scripts/providers.
- Updated `docs/configuration.md` for contextual shadow eligibility and proposal metadata. No edits to controller-owned verification or approved global constraints.

## Regression coverage

`tests/jev-final-review.test.js` contains 20 cases:

- Actual `index.js` legacy block executed by VM with real shared pool/runtimes: ordinary shadow/disabled × success/rejected inference retain writes; pending success/rejected inference × active/A→B→A replacement produce zero stale writes and preserve current state and both existing mood-file bytes. Caller signal remains live. Fake Date keeps legitimate timed evolution from obscuring stale mutation assertions.
- Actual runtime → patched captured host caller → real adapter: private authored context/persona/current mood reach shadow, proposed delivery is observable while provider speech is canonical neutral, and no timed evidence/mood files/new prompt directive appear.
- Matching authored context/persona/opposite current mood is available in both shadow and active; terminal/revoked and pending terminal/revoked runs cannot revive; a stale shadow exec handler cannot delete its replacement generation's context.
- Incoming proposals distinguish .8 from .2 joy, omit unknown/nonfinite axes, preserve the actual assessor's closed rejection reason, and reject arbitrary diagnostics/fields.
- Five known-tag/boolean/comparison/quoted-`>` cases.

Existing plugin production-block regression now uses real runtimes rather than boolean runtime doubles. Existing shadow runtime regression now expects its exact private context. Guarded routing adds two refusal cases.

## RED evidence

1. `node --test tests/jev-final-review.test.js > /tmp/jev-final-red-node.log 2>&1` returned 1 with only a generic file failure due to this environment's isolated test subprocess limitation. `node --test --test-reporter=tap tests/jev-final-review.test.js` showed the same generic failure. The controller confirmed the known sandbox limitation; these are **not** the behavior-level RED evidence.
2. `node tests/jev-final-review.test.js > /tmp/jev-final-red-node-direct.log 2>&1` returned 1: **15 tests, 5 pass, 10 fail**. All four legacy races wrote both stale files; shadow lacked the run file; incoming proposals contained empty metadata; four boolean-tag cases retained markup. The existing conservative comparison case passed.
3. `python3 tests/telegram-speech-routing.test.py CapturedReferenceSafety > /tmp/jev-final-red-routing.log 2>&1` returned 1: **2 cases, 2 expected failures**. Captured direct entry reached the intercepted unittest runner; original setup reached intercepted temporary setup. No subprocess or live filesystem path was invoked.
4. After the initial fix, `node --test --test-isolation=none tests/jev-final-review.test.js > /tmp/jev-final-green-node-initial.log 2>&1` had 13/15 pass; the remaining assertions needed deterministic Date and the full existing mood snapshot shape (includes timestamp/nuances). These were test-fixture corrections, not additional production findings. The corrected 15 cases passed in `/tmp/jev-final-green-node.log`.
5. Additional boundary regression: `node --test --test-isolation=none tests/jev-final-review.test.js > /tmp/jev-final-red-boundaries.log 2>&1` returned 1: **20 tests, 18 pass, 2 fail**. The actual assessor reason `invalid_or_uncertain_answer` was not yet allowlisted, and the new catch cleanup could delete a replacement generation's run via an old handler. Corrected both before the final covering run. The stale-handler test establishes a replacement file exists before exercising the stale handler.

## GREEN verification

All commands ran in `/root/plur1bus-dev-afterthought-jev` with no live providers, credentials, configuration/service/deployment changes or installed TTS execution.

```sh
node --test --test-isolation=none tests/jev-final-review.test.js tests/jev-emotion-runtime.test.js tests/jev-emotion-plugin.test.js tests/jev-emotion-speech.test.js tests/telegram-speech-adapter.test.js tests/telegram-speech-host-patch.test.js > /tmp/jev-final-green-covering.log 2>&1
```

Exit 0, **118/118 pass**, no skipped/cancelled cases.

```sh
node --test --test-isolation=none tests/emotional-state-timed.test.js > /tmp/jev-final-green-state.log 2>&1
python3 tests/telegram-speech-routing.test.py > /tmp/jev-final-green-routing.log 2>&1
python3 tests/telegram-speech-wrappers.test.py > /tmp/jev-final-green-wrappers.log 2>&1
```

Exit 0 respectively: **26/26 state, 8/8 routing, 13/13 wrapper cases**. Routing and wrapper commands use the existing fail-fast private fixture guards before any subprocess. `/tmp/jev-final-toggle-before.json` records read-only SHA-256/size baselines of all eight original `/root/.openclaw/settings/tts-toggle/*.json` files; `/tmp/jev-final-toggle-proof.json` verifies all hashes/sizes and the exact file set remain unchanged afterward. No toggle writes were performed.

A final fixed diagnostic was added to the stale rejected-inference catch to honor the no-silent-catch rule, then the affected production-block tests were rerun:

```sh
node --test --test-isolation=none tests/jev-final-review.test.js tests/jev-emotion-plugin.test.js > /tmp/jev-final-green-owner-final.log 2>&1
```

Exit 0, **25/25 pass**. `git diff --check`, `node --check index.js`, `node --check lib/jevEmotionRuntime.js`, `node --check lib/speechText.js`, and `node --check tests/jev-final-review.test.js` also returned 0.

## Self-review and limits

Reviewed the owned diff against I1/I2/M1/M2, the approved global constraints and actual production boundaries. No feature redesign, model/credential changes, new dependencies/services, memory-store writes or package metadata changes. Shared active ownership and legacy fallback/persistence remain distinct from context eligibility. Logging projection is closed and bounded; same context file format and private permissions are retained. M2's assertion methods are unchanged and run only through guarded fixtures.

No remaining implementation concern identified in this scope. This is offline behavioral evidence, not actual contextual Jev semantic acceptance or audio listening evidence. Full final-source `npm test` and lint are intentionally reserved for the controller's single run after the scoped rereview. This report does not claim deployment, activation, merge or whole-package passing. Report and evidence files remain local; only owned implementation/docs/tests are committed.
