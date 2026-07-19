# Attack-path analysis — Emotional state is isolated by agent but not by workspace

Candidate: `cand-emotional-state-cross-workspace`

## Path

1. **Source / trust boundary:** Conversation emotion from any workspace served by an agent updates emotionalPool.get(agentId).
2. **Nearest or broken control:** The pool key and hydrate-once guard omit workspace identity.
3. **Sink:** The shared state affects recall boosting, serialized mood files, and prompt/style injection in later turns for the same agent in another workspace.
4. **Security outcome if exploitable:** A workspace can infer or inherit another workspace's emotional state and have its recall/response behavior influenced across the intended isolation boundary.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

