# Attack-path analysis — Non-injective Neo workspace-key sanitization merges distinct workspace stores

Candidate: `cand-neo-workspace-key-collision`

## Path

1. **Source / trust boundary:** Host context, explicit workspace identifiers, configured aliases, paths, and corpus defaults supply a raw Neo workspace key.
2. **Nearest or broken control:** sanitizePathPart replaces every run of characters outside [A-Za-z0-9._-] with '_', strips edge underscores, maps empty results to default, and truncates at 120 characters without retaining a hash of the original identifier.
3. **Sink:** workspaceKeyFromContext returns the lossy value and createNeoStore uses it directly as the sole workspaces/<key> directory name for all turn, candidate, behavior, graph, run-state, and hook files.
4. **Security outcome if exploitable:** Two distinct workspaces can read, recall, modify, deduplicate, migrate, or prune each other's Neo records, causing cross-workspace confidentiality and integrity loss. The collision can be accidental or chosen when workspace names/IDs are user- or tenant-influenced.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

