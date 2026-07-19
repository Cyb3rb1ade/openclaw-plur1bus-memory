# Validation — Broad cron-context strings bypass authorization for privileged internal commands

Candidate: `cand-cron-context-auth-bypass`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-001.json`
- Attacker-controlled source: A registered /plur1bus command context contributes channel plus origin, source, or kind metadata.
- Closest/broken control: isCronCommandContext treats any one of those lower-cased strings equal to cron as trusted and skips the destructive checkAuth gate for every internal subcommand.
- Sink: The internal router exposes consolidation, classification, auto-accept, dreaming, skill mining, afterthought, persona evolution, reminder dispatch, semantic-link writes, GC, feedback, proactive, and meta-reflection jobs.
- Claimed impact: If a non-cron adapter, plugin, or inbound message can influence one fallback metadata field, an unauthorized user can execute privileged maintenance and state-mutating jobs under the service account.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
