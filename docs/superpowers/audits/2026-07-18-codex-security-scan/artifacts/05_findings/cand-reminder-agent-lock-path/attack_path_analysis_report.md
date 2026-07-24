# Attack-path analysis — Reminder lock path interpolates an unvalidated agent identifier

Candidate: `cand-reminder-agent-lock-path`

## Path

1. **Source / trust boundary:** Host command context agentId reaches runReminderDispatch.
2. **Nearest or broken control:** No safeAgentId/resolveInside precedes lock construction.
3. **Sink:** acquireJobLock creates and releaseJobLock removes reminder-dispatch-${agentId}.lock.
4. **Security outcome if exploitable:** A separator-bearing agent ID could affect a fixed-suffix file outside the workspace locks directory.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

