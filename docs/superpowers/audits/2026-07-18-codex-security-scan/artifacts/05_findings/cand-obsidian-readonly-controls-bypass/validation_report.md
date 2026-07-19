# Validation — Obsidian background rebuilds mutate vault state despite read-only, dry-run, or unconfirmed configuration

Candidate: `cand-obsidian-readonly-controls-bypass`  
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
- Attacker-controlled source: An operator enables the bridge/watch service while relying on mode='augment' or mode='dry-run', dryRun=true, requireVaultPathConfirmation=true, or allowWrite=false as a no-mutation safety posture.
- Closest/broken control: The bridge normalizes mode/dryRun/confirmation settings, but mode is never used as an execution gate. syncWorkspace checks dryRun and vault confirmation, whereas rebuildDashboards has no equivalent gate and is started/scheduled regardless. Several control-room state writers such as expireStaleBundles and generateConflictReport also bypass the otherwise-used allowWrite check.
- Sink: rebuildDashboards expires pending bundle JSON and invokes writeMemoryNotes, writeCommandsMarkdown, generateDashboards, and writeGraphLinks; startup invokes it immediately and periodically. Additional dry-run paths write config backups and sync metrics before/without their mutation guard.
- Claimed impact: A documented/readable safety mode can still create or replace vault files, rewrite graph-link managed blocks, and reject/expire review state. This can cause unexpected data loss or external writes when combined with the symlink escape, and defeats operator expectations during migration or audit runs.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier rationale while retaining a deferred disposition. No new PoC was run; only `artifacts/02_discovery/file_reviews/review-018.json` was used.

### Receipt-based rubric

- [x] Static call flow shows rebuild writers without the documented dry-run/read-only checks.
- [x] Existing tests establish that rebuilds normally write files.
- [ ] No test exercised `dryRun=true`, an unconfirmed vault, or `allowWrite=false`.
- [ ] No distinct lower-privileged principal was shown to select the safety mode and cause another principal's state mutation.

### Recalibrated result

The receipt supports a configuration/correctness defect, but its source is an operator-selected safety posture and the proposed cross-principal security consequence is not reproduced. Under the required cross-principal bar it is not reportable.

**Disposition:** deferred.  
**Survives:** uncertain.  
**Confidence:** 0.35.  
**Minimal next proof:** demonstrate a supported lower-privileged or vault-collaborator path that causes writes despite a protection chosen by a different principal.
