# Validation — Skill approval can activate LLM-generated instructions that the default review omits

Candidate: `cand-skill-approval-blind-executable`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-013.json, artifacts/02_discovery/file_reviews/review-036.json`
- Attacker-controlled source: Stored memory excerpts are supplied to an LLM that returns arbitrary instructions.
- Closest/broken control: Evidence trust/confidence gates and explicit authorized approval exist, but the default pending-proposal review shows only title, score, confidence, and an 80-character description; approval is bound only to an ID, not an exact displayed content hash.
- Sink: approveProposal renders the unshown instructions verbatim into workspace skills/<safeSlug>/SKILL.md, which is executable agent configuration on later skill loading.
- Claimed impact: Prompt-injected or compromised-model instructions can be approved under an innocuous summary and later steer tool use/data access with the user's skill authority.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
