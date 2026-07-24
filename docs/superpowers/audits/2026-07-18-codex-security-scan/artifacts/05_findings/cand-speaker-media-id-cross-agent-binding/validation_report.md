# Validation — Spoofable media-output IDs select diarization results without agent or session binding

Candidate: `cand-speaker-media-id-cross-agent-binding`  
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
- Attacker-controlled source: Any user/assistant message block can contain an HTML comment matching media-output-id with an arbitrary hex/dash value; index.js extracts all such values from ordinary message content.
- Closest/broken control: The token has no authenticity/provenance binding, and getMergeResultByMediaOutputId selects a globally shared external row solely by mediaOutputId without expected agent, workspace, session, chat, or owner criteria.
- Sink: The selected segments are scanned for speaker names and the resulting displayName/contextHint is persisted as a pending speaker mapping under the current agent; the pending proposal is later rendered by /speaker proposals and can be confirmed into an active mapping.
- Claimed impact: A principal who learns or guesses another media output ID can copy victim diarization identity/context hints into their routed agent, disclose those hints, poison its pending review queue, and potentially induce a wrong active speaker identity after confirmation.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
