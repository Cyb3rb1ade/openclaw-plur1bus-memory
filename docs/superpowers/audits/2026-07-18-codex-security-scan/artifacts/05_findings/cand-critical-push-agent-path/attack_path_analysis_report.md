# Attack-path analysis — Critical-push state path uses an unvalidated agent identifier

Candidate: `cand-critical-push-agent-path`

## Path

1. **Source / trust boundary:** Host command context agentId flows to runClassifier.
2. **Nearest or broken control:** Fallback to default exists, but there is no safeAgentId or resolveInside check in critical-push-state.
3. **Sink:** join(stateDir, `${agent}.json`) is read, written via a temporary sibling, and renamed.
4. **Security outcome if exploitable:** A traversal-shaped agentId could read and overwrite a JSON-suffixed file outside the critical-push state directory under the service account.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

