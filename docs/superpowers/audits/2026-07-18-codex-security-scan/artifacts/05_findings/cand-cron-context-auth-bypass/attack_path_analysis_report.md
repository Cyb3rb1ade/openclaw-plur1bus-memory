# Attack-path analysis — Broad cron-context strings bypass authorization for privileged internal commands

Candidate: `cand-cron-context-auth-bypass`

## Path

1. **Source / trust boundary:** A registered /plur1bus command context contributes channel plus origin, source, or kind metadata.
2. **Nearest or broken control:** isCronCommandContext treats any one of those lower-cased strings equal to cron as trusted and skips the destructive checkAuth gate for every internal subcommand.
3. **Sink:** The internal router exposes consolidation, classification, auto-accept, dreaming, skill mining, afterthought, persona evolution, reminder dispatch, semantic-link writes, GC, feedback, proactive, and meta-reflection jobs.
4. **Security outcome if exploitable:** If a non-cron adapter, plugin, or inbound message can influence one fallback metadata field, an unauthorized user can execute privileged maintenance and state-mutating jobs under the service account.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

