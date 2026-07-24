# Attack-path analysis — Skill-miner lock path interpolates an unvalidated agent identifier

Candidate: `cand-skill-miner-agent-lock-path`

## Path

1. **Source / trust boundary:** Host command context agentId is passed into runSkillMiner.
2. **Nearest or broken control:** No safeAgentId or resolveInside call precedes the lock path join.
3. **Sink:** acquireJobLock creates and releaseJobLock removes skill-miner-${agent}.lock.
4. **Security outcome if exploitable:** A separator-bearing agent ID may create/remove a fixed-suffix file outside the intended locks directory.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

