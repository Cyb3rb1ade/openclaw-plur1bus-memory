# Attack-path analysis — Spoofable media-output IDs select diarization results without agent or session binding

Candidate: `cand-speaker-media-id-cross-agent-binding`

## Path

1. **Source / trust boundary:** Any user/assistant message block can contain an HTML comment matching media-output-id with an arbitrary hex/dash value; index.js extracts all such values from ordinary message content.
2. **Nearest or broken control:** The token has no authenticity/provenance binding, and getMergeResultByMediaOutputId selects a globally shared external row solely by mediaOutputId without expected agent, workspace, session, chat, or owner criteria.
3. **Sink:** The selected segments are scanned for speaker names and the resulting displayName/contextHint is persisted as a pending speaker mapping under the current agent; the pending proposal is later rendered by /speaker proposals and can be confirmed into an active mapping.
4. **Security outcome if exploitable:** A principal who learns or guesses another media output ID can copy victim diarization identity/context hints into their routed agent, disclose those hints, poison its pending review queue, and potentially induce a wrong active speaker identity after confirmation.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

