# Attack-path analysis — Afterthought cron selects workspace-wide outcomes without agent, session, or destination scoping

Candidate: `cand-afterthought-cross-session-leak`

## Path

1. **Source / trust boundary:** Reply-outcome entries persist historical userPrompt together with agentId, sessionKey, and workspaceKey in a workspace-wide JSONL log.
2. **Nearest or broken control:** findAfterthoughtCandidate filters only timestamp and outcome and runAfterthoughtJob provides no expected agent/session/chat identity to the selector.
3. **Sink:** The selected historical prompt is sent to the LLM and the resulting text/topic is returned by /plur1bus internal afterthought for cron delivery to that job's configured destination.
4. **Security outcome if exploitable:** A delayed follow-up can disclose or allude to one chat/session's confidential topic in another agent or delivery destination that shares the workspace outcome log.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

