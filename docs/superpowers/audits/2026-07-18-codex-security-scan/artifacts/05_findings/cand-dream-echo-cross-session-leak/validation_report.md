# Validation — Workspace-wide dream echoes can surface one session's topic in another session

Candidate: `cand-dream-echo-cross-session-leak`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-005.json`
- Attacker-controlled source: Light dreams derive insights/narratives from one completed session, and REM dreams derive them from stored memories.
- Closest/broken control: The echo schema and workspace-wide file omit agent/session/chat/user/destination identity; loadFreshDreamEcho selects only by freshness, while the before-prompt hook knows the current context but supplies only workspaceDir.
- Sink: The newest echo sentence is inserted into the next eligible prompt's fullMemoriesContext and can be reflected in the response to whichever session contacts that workspace first.
- Claimed impact: A confidential health, relationship, credential, or project topic from one chat can be alluded to or repeated to another user/session sharing the agent workspace.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
