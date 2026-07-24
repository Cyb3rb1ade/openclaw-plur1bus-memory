# Validation — REM command info-logs the full generated dream narrative

Candidate: `cand-rem-dream-sensitive-log`  
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
- Attacker-controlled source: Up to 15 bounded snippets of stored memory text feed the default-enabled REM narrative generator, whose output can retain names, medical details, credentials, or other private content.
- Closest/broken control: Output is length-capped but not redacted; runRemDream assigns the whole narrative to report.narrative and the internal command serializes the complete report at info level.
- Sink: api.logger.info receives JSON.stringify(result.report), including up to 3,000 narrative characters.
- Claimed impact: Service/plugin log readers can recover sensitive dream-derived memory content outside normal memory ACL and chat visibility controls.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
