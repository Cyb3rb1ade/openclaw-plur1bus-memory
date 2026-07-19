# Attack-path analysis — Memory compaction mixes user and workspace scopes inside a per-agent table

Candidate: `cand-compaction-cross-scope`

## Path

1. **Source / trust boundary:** Active rows for multiple ownerUserId/workspaceKey/scope values coexist in one agent database.
2. **Nearest or broken control:** Compaction filters status/core/age but neither retains nor compares scope, ownerUserId, storedBy, or workspaceKey.
3. **Sink:** Rows are clustered and sent together to the LLM; cross-scope merged actions are persisted to the invoking workspace, and identical rows can be archived when auto-apply is enabled.
4. **Security outcome if exploitable:** One user's/workspace's maintenance run can disclose another scope's memory through proposals/LLM output or archive a memory belonging to another principal.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

