# Scoped capture fixture review

Reviewed supplied triage report and `review-1189feb6..bb5c1e19.diff` for base `1189feb6`, head `bb5c1e19`.

Spec verdict: PASS. Quality verdict: APPROVE. No findings in the supplied fixture-only change.

- The emitter still invokes and awaits every handler in registration order. It excludes only `undefined` return values; defined values including `null`, `false`, and unexpected objects remain observable. Handler exceptions still propagate.
- All five changed assertions require exact singleton arrays with complete expected scheduler outcomes. A capture hook returning `undefined` leaves no expected result and fails; duplicate or unexpected defined results also fail. Filtering lifecycle no-result returns therefore does not weaken these capture outcome checks.
- The diff preserves the durable-store-after-abort assertion and the queued-store, active-count, and maximum-overlap assertions surrounding both settlement scenarios. No production code changes appear in the supplied patch.
- Reported RED evidence contains the correct timeout result displaced by lifecycle `undefined` returns. Reported GREEN is 9/9 for the focused test file. Together with the narrow emitter change, this supports the stated fixture-assumption diagnosis.

Evidence limits: this is a static review of the supplied diff and report, with no source crawl, independent test rerun, or live operations. The parent owns the final full-suite audit; this approval does not claim the full suite passes. The known Local Inference lockfile/symlink failure remains outside this review.

## Test-housekeeping supplement: bb5c1e19..4d4ce775

Spec verdict: PASS. Quality verdict: APPROVE. No findings in the seven-file test-only supplement.

- Six test files replace direct temporary-directory creation with the existing `makeTempDir` helper. Prefixes and default roots are preserved. A focused read of the existing helper confirms it uses `mkdtempSync(join(root, prefix))` with `tmpdir()` as the default root and tracks created directories for recursive, forced process-exit cleanup. Existing explicit test cleanup remains; repeated removal is safe because both paths use `force: true`.
- Behavioral assertions, fixture permissions, runtime settlement cleanup, and path binding checks remain intact. The cleanup guard and helper are absent from the change set, so the guard is not relaxed to accommodate these files.
- Release identity still uses a literal exact expected version, now `7.18.32-jev.1`. A focused read confirms package, lockfile top-level and root-package versions, and plugin manifest must all equal that constant. Build, gateway floor, SDK, host target, and upstream identity baselines remain unchanged.
- The supplied diff changes tests only. No production runtime, scripts, manifest, or dependency changes appear in this supplement.

Validation evidence is reported, not rerun: eight focused files passed 91/91 with approved escalation for helper child processes, log `/tmp/plur1bus-jev-housekeeping-escalated-green.log`. The preceding sandbox-only failures were child-process `EPERM`, with no intervening code change reported. The original full suite completed with 5,580 tests, 5,571 pass, six fail and three skipped; these two housekeeping fixes and the previously approved three capture fixes address five failures. The separate known Local Inference fixture failure remains outside this approval. No full-suite GREEN or deployment approval is inferred.
