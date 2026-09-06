# Offline PLUR1BUS snapshots and restore

`plur1bus-hermes-snapshot` provides an end-user export, integrity check and
recoverable restore. It is included in the Python package; no npm, model download
or external service is needed. Use the Hermes venv that has this candidate.

## Select the complete scope explicitly

Specify every PLUR1BUS data root with repeatable `--data-dir`, plus configuration
files or external artifact/vault directories with repeatable `--include`.
For example, one shared data root plus root/profile plugin configs:

```sh
plur1bus-hermes-snapshot export --snapshot /private/backups/plur1bus-before-change \
  --data-dir /absolute/hermes-home/plur1bus \
  --include /absolute/hermes-home/plugins/plur1bus/config.json \
  --include /absolute/hermes-home/profiles/example/plugins/plur1bus/config.json
```

This is a **read-only plan**. Stop all affected Hermes gateways, desktop backends,
maintenance jobs and other writers. Re-plan once they are stopped; then repeat
with `--apply --runtimes-stopped --confirm HASH`, using the exact confirmation
from that plan. Active cooperating runtimes refuse the export even with the flag.
Older plugin processes and unrelated applications must also actually be stopped;
the flag is not a way to suspend them. Install the new guard-aware runtime before
using restore in a live deployment.

The complete data tree includes LanceDB generations, cards, graph/metadata,
tombstones, epistemic state, pending/dead-letter capture queues, mirrors, cache
and other artifacts under the selected root. Recognized process-coordination
locks are excluded; they are regenerated, not replayed as stale PID ownership.
Empty directories and executable flags are retained. Files become private to the
restoring user (0600, or 0700 for executable files; inherited home ACLs on Windows).
Symlinks, reparse points, special files, overlapping roots and broad home/root
targets are refused. External files are **not discovered or implicitly included**.

Snapshots are plaintext private directories, **not encrypted**. They may contain
memory content and credentials from selected config files. Store them privately;
do not upload/share them casually. Checksum verification detects damage, not a
malicious replacement of both the manifest and files. Restore only trusted backups.

## Verify and restore

```sh
plur1bus-hermes-snapshot verify --snapshot /private/backups/plur1bus-before-change
```

Use the same explicit roots/includes as export with `restore` instead of `export`.
The plan binds the verified snapshot, all target paths and their current contents.
After review and shutdown, repeat with `--apply --runtimes-stopped --confirm HASH`.
This is a **full point-in-time rollback**, including old configuration and memories
forgotten after the snapshot. Confirm only when that is your intended recovery.

Restore uses the original paths; it does not rewrite generation signatures,
ownership, model directories or endpoint settings for a new machine. It stages
and checks complete trees, keeps each previous root alongside its destination,
then switches the roots. No previous data root is recursively deleted. The receipt
lists retained backups and the external transaction/audit log. Keep those backups
until the restored runtime and profile routes have been accepted.

## Interrupted restore

An external guard prevents new runtime, writer and migration starts if restore
stops between root replacements. A file copy failure does not make the partially
written tree a valid snapshot. Fix the external problem (for example disk space)
and repeat the restore command with the **original hash**, `--apply`,
`--runtimes-stopped` and `--resume`. Resume verifies the snapshot, previous roots
and already restored roots again. A partial staging copy is retained separately
and rebuilt; manual edits to restored/previous roots fail closed for inspection.

Do not remove restore guards or change transaction journals to bypass a failure.
The process releases them only after all roots pass verification and the complete
receipt/audit is durable. A crash during export leaves an incomplete export
directory; retain it for inspection and choose a new export destination.

Tests cover real LanceDB round trips, retained originals, config rollback,
tombstone/queue preservation, stale approvals, corruption, wrong target paths,
active-runtime rejection and crashes after each rename. Native Windows and
network filesystems are not certified by macOS/Linux unit tests. Local filesystems
only; Windows flush/write-through is not identical to POSIX directory fsync.
