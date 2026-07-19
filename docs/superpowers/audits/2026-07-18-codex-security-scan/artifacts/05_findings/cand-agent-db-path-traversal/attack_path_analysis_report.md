# Attack-path analysis — Primary per-agent database pool joins unvalidated runtime agent IDs into filesystem paths

Candidate: `cand-agent-db-path-traversal`

## Path

1. **Source / trust boundary:** Host hook, command, and model-tool contexts supply ctx.agentId/commandCtx.agentId to the primary MultiNamespacePool and AgentDbPool.
2. **Nearest or broken control:** AgentDbPool only falls back to default; it caches and joins the raw identifier without safeAgentId or resolveInside, even though the repository provides safeAgentId and uses it in db-adapter.
3. **Sink:** MemoryDB is constructed at the escaped path, and subsequent init/search/store/maintenance connects to or creates LanceDB state there.
4. **Security outcome if exploitable:** A traversal-shaped agent ID can escape the configured namespace directory, collide with another agent or plugin path, and read/create/modify LanceDB files under the service account, violating per-agent isolation.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

