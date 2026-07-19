# Attack-path analysis — Startup cleanup symlink delete

Candidate: `cand-vault-task-cleanup-symlink-delete`  
Affected controls: `scripts/cleanup-vault-missing-tasks.mjs:99-121`.

1. A vault contributor replaces the supported task directory with a directory symlink.
2. Gateway-start cleanup resolves/enumerates it lexically.
3. A matching stale-task name causes `unlinkSync` against the symlink target.

The product boundary is a user-editable Obsidian vault operated by the OpenClaw service account. The matching-name predicate and local filesystem prerequisite constrain impact, while the dynamic proof confirms a real outside-workspace deletion. Severity is **low (P3)** and final policy decision is **reportable**.
