# OpenClaw Update Recovery and PLUR1BUS 7.1.9 Design

**Date:** 2026-08-01
**Status:** Approved for implementation

## Objective

Recover the running OpenClaw installation from the mixed PLUR1BUS deployment created during the 2026.7.2-beta.6 update, deploy the exact official PLUR1BUS `v7.1.9` release, and harden both PLUR1BUS and the private update workflow against the same failure class.

The work also restores reliable daily consolidation, provides a safe replacement for the removed promoted-memory reindex bridge, and corrects the false or misleading diagnostics observed in the update report.

## Confirmed Failure Causes

1. The private update script ran deploy-integrity repair with the server home directory as its repository source. The package metadata there identified PLUR1BUS 6.9.11, so the repair copied old files into the installed extension.
2. A later startup patch restored only selected files from a pinned 7.1.7 release. The resulting extension mixed several releases. In the observed runtime, `config-contract.js` imported `validateTimeZone`, while the deployed `time-window.js` did not export it, preventing PLUR1BUS from loading.
3. All three daily consolidation jobs were scheduled for 04:00 Europe/Berlin. Main and Bernhardine repeatedly stalled before plugin execution while Heisenberg completed, consistent with a startup/resource thundering herd rather than a consolidation-handler error.
4. The update script's only counted error was an active cron delivery target stored with a `telegram:` prefix. OpenClaw requires the bare chat ID; the script also suggested an unrelated hard-coded replacement ID.
5. Device scopes had already migrated from JSON to SQLite, but the checker still read only `device-auth.json`.
6. The YouTube checker expected obsolete Whisper ports and matched the valid value `language=de-DE` as though it were the obsolete `language=de` setting. The current service uses the Parakeet bridge on port 8000 and does not require the old VAD path.
7. Patch verification treated messages such as `manual check needed` and unexpected anchors as success because it recognized only a narrow warning spelling.
8. The memory health check mixed cold registry output and stale journal history with current-boot health, producing misleading auto-capture and auto-recall results.
9. The optional source-repository check used an obsolete repository path instead of the configured canonical PLUR1BUS repository.
10. `.openclaw/scripts/embed-promoted-memories.mjs` was removed from the repository by commit `de33209` during privacy cleanup, and the live copy was later renamed to `embed-promoted-memories.mjs.bak-pre-sys-move`. The update checker retained the old path. That backup is not suitable for direct restoration because it uses an older direct LanceDB writer and hard-coded embedding assumptions.

## Release Boundary

Production recovery and new development are deliberately separated:

- The live extension is restored from the exact official `v7.1.9` tag. No locally modified package may be presented as version 7.1.9.
- Generic hardening is implemented on `agent/openclaw-update-hardening` and published as a draft pull request for the next release.
- The server-specific update script remains private and local because it contains operational paths, account-specific jobs, model policy, and chat identifiers. Only reusable, sanitized mechanisms belong in this repository.

## Production Recovery

Before any live mutation, create a PLUR1BUS snapshot with `scripts/backup-snapshot.sh` and back up the installed extension and the private update scripts.

Recovery then proceeds in this order:

1. Stop or quiesce the gateway only for the bounded deployment window.
2. Deploy the complete file set from the official `v7.1.9` source, never a selected-file overlay.
3. Run deploy-integrity and real-import smoke checks against the deployed tree, including the plugin entry point.
4. Restart the gateway and verify readiness through the gateway RPC probe, plugin inspection, current-boot journal, and listening sockets. A running systemd unit alone is insufficient.
5. Confirm the loaded PLUR1BUS version and exercise memory status/recall without modifying stored memories.
6. Correct the cron delivery target to the existing destination's bare numeric chat ID.
7. Stagger daily consolidation to 04:00 main, 04:15 Bernhardine, and 04:30 Heisenberg in `Europe/Berlin`.
8. After snapshot verification, run the three consolidation jobs sequentially and confirm their terminal states and logs.

If deployment or smoke verification fails, restore the backed-up installed extension and restart the prior service configuration. Memory data is not migrated as part of the plugin-file recovery.

## Generic Repository Changes

### Complete Deployment Integrity

Deploy integrity must treat the extension as one coherent release:

- Its manifest contains every runtime file needed by the entry point and its transitive imports.
- Repair copies the coherent manifest set from one validated source root.
- Verification hashes all manifest files after repair.
- Smoke tests import representative modules and the actual deployed `index.js`, so a missing transitive export fails before gateway restart.
- Source and destination resolution retains the existing traversal and symlink protections.

### Consolidation Scheduling

The canonical feature-cron planner assigns non-colliding schedules:

- main: `0 4 * * *`
- bernhardine: `15 4 * * *`
- heisenberg: `30 4 * * *`
- timezone: `Europe/Berlin`

Migration is conservative. It changes a job only when its schedule still equals the previously shipped canonical schedule and the rest of its identity matches the PLUR1BUS-managed consolidation job. A user-customized schedule is reported and preserved. Repeated setup is idempotent.

### Promoted-Memory Reindex Bridge

A new, generic `scripts/embed-promoted-memories.mjs` replaces the obsolete backup instead of restoring it verbatim.

Required behavior:

- Discover configured agent/workspace targets without hard-coded personal identifiers.
- Read promotion candidates through the current promotion/query abstractions.
- Obtain embeddings through the current provider factory and normalized provider configuration, including the configured model and dimensions.
- Write through current memory/database abstractions rather than guessing a LanceDB schema.
- Validate agent IDs and resolve every input/output path inside an approved base directory.
- Deduplicate idempotently using stable promotion provenance.
- Default to `--dry-run`; require an explicit apply flag for writes.
- Report per-agent planned, inserted, skipped, and failed counts without logging memory plaintext or credentials.
- Fail nonzero on partial application and retain enough provenance for a safe retry.

The update script first checks whether reindexing is actually required. It runs the bridge in dry-run mode and displays the plan. Applying a backfill is a separate, snapshot-protected operation.

## Private Update-Script Hardening

The private server update script and its helpers will be adjusted locally:

- Define explicit, validated source roots for the development repository and pinned release. Reject a home directory or other broad parent as a PLUR1BUS source.
- Select one source version and use it for the entire deployment. Do not combine deploy-integrity from one tree with selected startup patches from another.
- Run the final integrity/import verifier after every `ExecStartPre` patch step because startup patches can reintroduce drift.
- Treat `manual check needed`, unexpected content, missing non-retired anchors, and equivalent outcomes as review warnings. Retired/native cases must be explicitly classified and version-gated.
- Query SQLite for migrated device scopes, with JSON fallback only for older installations.
- Detect the active ASR service and port 8000, and compare the language assignment exactly so `de-DE` is not reported as `de`.
- Restrict health evidence to the current boot/current gateway start and distinguish registry timeout from plugin failure.
- Use the configured canonical development repository for the optional Git repository check.
- Validate delivery targets from job state and display the target belonging to the affected job; do not print a hard-coded replacement ID.
- Report cron jobs with an error state as errors or warnings rather than prefixing every active job with a success marker.
- Count unresolved review warnings separately from fatal errors, and make the final summary name both categories.

## Verification Strategy

Repository changes follow test-driven development. New regression tests cover:

- coherent deploy repair and entry-point import failure detection;
- canonical 15-minute consolidation staggering;
- preservation of user-customized cron schedules;
- idempotent schedule setup/migration;
- reindex dry-run default, provider/dimension propagation, deduplication, path validation, partial failure, and redacted output.

Run targeted tests first, followed by the complete unit suite. The initial unmodified `v7.1.9` baseline passed all six previously failing files when rerun serially (110/110); the fully parallel suite showed six load-sensitive wrapper failures. Final verification therefore records both the ordinary full-suite result and a serial retry for any parallel-only failures rather than hiding them.

Live verification includes:

- official tag/source hash and installed manifest hashes;
- plugin entry-point real import;
- `openclaw gateway probe` and plugin inspection;
- current-boot gateway journal review;
- expected listening sockets and ASR health;
- SQLite device scopes;
- corrected delivery target and three staggered schedules;
- sequential successful consolidation runs after snapshot;
- promoted-memory reindex dry-run, followed by an explicitly authorized apply and post-count verification if candidates exist.

## GitHub Delivery

After repository tests and live verification:

1. Confirm the commit scope contains only generic repository changes and documentation.
2. Keep private server data and the local update script out of the commit.
3. Commit intentionally on `agent/openclaw-update-hardening`.
4. Push the branch and open a draft pull request describing the mixed-release root cause, backward-compatible migration behavior, tests, and operational rollout.
5. Verify that the official `v7.1.9` tag already exists remotely; do not move or recreate it.

## Non-Goals

- Rewriting unrelated OpenClaw patch logic.
- Publishing private server paths, user/chat identifiers, or operational model policy.
- Changing the PLUR1BUS memory schema during the 7.1.9 recovery.
- Automatically applying a promoted-memory backfill without a verified snapshot and dry-run.
- Renaming a modified development build to 7.1.9.
