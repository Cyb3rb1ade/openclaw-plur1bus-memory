# Attack-path analysis — Model-facing memory_forget is enabled by default and deletes without user identity or record ACL

Candidate: `cand-model-forget-auth-bypass`

## Path

1. **Source / trust boundary:** Untrusted conversational content can influence the model to invoke memory_forget with a query or memory UUID in a tool context that carries agentId but no user-bound authorization identity.
2. **Nearest or broken control:** security.allowModelDestructiveMemoryOps is treated as enabled unless exactly false; the code itself states model tool calls lack user-bound auth, and memory_forget performs no checkAccess against scope/ownerUserId.
3. **Sink:** The tool reads cards or search results, archives them, calls MemoryDB.delete, and returns candidate/full memory text or deletion status.
4. **Security outcome if exploitable:** Prompt injection or a malicious participant can cause unauthorized deletion/archiving of another user's or scope's memory within the same agent database and may enumerate matching memory text during query selection.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

