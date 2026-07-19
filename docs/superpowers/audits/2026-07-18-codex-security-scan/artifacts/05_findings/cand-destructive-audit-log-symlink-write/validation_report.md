# Validation — Destructive-operation logging follows a workspace-controlled directory symlink

Candidate: `cand-destructive-audit-log-symlink-write`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-035.json`
- Attacker-controlled source: A repository/workspace contributor can pre-create .adaptive-learning as a symlink to a directory outside workspaceDir; destructive event fields can also contain user/model-derived query text, although JSON encoding prevents raw line injection.
- Closest/broken control: appendDestructiveOpLog uses join/existsSync/mkdirSync without lstat, realpath containment, resolveInside, or no-follow file creation.
- Sink: appendFileSync follows the directory symlink and creates or appends destructive-ops.jsonl using the OpenClaw service account during chat/model forget, correction, or automatic merge deletion.
- Claimed impact: A malicious workspace can make the service create or corrupt a fixed-name file outside the workspace and redirect audit records away from their expected location, weakening audit integrity and crossing filesystem boundaries.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
+
## Targeted reassessment

### Rubric

- [x] A workspace-controlled directory symlink was created in an isolated temporary workspace.
- [x] The original audit-log helper was invoked without changing source.
- [x] The fixed audit filename was observed outside the workspace.
- [x] The attacker precondition and constrained basename were considered for severity.

### Result

A temporary workspace with .adaptive-learning redirected to a separate directory caused the original appendDestructiveOpLog helper to create outside/destructive-ops.jsonl. The basename is fixed and JSON encoding constrains arbitrary content, but the helper crosses the documented workspace-containment boundary during a privileged destructive/merge event.

**Disposition: reportable — P3 / Low.** A workspace collaborator able to plant the symlink can redirect audit evidence and create/append the predictable file outside the intended workspace. Canonical parent validation plus no-follow creation preserves audit logging and all destructive features.
