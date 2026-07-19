# Attack-path analysis — Daily-consolidation lock path interpolates an unvalidated agent identifier

Candidate: `cand-consolidation-agent-lock-path`

## Path

1. **Source / trust boundary:** commandCtx.agentId is passed as agent to runConsolidation.
2. **Nearest or broken control:** There is no safeAgentId or resolveInside validation before the lock filename is constructed.
3. **Sink:** acquireJobLock creates consolidation-${agent}.lock beneath a joined workspace locks path and releaseJobLock later removes it.
4. **Security outcome if exploitable:** A separator-bearing agent identifier could create/remove a lock file outside the intended locks directory, subject to the fixed prefix/suffix and filesystem permissions.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

