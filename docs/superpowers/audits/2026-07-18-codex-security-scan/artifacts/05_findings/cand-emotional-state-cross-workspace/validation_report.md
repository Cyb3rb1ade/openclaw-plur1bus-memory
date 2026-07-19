# Validation — Emotional state is isolated by agent but not by workspace

Candidate: `cand-emotional-state-cross-workspace`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-007.json`
- Attacker-controlled source: Conversation emotion from any workspace served by an agent updates emotionalPool.get(agentId).
- Closest/broken control: The pool key and hydrate-once guard omit workspace identity.
- Sink: The shared state affects recall boosting, serialized mood files, and prompt/style injection in later turns for the same agent in another workspace.
- Claimed impact: A workspace can infer or inherit another workspace's emotional state and have its recall/response behavior influenced across the intended isolation boundary.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
