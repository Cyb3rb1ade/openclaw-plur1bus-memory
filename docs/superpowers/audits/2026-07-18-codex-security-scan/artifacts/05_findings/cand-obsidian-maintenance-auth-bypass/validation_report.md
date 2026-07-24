# Validation — Deep-maintenance chat command deletes generated task notes without authorization, confirmation, or audit

Candidate: `cand-obsidian-maintenance-auth-bypass`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-021.json`
- Attacker-controlled source: Any chat user able to invoke /plur1bus can request obsidian maintenance deep; the common Obsidian command dispatch does not enforce configured PLUR1BUS allowlists.
- Closest/broken control: runLivingMaintenanceDeep is called directly at lib/obsidian-control-room.js:3444, with no dry-run flag, user/chat-bound confirmation nonce, or checkAuth; index.js:2948-2983 reaches it before destructive authorization branches.
- Sink: cleanupResolvedFindings unconditionally enumerates records/tasks and calls unlinkSync for every missing-<field>-<id>.md whose source ID is no longer classified as missing at lib/obsidian/maintenance-deep.js:31-39.
- Claimed impact: An unauthorized shared-chat participant can remove generated review findings/evidence and alter the human control-room state despite an allowlist; deletions have no archive or appendDestructiveOpLog receipt.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier rationale while retaining a deferred disposition. No new PoC was run; evidence is limited to `artifacts/02_discovery/file_reviews/review-021.json` and the classifier corroboration in `review-018.json`.

### Receipt-based rubric

- [x] The command branch and `unlinkSync` sink are statically traced.
- [x] The destructive classifier omission is independently corroborated.
- [ ] No excluded user was invoked through the registered command interface.
- [ ] No generated task file was shown deleted across a principal boundary.

### Recalibrated result

The receipt explicitly describes the unauthorized-handler/deletion exercise as work that “should” be performed; it is not an existing reproduction. A realistic cross-principal path therefore remains unproved.

**Disposition:** deferred.  
**Survives:** uncertain.  
**Confidence:** 0.40.  
**Minimal next proof:** invoke `maintenance deep` as a user excluded by `allowedUserIds` against a stale generated task and record the lock outcome plus filesystem effect.
