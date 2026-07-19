# B9 Operations and Maintenance Fix Receipt

Date: 2026-07-19
Batch: B9
Branch: `fix/high-mid-b9-operations`
Fix base: `cb0cfdcc21ab62e2c775b76fb3366e499e07ccf2`
Findings: BUG-ADD-02, BUG-ADD-06, BUG-ADD-07, FE-ADD-06

Outcome: **the two independent-review corrections are implemented at the isolated B9 boundary; focused, owning, syntax, diff, and bounded original-PoC gates pass; final independent re-review remains controller-owned**

## Restored invariants

### BUG-ADD-02 — bounded, backup-first LanceDB retention

`scripts/maintain-lancedb.mjs` now accepts `--keep` only as a complete decimal safe integer in `1..100000`. Invalid, missing, negative, zero, fractional, non-finite, prefixed, exponent, and over-limit values reject before DB discovery, plan output, backup creation, or deletion.

The maintainer performs a complete read-only discovery phase before mutation. Agent IDs pass `safeAgentId()`, selected paths pass `resolveInside()`, and agent, table, `_versions`, and manifest symlinks fail closed. Apply creates a backup only when deletion is planned, deletes only regular manifest metadata, re-reads each directory, requires the expected retained count, and records the destructive operation. Dry-run remains plan-only and preserves file content and mtimes.

### BUG-ADD-06 — truthful repair child status and end state

`scripts/repair-installed-plugin.mjs` now exports the focused, documented `assertSuccessfulMaintenanceResult()` boundary and is safe to import without executing `main()`. Maintenance spawn errors, timeout errors, signals, null/unknown status, and nonzero exit status all throw visibly and produce repair exit code 2. A successful child is followed by the same LanceDB diagnosis; only the fresh result reaches the summary and final exit code.

One normalized mutation policy now governs deploy repair, LanceDB maintenance, and cron execution. The documented `--dry-run` promise therefore holds with both `--maintain-lancedb` and `--run-cron`: diagnosis/listing and would-run plans remain available, the warning exit state stays truthful, and neither the applying maintenance child nor `openclaw cron run` is invoked. A real non-dry-run `--run-cron` still triggers the selected errored cron.

### BUG-ADD-06 / FE-ADD-06 — per-agent migration

`scripts/migrate-missing-columns.mjs` now safely enumerates every real per-agent directory under the default namespaced base. Each agent ID and path is validated, each target is opened, migrated, schema-verified, row-count-verified, closed, and reported separately. Invalid names, symlinks, missing tables, and target failures are visible; safe targets continue, and aggregate exit is nonzero if any target fails. The positional explicit single-DB path remains supported, additive, row-preserving, and idempotent.

### BUG-ADD-07 — fail-closed deploy-integrity checker

`scripts/protect-plur1bus-deploy.sh` no longer uses a hard-coded `/root` checker. It resolves a real non-symlink checker either beside the canonicalized script or, for the installed mirror, inside the canonical pinned source repository. Missing, escaping, unimportable, or API-incomplete checker state aborts before backup or restore.

One complete `RESTORE_FILES` allowlist now drives drift detection, preflight, backup, restore, and source/deploy hash equality. It includes the runtime list, `openclaw.plugin.json`, and the optional `package.json`, `README.md`, and `LICENSE` metadata. Every existing source candidate is required to be a regular non-symlink before backup; JavaScript candidates additionally receive the content-specific broken-stub check. A legitimate runtime-plus-metadata restore remains backup-first, verifies all allowlisted source/deploy hashes plus the required marker, and honors restart suppression.

### FE-ADD-06 — honest reindex contract

`scripts/reindex-provider.mjs` remains report-only. Its `--apply` path still exits nonzero with the explicit not-implemented message and creates no report or data directory. No re-embedding, provider switch, resume, rollback, or apply claim was introduced.

## TDD evidence

The authoritative pre-edit focused RED, executed outside the nested-process sandbox, was:

```text
$ node --test --test-isolation=none --test-reporter=spec tests/operations-maintenance-b9.test.js
tests 29; pass 4; fail 25; skipped 0; duration_ms 7575.600485
```

The four passing controls were dry-run preservation, explicit single-DB migration, legitimate deploy restoration, and honest reindex apply rejection. The 25 causal failures exercised strict retention, verified retention end state, maintenance child failure/re-diagnosis, default per-agent migration, and fail-closed checker/restore verification.

Two change-aware bypasses received their own later RED-to-GREEN cycles:

```text
repair --dry-run --maintain-lancedb: tests 1; pass 0; fail 1
installed guard using pinned-source checker: tests 1; pass 0; fail 1
```

The first RED proved that 451 manifests were deleted despite `--dry-run`; the second proved that a legitimate installed guard could not reach the checker in its canonical source checkout. Their focused GREEN reruns each passed 1/1.

The independent specification review then identified two remaining mutation/preflight gaps. Both were reproduced before their production corrections:

```text
repair --dry-run --run-cron: tests 1; pass 0; fail 1
symlinked optional package metadata: tests 1; pass 0; fail 1
```

The cron RED recorded both `cron list` and the applying `cron run`; the metadata RED completed backup and restore instead of rejecting the source candidate before mutation. Fresh focused GREEN runs passed both regressions. Separate positive controls also passed for real non-dry-run cron execution and legitimate runtime-plus-manifest/package/README/LICENSE restoration.

## Final focused and owning GREEN

```text
$ node --test --test-isolation=none --test-reporter=spec \
    tests/operations-maintenance-b9.test.js \
    tests/repair-scripts.test.js \
    tests/protect-plur1bus-deploy.test.js \
    tests/deploy-integrity.test.js
tests 74; suites 19; pass 73; fail 0; cancelled 0; skipped 1; todo 0
duration_ms 41913.166565
```

The one skip is the existing root-only unwritable-directory control in `verify-workspace-writer`; every B9 regression and positive control ran and passed. The B9 file contributes 34 passing subtests.

## Original PoC and bypass review

The retained bounded original `_versions`-symlink PoC was rerun against the patched maintainer:

```json
{
  "status": 1,
  "oldestWasRemoved": false,
  "remainingManifestCount": 51,
  "containedBackupCreated": false
}
```

The error identifies the unsafe `_versions` symlink before backup or deletion.

Change-aware review also covered:

- retention: negative, `-0`, zero, fraction, `NaN`, `Infinity`, numeric prefix, exponent form, missing value, `100001`, valid apply, dry-run mtime invariance, invalid agent ID, and external `_versions` symlink;
- repair: successful child plus fresh diagnosis, nonzero exit, signal, timeout tuple, still-elevated status, combined dry-run/maintenance, dry-run cron listing without execution, and real applying cron execution;
- migration: two valid agents, a missing table beside a valid agent, an external symlink beside a valid agent, and an explicit custom DB path;
- deploy: adjacent checker missing/broken/symlinked, canonical-source checker positive path, broken source stub, symlinked optional metadata, a copy command that falsely reports success, valid runtime-plus-metadata backup/restore/hash verification, and restart suppression; and
- reindex: explicit apply rejection with no filesystem state creation.

## Syntax and diff gates

All commands exited 0:

```text
node --check scripts/maintain-lancedb.mjs
node --check scripts/migrate-missing-columns.mjs
node --check scripts/repair-installed-plugin.mjs
node --check tests/operations-maintenance-b9.test.js
bash -n scripts/protect-plur1bus-deploy.sh
git diff --check
```

No full serial suite was started in this isolated lane; the integration controller owns that coordinated gate.

## Changed files

Production:

- `scripts/maintain-lancedb.mjs`
- `scripts/migrate-missing-columns.mjs`
- `scripts/repair-installed-plugin.mjs`
- `scripts/protect-plur1bus-deploy.sh`

Tests:

- `tests/operations-maintenance-b9.test.js` (new)

Documentation:

- `docs/audits/2026-07-19-b9-operations-maintenance-fix.md` (this receipt)

No `index.js`, dependency, graph, dreaming, reindex production code, shared aggregate report, integration branch, or `main` file changed.

## Remaining uncertainty

- Maintenance is an operator-run filesystem procedure, not a cross-process transaction. A concurrent LanceDB writer can cause the post-delete retained-count verification to fail visibly; the backup and error remain available for repair.
- Deploy restoration proves equality to the configured pinned source, but this batch does not add release-signature authenticity or address separate deployed-path symlink findings.
- Real gateway restart was not invoked; positive deployment tests use the documented `PLUR1BUS_NO_RESTART=1` path.
- Reindex apply, graph-link one-shot policy, and dreaming-cron repair remain outside the fixed B9 brief and are not claimed complete here.
- Repository-wide serial verification and independent re-review remain integration-controller gates.

## Independent review correction status

The independent specification review of `98a2e0cccc12cdaaddc8ab33a08966337f587c3c` reported exactly two Important findings: cron execution bypassed dry-run, and optional metadata bypassed source preflight. This follow-up adds causal regressions, preserves both positive paths, and limits production changes to the two reviewed scripts. A fresh independent re-review of the resulting second commit remains an integration-controller gate and is not claimed complete here.
