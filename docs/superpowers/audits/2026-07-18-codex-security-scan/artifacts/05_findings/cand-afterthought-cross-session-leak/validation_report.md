# Validation — Afterthought cron selects workspace-wide outcomes without agent, session, or destination scoping

Candidate: `cand-afterthought-cross-session-leak`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-001.json, artifacts/02_discovery/file_reviews/review-034.json`
- Attacker-controlled source: Reply-outcome entries persist historical userPrompt together with agentId, sessionKey, and workspaceKey in a workspace-wide JSONL log.
- Closest/broken control: findAfterthoughtCandidate filters only timestamp and outcome and runAfterthoughtJob provides no expected agent/session/chat identity to the selector.
- Sink: The selected historical prompt is sent to the LLM and the resulting text/topic is returned by /plur1bus internal afterthought for cron delivery to that job's configured destination.
- Claimed impact: A delayed follow-up can disclose or allude to one chat/session's confidential topic in another agent or delivery destination that shares the workspace outcome log.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
