# Task 4 foundation gate report

## Scope and result

This task closes the foundation traceability gate only. It does not claim the
Hermes port, any platform acceptance, signing, packaging, publication, or a
storage/lifecycle implementation complete. The candidate remains
`nativePortCoverage: incomplete`.

The reviewed source pins are:

- Hermes historical baseline:
  `c12ec2bba63d74ac8add8782ab6761472b4149c6`
  (`7.12.7-hermes.4`)
- Upstream range: `v7.12.7..a3f48f28ac647e81c5260e8a1dbab7977bf9fb51`
- Foundation-task starting candidate: `f4f9adc`
- Focused Task 4 review base (excluding root-only future plans): `4c3194f`
- Narrow persona fix reviewed: `02d9f9f`

The original Task 4 implementation range is `4c3194f..9e255f4`.
The first review fix implementation range is `9e255f4..203fa1c`; root-only
plan commits through `ebc5164` are intentionally not part of either range.

Both pinned parents are ancestors of the candidate. At review time the
candidate differed by 111 paths from the Hermes baseline and 317 paths from
the upstream candidate. The committed focused range
`git diff --check 4c3194f..9e255f4` passed. After the review fix committed,
`git diff --check 9e255f4..203fa1c` also passed. The broader parent diffs
still contain inherited whitespace findings in dashboard patch files and legacy
bridge files; those are outside Task 4 and are not waived by this report.

## Immutable history gate: RED then GREEN

The previous test compared `legacyFeatures` with live `parity_report()` and
required every `auditStatus` to remain `unreviewed`. That made the snapshot
mutable and prohibited legitimate evidence-backed audit progress.

The new gate obtains the trusted fixed baseline source with:

```text
git show c12ec2bba63d74ac8add8782ab6761472b4149c6:plur1bus-hermes/src/plur1bus_hermes/parity.py
```

and compiles it under the fixed local name `pinned_baseline_parity`. It compares
all original fields for the 57 `FEATURES`, 13 `COVERAGE_710`, and 15
`COVERAGE_712` rows exactly. Only `auditStatus`, `auditEvidence`, and
`auditTests` may be added. Audit status is one of `unreviewed`, `partial`,
`verified`, or `host-specific`; all progressed states require non-empty
evidence, and `verified` additionally requires tests. `unreviewed` must have
empty evidence and test lists.

RED command:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_upstream_71244_inventory.py -v
```

Result: 7 tests run, 1 expected failure. Existing historical rows lacked the
new `auditEvidence` and `auditTests` metadata fields. The new regression also
constructs a verified audit row with evidence/tests (accepted) and changes a
historical `status` field (rejected).

GREEN used the same command after adding explicit empty audit metadata to all
85 historical rows: **7 passed** in 1.593 s. The suite also verifies all 37
non-merge commit rows, all 90 changed upstream files, and baseline preservation
hashes. No source-row status/evidence/detail field changed.

### Review fix 1: nonblank proof items

The first independent review found that a truthy whitespace-only proof such as
`"  "` passed the original validator, and verified commit rows only required
truthy lists. The fix adds one shared proof-list check: entries must be strings
whose `strip()` is nonempty. It is applied to all audit evidence/test lists and
to evidence/test lists of every verified commit.

RED used the inventory command above after adding regressions for whitespace
and non-string entries: 9 tests ran with one expected whitespace failure and
two expected missing-helper errors. GREEN used the same command after the
validator was wired into both paths: **9 passed** in 1.678 s. The evidence-only
implementation is `203fa1c`; broad QA was not rerun because no runtime code or
dependency changed.

## Current persona result versus historical finding

The historical initial finding remains `verified-gap`: it accurately describes
the fixed Hermes baseline's 400-character projection cap. Its existing
`resolution.status: verified` is a current-candidate statement, not a rewrite
of history. The exact upstream 7.12.37 row (`600aa2b`) is now `verified` only
for the bounded directive projection, supported by the live domain forwarding
from `personaVoice.maxDirectiveChars`/`maxBullets` to `load_directive()` and
the directive loader's resolved character budget.

Targeted live-path command:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_persona_voice.py -v
```

Result: **13 passed** in 0.010 s, including
`test_long_directive_reaches_live_prompt`, configuration forwarding, bounds,
private-scope gating, and descriptor/symlink/replacement/growth races. Persona
evolution, outcomes, cooldown and scheduling are separate open work in the
persona-dynamics plan; they are not implied by this verified projection.

## Full native QA

A disposable QA venv was created at
`/var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/tmp.MqkPRIqgFh/venv` with:

```text
/Users/cyberblade/.hermes/hermes-agent/venv/bin/python -m venv --system-site-packages /var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/tmp.MqkPRIqgFh/venv
```

The child venv initially had no `pytest`; after installing it only into the
temporary environment, collection showed 17 missing-module errors (`numpy`,
`lancedb`, `yaml`, and `fastapi`). This is an environment-isolation result:
a venv created from another venv does not inherit that venv's own packages.
No existing Hermes venv package was changed. The retry used the existing
Hermes venv site-packages read-only on the test-process `PYTHONPATH` and
installed only `PyYAML<7` and `fastapi` into the disposable venv because
distribution checks intentionally run the selected interpreter with `-I`.

Final command:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent:/Users/cyberblade/.hermes/hermes-agent/venv/lib/python3.11/site-packages /var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/tmp.MqkPRIqgFh/venv/bin/python -B -m pytest -q plur1bus-hermes/tests plur1bus-controls/tests distribution/tests hermes-dashboard/tests
```

Result: **841 passed, 160 warnings, 63 subtests passed in 24.34 s**. All 160
warnings are the existing LanceDB `table_names()` deprecation warnings; no
waiver or dependency change is claimed.

Earlier candidate Node evidence remains: `node-candidate.log` records exit 0,
4,661 tests total, 4,585 passed, 76 skipped, 0 failed, 828 suites in 427.16 s;
lint passed. This does not supersede the documented earlier isolated-worktree
path-resolution failure, which was resolved by local `npm ci --ignore-scripts`
before the candidate run. `npm audit --audit-level=moderate` remains open with
four affected packages / two advisory roots (`adm-zip` and `sharp`), no fix
available and no waiver.

## Residuals and handoff

- The 36 remaining upstream commit rows are unreviewed; all other historical
  features retain their original snapshots and unreviewed audit metadata.
- The historical episode five-turn finding remains a gap.
- Platform gates (macOS ARM64, Windows ARM64, Windows x64, Ubuntu/Linux x64,
  plus retained Linux ARM64) are not run or closed here.
- The next unit is the already-written storage/lifecycle plan:
  `docs/superpowers/plans/2026-09-11-hermes-7.12.44-storage.md`. It must begin
  from real runtime/provider/domain call paths and its scoped turn identity,
  retry, ACL, temporal and knowledge boundaries; this foundation result does
  not implement any of them.
