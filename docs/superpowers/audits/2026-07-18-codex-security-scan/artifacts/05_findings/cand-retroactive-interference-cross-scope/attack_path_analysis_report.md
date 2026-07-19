# Attack-path analysis — Retroactive interference weakens semantically similar memories across workspace boundaries

Candidate: `cand-retroactive-interference-cross-scope`

## Path

1. **Source / trust boundary:** A user or model stores a normal non-core memory in workspace A for an agent whose per-agent DB also holds workspace-B memories, while retroactiveInterference is enabled.
2. **Nearest or broken control:** The helper excludes the new row and core rows and caps mutations, but it does not retain or compare workspaceKey, scope, ownerUserId, or storedBy. MemoryDB.search is an unscoped per-agent nearest-neighbor read.
3. **Sink:** For each match, db.update writes a reduced memoryStrength and lastDynamicsAt to the foreign row.
4. **Security outcome if exploitable:** A tenant can indirectly reduce retention/retrieval priority of up to five semantically similar memories owned by another workspace sharing the agent DB, undermining isolation and integrity.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

