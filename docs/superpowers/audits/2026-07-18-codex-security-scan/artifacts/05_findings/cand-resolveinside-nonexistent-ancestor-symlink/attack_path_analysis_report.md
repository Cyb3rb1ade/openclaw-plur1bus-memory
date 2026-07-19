# Attack-path analysis — resolveInside misses an existing ancestor symlink when the immediate parent does not exist

Candidate: `cand-resolveinside-nonexistent-ancestor-symlink`

## Path

1. **Source / trust boundary:** A caller supplies or derives a multi-level new target beneath a base containing an attacker-created symlink in an earlier path component.
2. **Nearest or broken control:** For a non-existent target whose immediate parent is also absent, resolveInside does not walk to and realpath the nearest existing ancestor; it lexically resolves dirname(join(...parts)) and only checks the resulting string prefix.
3. **Sink:** The helper returns a path that traverses the ancestor symlink when a downstream caller recursively creates the missing parent or writes the target.
4. **Security outcome if exploitable:** A caller relying on the documented containment guarantee can create/write outside baseDir through an ancestor symlink even though traversal strings are rejected.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

