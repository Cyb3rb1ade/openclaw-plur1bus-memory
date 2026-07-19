# Attack-path analysis — Safe reconsolidation drops workspace ownership from corrected memories

Candidate: `cand-safe-update-workspace-binding-loss`

## Path

1. **Source / trust boundary:** An authorized /correct operation targets an active scope:'workspace' memory that carries workspaceKey/workspaceId ownership metadata.
2. **Nearest or broken control:** buildUpdateEntry manually reconstructs the new row and copies scope but omits workspaceKey/workspaceId; MemoryDB.store fills the absent schema field with an empty string, and the ACL's legacy compatibility branch allows workspace rows with no binding.
3. **Sink:** safeUpdate stores the unbound replacement as active, then supersedes the correctly bound original; subsequent recall or mutation paths treat the replacement as visible from another workspace sharing the agent database.
4. **Security outcome if exploitable:** Correcting a workspace-scoped memory can broaden its visibility from one workspace to every workspace served by that agent, exposing the corrected content and enabling later wrong-workspace operations.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Calibration addendum — normal command path and existing ACL fact

Existing validation does more than identify an omitted field: it verifies that the product's own normalization creates the empty binding and that the actual ACL grants a different workspace access to the resulting row. The normal `/correct` completion path first object-authorizes the original card, then calls `safeUpdate`, which stores the replacement and supersedes the correctly bound original. That sequence supplies a realistic non-malicious producer; a different workspace sharing the agent database becomes the confidentiality beneficiary.

The same-agent multi-workspace condition is an explicit precondition, comparable to existing reportable ACL/graph findings. Confirmation and archive-first behavior do not repair access metadata after replacement.

**Policy decision revised: reportable, P2 / Medium.** Retain safe reconsolidation; enforce binding preservation and fail closed for workspace rows with missing binding rather than disabling corrections.
