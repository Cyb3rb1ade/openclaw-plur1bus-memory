# Attack-path analysis — Global emotion engine carries previous-message state across agent, workspace, and session boundaries

Candidate: `cand-emotion-engine-cross-agent-context`

## Path

1. **Source / trust boundary:** Emotion analyses are performed for user or assistant messages associated with potentially distinct agentId/workspace/session contexts.
2. **Nearest or broken control:** EmotionEngine stores one _context object per engine and never keys it by the supplied agentId; lib/emotion.js exposes one module-global engine/config for the entire process.
3. **Sink:** The next analysis uses the prior principal's emotion and timestamp to select blends and returns emotional_context.previous_top_emotion, previous_timestamp, and transition to its caller.
4. **Security outcome if exploitable:** One conversation can influence or reveal coarse emotional state in a later unrelated conversation, contaminating emotion-derived behavior and violating agent/workspace/session isolation.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

