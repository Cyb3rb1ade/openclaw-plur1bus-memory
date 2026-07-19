# Attack-path analysis — Model-facing knowledge_update rewrites durable curated knowledge without user-bound authorization

Candidate: `cand-model-tool-knowledge-authz`

## Path

1. **Source / trust boundary:** Untrusted chat/retrieved/stored content can influence model tool selection; pending memory text and optional model-supplied note are then embedded in the curator prompt.
2. **Nearest or broken control:** The operation is gated only by an opt-out flag defaulting to allow and feature configuration. It does not invoke isAuthorized, createConfirmation, or validateConfirmation before rewriting KNOWLEDGE.md.
3. **Sink:** renameSync(temp, memory/KNOWLEDGE.md)
4. **Security outcome if exploitable:** Prompt injection or model error can prematurely promote attacker-influenced memories into durable curated context, rewrite the knowledge body, and shape future agent behavior.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

