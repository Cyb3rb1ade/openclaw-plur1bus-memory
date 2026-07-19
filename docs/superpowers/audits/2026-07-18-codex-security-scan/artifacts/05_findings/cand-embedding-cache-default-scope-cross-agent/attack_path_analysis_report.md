# Attack-path analysis — Agent-scoped embedding cache silently collapses missing identities into a shared default scope

Candidate: `cand-embedding-cache-default-scope-cross-agent`

## Path

1. **Source / trust boundary:** Recall queries, reminder text, and other agent-associated text reach the embedding providers; several production call sites omit the agentId option.
2. **Nearest or broken control:** In agent scope, _resolveScopeId returns options.agentId || 'default' instead of requiring a validated agent identity, and providers pass an omitted identity through to the cache.
3. **Sink:** All such entries share the same in-memory key scope and persistent default.db; when embeddingCachePersistDebug is enabled, normalized plaintext is stored in that shared database.
4. **Security outcome if exploitable:** The configured per-agent cache isolation guarantee is lost. This can mix cache accounting/state between agents and co-locate plaintext from different agents at rest; a direct confidentiality impact depends on whether another principal can inspect/export the default cache database.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

