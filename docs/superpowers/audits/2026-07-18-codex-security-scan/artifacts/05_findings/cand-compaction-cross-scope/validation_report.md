# Validation — Memory compaction mixes user and workspace scopes inside a per-agent table

Candidate: `cand-compaction-cross-scope`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-012.json`
- Attacker-controlled source: Active rows for multiple ownerUserId/workspaceKey/scope values coexist in one agent database.
- Closest/broken control: Compaction filters status/core/age but neither retains nor compares scope, ownerUserId, storedBy, or workspaceKey.
- Sink: Rows are clustered and sent together to the LLM; cross-scope merged actions are persisted to the invoking workspace, and identical rows can be archived when auto-apply is enabled.
- Claimed impact: One user's/workspace's maintenance run can disclose another scope's memory through proposals/LLM output or archive a memory belonging to another principal.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
