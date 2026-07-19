# Validation — Startup cleanup follows a task-directory symlink

Candidate: `cand-vault-task-cleanup-symlink-delete`  
Instance: `vault-task-directory-symlink-delete:scripts/cleanup-vault-missing-tasks.mjs:112`

## Rubric

- [x] A configured vault can expose `records/tasks` as a symlink.
- [x] The original script traverses the link during normal startup cleanup.
- [x] It unlinks a matching file in the external target.
- [x] The name filter constrains but does not prevent the boundary crossing.
- [ ] Deployment timing/service privileges remain environment-dependent.

## Evidence and method

`validation_artifacts/proof.mjs` creates a temporary vault where `records/tasks` points outside, places a matching `missing-status-<uuid>.md` target there, sets the documented workspace environment, and imports the original cleanup script. The script reports `removed=1` and the external file is absent. No product file is changed.

Disposition: **reportable**, confidence 0.90. Preserve stale-task cleanup by canonicalizing/rejecting symlinked task directories before enumeration and deletion.
