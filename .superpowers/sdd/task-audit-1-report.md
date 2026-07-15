# Task 1 Audit Report

## What you implemented

- Bumped the plugin version from `6.9.10` to `6.9.11` in `package.json` and `openclaw.plugin.json`.
- Added the feature-cron bootstrap runtime files to `DEPLOY_FILES`:
  - `lib/setup/feature-cron-plan.js`
  - `scripts/setup-feature-crons.mjs`
  - `scripts/lib/openclaw-cli.mjs`
  - `scripts/lib/find-deploy-dir.mjs`
- Extended the strict plugin config schema for the humanization config objects used by the branch:
  - `recallHedging`
  - `styleDirective`
  - `dreamEcho`
  - `personaVoice`
  - `afterthought`
  - `reactionNudge`
  - `contradictionDisclosure`
- Matched schema defaults to the brief/code fallbacks:
  - `recallHedging.enabled: true`
  - `recallHedging.minSpread: 0.1`
  - `styleDirective.timeOfDay: true`
  - `styleDirective.opinion: true`
  - `styleDirective.askBack: true`
  - `dreamEcho.enabled: true`
  - `personaVoice.enabled: true`
  - `afterthought.enabled: true`
  - `reactionNudge.enabled: "auto"` with enum `[true, false, "auto"]`
  - `contradictionDisclosure.enabled: true`
- Changed automatic multi-agent feature-cron planning so delivery-needing per-agent jobs are always created disabled with the existing operator hint, and no live `delivery` object is attached in that automatic path.
- Refactored `scripts/setup-feature-crons.mjs` into an injectable runner export and fixed `--json` failure handling so each skip/failure path emits exactly one JSON object to stdout with exit code `0`, including a positive `lastPlanCreateCount`.
- Updated bootstrap hint logic so a current-version marker without numeric `lastPlanCreateCount` now still hints.

## What you tested and exact test result

Command:

```bash
node --test tests/deploy-integrity.test.js tests/config-audit.test.js tests/feature-cron-plan.test.js tests/feature-cron-bootstrap.test.js
```

Exact result:

```text
✔ tests/config-audit.test.js
✔ tests/deploy-integrity.test.js
✔ tests/feature-cron-bootstrap.test.js
✔ tests/feature-cron-plan.test.js
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

## TDD evidence

RED command:

```bash
node --test tests/deploy-integrity.test.js tests/config-audit.test.js tests/feature-cron-plan.test.js tests/feature-cron-bootstrap.test.js
```

RED failure:

```text
SyntaxError: The requested module '../scripts/setup-feature-crons.mjs' does not provide an export named 'runSetupFeatureCrons'
✖ tests/config-audit.test.js
✖ tests/deploy-integrity.test.js
✖ tests/feature-cron-bootstrap.test.js
✖ tests/feature-cron-plan.test.js
```

GREEN command:

```bash
node --test tests/deploy-integrity.test.js tests/config-audit.test.js tests/feature-cron-plan.test.js tests/feature-cron-bootstrap.test.js
```

GREEN pass output:

```text
✔ tests/config-audit.test.js
✔ tests/deploy-integrity.test.js
✔ tests/feature-cron-bootstrap.test.js
✔ tests/feature-cron-plan.test.js
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

## Files changed

- `package.json`
- `openclaw.plugin.json`
- `scripts/lib/deploy-integrity.mjs`
- `scripts/setup-feature-crons.mjs`
- `lib/setup/feature-cron-plan.js`
- `lib/setup/feature-cron-bootstrap.js`
- `tests/deploy-integrity.test.js`
- `tests/config-audit.test.js`
- `tests/feature-cron-plan.test.js`
- `tests/feature-cron-bootstrap.test.js`
- `.superpowers/sdd/task-audit-1-report.md`

## Self-review findings

- The owned Task 1 surfaces are covered by focused regression tests for deploy manifest coverage, strict schema coverage/defaults, automatic afterthought planning behavior, and `--json` failure-mode output.
- I left the pre-existing dirty files `lib/jobs/memory-dynamics-maintenance.js` and `tests/memory-dynamics-maintenance.test.js` untouched.
- I did not stage or modify `docs/superpowers/plans/2026-07-15-humanization-audit-fixes.md`.

## Issues/concerns

- Task brief step 10 explicitly references `runDeferredFeatureCronBootstrap`, which currently lives in `index.js`. Per the task ownership constraint, `index.js` was out of scope and was not edited.
- As a result, the deferred bootstrap writer still does not parse/use the new script-level `lastPlanCreateCount` field, and it still treats unparseable setup output as missing `lastPlanCreateCount` rather than forcing a positive fallback there. I implemented the owned pieces around this (`scripts/setup-feature-crons.mjs` output and `featureCronsHintFromMarker` hint behavior), but the `index.js` portion remains for whichever task is allowed to touch that file.

## Follow-up fix for step 10

- Added `parseFeatureCronBootstrapLastPlanCreateCount(stdout)` in `index.js` and routed `runDeferredFeatureCronBootstrap()` through it.
- The helper now:
  - prefers explicit numeric `lastPlanCreateCount` from the script JSON,
  - preserves the existing `failedCreates + disabledDeliveryCreates` calculation for normal JSON without the explicit field,
  - returns `1` when stdout is empty, unparseable, or parses to a non-object JSON value.
- This keeps the written marker positive on skipped/unparseable setup output instead of silently writing a success-looking marker.

### Follow-up tests

RED command:

```bash
node --test tests/feature-cron-bootstrap.test.js
```

RED failure:

```text
Expected values to be strictly equal:
+ actual - expected

+ 'undefined'
- 'function'
```

GREEN commands:

```bash
node --test tests/feature-cron-bootstrap.test.js
node --check index.js
```

GREEN results:

```text
✔ tests/feature-cron-bootstrap.test.js
ℹ pass 1
ℹ fail 0
```

```text
node --check index.js
exit 0
```

### Follow-up files changed

- `index.js`
- `tests/feature-cron-bootstrap.test.js`
- `.superpowers/sdd/task-audit-1-report.md`

### Updated concerns

- The original out-of-scope concern for step 10 is now resolved.

## Reviewer follow-up fix: automatic afterthought delivery wiring

- Fixed `scripts/setup-feature-crons.mjs` so automatic multi-agent afterthought jobs that are planned as `enabled: false` and have no `delivery` object no longer emit `--announce`.
- Preserved explicit delivery when `job.delivery` exists.
- Preserved the legacy explicit operator `--agent` path for enabled afterthought jobs, and added focused coverage for both behaviors.

### Reviewer follow-up TDD

RED command:

```bash
node --test tests/feature-cron-bootstrap.test.js
```

RED failure:

```text
AssertionError [ERR_ASSERTION]: automatic disabled afterthought must not wire --announce
```

GREEN commands:

```bash
node --test tests/feature-cron-bootstrap.test.js
node --check scripts/setup-feature-crons.mjs
```

GREEN results:

```text
✔ tests/feature-cron-bootstrap.test.js
ℹ pass 1
ℹ fail 0
```

```text
node --check scripts/setup-feature-crons.mjs
exit 0
```

### Reviewer follow-up files changed

- `scripts/setup-feature-crons.mjs`
- `tests/feature-cron-bootstrap.test.js`
- `.superpowers/sdd/task-audit-1-report.md`
