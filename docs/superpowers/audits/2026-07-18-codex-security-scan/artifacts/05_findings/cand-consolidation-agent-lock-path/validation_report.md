# Validation — Daily-consolidation lock path interpolates an unvalidated agent identifier

Candidate: `cand-consolidation-agent-lock-path`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-011.json`
- Attacker-controlled source: commandCtx.agentId is passed as agent to runConsolidation.
- Closest/broken control: There is no safeAgentId or resolveInside validation before the lock filename is constructed.
- Sink: acquireJobLock creates consolidation-${agent}.lock beneath a joined workspace locks path and releaseJobLock later removes it.
- Claimed impact: A separator-bearing agent identifier could create/remove a lock file outside the intended locks directory, subject to the fixed prefix/suffix and filesystem permissions.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
