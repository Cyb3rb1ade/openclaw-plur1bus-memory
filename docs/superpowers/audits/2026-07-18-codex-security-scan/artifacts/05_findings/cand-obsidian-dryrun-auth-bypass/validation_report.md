# Validation — A dry-run token suppresses Obsidian command authorization while handlers still perform real mutations

Candidate: `cand-obsidian-dryrun-auth-bypass`  
Scope: repository snapshot `6dff096e`  
Date: 2026-07-18

## Validation rubric

- [x] Discovery source, closest control, and sink are preserved below.
- [x] The repository code path was traced against the completed receipt.
- [ ] A bounded dynamic reproduction was not completed for this candidate.
- [x] The remaining proof gap and conservative disposition are stated.

## Method

Static source-to-sink trace using the independently reviewed discovery receipt. This bounded audit did not run a target-host exploit simulation for this candidate.

## Evidence

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-018.json`
- Attacker-controlled source: Any chat participant can append --dry-run (or a case variant such as --DRY-RUN) to a destructive Obsidian command, including review apply/quickapply, rotate, cron install, config discovery write, or SOUL patch.
- Closest/broken control: isObsidianCommandDestructive lowercases all tokens and immediately returns false whenever --dry-run is present, before checking dangerous flags or mutating subcommands. Execution does not share that parsed decision: several branches ignore --dry-run, derive real execution from --apply, or check the original case-sensitive token.
- Sink: The skipped authorization gate can reach applyApprovedReviewBundle -> memoryStore, rotateOldArchives -> rename/unlink, openclawCronAdd, writeDiscoveredObsidianWorkspaces, initWorkspace, and patchSoulMd with real-write parameters.
- Claimed impact: A user excluded by allowedUserIds, including a participant in a group/supergroup, can bypass the destructive-command ACL and write durable memory, install cron jobs, modify OpenClaw/SOUL/vault files, or delete/move review artifacts. No feature needs to be disabled to fix the parser/control mismatch.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier disposition above. No new PoC was run; the decision uses only the completed receipt `artifacts/02_discovery/file_reviews/review-018.json`.

### Receipt-based rubric

- [x] A realistic chat-command interface was exercised.
- [x] The caller was a distinct, non-whitelisted principal in a supergroup.
- [x] The broken control was observed: `review quickapply low-risk --dry-run` reached the normal handler instead of the authorization lock.
- [x] Direct classifier probes covered mixed destructive flags and case variants, and the receipt traces the same mismatch to concrete mutation handlers.
- [x] Residual preconditions are explicit: the selected feature and its target artifact must exist.

### Recalibrated result

The receipt verifies a realistic cross-principal authorization-boundary crossing. The probe stopped at `no-open-proposals`, so it did not materialize a durable mutation, but that is target-state counterevidence rather than restoration of the skipped ACL; the same normalized-token short circuit deterministically selects handlers whose sinks are traced in the receipt.

**Disposition:** reportable.  
**Survives:** yes.  
**Confidence:** 0.75.
