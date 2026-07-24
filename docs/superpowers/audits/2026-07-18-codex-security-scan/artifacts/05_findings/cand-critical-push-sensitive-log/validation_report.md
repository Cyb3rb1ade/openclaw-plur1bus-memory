# Validation — Critical-push classification serializes secrets and health data into info logs

Candidate: `cand-critical-push-sensitive-log`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-004.json`
- Attacker-controlled source: Stored memory-card content, including credentials, banking, or health information, enters classifyMemory/buildPushMessage.
- Closest/broken control: Type classification and daily rate limiting control delivery volume but do not redact the body.
- Sink: buildPushMessage copies card.text/summary verbatim; runClassifier includes message.text in pushMessages; index.js logs JSON.stringify(result) at info level.
- Claimed impact: Anyone with plugin/service log access can recover highly sensitive memory content; the same body is prepared for outbound chat delivery.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
