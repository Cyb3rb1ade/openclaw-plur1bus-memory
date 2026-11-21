# Whole-branch review — 6419a60e..20fc42b8

Reviewed the supplied 15-commit package for local version `7.18.32-jev.1`, against the approved plan, controller rulings and the code-reviewer contract. This is the single broad review. No implementation, index, branch, live configuration, toggle, service, deployment or provider changes were made. The only checkout write is this requested report.

## Strengths

- The incoming runtime shares the same process-scoped emotional pool as recall; the independent hook is installed outside recall/DB gates (`index.js:5791`). Stable admission IDs, per-agent commit serialization, session retirement, run tombstones and post-await lifecycle checks are substantive safeguards. The initial eligibility generation/session guard is correct; it should not be confused with I1 below.
- Timed state integrates the previous target before replacing evidence, preserves individual unknown dimensions and their original expiries, and retains v2/old-v3 hydration with explicit opt-in (`lib/emotional-state.js:89`, `lib/emotional-state.js:117`, `lib/emotional-state.js:569`). The fake-clock tests check event-rate independence, long-idle integration and restart behavior rather than merely calling the implementation twice.
- Incoming observed affect and independent persona reaction remain distinct. Strict numeric validation and the explicit known-dimension mask prevent uncertainty becoming zero-valued evidence. Outgoing decisions use contiguous Unicode spans and closed enums, with meaning/congruence and confidence checks before rendering (`lib/jevEmotion.js:266`, `lib/speechRegie.js:139`).
- Canonical text preparation, the adapter and the Python prepared-payload validator form a coherent exact-word boundary. Bilingual planning is combined; fixed speakers remain outside model output. The corrected bridge contains timeout/spawn failures within each language iteration and retains successful `OK_*` output (`scripts/telegramTts/speech-bridge.py:56`).
- Private run context uses restrictive modes, exact workspace/run matching, expiration, no-follow file reads and terminal cleanup; the host patch forwards only the trusted wrapper/default identity fields. Selected credential resolution does not export secrets in argv or the run environment (`lib/telegramSpeech.js:11`, `lib/telegramSpeech.js:26`, `lib/telegramSpeech.js:63`, `scripts/telegramTts/patch-exec-speech-context.mjs:5`).
- Deployment has a reviewable mapping, dry-run default, affected-file backups and hash-checked targeted rollback. The supported Python aggregate uses guarded temporary fixtures; Task4's final fix addresses its three scoped findings.

## Consolidated findings — one fix wave

No Critical findings. The following is the complete fix list from this review; I2 groups the two parts of one shadow-comparison contract defect.

1. **I1 — Important: pending legacy inference can mutate and persist after its owner is superseded.**

   **Evidence:** `index.js:12959` checks `!jevEmotionRuntime.isEnabled(agentId)` before awaiting inference at `index.js:12973`. The success mutation at `index.js:12975`, fallback at `index.js:12982`, and writes at `index.js:12989` / `index.js:12991` check cancellation but never revalidate shared ownership/generation. `/tmp/jev-legacy-owner-race.md` records the exact production-block reproduction with real old/new runtimes and shared state: an active owner accepted newer evidence while legacy inference waited; the caller signal remained live; resolving the old inference changed sadness from `.08` to `.631999858289928`, persisted `.632`, and replaced both mood files.

   **Impact:** activation/reconfiguration can violate the single-owner guarantee and overwrite the newer authoritative state. No host guarantee that pending legacy callbacks are drained has been established.

   **Smallest coherent fix:** expose/capture shared owner generation or equivalent ownership proof before starting legacy work, and revalidate after every asynchronous boundary and before success/fallback mutation and persistence. The proof must detect A→B→A, not merely check today's active boolean. Keep ordinary disabled/shadow legacy behavior. Do not convert ownership rejection into a legacy fallback. Add real production-block regressions covering successful and rejected inference, active replacement, A→B→A and no stale file writes. The adjacent runtime initial-policy guard needs no speculative rewrite.

2. **I2 — Important: shadow cannot perform the approved contextual comparison of proposed emotions and delivery.**

   **Evidence:** `lib/jevEmotionRuntime.js:234` returns from shadow after logging only `shadow_accepted` / `shadow_rejected` at line 235. It discards the proposed reaction dimensions/strengths, rejection reason and elapsed metadata, and exits before the private snapshot at line 251. `resolveExecEnv` additionally requires active-only `isEnabled` at `lib/jevEmotionRuntime.js:267`. Consequently `lib/telegramSpeech.js:121` has no legitimate run file in shadow and the planner receives empty context/persona/mood at line 127. The active path receives those contextual inputs. Existing runtime shadow coverage explicitly expects `{}` from the exec hook, so this is current behavior, not a hypothetical missing caller. Task4's corrected outgoing `proposed` enum projection is good and does not repair this upstream gap.

   **Impact:** the binding gate, “Zunächst werden vorgeschlagene Emotionen und Darbietungen ohne hörbare Änderung verglichen,” cannot inspect proposed incoming emotion at all. Outgoing shadow results also cannot establish how contextual irony, persona or opposite mood will behave once active; all real shadow runs silently use the fallback path even with complete trusted identity. The controller confirmed there is no exemption from contextual shadow comparison.

   **Smallest coherent fix:** distinguish configured shadow/active observation and run-context eligibility from active state ownership. Publish/refresh the same private, run-bound current-context snapshot for eligible stable shadow runs and allow its exact exec bridge, while keeping legacy mood mutation/persistence authoritative, suppressing new mood directives and sending canonical neutral audio. Emit a bounded, explicitly projected incoming proposal summary containing known dimension names and finite values, with safe outcome/reason/elapsed information sufficient for the acceptance comparison. Do not log text, persona, arbitrary model fields or credentials, and do not create a second durable shadow mood store. Update the active-only context documentation. Add a runtime→adapter/host-seam regression proving matching authored context/persona/current mood is available in shadow, different incoming proposals remain distinguishable, unknown axes are not reported as known zeros, terminal/revoked context cannot revive, and no shadow timed evidence, mood-file writes, competing guidance or expressive provider tags occur.

3. **M1 — Minor: known HTML tags with boolean attributes survive canonical sanitation.**

   **Evidence:** the known-tag expression at `lib/speechText.js:38` accepts only attribute assignments. `<span hidden>Hallo</span>` retains the opening `<span hidden>` while stripping the closing tag. This confirms the Task1 deferred finding from the current packaged source.

   **Impact:** markup can enter the classified/spoken canonical words, contrary to the intended markup cleanup, though it does not bypass the closed square-bracket tag gate.

   **Fix:** support boolean attributes within the existing recognized-tag grammar (or an equally conservative parser), preserving comparison prose and quoted `>` handling. Add focused known-tag/boolean-attribute and comparison-prose regression cases.

4. **M2 — Minor: the captured routing reference is still executable against live helper paths after rollout.**

   **Evidence:** `tests/fixtures/telegramSpeech/installed-tts-routing.py:9` selects live `/root/.openclaw`; its original `setUp` copies installed wrappers but substitutes only workspace/audio paths. Its direct entrypoint at line 118 runs those cases. The deployed bilingual wrapper calls the live shared bridge directly at `scripts/telegramTts/bernhardine/bin/tts-bilingual.sh:41`, outside those substitutions. The supported `tests/telegram-speech-routing.test.py:15` adapter is isolated because it replaces the fixture setup/execution methods.

   **Impact:** directly executing a file labelled an offline regression can unexpectedly call the live bridge/provider after deployment. This is not a finding against the corrected aggregate fixture, and no unsafe execution was attempted here.

   **Fix:** make the captured reference import-only/fail closed on direct execution and prevent its original live-path setup from being an alternative executable test route. Keep importing its unchanged assertions through the guarded adapter. Verify the refusal without invoking a live subprocess/provider.

## Review evidence and limits

- Read the approved plan, progress/rulings, verification record, Task4 review and fix review, supplied legacy-race evidence, and bounded portions of the supplied whole-branch diff. Reviewed all new core boundaries and regression suites. Repeated wrapper copies were compared within the package; operational skill commands and appended adapter instructions were inspected from the package. No `git diff` regeneration or full changed-file rereads were performed.
- One narrow external inventory lookup checked the named deployment contract for emotional-state, mood-style and standalone injector entries. The state and mood modules are present in `DEPLOY_FILES`; the standalone injector remains a separate controller-owned deployment, explicitly required by `docs/configuration.md`. Its actual installation must be included in the controller's adoption/rollback checks.
- Did not rerun task-only suites or run a full suite/stress loop. The evidence already includes the final Task4 fix's adapter 9/9, helper 3/3, wrapper 13/13 and routing 6/6, plus prior task checks. These are reported evidence, not a new full-suite result.
- Actual semantic acceptance comprised 20 fixtures and two bilingual reruns at matching core bytes; it supports those bounded cases only. User hearing approval is cleared. Neither model confidence nor those samples establishes population accuracy or comprehensive acoustic quality.
- Full final-source `npm test`, lint, the repaired contextual shadow gate, installed host adoption, adapter end-to-end audio and post-install preservation checks remain pending. The baseline environment/lockfile incident must remain separately classified. The known toggle-fixture incident and byte restoration are recorded controller evidence; this reviewer made no live accesses or state writes.

## Declined to judge

- General hardening/redesign of the copied local/Edge generator and shell-manager command surface beyond this ElevenLabs bridge: the approved scope preserves those routes, and arbitrary local shell callers are not a new privilege boundary. This does not exempt new context, wrapper identity or fixture-isolation defects, which were reviewed above.
- Unbounded classifier/population accuracy and comprehensive accent/acting quality: outside the approved bounded semantic/audio acceptance; the report preserves those limits rather than treating confidence as correctness.
- Fixing the pre-existing linked-node_modules lockfile assertion and sandbox baseline failures: unrelated baseline work, explicitly separated by the controller; final-source checks still must identify them honestly.

These set-asides require the executor's explicit ruling. Deployment/adoption and the remaining acceptance checks are not set aside as out of scope; they are still required controller work.

## Assessment

**Spec verdict: Needs fixes.** The major architecture and Tasks1–5 are implemented, including the approved uncertainty refinements, but I1 violates the single-owner contract and I2 prevents the promised shadow comparison.

**Code-quality verdict: With fixes.** State timing, validation, exact-text rendering and subprocess isolation are well supported; close the generation and shadow-mode gaps and address the two bounded deferred Minors in the same fix wave.

**Production-readiness verdict: Not ready for activation.** Repair the Important findings, run the focused regression/fix review and final checks, then complete the already-authorized controlled deployment and contextual shadow→active acceptance. No new user permission is needed merely because these technical gates remain.

**Ready to merge? No at this head.** No merge, push, tag publication or release is authorized by this report.
